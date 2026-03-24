import { ConnectionConfig } from '../../engines/base.engine';
import { SSHTunnel } from '../../ssh.service';

interface EngineHostPort {
  host: string;
  port: number;
  tunnel: SSHTunnel | null;
}

/**
 * Get host and port for a connection, optionally creating an SSH tunnel.
 */
export async function getEngineHostPort(config: ConnectionConfig): Promise<EngineHostPort> {
  let tunnel: SSHTunnel | null = null;
  let host = config.host;
  let port = config.port;

  if (config.sshEnabled) {
    tunnel = new SSHTunnel(config as any);
    port = await tunnel.connect();
    host = '127.0.0.1';
  }

  return { host, port, tunnel };
}
