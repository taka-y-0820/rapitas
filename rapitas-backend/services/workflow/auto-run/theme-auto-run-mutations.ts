/**
 * theme-auto-run-mutations
 *
 * State-transition writes for ThemeAutoRun records (start/pause/resume/stop/
 * finalizeStop and the per-task progress markers). Split out of
 * theme-auto-run-service.ts (task 784) to stay under the file-size ratchet;
 * theme-auto-run-service.ts re-exports this as a barrel. Not responsible for
 * reads — see theme-auto-run-queries.ts.
 */
import { prisma } from '../../../config';
import { createLogger } from '../../../config/logger';
import {
  mapToState,
  narrowAutoRunStatus,
  isAutoResumablePauseStatus,
  type IdleTimerColumns,
  type ThemeAutoRunState,
} from './theme-auto-run-types';

const log = createLogger('theme-auto-run-service');

/** Best-effort write of the idle-timer columns; failures are logged, never thrown. */
async function writeIdleTimerColumns(
  themeId: number,
  data: IdleTimerColumns,
  what: string,
): Promise<void> {
  try {
    await prisma.themeAutoRun.updateMany({
      where: { themeId },
      data: data as unknown as Parameters<typeof prisma.themeAutoRun.updateMany>[0]['data'],
    });
  } catch (err) {
    log.warn({ err, themeId, data }, `[ThemeAutoRunService] ${what} persist failed`);
  }
}

/**
 * Start auto-run for a theme (idle → running).
 * Creates the record if it does not exist.
 * No-op if already running.
 *
 * @param themeId - Theme to start / 開始するテーマID
 * @param order - Task selection order / タスク選択順序
 * @returns updated state / 更新後の状態
 */
export async function startAutoRun(
  themeId: number,
  order?: 'priority' | 'created',
): Promise<ThemeAutoRunState> {
  const existing = await prisma.themeAutoRun.findUnique({ where: { themeId } });

  if (existing?.status === 'running') {
    log.warn(`[ThemeAutoRunService] Theme ${themeId} is already running`);
    return mapToState(existing);
  }

  const updated = await prisma.themeAutoRun.upsert({
    where: { themeId },
    create: {
      themeId,
      enabled: true,
      status: 'running',
      order: order ?? 'priority',
      startedAt: new Date(),
    },
    update: {
      enabled: true,
      status: 'running',
      order: order ?? existing?.order ?? 'priority',
      startedAt: new Date(),
      lastError: null,
      // Keep processedCount to track total across restarts
    },
  });

  // NOTE (task 784): every enabled flip is logged explicitly (silent-flip
  // incident 2026-08-30) — a start always re-arms, so say so.
  log.info(
    { themeId, previousEnabled: existing?.enabled ?? null },
    `[ThemeAutoRunService] Started auto-run for theme ${themeId} (enabled=true)`,
  );
  // A start ends any idle-stop timer / idle-stop state (task 784, separate
  // best-effort write — these columns are pending client regeneration).
  await writeIdleTimerColumns(
    themeId,
    { idleSince: null, idleStoppedAt: null },
    'idle-timer clear',
  );
  return { ...mapToState(updated), idleSince: null, idleStoppedAt: null };
}

/**
 * Pause auto-run for a theme (running → paused_user).
 * The current in-flight task is allowed to complete naturally. Always
 * records the pause as user-initiated (task 883) — the queued-item
 * safety net and onPlanApproved() must never auto-resume this pause.
 *
 * @param themeId - Theme to pause / 一時停止するテーマID
 * @returns updated state / 更新後の状態
 */
export async function pauseAutoRun(themeId: number): Promise<ThemeAutoRunState> {
  const updated = await prisma.themeAutoRun.upsert({
    where: { themeId },
    create: { themeId, status: 'paused_user' },
    update: { status: 'paused_user' },
  });
  log.info(`[ThemeAutoRunService] Paused auto-run for theme ${themeId}`);
  return mapToState(updated);
}

