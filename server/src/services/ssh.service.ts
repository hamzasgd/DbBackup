import { Client as SSHClient } from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
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

/** The connection's SSH private key: stored PEM, or a key file on this server (inside SSH_KEY_DIR when set). */
function resolveSshPrivateKey(config: ConnectionConfig): Buffer | string | undefined {
  if (config.sshPrivateKey) {
    return config.sshPrivateKey;
  }
  const keyPath = config.sshPrivateKeyPath;
  if (!keyPath) return undefined;

  // The path comes from the connection, so it must not let the server read
  // arbitrary files (e.g. /etc/shadow). When SSH_KEY_DIR is set, require the
  // key to live inside it; otherwise warn (single-owner deployments still work).
  const resolved = path.resolve(keyPath);
  const baseDir = process.env.SSH_KEY_DIR;
  if (baseDir) {
    const base = path.resolve(baseDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error('SSH private key path is outside the allowed SSH_KEY_DIR');
    }
  } else {
    logger.warn(`SSH key read from an unconstrained path: ${sanitizeForLog(resolved)}. Set SSH_KEY_DIR to restrict where key files may live.`);
  }

  if (!fs.existsSync(resolved)) {
    throw new Error('SSH private key file not found on server');
  }
  return fs.readFileSync(resolved);
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
    return resolveSshPrivateKey(this.config);
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

/** Quote a value for a POSIX shell: the result is always one literal word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SshRunOptions {
  /** Sent to the command's stdin, then EOF. Without it stdin is closed at once. */
  stdin?: Readable | string | Buffer;
  /** Receives the command's stdout (it is piped, with backpressure). Without it, stdout is collected. */
  stdout?: Writable;
  /** Called with each stderr chunk as it arrives. */
  onStderr?: (text: string) => void;
}

export interface SshRunResult {
  /** Exit code; null when the connection was lost before the command finished */
  code: number | null;
  signal: string | null;
  stdout: string;
  /** The last 64 KB of stderr */
  stderr: string;
}

const MAX_CAPTURE = 64 * 1024;

/**
 * An SSH session for running commands on the SSH server itself (the
 * "run the tools on the SSH server" strategy). Same authentication and
 * pinned host-key check as the tunnel.
 */
export class SshExec {
  private client: SSHClient | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  get target(): string {
    return `${this.config.sshUsername}@${this.config.sshHost}`;
  }

  async connect(): Promise<void> {
    if (!this.config.sshEnabled || !this.config.sshHost) {
      throw new Error('This connection has no SSH server to run the tools on');
    }
    const client = new SSHClient();
    let hostKeyError: Error | null = null;
    let settled = false;
    await new Promise<void>((resolve, reject) => {
      client
        .on('ready', () => { settled = true; resolve(); })
        // Kept for the whole session: a late error must never be unhandled
        .on('error', (err) => {
          if (!settled) { settled = true; reject(hostKeyError ?? err); }
          else logger.warn(`SSH session to ${sanitizeForLog(this.config.sshHost ?? '')} failed: ${err.message}`);
        })
        .connect({
          host: this.config.sshHost!,
          port: this.config.sshPort || 22,
          username: this.config.sshUsername!,
          privateKey: resolveSshPrivateKey(this.config),
          passphrase: this.config.sshPassphrase ?? undefined,
          readyTimeout: 30_000,
          // Long dumps and restores: keep idle-looking connections alive through NAT/firewalls
          keepaliveInterval: 30_000,
          keepaliveCountMax: 6,
          hostVerifier: (hostKey: Buffer, verify: (valid: boolean) => void) => {
            verifyHostKey(this.config, sshFingerprint(hostKey)).then(
              () => verify(true),
              (err: Error) => { hostKeyError = err; verify(false); },
            );
          },
        });
    });
    this.client = client;
  }

  /** Run `command` through the remote user's shell. Resolves when the command and its stdout are done. */
  run(command: string, opts: SshRunOptions = {}): Promise<SshRunResult> {
    const client = this.client;
    if (!client) return Promise.reject(new Error('SSH session is not connected'));
    return new Promise((resolve, reject) => {
      client.exec(command, (err, channel) => {
        if (err) { reject(err); return; }
        let code: number | null = null;
        let signal: string | null = null;
        let stdout = '';
        let stderr = '';
        let failure: Error | null = null;

        channel.on('exit', (c: number | null, s?: string) => { code = c ?? null; signal = s ?? null; });
        channel.stderr.on('data', (d: Buffer) => {
          const text = d.toString();
          stderr = (stderr + text).slice(-MAX_CAPTURE);
          opts.onStderr?.(text);
        });

        const output: Promise<void> = opts.stdout
          ? pipeline(channel, opts.stdout).catch((e: Error) => { failure = failure ?? e; })
          : new Promise<void>((done) => {
              channel.on('data', (d: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += d.toString(); });
              channel.on('close', () => done());
            });

        if (opts.stdin === undefined) {
          channel.end();
        } else if (typeof opts.stdin === 'string' || Buffer.isBuffer(opts.stdin)) {
          channel.end(opts.stdin);
        } else {
          const src = opts.stdin;
          src.on('error', (e) => { failure = failure ?? e; channel.close(); });
          // EPIPE-style errors when the remote command quits early: its exit code says why
          channel.on('error', () => undefined);
          src.pipe(channel);
        }

        const closed = new Promise<void>((done) => channel.on('close', () => done()));
        Promise.all([closed, output]).then(() => {
          if (failure) reject(failure);
          else resolve({ code, signal, stdout, stderr });
        });
      });
    });
  }

  close(): void {
    this.client?.end();
    this.client = null;
  }
}
