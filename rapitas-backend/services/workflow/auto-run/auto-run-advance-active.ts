/**
 * auto-run-advance-active
 *
 * The current-task branch of the auto-run scheduler's advance step: hang
 * backstop (wall-clock tenure guard), active-item wait / stall release, and
 * terminal resolution (completed / failed / vanished item re-enqueue). On
 * resolution it continues into next-task selection (auto-run-advance-select).
 * Extracted verbatim from ThemeAutoRunScheduler.advanceTheme (task 628).
 */
import type { PrismaClient } from '../../../generated/prisma-postgres';
import { createLogger } from '../../../config/logger';
import { resolveTaskWorkflowState } from '../../task/task-resolver';
import { WorkflowQueueService } from '../workflow-queue';
import { logCycleEvent } from '../../observability';
import {
  COOLDOWN_MS,
  MAX_TASK_WALL_MS,
  getThemeActiveQueueItems,
  hasItemAwaitingApproval,
  isAwaitingUserAnswer,
  resolveLastProgressAt,
} from './auto-run-selection';
import { liveOrQueuedBehind } from './queue-wait-exemption';
import {
  setCurrentTask,
  onTaskCompleted,
  onTaskFailed,
  onAwaitingPlanApproval,
} from './theme-auto-run-service';
import {
  notifyAwaitingPlanApproval,
  notifyAwaitingUserAnswer,
  notifyTaskSkipped,
  notifyHangBackstop,
  notifyTaskVanished,
} from './auto-run-notifications';
import { isTaskVanishedMessage } from '../queue-vanished-task-policy';
import { releaseStaleActiveItems } from './auto-run-stall-guard';
import { stopThemeExecutionImpl, broadcastAutoRunUpdateImpl } from './auto-run-lifecycle';
import { selectAndEnqueueNextTask } from './auto-run-advance-select';
import { isOverlapHeld } from '../workflow-orchestrator-overlap-guard';
import { recordTransition } from '../transition-recorder';

import { resolveResumedTenureStart } from './resume-tenure';

const log = createLogger('theme-auto-run-scheduler');

/**
 * Advance a running theme that has a current task: resolve the current task's
 * outcome (hang backstop / in-flight wait / terminal resolution) and, once it
 * is resolved, continue into next-task selection.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param themeId - Theme to advance / 進めるテーマID
 * @param currentTaskId - Currently tracked task / 現在のタスクID
 * @param order - Task selection order / タスク選択順序
 * @param globalActive - Current global auto-run active count / グローバルアクティブ数
 * @param lastRunAt - When the current task became current / 現在タスクの開始時刻
 * @param barrierHoldSince - Per-theme merge-barrier hold start, forwarded to selection / マージバリア保留開始時刻
 */
