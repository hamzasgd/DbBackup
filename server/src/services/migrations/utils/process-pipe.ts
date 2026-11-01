import { spawn } from 'child_process';

export interface PipeSide {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `dump | restore` and resolve only when BOTH processes exited with 0.
 * A failed dump must fail the step even if the restore side exited cleanly on
 * the truncated stream. Stderr lines containing "Warning" are not treated as
 * errors (mysql prints password/TLS warnings there).
 */
export function runPipe(dump: PipeSide, restore: PipeSide, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const d = spawn(dump.cmd, dump.args, { env: dump.env ?? process.env });
    const r = spawn(restore.cmd, restore.args, { env: restore.env ?? process.env });

    let dumpError = '';
    let restoreError = '';
    let dumpCode: number | null | undefined;
    let restoreCode: number | null | undefined;
    let settled = false;
    const fail = (err: Error) => { if (!settled) { settled = true; reject(err); } };

    d.stderr.on('data', (b) => { const m = b.toString(); if (!/warning/i.test(m)) dumpError += m; });
    r.stderr.on('data', (b) => { const m = b.toString(); if (!/warning/i.test(m)) restoreError += m; });

    // If the restore side dies early the dump gets EPIPE; report it through the exit codes
    r.stdin.on('error', () => undefined);
    d.stdout.pipe(r.stdin);

    const finish = () => {
      if (settled || dumpCode === undefined || restoreCode === undefined) return;
      if (dumpCode !== 0) return fail(new Error(`${label}: ${dump.cmd} failed: ${dumpError.trim() || `exit code ${dumpCode}`}`));
      if (restoreCode !== 0) return fail(new Error(`${label}: ${restore.cmd} failed: ${restoreError.trim() || dumpError.trim() || `exit code ${restoreCode}`}`));
      settled = true;
      resolve();
    };
    d.on('close', (code) => { dumpCode = code; finish(); });
    r.on('close', (code) => { restoreCode = code; finish(); });
    d.on('error', fail);
    r.on('error', fail);
  });
}
