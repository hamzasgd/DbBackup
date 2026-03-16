import { Client as SSHClient } from 'ssh2';
import net from 'net';
import { ConnectionConfig } from './engines/base.engine';
import { logger } from '../config/logger';

export class SSHTunnel {
  private client: SSHClient;
  private server: net.Server | null = null;
  private localPort: number = 0;
  private config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.client = new SSHClient();
  }

  async connect(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.client
        .on('ready', () => {
          logger.debug(`SSH tunnel connected to ${this.config.sshHost}`);

          this.server = net.createServer((sock) => {
            this.client.forwardOut(
              sock.remoteAddress || '127.0.0.1',
              sock.remotePort || 0,
              this.config.host,
              this.config.port,
              (err, stream) => {
                if (err) {
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
            logger.debug(`SSH tunnel listening on port ${this.localPort}`);

            // Override config to use tunnel
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
          privateKey: this.config.sshPrivateKey,
          passphrase: this.config.sshPassphrase,
        });
    });
  }

  close(): void {
    this.server?.close();
    this.client.end();
  }
}
