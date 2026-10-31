import { Client as SSHClient } from 'ssh2';
import fs from 'fs';
import net from 'net';
import { ConnectionConfig } from './engines/base.engine';
import { logger } from '../config/logger';

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
    const targetHost = this.config.host;
    const targetPort = this.config.port;

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
            // sshEnabled + _localPort instead.
            this.config.host = '127.0.0.1';
            this.config.port = this.localPort;

            resolve(this.localPort);
          });
        })
        .on('error', reject)
        .connect({
          host: this.config.sshHost!,
          port: this.config.sshPort || 22,
          username: this.config.sshUsername!,
          // Prefer an explicitly stored key; otherwise read the referenced
          // server-side key file at use time (key material never in the DB).
          privateKey: this.resolvePrivateKey(),
          passphrase: this.config.sshPassphrase ?? undefined,
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
