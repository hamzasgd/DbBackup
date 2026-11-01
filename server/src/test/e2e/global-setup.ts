import { execFileSync } from 'child_process';
import path from 'path';

/**
 * Apply the Prisma migrations to the E2E app database (used by the SSH host-key,
 * refresh-token and health suites). Skipped when E2E_APP_DATABASE_URL is unset.
 */
export default function setup(): void {
  const url = process.env.E2E_APP_DATABASE_URL;
  if (!url) return;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
