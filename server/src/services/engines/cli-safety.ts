import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { logger } from '../../config/logger';

/**
 * Safety settings for the database CLI tools (mysql, mysqldump, mariadb-dump,
 * psql, pg_dump, pg_restore, mongodump, mongorestore, redis-cli).
 *
 * 1. Environment. The app's own environment holds its secrets (ENCRYPTION_KEY*,
 *    JWT secrets, DATABASE_URL, cloud, SMTP and messaging credentials). The
 *    tools need none of them, so they get only what they need to run plus the
 *    variables the caller sets (password, TLS settings).
 *
 * 2. Client commands. mysql and psql do more than send SQL to the server: they
 *    also run their own commands found in the input (`\!` / `system` runs a
 *    shell command, `source` / `\i` reads files, `tee` / `\o` writes files,
 *    `connect` / `\c` switches servers). A dump file swapped in storage, or a
 *    malicious source server in a migration (CVE-2025-8714, CVE-2026-18408),
 *    could use them to run code on this server, so every client that executes
 *    a dump (restore, migration) has them turned off.
 */

const PASS_THROUGH = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  // shared libraries and CA bundles of tools installed outside the system paths
  'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Windows: programs can't start or open sockets without these
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
]);

/**
 * Environment for a DB CLI tool: the variables above (and LC_*) from the app's
 * environment, plus `extra`. Entries of `extra` that are undefined or null are
 * left out.
 */
export function cliEnv(extra: Record<string, string | null | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase(); // Windows spells it "Path"
    if (value !== undefined && (PASS_THROUGH.has(upper) || upper.startsWith('LC_'))) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) env[name] = value;
  }
  return env;
}

const versionText = new Map<string, string>();

/** Output of `<bin> --version`, cached per binary ('' when it can't run). */
export function toolVersionText(bin: string): string {
  let text = versionText.get(bin);
  if (text === undefined) {
    const out = spawnSync(bin, ['--version'], { encoding: 'utf8', env: cliEnv(), timeout: 10_000 });
    text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
    versionText.set(bin, text);
  }
  return text;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

// ── mysql / mariadb

/**
 * MariaDB releases that have --sandbox but, in --binary-mode, reject the `\-`
 * (enable sandbox) line that mariadb-dump writes at the top of every dump.
 * Fixed in the next release of each series (MDEV-34203).
 */
const MARIADB_SANDBOX_WITHOUT_BINARY_MODE_FIX = new Set([
  '10.5.25', '10.6.18', '10.11.8', '11.0.6', '11.1.5', '11.2.4', '11.4.2', '11.5.1',
]);

/**
 * Options for a mysql / mariadb client that executes a dump.
 *
 * --binary-mode turns off every client command except `delimiter` and `\C`
 * for piped input, in MySQL and in MariaDB (which also accepts the harmless
 * `\-` line of mariadb-dump). The MariaDB releases listed above would fail on
 * that line, so they get --sandbox, which blocks the commands that reach the
 * shell or the file system.
 */
export function mysqlRestoreGuardArgs(bin: string): string[] {
  const m = /(\d+\.\d+\.\d+)-MariaDB/i.exec(toolVersionText(bin));
  if (m && MARIADB_SANDBOX_WITHOUT_BINARY_MODE_FIX.has(m[1])) return ['--sandbox'];
  return ['--binary-mode'];
}

// ── psql

/** First minor release of each major with psql \restrict (CVE-2025-8714). Every 18.x has it. */
const PG_RESTRICT_SINCE: Record<number, number> = { 13: 22, 14: 19, 15: 14, 16: 10, 17: 6 };
/** ...and where \unrestrict no longer expands its argument (CVE-2026-18408). Every 19+ has it. */
const PG_UNRESTRICT_FIXED_SINCE: Record<number, number> = { 14: 24, 15: 19, 16: 15, 17: 11, 18: 6 };
const PG_CLIENT_ADVICE = 'Upgrade the PostgreSQL client tools to 18.6, 17.11, 16.15, 15.19, 14.24 or later.';

function pgVersion(bin: string): { major: number; minor: number; text: string } | null {
  const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(toolVersionText(bin));
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0), text: m[2] ? `${m[1]}.${m[2]}` : m[1] } : null;
}

function pgAtLeast(v: { major: number; minor: number } | null, since: Record<number, number>, everyFrom: number): boolean {
  if (!v) return false;
  if (v.major >= everyFrom) return true;
  const first = since[v.major];
  return first !== undefined && v.minor >= first;
}

/**
 * Line to send to psql before the SQL of a plain-format dump:
 * `\restrict <random key>`. In restricted mode psql still runs every SQL
 * statement but refuses all backslash commands except `\unrestrict <key>`,
 * and the dump can't know the key. Returns '' (with a one-time warning)
 * when psql is too old to have \restrict; the restore still works then.
 *
 * Pass `dumpBin` for a live `pg_dump | psql` pipe: pg_dump releases with
 * \restrict start their output with their own random key already, and a
 * second \restrict would be an error under ON_ERROR_STOP, so no line is
 * added in that case.
 */
export function psqlRestrictLine(psqlBin = 'psql', dumpBin?: string): string {
  const psql = pgVersion(psqlBin);
  if (!pgAtLeast(psql, PG_RESTRICT_SINCE, 18)) {
    warnOnce(`restrict:${psqlBin}`,
      `${psqlBin} ${psql?.text ?? '(unknown version)'} has no \\restrict, so plain-SQL restores and PostgreSQL migrations ` +
      `can run psql commands embedded in the SQL (for example \\! shell commands). ${PG_CLIENT_ADVICE}`);
    return '';
  }
  if (!pgAtLeast(psql, PG_UNRESTRICT_FIXED_SINCE, 19)) {
    warnOnce(`unrestrict:${psqlBin}`,
      `${psqlBin} ${psql!.text} is affected by CVE-2026-18408 (\\unrestrict expands its argument), so \\restrict ` +
      `only partly protects plain-SQL restores and PostgreSQL migrations. ${PG_CLIENT_ADVICE}`);
  }
  if (dumpBin && pgAtLeast(pgVersion(dumpBin), PG_RESTRICT_SINCE, 18)) return '';
  // Hex is alphanumeric, which is all \restrict accepts
  return `\\restrict ${crypto.randomBytes(24).toString('hex')}\n`;
}
