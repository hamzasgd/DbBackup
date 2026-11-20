import { AppError } from '../middleware/errorHandler';
import { supportsSshServerStrategy, type ToolStrategy } from './engines/base.engine';

const DB_NAMES: Record<string, string> = {
  MYSQL: 'MySQL', MARIADB: 'MariaDB', POSTGRESQL: 'PostgreSQL', MONGODB: 'MongoDB', REDIS: 'Redis',
};

/**
 * Check a requested tool strategy against the connection it runs for.
 * TUNNEL (or nothing) is always fine; SSH_SERVER needs a connection that uses
 * SSH and an engine that supports it.
 */
export function resolveToolStrategy(
  requested: string | undefined | null,
  conn: { name: string; type: string; sshEnabled: boolean },
): ToolStrategy {
  if (!requested || requested === 'TUNNEL') return 'TUNNEL';
  if (requested !== 'SSH_SERVER') throw new AppError(`Unknown strategy "${requested}"`, 400, 'VALIDATION_ERROR');
  if (!conn.sshEnabled) {
    throw new AppError(`"${conn.name}" doesn't use SSH, so there is no SSH server to run the tools on.`, 400, 'STRATEGY_UNAVAILABLE');
  }
  if (!supportsSshServerStrategy(conn.type)) {
    throw new AppError(`Running the tools on the SSH server isn't available for ${DB_NAMES[conn.type] ?? conn.type} yet.`, 400, 'STRATEGY_UNAVAILABLE');
  }
  return 'SSH_SERVER';
}
