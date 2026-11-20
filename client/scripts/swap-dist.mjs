// Put a finished build in place without the server ever serving a half-written one.
// `vite build` writes to dist-next; this swaps it in with two renames. Build files
// of recent previous versions are carried over: a page loaded just before the swap
// still finds its own (content-hashed) stylesheet and script.
import { existsSync, readdirSync, statSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const NEXT = 'dist-next';
const CUR = 'dist';
const OLD = 'dist-old';
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

if (!existsSync(join(NEXT, 'index.html'))) {
  console.error(`swap-dist: ${NEXT}/index.html is missing, the build did not finish; ${CUR} left unchanged`);
  process.exit(1);
}
const curAssets = join(CUR, 'assets');
if (existsSync(curAssets)) {
  for (const name of readdirSync(curAssets)) {
    const from = join(curAssets, name);
    const to = join(NEXT, 'assets', name);
    if (!existsSync(to) && Date.now() - statSync(from).mtimeMs < KEEP_MS) copyFileSync(from, to);
  }
}
rmSync(OLD, { recursive: true, force: true });
if (existsSync(CUR)) renameSync(CUR, OLD);
renameSync(NEXT, CUR);
rmSync(OLD, { recursive: true, force: true });
console.log(`swap-dist: new build is live in ${CUR}/`);
