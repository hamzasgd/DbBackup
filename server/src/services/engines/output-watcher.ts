import { statSync, readdirSync, readlinkSync, readFileSync, realpathSync } from 'fs';
import path from 'path';
import type { Readable } from 'stream';

/** Size on disk of a file, or of every file under a directory (pg_dump -Fd). */
export function outputSize(target: string): number {
  try {
    const st = statSync(target);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      total += outputSize(path.join(target, entry.name));
    }
    return total;
  } catch {
    return 0; // not created yet, or removed mid-scan
  }
}

/**
 * Poll the dump's output path and report its size while the dump runs, so a
 * long backup shows bytes growing instead of a frozen 0%. Polling the path
 * works for every engine and format (piped gzip, pg_dump -f, mongodump
 * --archive, redis-cli --rdb, directory dumps). Returns a stop function.
 */
export function watchOutputSize(
  target: string,
  onBytes: ((bytes: number) => void) | undefined,
  intervalMs = 1000,
): () => void {
  if (!onBytes) return () => undefined;
  let last = -1;
  const tick = () => {
    const size = outputSize(target);
    if (size !== last) {
      last = size;
      onBytes(size);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    tick();
  };
}

/** Report the running total of bytes a stream has produced (a restore reading its backup file). */
export function countStreamBytes(stream: Readable, onBytes: ((bytes: number) => void) | undefined): void {
  if (!onBytes) return;
  let total = 0;
  stream.on('data', (chunk: Buffer | string) => {
    total += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    onBytes(total);
  });
}

/**
 * How far process `pid` has read into `filePath`: the offset of its open file
 * descriptor, from /proc/<pid>/fdinfo. For tools that open the backup file
 * themselves (pg_restore, mongorestore). Linux only; null elsewhere or when
 * the process doesn't have the file open (yet).
 */
export function processReadPosition(pid: number, filePath: string): number | null {
  try {
    const want = realpathSync(filePath);
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let link: string;
      try { link = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (link !== want) continue;
      const m = /^pos:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'));
      if (m) return Number(m[1]);
    }
  } catch {
    // not Linux, or the process has exited
  }
  return null;
}

/** Poll processReadPosition and report it while it changes. Returns a stop function. */
export function watchProcessReads(
  pid: number | undefined,
  filePath: string,
  onBytes: ((bytes: number) => void) | undefined,
  intervalMs = 1000,
): () => void {
  if (!onBytes || !pid) return () => undefined;
  let last = -1;
  const timer = setInterval(() => {
    const pos = processReadPosition(pid, filePath);
    if (pos !== null && pos !== last) {
      last = pos;
      onBytes(pos);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
