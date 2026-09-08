/**
 * auto-run-lifecycle
 *
 * Theme lifecycle handling for the auto-run scheduler: stopping/idle/paused
 * theme processing, in-flight execution teardown, and SSE broadcast. Extracted
 * verbatim from ThemeAutoRunScheduler (task 628) as prisma-injected free
 * functions; the scheduler class delegates to these. Not responsible for the
 * running-theme advance logic (see auto-run-advance-active / -select).
 */
import type { PrismaClient } from '../../../generated/prisma-postgres';
import { createLogger } from '../../../config/logger';
import { resolveTaskWorkingDirectory } from '../../task/task-resolver';
import { AgentWorkerManager } from '../../agents/agent-worker-manager';
import { realtimeService } from '../../communication/realtime-service';
import { hasPromotableBacklog, promoteBacklogForTheme } from './backlog-task-promoter';
import { logCycleEvent } from '../../observability';
import { getThemeActiveQueueItems, hasItemAwaitingApproval } from './auto-run-selection';
import { eligibleTopLevelTodoWhere } from './auto-run-eligibility';
import {
  resumeAutoRun,
  finalizeStop,
  startAutoRun,
  isAutoResumablePauseStatus,
  type ThemeAutoRunState,
} from './theme-auto-run-service';
import {
  getIdleStopMinutes,
  isIdleTimerActivelyCounting,
  isIdleTimerExpired,
  countHumanOriginTodo,
  attemptCriticalConcernBypass,
  stopThemeForIdleTimeout,
  shouldRefillBacklogNow,
  markSelfRefillSucceeded,
} from './auto-run-idle-timer';

const log = createLogger('theme-auto-run-scheduler');

/**
 * Handle themes in 'stopping' status: cancel queue items and stop the agent.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param stopping - Themes currently in 'stopping' status / 停止中テーマ一覧
 */
export async function processStoppingThemesImpl(
  prisma: PrismaClient,
  stopping: ThemeAutoRunState[],
): Promise<void> {
  for (const state of stopping) {
    try {
      // Stopping execution is not authorization to discard shared workspace edits.
      await stopThemeExecutionImpl(prisma, state.themeId, state.currentTaskId, {
        preserveChanges: true,
      });
      await finalizeStop(state.themeId);
      broadcastAutoRunUpdateImpl(state.themeId);
      log.info(`[ThemeAutoRunScheduler] Theme ${state.themeId} stopped`);
      logCycleEvent('theme.stopped', {
        theme: state.themeId,
        task: state.currentTaskId ?? undefined,
        msg: 'auto-run stopped by user',
      });
    } catch (err) {
      log.error({ err }, `[ThemeAutoRunScheduler] Error stopping theme ${state.themeId}`);
    }
  }
}

/** Cause codes for an idle theme resuming (mirrors the `theme.resumed` event). */
type ResumeCause = 'new_todo' | 'backlog_promotable' | 'concern_bypass' | 'manual_task_rearm';

/** Start an idle theme and record why (log + cycle event + SSE). */
async function resumeIdleTheme(themeId: number, cause: ResumeCause, todo: number): Promise<void> {
  await startAutoRun(themeId);
  broadcastAutoRunUpdateImpl(themeId);
  log.info(
    { themeId, todo, cause },
    '[ThemeAutoRunScheduler] new work appeared — auto-resumed idle theme',
  );
  logCycleEvent('theme.resumed', {
    theme: themeId,
    todo,
    cause,
    msg: 'idle theme auto-resumed (new work appeared)',
  });
}

/**
 * Handle a single ARMED (enabled:true) idle theme: resume on human-filed work
 * or a promotable backlog, otherwise run the idle-stop timer (task 784).
 *
 * @returns true when this pass stopped the theme (timer expired). / タイマー満了で停止したら true
 */
