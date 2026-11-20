import { createReadStream, createWriteStream } from 'fs';
import { createGzip, createGunzip } from 'zlib';
import type { Readable, Writable } from 'stream';
import { SshExec, shellQuote } from '../ssh.service';
import { ConnectionConfig } from './base.engine';
import { mysqlTlsArgsFor, mysqlFlavorFromVersion } from './tls';
import { mysqlRestoreGuardArgsFor } from './cli-safety';
import { byteCounter } from './output-watcher';
import { logger } from '../../config/logger';

/**
 * "Run on the SSH server" strategy for MySQL / MariaDB.
 *
 * Instead of forwarding the database port and running mysqldump / mysql
 * here, the tools run on the SSH server, next to the database:
 *  - backup:  mysqldump | gzip runs there; only the compressed dump crosses
 *             the internet, and every query round trip stays local to it.
 *  - restore: the compressed file is streamed into gzip -d | mysql there.
 *
 * The password never appears in a command line on the remote machine: it is
 * written to an option file in a private temp directory (umask 077, mktemp),
 * which a shell trap removes when the command ends, however it ends.
 */

/** aaPanel and other installs keep the client outside the default PATH of a non-login shell. */
const PATH_SETUP = 'PATH="$PATH:/usr/local/bin:/usr/local/mysql/bin:/www/server/mysql/bin"; export PATH';

export class RemoteToolsMissingError extends Error {}

/** A value for a MySQL option file: quoted, with backslash escapes. */
export function optionFileValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

interface Prepared {
  dir: string;
  /** Tool name → its `--version` line, for the tools found */
  tools: Map<string, string>;
}

/** Make the private temp dir and see which tools exist (one round trip). */
async function prepare(ssh: SshExec, wanted: string[]): Promise<Prepared> {
  const script = [
    'umask 077',
    PATH_SETUP,
    'd=$(mktemp -d "${TMPDIR:-/tmp}/dbbackup.XXXXXXXX") || exit 97',
    'echo "DIR=$d"',
    `for t in ${wanted.map(shellQuote).join(' ')}; do`,
    '  if command -v "$t" >/dev/null 2>&1; then printf "HAVE=%s\\t%s\\n" "$t" "$("$t" --version 2>&1 | head -n 1)"; fi',
    'done',
  ].join('\n');
  const res = await ssh.run(script);
  if (res.code !== 0) {
    throw new Error(`Could not prepare a temp directory on the SSH server (${ssh.target}): ${(res.stderr || res.stdout).trim().slice(0, 300) || `exit ${res.code}`}`);
  }
  const dir = /^DIR=(.+)$/m.exec(res.stdout)?.[1]?.trim();
  if (!dir || !dir.startsWith('/')) throw new Error(`Unexpected reply from the SSH server: ${res.stdout.slice(0, 200)}`);
  const tools = new Map<string, string>();
  for (const m of res.stdout.matchAll(/^HAVE=([^\t\n]+)\t(.*)$/gm)) tools.set(m[1], m[2]);
  return { dir, tools };
}

async function removeDir(ssh: SshExec, dir: string): Promise<void> {
  await ssh.run(`rm -rf -- ${shellQuote(dir)}`).catch(() => undefined);
}

function missing(ssh: SshExec, what: 'mysql' | 'gzip', tool: string): RemoteToolsMissingError {
  const install = what === 'gzip'
    ? 'Install gzip there (for example: sudo apt install gzip)'
    : 'Install the MySQL client there (for example: sudo apt install mysql-client, or sudo dnf install mariadb105)';
  return new RemoteToolsMissingError(
    `${tool} is not installed on the SSH server (${ssh.target}). ${install}, or run this on the DbBackup server instead.`,
  );
}

function failure(what: string, res: { code: number | null; stderr: string }, partlyRestored = false): Error {
  if (res.code === null) {
    return new Error(
      `${what} stopped: the SSH connection was lost before it finished` +
      (partlyRestored ? '. The database may be only partly restored.' : '.'),
    );
  }
  return new Error(`${what} failed (exit ${res.code}): ${cleanStderr(res.stderr) || 'no error output'}`);
}

/** Write the option file and any TLS files; returns the connection arguments for the tools. */
async function writeClientFiles(ssh: SshExec, config: ConnectionConfig, dir: string, flavor: 'mariadb' | 'mysql'): Promise<string[]> {
  const files = new Map<string, string>();
  files.set('client.cnf', [
    '[client]',
    `user=${optionFileValue(config.username)}`,
    ...(config.password ? [`password=${optionFileValue(config.password)}`] : []),
    '',
  ].join('\n'));
  // The tools connect straight to the database from the SSH server: not tunnelled
  const tls = mysqlTlsArgsFor(config, flavor, false, (name, content) => {
    files.set(name, content.endsWith('\n') ? content : `${content}\n`);
    return `${dir}/${name}`;
  });
  for (const [name, content] of files) {
    const res = await ssh.run(`umask 077 && cat > ${shellQuote(`${dir}/${name}`)}`, { stdin: content });
    if (res.code !== 0) throw new Error(`Could not write ${name} on the SSH server: ${res.stderr.trim().slice(0, 200)}`);
  }
  return [
    // --defaults-extra-file must come first
    `--defaults-extra-file=${dir}/client.cnf`,
    `--host=${config.host}`,
    `--port=${config.port}`,
    ...tls,
  ];
}

