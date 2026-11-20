import { AppError } from '../middleware/errorHandler';

/**
 * Write protection, like termination protection on a cloud database: a
 * connection marked writeProtected is never written to by DbBackup. Reading
 * (backups, Compare, being a source) stays allowed. Checked on the server at
 * every write path, and again by the workers right before they write, so a
 * job queued before protection was turned on still can't write.
 */
export function assertWritable(
  conn: { name: string; writeProtected?: boolean | null } | null | undefined,
  action: string,
): void {
  if (conn?.writeProtected) {
    throw new AppError(
      `"${conn.name}" is write-protected, so DbBackup won't ${action}. Turn off write protection in the connection's settings first if you really mean to.`,
      403,
      'WRITE_PROTECTED',
    );
  }
}
