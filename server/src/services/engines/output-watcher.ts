import { statSync, readdirSync } from 'fs';
import path from 'path';

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
