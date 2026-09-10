/**
 * task-execution-lock
 *
 * Process-wide in-memory mutex that guarantees AT MOST ONE agent run per task
 * at a time. This is the single source of truth shared by BOTH the manual
 * execution routes (execute / continue) AND the workflow orchestrator
 * (advanceWorkflow), so a manual "run" and an auto-run phase can never spawn a
 * second agent for the same task concurrently.
 *
 * Locks auto-expire after a TTL to guard against leaked locks when a worker
 * crashes before the release path runs.
 */

import { createLogger } from '../../config/logger';
import { getWorkflowLockTtlMs } from './execution-timeouts';

const log = createLogger('task-execution-lock');

/** Tracks currently locked tasks with the time the lock was acquired. */
const taskExecutionLocks = new Map<number, { lockedAt: Date; expiresAt: number; owner: symbol }>();
const cancellationVersions = new Map<number, number>();

/** Survives normal lease release so deferred next-phase callbacks can observe a stop. */
export function getTaskExecutionCancellationVersion(taskId: number): number {
  return cancellationVersions.get(taskId) ?? 0;
}

/**
 * Lock TTL must OUTLIVE a phase so a long phase never has its lock stolen
 * mid-run (which would spawn a duplicate agent). Derived from the phase timeout
 * (see execution-timeouts) so the three timeouts stay consistent — previously a
 * 15-min lock paired with a 10-min phase, both of which a >10-min legitimate
 * phase blew past. Both the manual routes and the workflow path use this.
 */
export const DEFAULT_LOCK_TTL_MS = getWorkflowLockTtlMs();
export const WORKFLOW_LOCK_TTL_MS = getWorkflowLockTtlMs();

/**
 * Attempts to acquire an exclusive lock for a task execution.
 * Returns false if another execution is already in progress (and the lock is
 * not stale).
 *
 * @param taskId - The task ID to lock / ロック対象のタスクID
 * @param ttlMs - Lock time-to-live in ms / ロックの有効期限（ミリ秒）
 * @returns true if the lock was acquired, false if already locked / ロック取得成功可否
 */
export function acquireTaskExecutionLock(
  taskId: number,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
): boolean {
  const existing = taskExecutionLocks.get(taskId);
  if (existing) {
    if (Date.now() < existing.expiresAt) {
      return false;
    }
    log.warn(`[TaskExecutionLock] Stale lock released for task ${taskId}`);
  }
  taskExecutionLocks.set(taskId, {
    lockedAt: new Date(),
    expiresAt: Date.now() + ttlMs,
    owner: Symbol(),
  });
  return true;
}

/**
 * Releases the execution lock for a task.
 *
 * @param taskId - The task ID to unlock / アンロック対象のタスクID
 */
export function releaseTaskExecutionLock(taskId: number, owner?: symbol): void {
  if (owner === undefined) {
    cancellationVersions.set(taskId, getTaskExecutionCancellationVersion(taskId) + 1);
  }
  if (owner !== undefined && taskExecutionLocks.get(taskId)?.owner !== owner) return;
  if (taskExecutionLocks.delete(taskId)) {
    log.info(`[TaskExecutionLock] Lock released for task ${taskId}`);
  }
}

/** Capture the current lease identity; stopping or replacing it invalidates the identity. */
export function getTaskExecutionLockOwner(taskId: number): symbol | undefined {
  return isTaskExecutionLocked(taskId) ? taskExecutionLocks.get(taskId)?.owner : undefined;
}

/**
 * Reports whether a task currently holds a (non-stale) execution lock.
 *
 * @param taskId - The task ID to check / 確認対象のタスクID
 * @returns true when an execution is in progress for the task / 実行中かどうか
 */
export function isTaskExecutionLocked(taskId: number): boolean {
  const existing = taskExecutionLocks.get(taskId);
  if (!existing) return false;
  if (Date.now() >= existing.expiresAt) {
    taskExecutionLocks.delete(taskId);
    return false;
  }
  return true;
}
