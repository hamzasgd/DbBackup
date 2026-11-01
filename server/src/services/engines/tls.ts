import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { spawnSync } from 'child_process';
import { ConnectionConfig } from './base.engine';
import { logger } from '../../config/logger';

/**
 * TLS settings for database connections, shared by every code path.
 *
 * Meaning of the connection's SSL settings:
 *   - SSL off            → driver/CLI defaults (unchanged behaviour)
 *   - SSL on, no CA      → encryption REQUIRED, server certificate NOT verified
 *                          (same as before for the Node drivers; the CLI tools
 *                          used for backup/restore previously ignored SSL entirely)
 *   - SSL on, CA given   → encryption required AND the server certificate is
 *                          verified against the CA, including the host name
 *   - client cert + key  → sent for mutual TLS in every mode
 */

/** Host name the certificate must match: the real DB host, even when traffic goes through an SSH tunnel. */
function tlsHost(config: ConnectionConfig): string {
  return config.tlsHost ?? config.host;
}

const warned = new Set<string>();
function warnUnverified(config: ConnectionConfig): void {
  const key = config.connectionId ?? `${config.host}:${config.port}`;
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(
    `SSL is enabled for connection ${config.connectionId ?? '(unsaved)'} without a CA certificate: ` +
    'traffic is encrypted but the server certificate is not verified. Add the CA certificate to verify it.',
  );
}

/** True when SSL is on but nothing verifies the server certificate. */
export function isTlsUnverified(config: ConnectionConfig): boolean {
  return !!config.sslEnabled && !config.sslCa;
}

export interface DriverTlsOptions {
  rejectUnauthorized: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  /** pg only (passed through to tls.connect) */
  servername?: string;
  checkServerIdentity?: (hostname: string, cert: tls.PeerCertificate) => Error | undefined;
  /** mysql2 only: check the host name against the certificate */
  verifyIdentity?: boolean;
}

/**
 * `ssl` option for the Node drivers. `driver` matters because mysql2 ignores
 * checkServerIdentity and checks the host name only through `verifyIdentity`.
 */
export function nodeTlsOptions(config: ConnectionConfig, driver: 'pg' | 'mysql2' = 'pg'): DriverTlsOptions | undefined {
  if (!config.sslEnabled) return undefined;
  const clientCert = config.sslCert && config.sslKey ? { cert: config.sslCert, key: config.sslKey } : {};
  if (!config.sslCa) {
    warnUnverified(config);
    return { rejectUnauthorized: false, ...clientCert };
  }
  const host = tlsHost(config);
  if (driver === 'mysql2') {
    // mysql2 checks the name against the host it connects to, and only for host NAMES (for an IP
    // address it can verify the chain only). Through a tunnel the host is 127.0.0.1, so the chain
    // is verified there and the tunnel itself is verified by its pinned host key.
    const tunnelled = !!config.sshEnabled || host !== config.host;
    return { rejectUnauthorized: true, ca: config.sslCa, ...clientCert, verifyIdentity: !tunnelled && !net.isIP(host) };
  }
  return {
    rejectUnauthorized: true,
    ca: config.sslCa,
    ...clientCert,
    ...(net.isIP(host) ? {} : { servername: host }),
    // Check the certificate against the real DB host, not 127.0.0.1 of an SSH tunnel
    checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(host, cert),
  };
}

/** Private temp directory for certificate files handed to CLI tools; remove it with cleanup(). */
export class TlsFiles {
  private dir: string | null = null;

  write(name: string, content: string): string {
    if (!this.dir) this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbk-tls-'));
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
    return file;
  }

  cleanup(): void {
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }
}

/**
 * libpq settings for psql / pg_dump / pg_restore.
 * `connectHost` is where the tool actually connects (127.0.0.1 for an SSH tunnel).
 * Returns the -h value to pass plus extra environment variables.
 */