/**
 * Resume a paused theme (paused_approval → running).
 * Used when plan approval is granted while the theme was waiting. No-ops
 * for a user-initiated pause or a reason-unknown legacy pause (task 883) —
 * only the awaiting-approval pause may be resumed this way.
 *
 * @param themeId - Theme to resume / 再開するテーマID
 * @returns updated state or null if theme not found / 更新後の状態またはnull
 */
export async function resumeAutoRun(themeId: number): Promise<ThemeAutoRunState | null> {
  const existing = await prisma.themeAutoRun.findUnique({ where: { themeId } });
  if (!existing) return null;
  if (!isAutoResumablePauseStatus(narrowAutoRunStatus(existing.status))) {
    return mapToState(existing);
  }

  const updated = await prisma.themeAutoRun.update({
    where: { themeId },
    data: { status: 'running' },
  });
  log.info(`[ThemeAutoRunService] Resumed auto-run for theme ${themeId}`);
  return mapToState(updated);
}

/**
 * Signal that auto-run should stop (running → stopping).
 * The scheduler processes this signal on next tick and performs cleanup.
 *
 * @param themeId - Theme to stop / 停止するテーマID
 * @returns updated state / 更新後の状態
 */
export async function stopAutoRun(themeId: number): Promise<ThemeAutoRunState> {
  const updated = await prisma.themeAutoRun.upsert({
    where: { themeId },
    create: { themeId, status: 'idle' },
    update: { status: 'stopping' },
  });
  log.info(`[ThemeAutoRunService] Stopping auto-run for theme ${themeId}`);
  return mapToState(updated);
}

/**
 * Immediately set theme status to idle and clear current task.
 * Called by the scheduler after completing a stop operation.
 *
 * @param themeId - Theme ID / テーマID
 */
export async function finalizeStop(themeId: number): Promise<void> {
  await prisma.themeAutoRun.updateMany({
    where: { themeId },
    data: { status: 'idle', enabled: false, currentTaskId: null },
  });
  log.info(
    { themeId },
    `[ThemeAutoRunService] Finalized USER stop for theme ${themeId} (enabled=false)`,
  );
  // A USER stop is never auto re-armed: clear the idle-stop marker so it can
  // never be mistaken for a timer stop (task 784).
  await writeIdleTimerColumns(
    themeId,
    { idleSince: null, idleStoppedAt: null },
    'user-stop idle-timer clear',
  );
}

/**
 * Update the current task being executed and increment processedCount.
 *
 * @param themeId - Theme ID / テーマID
 * @param taskId - New current task ID, or null to release it. / 新しいカレントタスクID（null で解放）
 */
export async function setCurrentTask(themeId: number, taskId: number | null): Promise<void> {
  await prisma.themeAutoRun.updateMany({
    where: { themeId },
    data: { currentTaskId: taskId, lastRunAt: new Date(), lastError: null },
  });
}

/**
 * Mark the current task as completed and pick the next one.
 * Increments processedCount and clears currentTaskId.
 *
 * @param themeId - Theme ID / テーマID
 */
export async function onTaskCompleted(themeId: number): Promise<void> {
  await prisma.themeAutoRun.updateMany({
    where: { themeId },
    data: { currentTaskId: null, processedCount: { increment: 1 } },
  });
}

/**
 * Record a task failure and mark for skip; increment processedCount.
 *
 * @param themeId - Theme ID / テーマID
 * @param error - Error message / エラーメッセージ
 */
export async function onTaskFailed(themeId: number, error: string): Promise<void> {
  await prisma.themeAutoRun.updateMany({
    where: { themeId },
    data: { currentTaskId: null, processedCount: { increment: 1 }, lastError: error },
  });
}

/**
 * Mark a queue item as waiting for plan approval (running → paused_approval).
 *
 * @param themeId - Theme ID / テーマID
 */
export async function onAwaitingPlanApproval(themeId: number): Promise<void> {
  await prisma.themeAutoRun.updateMany({
    where: { themeId, status: 'running' },
    data: { status: 'paused_approval' },
  });
  log.info(`[ThemeAutoRunService] Theme ${themeId} paused — awaiting plan approval`);
}
