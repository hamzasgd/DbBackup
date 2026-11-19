import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { outputSize, watchOutputSize } from './output-watcher';

describe('output-watcher', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ow-'));

  it('measures a file, a nested directory, and a missing path as 0', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a'), Buffer.alloc(100));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b'), Buffer.alloc(50));
    expect(outputSize(path.join(dir, 'a'))).toBe(100);
    expect(outputSize(dir)).toBe(150);
    expect(outputSize(path.join(dir, 'nope'))).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports growth while running and a final size on stop', async () => {
    const dir = tmp();
    const file = path.join(dir, 'dump.sql');
    const seen: number[] = [];
    const stop = watchOutputSize(file, (n) => seen.push(n), 20);

    fs.writeFileSync(file, Buffer.alloc(10));
    await new Promise((r) => setTimeout(r, 80));
    fs.appendFileSync(file, Buffer.alloc(30));
    stop();

    expect(seen).toContain(10);
    expect(seen[seen.length - 1]).toBe(40);
    // only changes are reported
    expect(new Set(seen).size).toBe(seen.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op without a callback', () => {
    const stop = watchOutputSize('/nonexistent', undefined);
    expect(() => stop()).not.toThrow();
  });
});