export async function advanceActiveTask(
  prisma: PrismaClient,
  themeId: number,
  currentTaskId: number,
  order: 'priority' | 'created',
  globalActive: number,
  lastRunAt: string | null,
  barrierHoldSince: Map<number, number>,
): Promise<void> {
  // Hang backstop: never let a wedged run burn tokens indefinitely. If the
  // task has been the current task longer than MAX_TASK_WALL_MS, force-stop
  // it, mark it blocked (skip), and advance. This sits ABOVE WorkflowRunner's
  // per-phase timeout as a whole-task safety net (the user's "正常性確認").
  // EXEMPT a task that is waiting for the USER'S ANSWER: it burns no tokens,
  // and force-stopping it runs revertChanges — destroying the agent's
  // uncommitted work just because the user was away for 45 min.
  let tenureStart = lastRunAt ? new Date(lastRunAt).getTime() : Date.now();
  if (lastRunAt && Date.now() - tenureStart >= MAX_TASK_WALL_MS) {
    tenureStart = await resolveResumedTenureStart(prisma, currentTaskId, tenureStart);
  }
  const tenureMs = Date.now() - tenureStart;
  if (lastRunAt && tenureMs >= MAX_TASK_WALL_MS) {
    if (await isAwaitingUserAnswer(prisma, currentTaskId)) {
      await notifyAwaitingUserAnswer(themeId, currentTaskId);
      return;
    }
    // EXEMPT a task held by the overlap guard (task 793): the implementer has
    // not even started — it is queued behind another open auto-PR touching
    // the same files — so the tenure wall is measuring wait time, not stuck
    // work. In task 784's timeline the 16:51 manual retry was confirmed to
    // follow exactly this misread (implement_overlap_hold at 16:04 → hang
    // backstop at 16:49); the 18:21 retry matches the same shape but only on
    // circumstantial evidence (no hold log survived the 17:34 self-restart).
    if (isOverlapHeld(currentTaskId)) {
      log.info(
        `[ThemeAutoRunScheduler] Task ${currentTaskId} over tenure wall but held by the overlap guard — deferring hang backstop (theme ${themeId})`,
      );
      return;
    }
    // Measure time since PROGRESS, not tenure. A multi-phase task legitimately
    // outlives the task wall (the implementer alone may run 56 min against a
    // 45-min wall), and the liveness check below cannot see the phase seam
    // where one execution has ended and the next has not started: task 585
    // was killed there, 8 seconds after its implementer committed a complete
    // implementation. Transitions and heartbeats are the actual evidence of
    // movement; only their absence means wedged.
    const lastProgressAt = await resolveLastProgressAt(prisma, currentTaskId, tenureStart);
    const sinceProgressMs = Date.now() - lastProgressAt;
    // Liveness exemption: a running execution with a fresh heartbeat is
    // SLOW, not wedged — killing it destroys legitimate long work (task
    // 563: healthy 31-min implementer force-stopped because multi-phase
    // tenure crossed the 45-min wall). While live, the role wall-clock /
    // phase timeouts govern; the tenure wall only fires once the task has
    // no live execution. A hard ceiling (3x) still bounds runaway tokens
    // even with a heartbeat, preserving the original guard's purpose.
    const withinHardCeiling = tenureMs < MAX_TASK_WALL_MS * 3;
    const progressedRecently = sinceProgressMs < MAX_TASK_WALL_MS && withinHardCeiling;
    const executionIsLive =
      withinHardCeiling && !progressedRecently && (await liveOrQueuedBehind(prisma, currentTaskId));
    // CRITICAL: deferring must FALL THROUGH to the normal resolution below,
    // never return. Returning here wedged the whole theme: task 594 finished
    // while over the tenure wall, so every tick saw "progressed 429s ago",
    // deferred, and returned before the code that resolves a finished task
    // and picks the next one — auto-run sat "running" with a completed
    // current task and 9 runnable tasks untouched.
    if (progressedRecently || executionIsLive) {
      log.info(
        `[ThemeAutoRunScheduler] Task ${currentTaskId} over tenure wall but ${
          progressedRecently
            ? `progressed ${Math.round(sinceProgressMs / 1000)}s ago`
            : 'execution heartbeat is fresh'
        } — deferring hang backstop (theme ${themeId})`,
      );
    } else {
      log.warn(
        `[ThemeAutoRunScheduler] Task ${currentTaskId} exceeded wall budget (${Math.round(
          MAX_TASK_WALL_MS / 60000,
        )}min) — force-stopping (theme ${themeId})`,
      );
      logCycleEvent('task.hang_backstop', {
        theme: themeId,
        task: currentTaskId,
        ok: false,
        cause: 'wall_budget_exceeded',
        wallMinutes: Math.round(MAX_TASK_WALL_MS / 60000),
        msg: 'task force-stopped by hang backstop',
      });
      // NOTE: logCycleEvent only writes the NDJSON cycle log — invisible unless
      // an operator is tailing it. Persist a Notification too so a stalled run
      // surfaces in the NotificationBell (same pattern as the other auto-run
      // lifecycle notifications above).
      await notifyHangBackstop(themeId, currentTaskId, Math.round(MAX_TASK_WALL_MS / 60000));
      await stopThemeExecutionImpl(prisma, themeId, currentTaskId, {
        recordRevertTransition: false,
        preserveChanges: true,
      });
      // Read the row BEFORE the blocked write so the transition below can
      // carry the pre-stop task.status (resolveTaskWorkflowState is the
      // existing task-resolver helper; it returns null on a DB miss).
      const wallBudgetState = await resolveTaskWorkflowState(currentTaskId);
      await prisma.task
        .update({ where: { id: currentTaskId }, data: { status: 'blocked' } })
        .catch(() => {});
      // Task 793: this write left no WorkflowTransition row, so downstream
      // retro analysis (retro-evidence.ts) could not tell why a task went
      // blocked here versus any other blocked path.
      // NOTE: this path flips task.status to 'blocked', so the row records a
      // REAL transition INTO blocked — fromStatus is the task's prior state
      // (its workflowStatus, or task.status when the workflow never started),
      // toStatus is 'blocked'. That matches the actual DB change and lets
      // computePhaseTimings (retro-evidence.ts) attribute the timeline
      // correctly; a self-loop (from===to) would have shown "nothing changed".
      // 'blocked' is already an established timeline state here (see
      // blocked-task-escalation and the retro dwell table). The unchanged
      // workflowStatus is preserved in metadata for context.
      const wallMinutes = Math.round(MAX_TASK_WALL_MS / 60000);
      await recordTransition({
        taskId: currentTaskId,
        fromStatus: wallBudgetState?.workflowStatus ?? wallBudgetState?.status ?? null,
        toStatus: 'blocked',
        actor: 'system',
        cause: 'auto_run_hang_backstop',
        metadata: {
          wallMinutes,
          workflowStatus: wallBudgetState?.workflowStatus ?? null,
          taskStatusFrom: wallBudgetState?.status ?? null,
        },
      }).catch(() => {});
      await onTaskFailed(themeId, `Task ${currentTaskId} timed out (auto-run hang guard)`);
      broadcastAutoRunUpdateImpl(themeId);
      await new Promise((r) => setTimeout(r, COOLDOWN_MS));
      // NOTE: was `this.advanceTheme(themeId, null, ...)` — a null currentTaskId always
      // took the selection branch, so this direct call is equivalent (task 628).
      await selectAndEnqueueNextTask(
        prisma,
        themeId,
        order,
        Math.max(0, globalActive - 1),
        barrierHoldSince,
      );
      return;
    }
  }

  // Active queue items (queued / running / waiting_approval) for this task.
  const queueItems = await getThemeActiveQueueItems(prisma, themeId);
  const currentItems = queueItems.filter((i) => i.taskId === currentTaskId);

  // While the task still has an ACTIVE item it is in flight: never move on.
  // This is the core "one task fully completes before the next starts"
  // guarantee — the only non-terminal exit here is the approval pause.
  if (currentItems.length > 0) {
    // Task 618 (事例2): a TERMINAL task can still hold active items (e.g. a
    // 'running' residue after an abort). Waiting on those would wedge the
    // theme forever — release them and resolve the task in THIS tick.
    const releasedStaleCount = await releaseStaleActiveItems(
      prisma,
      themeId,
      currentTaskId,
      currentItems,
    );
    if (releasedStaleCount === 0) {
      if (hasItemAwaitingApproval(currentItems)) {
        await onAwaitingPlanApproval(themeId);
        await notifyAwaitingPlanApproval(themeId, currentTaskId);
        broadcastAutoRunUpdateImpl(themeId);
        logCycleEvent('task.awaiting_approval', {
          theme: themeId,
          task: currentTaskId,
          cause: 'plan_approval_gate',
          msg: 'theme paused — plan awaiting approval',
        });
      }
      // queued / running → still working; wait for the next tick.
      return;
    }
    // released > 0: the items were residue of an already-terminal task.
    // Fall through to the terminal resolution below in the same tick.
  }

  // No active item. Decide the outcome from the most recent TERMINAL queue
  // item FIRST, then fall back to task.status. Checking the terminal item
  // unconditionally (not only when an active item exists) fixes the stall
  // where a queue item failed after max retries but task.status was left
  // 'in-progress' (WorkflowRunner only sets task.status for subtasks) — the
  // theme used to hang here until the 45-min wall backstop.
  const terminalItem = await prisma.workflowQueueItem.findFirst({
    where: {
      themeId,
      taskId: currentTaskId,
      status: { in: ['completed', 'failed', 'cancelled'] },
    },
    orderBy: { completedAt: 'desc' },
    select: { id: true, status: true, errorMessage: true, completedAt: true },
  });

  const task = await resolveTaskWorkflowState(currentTaskId);

  // Confirmed-vanished-task guard (task 651): the task row is confirmed
  // absent (dequeue/runner/reconciler all detected this and marked their
  // queue item with the same vanished-task marker). Writing task.blocked
  // for a task that doesn't exist is meaningless — record task.skipped with
  // a distinct cause and move straight to the next task, never through the
  // isFailed branch below (which would try `prisma.task.update` against a
  // non-existent row and silently no-op, and whose 'blocked' framing is
  // inaccurate for "this task no longer exists").
  if (terminalItem && isTaskVanishedMessage(terminalItem.errorMessage) && !task) {
    await notifyTaskVanished(themeId, currentTaskId);
    broadcastAutoRunUpdateImpl(themeId);
    logCycleEvent('task.skipped', {
      theme: themeId,
      task: currentTaskId,
      cause: 'task_vanished',
      msg: 'task row confirmed absent — skipped without blocking',
    });
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    await selectAndEnqueueNextTask(
      prisma,
      themeId,
      order,
      Math.max(0, globalActive - 1),
      barrierHoldSince,
    );
    return;
  }

  const isCompleted =
    terminalItem?.status === 'completed' ||
    task?.status === 'done' ||
    task?.workflowStatus === 'completed';
  // NOTE: 'cancelled' is deliberately NOT a failure. An item is cancelled when
  // the dispatch was ABANDONED — auto-run stopped, the task reached a terminal
  // state, a phantom item was swept, or the task was not runnable at dispatch
  // time (queue-skip-policy). None of those mean the TASK failed, and treating
  // them as failure is what blocked task 646 ten seconds after its user
  // answered the question.
  const isFailed =
    terminalItem?.status === 'failed' || task?.status === 'failed' || task?.status === 'blocked';

  if (isCompleted) {
    await onTaskCompleted(themeId);
    broadcastAutoRunUpdateImpl(themeId);
    logCycleEvent('task.completed', {
      theme: themeId,
      task: currentTaskId,
      ok: true,
      via: terminalItem?.status === 'completed' ? 'queue_item' : 'task_status',
      msg: 'task completed — advancing to next',
    });
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    await selectAndEnqueueNextTask(
      prisma,
      themeId,
      order,
      Math.max(0, globalActive - 1),
      barrierHoldSince,
    );
    return;
  }

  if (isFailed) {
    // A task parked as 'blocked' may actually be WAITING FOR A USER ANSWER
    // (AskUserQuestion), not failed. Hold the theme here: advancing would
    // start the next task's agent, which then runs concurrently with this
    // task's answer-resume — the "multiple agents launched" symptom.
    if (task?.status === 'blocked' && (await isAwaitingUserAnswer(prisma, currentTaskId))) {
      log.info(
        `[ThemeAutoRunScheduler] Task ${currentTaskId} is awaiting a user answer — holding, not advancing (theme ${themeId})`,
      );
      await notifyAwaitingUserAnswer(themeId, currentTaskId);
      broadcastAutoRunUpdateImpl(themeId);
      logCycleEvent('task.awaiting_answer', {
        theme: themeId,
        task: currentTaskId,
        cause: 'ask_user_question',
        msg: 'theme holding — task awaiting user answer',
      });
      return;
    }
    // A HUMAN may have acted on this task after the queue item reached its
    // terminal state — answering a question revives it (workflowStatus → draft,
    // status → todo). `task` above is a snapshot taken before the
    // awaiting-answer lookup and the notifications, so writing 'blocked' from
    // it silently undoes that answer: measured 2026-08-24 on task 646, where the
    // answer landed 10 seconds before this write.
    // Only a `user` actor counts — system transitions are the very failure being
    // resolved here and must not veto their own bookkeeping.
    if (await userActedAfter(prisma, currentTaskId, terminalItem?.completedAt ?? null)) {
      log.info(
        `[ThemeAutoRunScheduler] Task ${currentTaskId} was revived by the user — re-queuing instead of blocking (theme ${themeId})`,
      );
      logCycleEvent('task.revived', {
        theme: themeId,
        task: currentTaskId,
        cause: 'user_action_after_failure',
        msg: 'user acted after the failure decision — re-queued instead of blocked',
      });
      await WorkflowQueueService.getInstance()
        .enqueue({ taskId: currentTaskId, themeId, priority: 50 })
        .catch(() => {});
      await setCurrentTask(themeId, currentTaskId);
      broadcastAutoRunUpdateImpl(themeId);
      return;
    }

    const errMsg = terminalItem?.errorMessage ?? `Task ${currentTaskId} failed or was blocked`;
    // Mark the task blocked so selection skips it next time.
    if (task?.status !== 'blocked') {
      await prisma.task
        .update({ where: { id: currentTaskId }, data: { status: 'blocked' } })
        .catch(() => {});
    }
    await onTaskFailed(themeId, errMsg);
    await notifyTaskSkipped(themeId, currentTaskId, errMsg);
    broadcastAutoRunUpdateImpl(themeId);
    logCycleEvent('task.blocked', {
      theme: themeId,
      task: currentTaskId,
      ok: false,
      cause: terminalItem?.status ?? 'blocked',
      msg: errMsg.slice(0, 200),
    });
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    await selectAndEnqueueNextTask(
      prisma,
      themeId,
      order,
      Math.max(0, globalActive - 1),
      barrierHoldSince,
    );
    return;
  }

  // No active AND no terminal queue item, and the task is not terminal:
  // the item vanished (e.g. cleared) while the task is still mid-workflow.
  // Re-enqueue the SAME task so it resumes — never silently stall. The
  // WorkflowRunner picks up from the task's current workflowStatus.
  //
  // Bounded, though: if the same task keeps coming straight back as a cancelled
  // item, re-enqueueing spins. Measured 2026-08-24 on task 635 (todo +
  // awaiting_question, which the orchestrator refuses to dispatch): 106 queue
  // items in 21 minutes while auto-run reported itself as running. The selector
  // no longer picks that state, but any future "enqueued then immediately
  // abandoned" cause would loop the same way, so release the task instead.
  if (await hasRunawayCancelLoop(prisma, currentTaskId)) {
    log.warn(
      `[ThemeAutoRunScheduler] Task ${currentTaskId} keeps being cancelled without running — releasing it (theme ${themeId})`,
    );
    logCycleEvent('task.skipped', {
      theme: themeId,
      task: currentTaskId,
      cause: 'runaway_cancel_loop',
      msg: 'enqueue-cancel loop detected — task released so the theme can move on',
    });
    await setCurrentTask(themeId, null);
    broadcastAutoRunUpdateImpl(themeId);
    return;
  }

  try {
    // NOTE: getInstance() replaces the former scheduler `queue` field — same singleton (task 628).
    await WorkflowQueueService.getInstance().enqueue({
      taskId: currentTaskId,
      themeId,
      priority: 50,
    });
    await setCurrentTask(themeId, currentTaskId);
    broadcastAutoRunUpdateImpl(themeId);
    log.warn(
      `[ThemeAutoRunScheduler] Task ${currentTaskId} had no queue item; re-enqueued to resume (theme ${themeId})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 'already in the queue' means a race re-created it — fine, just wait.
    if (!msg.includes('already in the queue')) {
      log.error({ err }, `[ThemeAutoRunScheduler] Failed to re-enqueue task ${currentTaskId}`);
    }
  }
  return;
}

/** Cancelled-without-running items that trip the runaway-loop guard. */
const RUNAWAY_CANCEL_THRESHOLD = 8;

/** Window the runaway-loop guard counts over. */
const RUNAWAY_CANCEL_WINDOW_MS = 10 * 60_000;

/**
 * Whether a task keeps producing cancelled queue items without ever running.
 *
 * Fails OPEN (false) — an unreadable queue must not stop the scheduler from
 * resuming genuinely-stalled work.
 *
 * @param prisma - Prisma client. / Prismaクライアント
 * @param taskId - Task under resolution. / 対象タスク
 * @returns true when the re-enqueue loop should be broken. / ループ打切りなら true
 */
async function hasRunawayCancelLoop(prisma: PrismaClient, taskId: number): Promise<boolean> {
  try {
    const since = new Date(Date.now() - RUNAWAY_CANCEL_WINDOW_MS);
    const n = await prisma.workflowQueueItem.count({
      where: { taskId, status: 'cancelled', createdAt: { gt: since } },
    });
    return n >= RUNAWAY_CANCEL_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Whether a human acted on the task after a point in time.
 *
 * Used to detect that a failure decision has been overtaken by a user action
 * (most often answering an AskUserQuestion, which revives the task). Only
 * `actor: 'user'` transitions count; the system transitions recorded around a
 * failure are the bookkeeping being applied, not a revival.
 *
 * Fails CLOSED (false) — an unreadable transition log must not stop the
 * scheduler from recording a genuine failure.
 *
 * @param prisma - Prisma client. / Prismaクライアント
 * @param taskId - Task under resolution. / 対象タスク
 * @param since - Terminal timestamp to compare against; null skips the check. / 比較起点
 * @returns true when a user transition exists after `since`. / ユーザー操作があれば true
 */
async function userActedAfter(
  prisma: PrismaClient,
  taskId: number,
  since: Date | null,
): Promise<boolean> {
  if (!since) return false;
  try {
    const n = await prisma.workflowTransition.count({
      where: { taskId, actor: 'user', createdAt: { gt: since } },
    });
    return n > 0;
  } catch {
    return false;
  }
}
