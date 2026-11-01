import { Client as SSHClient } from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import { ConnectionConfig } from './engines/base.engine';
import { logger } from '../config/logger';
import { prisma } from '../config/database';
import { sanitizeForLog } from '../utils/sanitize';

/** OpenSSH-style fingerprint of a raw host key blob: "SHA256:<base64 without padding>". */
export function sshFingerprint(hostKey: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
}

export class SshHostKeyMismatchError extends Error {
  constructor(public readonly expected: string, public readonly received: string, target: string) {
    super(
      `SSH host key for ${target} has changed (pinned ${expected}, server sent ${received}). ` +
      'The connection was refused because someone may be intercepting it. If the server was reinstalled ' +
      'or its key was rotated, confirm the new fingerprint with the server admin, then use ' +
      '"Forget SSH host key" in the connection settings.',
    );
    this.name = 'SshHostKeyMismatchError';
  }
}

/**
 * Trust-on-first-use host key check. The first successful connect pins the
 * key on the connection; every later connect must present the same key.
 * The pin is always read from the database, so jobs queued before the first
 * connect (or before a reset) still see the current value.
 */
async function verifyHostKey(config: ConnectionConfig, received: string): Promise<void> {
  const target = `${config.sshHost}:${config.sshPort || 22}`;
  if (!config.connectionId) {
    logger.warn(`SSH host key for ${sanitizeForLog(target)} not pinned (no saved connection): ${received}`);
    return;
  }
  const row = await prisma.connection.findUnique({ where: { id: config.connectionId }, select: { sshHostKey: true } });
  if (!row) throw new Error('Connection not found while checking the SSH host key');
  if (row.sshHostKey) {
    if (row.sshHostKey !== received) throw new SshHostKeyMismatchError(row.sshHostKey, received, target);
    return;
  }
  // First connect: pin it. The conditional update makes concurrent first connects agree on one key.
  const pinned = await prisma.connection.updateMany({
    where: { id: config.connectionId, sshHostKey: null },
    data: { sshHostKey: received },
  });
  if (pinned.count === 1) {
    logger.info(`Pinned SSH host key for ${sanitizeForLog(target)}: ${received}`);
    return;
  }
  const again = await prisma.connection.findUnique({ where: { id: config.connectionId }, select: { sshHostKey: true } });
  if (again?.sshHostKey && again.sshHostKey !== received) throw new SshHostKeyMismatchError(again.sshHostKey, received, target);
}

export class SSHTunnel {
  private client: SSHClient;
  private server: net.Server | null = null;
  private localPort: number = 0;
  private config: ConnectionConfig;
  private sockets = new Set<net.Socket>();

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.client = new SSHClient();
  }

  private resolvePrivateKey(): Buffer | string | undefined {
    if (this.config.sshPrivateKey) {
      return this.config.sshPrivateKey;
    }
    const keyPath = (this.config as { sshPrivateKeyPath?: string }).sshPrivateKeyPath;
    if (!keyPath) return undefined;
    if (!fs.existsSync(keyPath)) {
      throw new Error(`SSH private key file not found on server: ${keyPath}`);
    }
    return fs.readFileSync(keyPath);
  }

  async connect(): Promise<number> {
    // Capture the real DB target BEFORE rewriting config below: the
    // forwardOut callback resolves its host/port lazily (per incoming
    // socket), which happens after config was rewritten to 127.0.0.1,
    // making the tunnel loop back to the SSH server instead of the DB.
    // The same config object is reused across operations (a restore drill opens
    // four tunnels on one engine), so remember the real target the first time.
    this.config.sshTarget = this.config.sshTarget ?? { host: this.config.host, port: this.config.port };
    const targetHost = this.config.sshTarget.host;
    const targetPort = this.config.sshTarget.port;

    // Set when the host key check rejects the server, so that error (not ssh2's generic one) is reported
    let hostKeyError: Error | null = null;

    return new Promise((resolve, reject) => {
      this.client
        .on('ready', () => {
          logger.debug(`SSH tunnel connected to ${this.config.sshHost}`);

          this.server = net.createServer((sock) => {
            this.sockets.add(sock);
            sock.on('close', () => this.sockets.delete(sock));

            this.client.forwardOut(
              sock.remoteAddress || '127.0.0.1',
              sock.remotePort || 0,
              targetHost,
              targetPort,
              (err, stream) => {
                if (err) {
                  logger.debug(`SSH forwardOut to ${targetHost}:${targetPort} failed: ${err.message}`);
                  sock.end();
                  return;
                }
                sock.pipe(stream).pipe(sock);
              }
            );
          });

          this.server!.listen(0, '127.0.0.1', () => {
            const address = this.server!.address() as net.AddressInfo;
            this.localPort = address.port;
            logger.debug(`SSH tunnel 127.0.0.1:${this.localPort} -> ${targetHost}:${targetPort}`);

            // Rewrite config so consumers that read config.host/port directly
            // (e.g. export.service) target the tunnel. Engine paths use
            // sshEnabled + _localPort instead. TLS still checks the real host.
            this.config.tlsHost = this.config.tlsHost ?? targetHost;
            this.config.host = '127.0.0.1';
            this.config.port = this.localPort;

            resolve(this.localPort);
          });
        })
        .on('error', (err) => reject(hostKeyError ?? err))
        .connect({
          host: this.config.sshHost!,
          port: this.config.sshPort || 22,
          username: this.config.sshUsername!,
          // Prefer an explicitly stored key; otherwise read the referenced
          // server-side key file at use time (key material never in the DB).
          privateKey: this.resolvePrivateKey(),
          passphrase: this.config.sshPassphrase ?? undefined,
          // Raw host key blob (no hostHash) → checked against the pinned fingerprint
          hostVerifier: (hostKey: Buffer, verify: (valid: boolean) => void) => {
            verifyHostKey(this.config, sshFingerprint(hostKey)).then(
              () => verify(true),
              (err: Error) => { hostKeyError = err; verify(false); },
            );
          },
        });
    });
  }

  getLocalPort(): number {
    return this.localPort;
  }

  close(): void {
    // server.close() alone waits for open sockets; destroy them so
    // repeated test/info calls don't leak connections
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    this.server?.close();
    this.client.end();
  }
}
