import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../config/logger';

const execFileAsync = promisify(execFile);

export interface VerificationResult {
  valid: boolean;
  checksum: string;
  error?: string;
}

/** Compute SHA-256 of a file using streams (non-blocking for large files) */
async function computeChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Verify a .sql.gz file is a valid gzip archive */
async function verifyGzip(filePath: string): Promise<void> {
  await execFileAsync('gunzip', ['-t', filePath]);
}

/** Check a plain .sql file has a mysqldump/pg_dump footer */
function verifySqlFile(filePath: string): void {
  const size = fs.statSync(filePath).size;
  if (size < 100) throw new Error('SQL file too small to be valid');
  // Read last 512 bytes to look for dump-completed markers
  const fd = fs.openSync(filePath, 'r');
  const tail = Buffer.alloc(512);
  fs.readSync(fd, tail, 0, 512, Math.max(0, size - 512));
  fs.closeSync(fd);
  const content = tail.toString('utf8');
  // mysqldump ends with "-- Dump completed", pg_dump ends with various markers
  const hasMarker =
    content.includes('Dump completed') ||
    content.includes('pg_dump') ||
    content.includes('PostgreSQL database dump complete') ||
    content.includes('SET search_path') ||
    content.includes('-- ');
  if (!hasMarker) throw new Error('SQL file missing expected dump footer');
}

/** Verify a PostgreSQL custom format (.dump) — pg_restore --list reads the TOC */
async function verifyPgCustom(filePath: string): Promise<void> {
  await execFileAsync('pg_restore', ['--list', filePath]);
}

/** Verify a PostgreSQL tar format (.tar) */
async function verifyPgTar(filePath: string): Promise<void> {
  await execFileAsync('pg_restore', ['--list', filePath]);
}

/** Verify a PostgreSQL directory format — check toc.dat exists and is readable */
function verifyPgDirectory(dirPath: string): void {
  const tocPath = path.join(dirPath, 'toc.dat');
  if (!fs.existsSync(tocPath)) throw new Error('Directory backup missing toc.dat');
  const stat = fs.statSync(tocPath);
  if (stat.size < 8) throw new Error('toc.dat appears empty or corrupt');
}

export async function verifyBackup(
  filePath: string,
  dbType: string,
  format: string,
): Promise<VerificationResult> {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, checksum: '', error: 'File not found on disk' };
    }

    // Compute checksum first (works for both files and directories)
    let checksum = '';
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      // For directories, hash the toc.dat file
      const tocPath = path.join(filePath, 'toc.dat');
      checksum = fs.existsSync(tocPath) ? await computeChecksum(tocPath) : 'dir-no-toc';
    } else {
      checksum = await computeChecksum(filePath);
    }

    // Format-specific integrity check
    if (format === 'COMPRESSED_SQL') {
      await verifyGzip(filePath);
    } else if (format === 'PLAIN_SQL') {
      verifySqlFile(filePath);
    } else if (format === 'CUSTOM') {
      await verifyPgCustom(filePath);
    } else if (format === 'TAR') {
      await verifyPgTar(filePath);
    } else if (format === 'DIRECTORY') {
      verifyPgDirectory(filePath);
    }

    logger.info(`✅ Backup verified [${format}]: ${filePath}`);
    return { valid: true, checksum };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`⚠️  Backup verification failed: ${msg}`);
    return { valid: false, checksum: '', error: msg };
  }
}
