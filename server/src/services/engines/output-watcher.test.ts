import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { outputSize, watchOutputSize, countStreamBytes, processReadPosition, watchProcessReads } from './output-watcher';

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

  it('counts the bytes a stream produces', async () => {
    const seen: number[] = [];
    const stream = Readable.from([Buffer.alloc(5), 'abc', Buffer.alloc(2)]);
    countStreamBytes(stream, (n) => seen.push(n));
    await new Promise((r) => stream.on('end', r));
    expect(seen).toEqual([5, 8, 10]);
  });

  it.runIf(process.platform === 'linux')('follows how far another process has read into a file', async () => {
    const dir = tmp();
    const file = path.join(dir, 'backup.dump');
    fs.writeFileSync(file, Buffer.alloc(10_000));
    // Reads 4 KB with read(2) (which moves the offset), then waits
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const fd = fs.openSync(process.argv[1], 'r');
      fs.readSync(fd, Buffer.alloc(4096), 0, 4096, null);
      process.stdout.write('ready');
      setTimeout(() => {}, 5000);
    `, file]);
    try {
      await new Promise((r) => child.stdout.once('data', r));
      expect(processReadPosition(child.pid!, file)).toBe(4096);
      expect(processReadPosition(child.pid!, path.join(dir, 'other'))).toBeNull();

      const seen: number[] = [];
      const stop = watchProcessReads(child.pid, file, (n) => seen.push(n), 10);
      await new Promise((r) => setTimeout(r, 60));
      stop();
      expect(seen).toEqual([4096]);
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(processReadPosition(999_999_999, file)).toBeNull();
  });
});