async function processArmedIdleTheme(
  prisma: PrismaClient,
  state: ThemeAutoRunState,
  idleStopMinutes: number,
  now: Date,
): Promise<boolean> {
  // Mirror selectNextTask's eligibility via eligibleTopLevelTodoWhere
  // (parentId:null — the scheduler only drives TOP-LEVEL tasks; subtasks are
  // run by AIOrchestra — plus workflowDisabled/awaiting_question exclusion).
  // Counting a task selectNextTask would refuse (subtask, workflowDisabled,
  // or awaiting_question) resumes the theme, which then goes straight back to
  // idle/all_done because selection skips it — a 12s idle⇄running flap that
  // never made progress (task 635, task 884).
  const todo = await prisma.task
    .count({ where: eligibleTopLevelTodoWhere(state.themeId) })
    .catch(() => 0);

  if (!state.idleSince) {
    // A row that went idle before the timer existed (or before this write
    // path started stamping idleSince): check for immediate work first —
    // same as the timer-disabled legacy path — then start the timer.
    if (todo > 0) {
      await resumeIdleTheme(state.themeId, 'new_todo', todo);
      return false;
    }
    if (await hasPromotableBacklog(state.themeId, now)) {
      await resumeIdleTheme(state.themeId, 'backlog_promotable', 0);
      return false;
    }
    if (idleStopMinutes > 0) {
      await prisma.themeAutoRun
        .updateMany({
          where: { themeId: state.themeId },
          data: { idleSince: now } as unknown as Parameters<
            typeof prisma.themeAutoRun.updateMany
          >[0]['data'],
        })
        .catch(() => {});
    }
    return false;
  }

  const activelyCounting = isIdleTimerActivelyCounting(
    { enabled: state.enabled, status: state.status, idleSince: state.idleSince },
    idleStopMinutes,
    now,
  );

  if (activelyCounting) {
    // Countdown running (task 784, design points 2 & 3): a human filing or a
    // high/urgent concern returns the theme to normal operation immediately;
    // an ordinary backlog refill stays HELD until the countdown ends.
    const humanTodo = await countHumanOriginTodo(state.themeId);
    if (humanTodo > 0) {
      await resumeIdleTheme(state.themeId, 'new_todo', humanTodo);
      return false;
    }
    if (await attemptCriticalConcernBypass(state.themeId)) {
      await resumeIdleTheme(state.themeId, 'concern_bypass', 0);
      return false;
    }
    return false; // still counting down, nothing to do this pass
  }

  if (idleStopMinutes > 0) {
    // Not counting down and the timer is armed → it has expired.
    if (!isIdleTimerExpired(state.idleSince, idleStopMinutes, now)) return false;
    await stopThemeForIdleTimeout(state.themeId);
    broadcastAutoRunUpdateImpl(state.themeId);
    return true;
  }

  // Timer disabled (idleStopMinutes=0): legacy resume — a fresh todo short-
  // circuits the (gated) backlog check, matching the pre-784 behaviour.
  if (todo > 0) {
    await resumeIdleTheme(state.themeId, 'new_todo', todo);
    return false;
  }
  if (await hasPromotableBacklog(state.themeId, now)) {
    await resumeIdleTheme(state.themeId, 'backlog_promotable', 0);
  }
  return false;
}

/**
 * Handle a single STOPPED (enabled:false) idle theme (task 784): a USER stop
 * (idleStoppedAt null) stays stopped forever. A TIMER stop re-arms on a
 * human-filed task (design point 5 — "手動でタスクが起票されたら…自動再アーム");
 * severity-high concerns and the nightly self-refill window deliberately do
 * NOT re-arm it (they only bypass the countdown BEFORE the stop — see
 * processArmedIdleTheme) — the theme still learns (self-refills in place)
 * but stays off until a human re-arms it.
 */
async function processStoppedIdleTheme(
  prisma: PrismaClient,
  state: ThemeAutoRunState,
  now: Date,
): Promise<void> {
  if (!state.idleStoppedAt) return; // user stop → stay stopped

  // Same reason as processArmedIdleTheme (task 884): count only tasks
  // selectNextTask would also accept, or a re-arm here just bounces straight
  // back to idle once the auto-run loop rejects the same task.
  const manualTodo = await prisma.task
    .count({ where: eligibleTopLevelTodoWhere(state.themeId, { autoCreatedFromBacklog: false }) })
    .catch(() => 0);
  if (manualTodo > 0) {
    await resumeIdleTheme(state.themeId, 'manual_task_rearm', manualTodo);
    return;
  }

  // Learning loop maintained while stopped (design point 6): self-refill may
  // still run in place, but it does NOT re-arm auto-run (design point 5).
  if (await shouldRefillBacklogNow(state.themeId, now)) {
    const created = await promoteBacklogForTheme(state.themeId).catch((err) => {
      log.warn(
        { err, themeId: state.themeId },
        '[ThemeAutoRunScheduler] Backlog self-refill while stopped failed',
      );
      return 0;
    });
    logCycleEvent('backlog.refill_while_stopped', {
      theme: state.themeId,
      created,
      msg: 'nightly self-refill ran while auto-run is idle-stopped (not re-armed)',
    });
    if (created > 0) await markSelfRefillSucceeded(state.themeId, now);
  }
}

/**
 * Auto-resume themes that completed all work and went idle-but-ARMED
 * (enabled:true) once new work appears — a fresh todo task, or a backlog item
 * that can now be promoted. This is what makes auto-run self-sustaining
 * instead of dying at the first dry. A USER stop leaves enabled:false and is
 * never auto-resumed by this loop.
 *
 * Idle-stop timer (task 784): an armed idle theme with no work for
 * idleStopMinutes is stopped (enabled:false, notification, cycle event). A
 * TIMER stop is re-armed only by a manual task filing after the stop; a USER
 * stop never is. See processArmedIdleTheme / processStoppedIdleTheme.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param idle - Themes currently in 'idle' status / アイドル状態のテーマ一覧
 * @param now - Decision time (injectable for tests) / 判定時刻
 * @returns true when this pass idle-stopped at least one theme. / この回でタイムアウト停止したテーマがあれば true
 */
