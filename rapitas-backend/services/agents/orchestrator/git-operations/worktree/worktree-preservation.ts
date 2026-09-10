import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Git failures reject: callers must preserve the directory on uncertainty. */
export async function isWorktreeContentPreserved(
  worktreePath: string,
  preservedSnapshotTag?: string,
): Promise<boolean> {
  const options = { cwd: worktreePath, encoding: 'utf8' as const, timeout: 60_000 };
  const { stdout: status } = await run(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    options,
  );
  if (!status.trim()) return true;
  if (!preservedSnapshotTag || !/^recovery\/task-\d+-\d+$/.test(preservedSnapshotTag)) return false;
  const { stdout: snapshot } = await run(
    'git',
    ['rev-parse', '--verify', `refs/tags/${preservedSnapshotTag}^{commit}`],
    options,
  );
  await run('git', ['diff', '--exit-code', snapshot.trim(), '--'], options);
  await run('git', ['diff', '--cached', '--exit-code', snapshot.trim(), '--'], options);
  const { stdout: untracked } = await run(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    options,
  );
  return !untracked.trim();
}
