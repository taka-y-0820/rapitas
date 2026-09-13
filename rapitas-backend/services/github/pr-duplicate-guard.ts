/**
 * pr-duplicate-guard
 *
 * Prevents creating a second PR for a task that already has one OPEN.
 * `createPullRequest`'s own idempotency check (services/agents/orchestrator/
 * git-operations/branch-pr-ops.ts) is branch-scoped (`gh pr list --head
 * <branch>`) — it correctly reuses a PR when the SAME branch is pushed again,
 * but is blind whenever a task gets re-executed on a DIFFERENT branch (e.g. a
 * recreated worktree, or a diverged push renamed to `<branch>-<sha>`): the
 * task's real open PR sits under the old branch name and is never found, so a
 * second PR gets created. This is the task-scoped backstop, checked BEFORE
 * `createPullRequest` is ever called.
 *
 * Constraint: at most one OPEN PR per task at a time (not "ever") — a task
 * whose PR was closed/merged may legitimately get a new PR on a later run.
 */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { createLogger } from '../../config/logger';
import { updateTaskPublicationMetadata } from './task-publication-metadata';

type PrismaClientInstance = InstanceType<typeof PrismaClient>;
const log = createLogger('github:pr-duplicate-guard');

/** A stale claim (crash mid-section) self-expires after this long. */
const PR_CREATION_LOCK_STALE_MS = 5 * 60 * 1000;

export interface ExistingOpenPr {
  prNumber: number;
  url: string;
}

/**
 * Returns the task's currently open PR according to the local record, if any.
 * Only meaningful to call while holding the task's PR-creation lock (see
 * {@link claimPrCreationLock}) — otherwise a concurrent request could create a
 * PR between this check and the caller's own `createPullRequest` call.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param taskId - Task to check / 対象タスク
 * @returns The open PR's number/url, or null if none is tracked. / オープンPR情報、無ければnull
 */
export async function findOpenPrForTask(
  prisma: PrismaClientInstance,
  taskId: number,
): Promise<ExistingOpenPr | null> {
  const row = await prisma.gitHubPullRequest
    .findFirst({
      where: { linkedTaskId: taskId, state: 'open' },
      orderBy: { createdAt: 'desc' },
      select: { prNumber: true, url: true },
    })
    .catch((err: unknown) => {
      log.warn({ err, taskId }, 'Failed to check for an existing open PR — proceeding to create');
      return null;
    });
  return row;
}

/**
 * Atomically claims the task's PR-creation lock via a compare-and-swap
 * update: only succeeds when the lock is unheld (null) or stale (older than
 * {@link PR_CREATION_LOCK_STALE_MS}, guarding against a crash that left it
 * set). Two concurrent callers racing this can never both succeed — the
 * `updateMany` WHERE clause is evaluated atomically by the database.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param taskId - Task to lock / 対象タスク
 * @returns True when this call claimed the lock. / 取得できたか
 */
export async function claimPrCreationLock(
  prisma: PrismaClientInstance,
  taskId: number,
): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - PR_CREATION_LOCK_STALE_MS);
  try {
    return await updateTaskPublicationMetadata(
      prisma,
      taskId,
      { prCreationLockedAt: new Date() },
      {
        OR: [{ prCreationLockedAt: null }, { prCreationLockedAt: { lt: staleThreshold } }],
      },
    );
  } catch (err) {
    log.warn({ err, taskId }, 'Failed to claim PR-creation lock — treating as not claimed');
    return false;
  }
}

/**
 * Releases the task's PR-creation lock. Call unconditionally in a `finally`
 * block after {@link claimPrCreationLock} returns true, regardless of whether
 * PR creation succeeded — a stuck lock would otherwise silently block every
 * future PR attempt for this task until the staleness timeout.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param taskId - Task to unlock / 対象タスク
 */
export async function releasePrCreationLock(
  prisma: PrismaClientInstance,
  taskId: number,
): Promise<void> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await updateTaskPublicationMetadata(prisma, taskId, { prCreationLockedAt: null })) return;
    }
    log.warn({ taskId }, 'PR-creation lock release lost its task revision race (will self-expire)');
  } catch (err) {
    log.warn({ err, taskId }, 'Failed to release PR-creation lock (will self-expire)');
  }
}
