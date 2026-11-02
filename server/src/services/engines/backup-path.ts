import path from 'path';

/**
 * Build the on-disk path for a new backup artifact.
 *
 * The database name comes from the connection and is not restricted to file-name
 * characters, so it is reduced to a safe slug before it becomes part of the file
 * name. The resolved path must stay directly inside the backup directory; a name
 * like "/../../server/dist/x" used to write outside it.
 */
export function buildBackupPath(
  outputDir: string,
  prefix: string,
  database: string,
  timestamp: string,
  ext: string,
): { fileName: string; filePath: string } {
  const slug = String(database ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^[.-]+/, '_')
    .slice(0, 64) || 'db';
  const fileName = `${prefix}_${slug}_${timestamp}${ext}`;
  const root = path.resolve(outputDir);
  const filePath = path.resolve(root, fileName);
  if (path.dirname(filePath) !== root) {
    throw new Error('Refusing to write a backup outside the backup storage directory');
  }
  return { fileName, filePath };
}