function cleanStderr(stderr: string): string {
  return stderr.split('\n').filter((l) => l.trim() && !/warning/i.test(l)).join('\n').trim().slice(0, 1000);
}

/**
 * Dump on the SSH server, gzip there, and write the result to `filePath`.
 * `gzipOutput` false (plain .sql) decompresses here as it arrives.
 */
export async function remoteMysqlBackup(
  config: ConnectionConfig,
  filePath: string,
  gzipOutput: boolean,
): Promise<void> {
  const ssh = new SshExec(config);
  await ssh.connect();
  let dir: string | null = null;
  try {
    const preferred = config.type === 'MARIADB' ? ['mariadb-dump', 'mysqldump'] : ['mysqldump', 'mariadb-dump'];
    const prep = await prepare(ssh, [...preferred, 'gzip']);
    dir = prep.dir;
    const bin = preferred.find((t) => prep.tools.has(t));
    if (!bin) throw missing(ssh, 'mysql', 'mysqldump');
    if (!prep.tools.has('gzip')) throw missing(ssh, 'gzip', 'gzip');
    const flavor = mysqlFlavorFromVersion(prep.tools.get(bin)!);
    logger.info(`Backup runs on the SSH server ${ssh.target}: ${prep.tools.get(bin)}`);

    const conn = await writeClientFiles(ssh, config, dir, flavor);
    const dumpArgs = [
      ...conn,
      '--single-transaction',
      '--routines',
      '--triggers',
      '--events',
      '--set-charset',
      '--add-drop-table',
      '--',
      config.database,
    ];
    const d = shellQuote(dir);
    const script = [
      PATH_SETUP,
      `d=${d}`,
      `trap 'rm -rf -- "$d"' EXIT HUP INT TERM`,
      // The dump's own exit code is kept in a file: a pipeline only reports gzip's
      `( ${[bin, ...dumpArgs].map(shellQuote).join(' ')}; echo $? > "$d/rc" ) | gzip -c`,
      'g=$?; r=$(cat "$d/rc" 2>/dev/null || echo 255)',
      '[ "$r" = 0 ] || exit "$r"',
      'exit "$g"',
    ].join('\n');

    const file = createWriteStream(filePath);
    const sink: Writable = gzipOutput ? file : (() => { const gunzip = createGunzip(); gunzip.pipe(file); return gunzip; })();
    const done = gzipOutput ? null : new Promise<void>((res, rej) => { file.on('finish', res); file.on('error', rej); });
    const res = await ssh.run(script, { stdout: sink });
    await done;
    dir = null; // the trap removed it
    if (res.code !== 0) throw failure(`${bin} on the SSH server`, res);
  } finally {
    if (dir) await removeDir(ssh, dir);
    ssh.close();
  }
}

/**
 * Stream the backup file (compressed on the way if it isn't already) into
 * gzip -d | mysql on the SSH server. `onBytes` = bytes of the file read here.
 */
export async function remoteMysqlRestore(
  config: ConnectionConfig,
  backupFilePath: string,
  dbName: string,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  const ssh = new SshExec(config);
  await ssh.connect();
  let dir: string | null = null;
  try {
    const preferred = config.type === 'MARIADB' ? ['mariadb', 'mysql'] : ['mysql', 'mariadb'];
    const prep = await prepare(ssh, [...preferred, 'gzip']);
    dir = prep.dir;
    const bin = preferred.find((t) => prep.tools.has(t));
    if (!bin) throw missing(ssh, 'mysql', 'The mysql client');
    if (!prep.tools.has('gzip')) throw missing(ssh, 'gzip', 'gzip');
    const version = prep.tools.get(bin)!;
    logger.info(`Restore runs on the SSH server ${ssh.target}: ${version}`);

    const conn = await writeClientFiles(ssh, config, dir, mysqlFlavorFromVersion(version));
    // The dump is only SQL to execute: client commands in it (\! shell, source, ...) are refused
    const args = [...conn, ...mysqlRestoreGuardArgsFor(version), '--', dbName];
    const d = shellQuote(dir);
    const script = [
      PATH_SETUP,
      `d=${d}`,
      `trap 'rm -rf -- "$d"' EXIT HUP INT TERM`,
      `( gzip -dc; echo $? > "$d/grc" ) | ${[bin, ...args].map(shellQuote).join(' ')}`,
      'm=$?; g=$(cat "$d/grc" 2>/dev/null || echo 255)',
      '[ "$m" = 0 ] || exit "$m"',
      '[ "$g" = 0 ] || { echo "the backup file could not be decompressed (gzip exit $g)" >&2; exit 90; }',
      'exit 0',
    ].join('\n');

    // The SSH channel opens a round trip later: the counter holds the data until
    // it is consumed (a 'data' listener here would start the flow and lose it)
    const file = createReadStream(backupFilePath);
    const counter = byteCounter(onBytes);
    file.on('error', (e) => counter.destroy(e));
    let stdin: Readable = file.pipe(counter);
    if (!backupFilePath.endsWith('.gz')) {
      // Plain .sql: compress on the way (gzip -1 is cheap) so less crosses the network
      const gz = createGzip({ level: 1 });
      counter.on('error', (e) => gz.destroy(e));
      stdin = counter.pipe(gz);
    }
    const res = await ssh.run(script, { stdin });
    dir = null;
    if (res.code !== 0) throw failure('MySQL restore on the SSH server', res, true);
  } finally {
    if (dir) await removeDir(ssh, dir);
    ssh.close();
  }
}
