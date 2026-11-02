import { spawn } from 'child_process';
import { createWriteStream, rmSync } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';

/**
 * Run a dump command and stream its stdout into `filePath` (optionally gzipped).
 *
 * Resolves only when the file is fully written AND the command exited with 0.
 * Resolving on the file's 'finish' alone (as before) raced the exit code: a
 * dump that failed at once (wrong password, unreachable host) closed stdout
 * first, so the backup was marked successful with an empty file.
 */
export async function dumpToFile(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  filePath: string,
  gzip: boolean,
  isError: (stderrChunk: string) => boolean = () => true,
): Promise<void> {
  const proc = spawn(cmd, args, { env });
  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    const msg = d.toString();
    if (isError(msg)) stderr += msg;
  });

  const exited = new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed: ${stderr.trim() || (signal ? `killed by ${signal}` : `exit code ${code}`)}`));
    });
  });
  const written = gzip
    ? pipeline(proc.stdout, createGzip(), createWriteStream(filePath))
    : pipeline(proc.stdout, createWriteStream(filePath));

  // Report the dump's own error first: it explains why the file is short
  const [exitResult, writeResult] = await Promise.allSettled([exited, written]);
  if (exitResult.status === 'rejected' || writeResult.status === 'rejected') {
    // Don't leave a partial/empty artifact behind for a failed dump
    try { rmSync(filePath, { force: true }); } catch { /* best effort */ }
  }
  if (exitResult.status === 'rejected') throw exitResult.reason;
  if (writeResult.status === 'rejected') throw writeResult.reason;
}
