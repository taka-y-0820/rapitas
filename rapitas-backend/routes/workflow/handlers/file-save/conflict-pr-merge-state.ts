/**
 * ConflictPrMergeState
 *
 * Tells the conflict-resolution completion path whether the PR the task was
 * filed for is still DIRTY on GitHub. Owns only that lookup; completing or
 * bouncing the task stays in verify-commit-pr.ts.
 *
 * Measured 2026-08-30: #762 「PR #534 の競合を解消」 recorded
 * conflict_resolution_completed while PR #534 was still CONFLICTING, and the
 * auto-merge watcher re-filed the identical task 20 minutes later. verify.md
 * alone is not evidence that a merge conflict is gone — GitHub is.
 */
import { prisma } from '../../../../config';
import { createLogger } from '../../../../config/logger';
import { readMergeState } from '../../../../services/workflow/auto-merge-checks';

const log = createLogger('routes:workflow:handlers:files');

/** GitHub answers UNKNOWN while it recomputes mergeability after a push; poll a little before giving up. */
export const UNKNOWN_STATE_RETRIES = 3;
export const UNKNOWN_STATE_RETRY_MS = 5_000;

export interface ConflictPrVerdict {
  /** True only when GitHub definitively reports the PR still has conflicts. */
  dirty: boolean;
  /** Last mergeStateStatus observed, or null when gh could not answer. */
  state: string | null;
}

/**
 * Whether the PR behind a conflict-resolution task still has merge conflicts.
 *
 * An unavailable or UNKNOWN state is not proof of conflict resolution.
 * Callers must inspect state as well as dirty and hold completion if unknown.
 *
 * @param taskId - Task whose theme supplies the git working directory. / 作業ディレクトリを引くタスク
 * @param prNumber - PR number (Task.githubPrId holds the number itself). / PR番号
 * @param opts.read - readMergeState override for tests. / テスト用差し替え
 * @param opts.sleep - Delay override for tests. / テスト用差し替え
 * @returns Dirty flag plus the last observed state. / 競合有無と最終状態
 */
export async function readConflictPrVerdict(
  taskId: number,
  prNumber: number,
  opts: {
    read?: (cwd: string, prNumber: number) => Promise<string | null>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ConflictPrVerdict> {
  const read = opts.read ?? readMergeState;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const task = await prisma.task
    .findUnique({
      where: { id: taskId },
      select: { theme: { select: { workingDirectory: true } } },
    })
    .catch(() => null);
  const cwd = task?.theme?.workingDirectory ?? process.cwd();
  let state: string | null = null;
  for (let attempt = 0; attempt <= UNKNOWN_STATE_RETRIES; attempt++) {
    state = await read(cwd, prNumber);
    if (state !== 'UNKNOWN') break;
    if (attempt < UNKNOWN_STATE_RETRIES) await sleep(UNKNOWN_STATE_RETRY_MS);
  }
  if (state === null) {
    log.warn(
      { taskId, prNumber },
      '[Workflow] Could not read merge state for the conflict PR — completion requires a conclusive PR state',
    );
  }
  return { dirty: state === 'DIRTY', state };
}
