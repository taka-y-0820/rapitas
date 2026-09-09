import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Reject deleted worktrees whose remaining directory makes Git walk to the parent checkout. */
export async function isVerificationWorktreeRoot(workdir: string): Promise<boolean> {
  try {
    const expected = await realpath(workdir);
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], {
      cwd: expected,
      timeout: 5000,
      windowsHide: true,
    });
    const actual = await realpath(stdout.trim());
    const normalize = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
    return normalize(actual) === normalize(expected);
  } catch {
    return false;
  }
}