export async function processIdleThemesImpl(
  prisma: PrismaClient,
  idle: ThemeAutoRunState[],
  now: Date = new Date(),
): Promise<boolean> {
  if (idle.length === 0) return false;
  const idleStopMinutes = await getIdleStopMinutes();
  let idleTimedOut = false;
  for (const state of idle) {
    try {
      if (!state.enabled) {
        await processStoppedIdleTheme(prisma, state, now);
        continue;
      }
      if (await processArmedIdleTheme(prisma, state, idleStopMinutes, now)) {
        idleTimedOut = true;
      }
    } catch (err) {
      log.warn({ err, themeId: state.themeId }, '[ThemeAutoRunScheduler] idle auto-resume failed');
    }
  }
  return idleTimedOut;
}

/**
 * For paused themes, check whether approval was granted and auto-resume.
 * Only themes paused for approval (status='paused_approval') are eligible —
 * an explicit user pause or the reason-unknown legacy pause must never be
 * silently overridden by this polling safety net (task 883).
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param paused - Themes currently in a paused status / 一時停止中テーマ一覧
 */
export async function processPausedThemesImpl(
  prisma: PrismaClient,
  paused: ThemeAutoRunState[],
): Promise<void> {
  for (const state of paused) {
    if (!state.currentTaskId) continue;
    if (!isAutoResumablePauseStatus(state.status)) continue;
    try {
      // If the queue item is no longer 'waiting_approval' (e.g. user approved in UI)
      // AND the ThemeAutoRun was not already resumed by onPlanApproved(), resume now.
      const queueItems = await getThemeActiveQueueItems(prisma, state.themeId);
      const stillWaiting = hasItemAwaitingApproval(queueItems);

      // If queue item is gone (completed during pause) or re-queued after approval
      if (!stillWaiting) {
        const taskItem = await prisma.workflowQueueItem.findFirst({
          where: { taskId: state.currentTaskId, status: 'queued' },
        });
        if (taskItem) {
          // Plan was approved, item is back in queue — resume the theme
          await resumeAutoRun(state.themeId);
          broadcastAutoRunUpdateImpl(state.themeId);
          log.info(
            `[ThemeAutoRunScheduler] Theme ${state.themeId} auto-resumed (plan approved detected)`,
          );
        }
      }
    } catch (err) {
      log.error({ err }, `[ThemeAutoRunScheduler] Error processing paused theme ${state.themeId}`);
    }
  }
}

/**
 * Stop a theme's current execution: cancel queue items and kill the in-flight agent.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param themeId - Theme to stop / 停止するテーマID
 * @param currentTaskId - Currently tracked task ID / 現在のタスクID
 * @param options.preserveChanges - Keep filesystem changes on automatic timeout for diagnosis/retry.
 */
export async function stopThemeExecutionImpl(
  prisma: PrismaClient,
  themeId: number,
  currentTaskId: number | null,
  options: { preserveChanges?: boolean } = {},
): Promise<void> {
  const { preserveChanges = false } = options;
  // Cancel all auto-run queue items for this theme
  await prisma.workflowQueueItem.updateMany({
    where: {
      themeId,
      status: { in: ['queued', 'running', 'waiting_approval'] },
    },
    data: { status: 'cancelled', completedAt: new Date(), errorMessage: 'Auto-run stopped' },
  });

  const { stopThemeAgents } = await import('../../agents/stop-task-agents');
  const stopped = await stopThemeAgents(themeId, currentTaskId, {
    errorMessage: 'Auto-run stopped',
  });
  const { settleStoppedTasks } = await import('../../agents/settle-stopped-tasks');
  await settleStoppedTasks(prisma, stopped.executionIds);
  if (!currentTaskId) return;

  // Stop the agent execution(s) if any are running
  try {
    const task = await resolveTaskWorkingDirectory(currentTaskId);
    const workDir = task?.workingDirectory ?? task?.theme?.workingDirectory;

    // Kill ALL in-flight agents across the theme — the current task, its
    // subtasks, and any other theme task with a live execution (not just the
    // first found) — and release their locks. A split parent's subtask runs
    // under a different taskId, so a current-task-only stop would orphan it.

    // Revert any uncommitted changes
    if (workDir && !preserveChanges) {
      // NOTE: getInstance() replaces the former scheduler field — same singleton (task 628).
      await AgentWorkerManager.getInstance()
        .revertChanges(workDir)
        .catch((err) => {
          log.warn(
            { err },
            `[ThemeAutoRunScheduler] Failed to revert changes for theme ${themeId}`,
          );
        });
    }

    // Task state was settled atomically from cancelled execution IDs above.
    // Never reset currentTaskId blindly: it may have completed or started a newer run.
  } catch (err) {
    log.error(
      { err },
      `[ThemeAutoRunScheduler] Error stopping execution for task ${currentTaskId}`,
    );
  }
}

/**
 * Broadcast SSE update for a theme's auto-run state change.
 *
 * @param themeId - Theme whose state changed / 状態が変わったテーマID
 */
export function broadcastAutoRunUpdateImpl(themeId: number): void {
  try {
    realtimeService.broadcast('orchestra', 'auto_run_update', {
      themeId,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // SSE unavailable — non-fatal
  }
}