export function pgCliTls(
  config: ConnectionConfig,
  connectHost: string,
  files: TlsFiles,
): { host: string; env: NodeJS.ProcessEnv } {
  if (!config.sslEnabled) return { host: connectHost, env: {} };
  const env: NodeJS.ProcessEnv = {};
  if (config.sslCert && config.sslKey) {
    env.PGSSLCERT = files.write('client.crt', config.sslCert);
    env.PGSSLKEY = files.write('client.key', config.sslKey);
  }
  if (!config.sslCa) {
    warnUnverified(config);
    env.PGSSLMODE = 'require';
    return { host: connectHost, env };
  }
  env.PGSSLMODE = 'verify-full';
  env.PGSSLROOTCERT = files.write('ca.crt', config.sslCa);
  const host = tlsHost(config);
  if (host !== connectHost && net.isIP(connectHost)) {
    // libpq verifies against -h but connects to PGHOSTADDR: full verification through the tunnel
    env.PGHOSTADDR = connectHost;
    return { host, env };
  }
  return { host: connectHost, env };
}

const mysqlFlavorCache = new Map<string, 'mariadb' | 'mysql'>();

/** The `mysql` binary on many systems (e.g. Alpine's mysql-client) is really the MariaDB client; their TLS flags differ. */
export function mysqlClientFlavor(bin: string): 'mariadb' | 'mysql' {
  const cached = mysqlFlavorCache.get(bin);
  if (cached) return cached;
  const out = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  const flavor = /mariadb/i.test(`${out.stdout ?? ''}${out.stderr ?? ''}`) ? 'mariadb' : 'mysql';
  mysqlFlavorCache.set(bin, flavor);
  return flavor;
}

/** TLS flags for mysql / mysqldump / mariadb-dump. `tunnelled` = connecting through an SSH tunnel. */
export function mysqlCliTlsArgs(config: ConnectionConfig, bin: string, tunnelled: boolean, files: TlsFiles): string[] {
  if (!config.sslEnabled) return [];
  const flavor = mysqlClientFlavor(bin);
  const args: string[] = [];
  if (config.sslCert && config.sslKey) {
    args.push(`--ssl-cert=${files.write('client.crt', config.sslCert)}`, `--ssl-key=${files.write('client.key', config.sslKey)}`);
  }
  if (!config.sslCa) {
    warnUnverified(config);
    return flavor === 'mariadb'
      ? ['--ssl', '--skip-ssl-verify-server-cert', ...args]
      : ['--ssl-mode=REQUIRED', ...args];
  }
  const ca = `--ssl-ca=${files.write('ca.crt', config.sslCa)}`;
  if (flavor === 'mysql') {
    // VERIFY_IDENTITY checks the host name; through a tunnel that would be 127.0.0.1, so verify the chain only
    return [`--ssl-mode=${tunnelled ? 'VERIFY_CA' : 'VERIFY_IDENTITY'}`, ca, ...args];
  }
  if (tunnelled) {
    // The MariaDB client can only verify chain + host name together, and the host is 127.0.0.1 here.
    logger.warn(
      `Connection ${config.connectionId ?? '(unsaved)'}: the MariaDB client cannot verify the server certificate ` +
      'through an SSH tunnel; the CA is used but host name verification is skipped (the tunnel itself is verified by its host key).',
    );
    return ['--ssl', ca, '--skip-ssl-verify-server-cert', ...args];
  }
  return ['--ssl', ca, '--ssl-verify-server-cert', ...args];
}

/** TLS flags for mongodump / mongorestore. */
export function mongoCliTlsArgs(config: ConnectionConfig, files: TlsFiles): string[] {
  if (!config.sslEnabled) return [];
  const args = ['--ssl'];
  if (config.sslCa) args.push(`--sslCAFile=${files.write('ca.crt', config.sslCa)}`);
  if (config.sslCert && config.sslKey) {
    args.push(`--sslPEMKeyFile=${files.write('client.pem', `${config.sslCert.trim()}\n${config.sslKey.trim()}\n`)}`);
  }
  return args;
}
