import { decrypt, decryptIfPresent } from '../crypto.service';
import { ConnectionConfig } from './base.engine';

/** The columns of a `connections` row needed to build an engine config (values as stored, i.e. encrypted). */
export interface StoredConnection {
  id: string;
  type: string;
  host: string;
  port: number;
  username: string;
  password: string | null;
  database: string;
  sslEnabled: boolean;
  sslCa?: string | null;
  sslCert?: string | null;
  sslKey?: string | null;
  connectionTimeout?: number | null;
  sshEnabled: boolean;
  sshHost: string | null;
  sshPort: number | null;
  sshUsername: string | null;
  sshPrivateKey: string | null;
  sshPrivateKeyPath: string | null;
  sshPassphrase: string | null;
  sshHostKey?: string | null;
}

/**
 * Decrypt a stored connection into the config the engines use.
 *
 * Single place for this mapping: the copies it replaces each dropped some
 * fields (none passed the SSL CA / client certificate, so "verify with CA"
 * never reached a backup), and SSH host-key pinning needs the connection id.
 */
/**
 * Values below reach CLI tools (mysqldump, psql, mongodump, redis-cli) as argv.
 * The API schema already rejects a leading "-", but rows can also arrive via
 * bundle import or predate that check, so enforce it where every engine config
 * is built: a leading "-" would be parsed as an option (option injection).
 */
function assertCliSafe(label: string, value: string | undefined): void {
  if (value && (value.startsWith('-') || /[\r\n\0]/.test(value))) {
    throw new Error(`Connection ${label} is not allowed: it must not start with "-" or contain control characters`);
  }
}

export function toEngineConfig(conn: StoredConnection): ConnectionConfig {
  const config = buildConfig(conn);
  assertCliSafe('host', config.host);
  assertCliSafe('username', config.username);
  assertCliSafe('database', config.database);
  assertCliSafe('SSH host', config.sshHost);
  assertCliSafe('SSH username', config.sshUsername);
  return config;
}

function buildConfig(conn: StoredConnection): ConnectionConfig {
  return {
    connectionId: conn.id,
    type: conn.type as ConnectionConfig['type'],
    host: decrypt(conn.host),
    port: conn.port,
    username: decrypt(conn.username),
    password: conn.password ? decrypt(conn.password) : undefined,
    database: decrypt(conn.database),
    sslEnabled: conn.sslEnabled,
    sslCa: decryptIfPresent(conn.sslCa) || undefined,
    sslCert: decryptIfPresent(conn.sslCert) || undefined,
    sslKey: decryptIfPresent(conn.sslKey) || undefined,
    connectionTimeout: conn.connectionTimeout ?? undefined,
    sshEnabled: conn.sshEnabled,
    sshHost: decryptIfPresent(conn.sshHost) || undefined,
    sshPort: conn.sshPort || 22,
    sshUsername: decryptIfPresent(conn.sshUsername) || undefined,
    sshPrivateKey: decryptIfPresent(conn.sshPrivateKey) || undefined,
    sshPrivateKeyPath: conn.sshPrivateKeyPath ?? undefined,
    sshPassphrase: decryptIfPresent(conn.sshPassphrase) || undefined,
    sshHostKey: conn.sshHostKey ?? undefined,
  };
}
