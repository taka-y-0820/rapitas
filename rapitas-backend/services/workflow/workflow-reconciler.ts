/**
 * Workflow Reconciler
 *
 * Periodic self-healing for known state-divergence classes that otherwise
 * require a manual reload / backend restart to clear. Runs on a timer (and once
 * after startup). Every repair is conservative, idempotent, and best-effort —
 * it only acts on states that cannot be a legitimately-running phase.
 *
 * Repairs:
 *  1. Zombie session — an `active` AgentSession with no activity for longer than
 *     any possible phase (well beyond the phase timeout), not awaiting user
 *     input → finalize the session + its stuck executions. Fixes the "進行中 /
 *     execution-status returns a running session forever" symptom.
 *  2. Phantom worktree — a terminal session still referencing a worktreePath
 *     that no longer exists on disk → clear it (the next run recreates).
 *  3. Orphan task (detect + notify) — an in-progress task with no live execution
 *     for a long time → surface it so the operator can re-run (no auto-mutation).
 *
 * Detections (no auto-repair):
 *  - Self-incident watch (self-incident-watcher, throttled to ~5m) — scans
 *    recent tasks for stagnation / tri-state desync / repeat-loop signatures
 *    and files evidence-backed concerns. It NEVER mutates state; repair flows
 *    through the concern → task → workflow pipeline.
 *
 * NOT responsible for selecting/advancing phases — only for clearing divergence.
 */
import { existsSync } from 'fs';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { createNotification } from '../communication/notification-service';
// NOTE: recordTransition is no longer imported here — every heal that records a
// transition now lives in workflow-reconciler-requeue.
import {
  ACTIVE_EXEC,
  STALE_TASK_MS,
  requeueOrphanTasks,
  requeueBlockedTasks,
  healUndispatchableTodo,
} from './workflow-reconciler-requeue';

export { STALE_TASK_MS } from './workflow-reconciler-requeue';

const log = createLogger('workflow-reconciler');

const RECONCILE_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 30_000;
/**
 * A session active with NO activity for this long cannot be a legitimate phase:
 * it exceeds the WorkflowRunner phase timeout (30m) + margin, so it is abandoned.
 * Kept above the phase timeout deliberately to avoid finalizing a live long run.
 */
export const STALE_SESSION_MS = 45 * 60 * 1000;
/**
 * Settle window before healing a status=in-progress / workflowStatus=completed
 * desync. Short (the workflow is already terminal) but non-zero so we never race
 * a task whose completion is still mid-write.
 */
export const COMPLETED_DESYNC_MS = 2 * 60 * 1000;
/** Only inspect worktree rows touched within this window (bound the scan). */
const PHANTOM_LOOKBACK_MS = 24 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/**
 * Pure decision: should an active session be finalized as abandoned?
 * Stale beyond the threshold AND not legitimately waiting on the user.
 *
 * @param args.lastActivityAtMs - Session lastActivityAt (ms). / 最終活動時刻
 * @param args.nowMs - Current time (ms). / 現在時刻
 * @param args.latestExecStatus - Latest execution status, if any. / 最新実行status
 * @param args.taskWorkflowStatus - Owning task's workflowStatus. / タスクのworkflowStatus
 * @param args.staleMs - Staleness threshold. / 陳腐化閾値
 * @returns true when safe to finalize. / 終端化してよいか
 */
export function shouldFinalizeSession(args: {
  lastActivityAtMs: number;
  nowMs: number;
  latestExecStatus?: string | null;
  taskWorkflowStatus?: string | null;
  staleMs?: number;
}): boolean {
  const stale = args.nowMs - args.lastActivityAtMs >= (args.staleMs ?? STALE_SESSION_MS);
  if (!stale) return false;
  if (args.latestExecStatus === 'waiting_for_input') return false; // awaiting user answer
  if (args.taskWorkflowStatus === 'awaiting_question') return false; // awaiting clarification
  return true;
}

/** Finalize abandoned active sessions (and their stuck executions). */
async function healZombieSessions(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - STALE_SESSION_MS);
  const sessions = await prisma.agentSession
    .findMany({
      // Heal BOTH 'active' AND 'running' zombies. verification-retry sets a
      // session to status:'running'; if that run then crashes/is interrupted, the
      // session stays 'running' forever — the reconciler used to only finalize
      // 'active', so a 'running' zombie blocked auto-run permanently (it waits on
      // the dead session and never advances; e.g. task 253 stuck at plan_approved
      // with a running session but no live agent process).
      where: { status: { in: ['active', 'running'] }, lastActivityAt: { lt: cutoff } },
      select: {
        id: true,
        lastActivityAt: true,
        config: { select: { taskId: true } },
        agentExecutions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
      },
    })
    .catch(() => []);

  let healed = 0;
  for (const s of sessions) {
    const taskId = s.config?.taskId;
    const task = taskId
      ? await prisma.task
          .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
          .catch(() => null)
      : null;
    if (
      !shouldFinalizeSession({
        lastActivityAtMs: s.lastActivityAt.getTime(),
        nowMs,
        latestExecStatus: s.agentExecutions[0]?.status,
        taskWorkflowStatus: task?.workflowStatus,
      })
    ) {
      continue;
    }
    await prisma.agentSession
      .update({
        where: { id: s.id },
        data: {
          status: 'cancelled',
          errorMessage: 'Reconciler: abandoned active session (>45m idle)',
        },
      })
      .catch(() => {});
    await prisma.agentExecution
      .updateMany({
        where: { sessionId: s.id, status: { in: ACTIVE_EXEC } },
        data: { status: 'failed', completedAt: new Date(), errorMessage: 'Reconciler: abandoned' },
      })
      .catch(() => {});
    healed++;
  }
  return healed;
}

/** Clear worktreePath on terminal sessions whose worktree no longer exists. */
async function clearPhantomWorktrees(nowMs: number): Promise<number> {
  const sessions = await prisma.agentSession
    .findMany({
      where: {
        worktreePath: { not: null },
        status: { notIn: ['active', 'pending'] },
        updatedAt: { gte: new Date(nowMs - PHANTOM_LOOKBACK_MS) },
      },
      select: { id: true, worktreePath: true },
    })
    .catch(() => []);

  let cleared = 0;
  for (const s of sessions) {
    if (s.worktreePath && !existsSync(s.worktreePath)) {
      await prisma.agentSession
        .update({ where: { id: s.id }, data: { worktreePath: null } })
        .catch(() => {});
      cleared++;
    }
  }
  return cleared;
}

/** Surface (notify once) in-progress tasks that have no live execution. */
async function flagOrphanTasks(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - STALE_TASK_MS);
  const tasks = await prisma.task
    .findMany({
      where: { status: 'in-progress', parentId: null, updatedAt: { lt: cutoff } },
      select: { id: true, title: true, workflowStatus: true },
    })
    .catch(() => []);

  let flagged = 0;
  for (const t of tasks) {
    if (t.workflowStatus === 'completed' || t.workflowStatus === 'awaiting_question') continue;
    const liveExec = await prisma.agentExecution
      .findFirst({
        where: { session: { config: { taskId: t.id } }, status: { in: ACTIVE_EXEC } },
        select: { id: true },
      })
      .catch(() => null);
    if (liveExec) continue;

    // Dedup: skip if we already surfaced this task recently.
    const recent = await prisma.notification
      .findFirst({
        where: {
          link: `/tasks?taskId=${t.id}`,
          title: 'タスクが停滞しています',
          createdAt: { gt: new Date(nowMs - 6 * 60 * 60 * 1000) },
        },
        select: { id: true },
      })
      .catch(() => null);
    if (recent) continue;

    await createNotification({
      type: 'system',
      title: 'タスクが停滞しています',
      message: `#${t.id}「${t.title}」が長時間「進行中」のまま実行が見当たりません。再実行をご検討ください。`,
      link: `/tasks?taskId=${t.id}`,
      metadata: { taskId: t.id, reason: 'reconciler_orphan' },
    }).catch(() => {});
    flagged++;
  }
  return flagged;
}

/**
 * Heal the completion desync: a task left at status='in-progress' while its
 * workflowStatus has already reached 'completed'. This happens when an
 * execution-start path (continue / execute / respond / post-review) sets
 * status='in-progress' without syncing workflowStatus, or a re-selection
 * re-flips an already-completed task. `flagOrphanTasks` deliberately skips
 * wf=completed, so without this heal these tasks stay stuck "進行中" forever
 * with no live execution. The workflow is terminal, so finalize to 'done'.
 */
async function healCompletedDesync(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - COMPLETED_DESYNC_MS);
  const tasks = await prisma.task
    .findMany({
      where: { status: 'in-progress', workflowStatus: 'completed', updatedAt: { lt: cutoff } },
      select: { id: true, title: true, completedAt: true },
    })
    .catch(() => [] as { id: number; title: string; completedAt: Date | null }[]);

  let healed = 0;
  for (const t of tasks) {
    // A live agent means the completion may still be settling — leave it alone.
    const liveExec = await prisma.agentExecution
      .findFirst({
        where: { session: { config: { taskId: t.id } }, status: { in: ACTIVE_EXEC } },
        select: { id: true },
      })
      .catch(() => null);
    if (liveExec) continue;

    await prisma.task
      .update({
        where: { id: t.id },
        data: { status: 'done', completedAt: t.completedAt ?? new Date() },
      })
      .catch(() => {});
    healed++;
    log.info(
      { taskId: t.id },
      '[reconciler] Healed completion desync (in-progress + wf=completed) -> done',
    );
  }
  return healed;
}

/** Run one reconciliation pass. Single-flight; never throws. */
export async function reconcileOnce(): Promise<{
  zombieSessions: number;
  phantomWorktrees: number;
  orphanTasks: number;
  completedDesyncs: number;
  requeuedOrphans: number;
  blockedEvidenceCorrected: number;
  statusDesyncsHealed: number;
  retriedBlocked: number;
  blockedEscalated: number;
  undispatchableTodos: number;
  questionPauses: number;
  questionAutoAnswered: number;
  autoApproveStalls: number;
  staleQueueItemsCancelled: number;
  staleRunningItemsReleased: number;
  queueStarvationHandled: number;
  selfIncidentsFiled: number;
  zeroProgressDetected: number;
}> {
  const empty = {
    zombieSessions: 0,
    phantomWorktrees: 0,
    orphanTasks: 0,
    completedDesyncs: 0,
    requeuedOrphans: 0,
    blockedEvidenceCorrected: 0,
    statusDesyncsHealed: 0,
    retriedBlocked: 0,
    blockedEscalated: 0,
    undispatchableTodos: 0,
    questionPauses: 0,
    questionAutoAnswered: 0,
    autoApproveStalls: 0,
    staleQueueItemsCancelled: 0,
    staleRunningItemsReleased: 0,
    queueStarvationHandled: 0,
    selfIncidentsFiled: 0,
    zeroProgressDetected: 0,
  };
  if (inFlight) return empty;
  inFlight = true;
  const nowMs = Date.now();
  try {
    // NOTE: Each heal pass is isolated in its own try/catch (via `runHealPass`)
    // rather than sharing one try/catch around the whole sequence. These
    // passes fix UNRELATED kinds of divergence (zombie sessions, phantom
    // worktrees, completed-status desync, orphan requeue, blocked-task
    // correct/retry/escalate, undispatchable todos, orphan flagging, stale
    // queue items) — a non-DB
    // throw in one (e.g. a bad row shape) must not starve the others for
    // this whole cycle. Without
    // this, a deterministically-throwing row in an EARLY pass would
    // permanently prevent every LATER pass from ever running again.
    const zombieSessions = await runHealPass('healZombieSessions', () => healZombieSessions(nowMs));
    const phantomWorktrees = await runHealPass('clearPhantomWorktrees', () =>
      clearPhantomWorktrees(nowMs),
    );
    const completedDesyncs = await runHealPass('healCompletedDesync', () =>
      healCompletedDesync(nowMs),
    );
    // Try to recover orphans (re-queue) BEFORE flagging — a successful re-queue
    // means we don't also notify the user about the same task.
    const failedRepairTasks = new Set<number>();
    const recoveredRepairs = await runHealPass('recoverPendingRepairs', async () => {
      const { recoverRepairsForRunner } = await import('./verify-repair-recovery');
      return recoverRepairsForRunner(prisma, nowMs, failedRepairTasks);
    });
    const requeuedOrphans =
      recoveredRepairs +
      (await runHealPass('requeueOrphanTasks', () => requeueOrphanTasks(nowMs, failedRepairTasks)));
    // Blocked-task order contract (task 615): correct → retry → escalate.
    // Evidence correction removes PROVEN-successful blocked tasks FIRST so the
    // blind retry below never re-runs them (a re-run opens a duplicate PR).
    const blockedEvidenceCorrected = await runHealPass('correctBlockedByEvidence', async () => {
      const { correctBlockedByEvidence } = await import('./workflow-reconciler-blocked');
      return correctBlockedByEvidence(nowMs);
    });
    // Restore `status` for tasks a human already advanced via `workflowStatus`
    // while `status` stayed 'blocked' (task 802) — BEFORE the blind retry
    // below, so a healed task's status:'blocked' row is gone from that pass'
    // own candidate query by the time it runs (same-cycle exclusion).
    const statusDesyncsHealed = await runHealPass('healBlockedStatusDesync', async () => {
      const { healBlockedStatusDesync } = await import('./workflow-reconciler-blocked');
      return healBlockedStatusDesync(nowMs);
    });
    // Auto-retry blocked tasks so the perpetual loop self-heals instead of idling
    // with a cap full of permanently-blocked tasks.
    const retriedBlocked = await runHealPass('requeueBlockedTasks', () =>
      requeueBlockedTasks(nowMs),
    );
    // Escalate (once per task) the blocked remainder retry will NOT touch
    // (awaiting_question / exhausted budget / retry cap / too old) — exclusion
    // from retry must no longer mean abandonment.
    const blockedEscalated = await runHealPass('escalateAbandonedBlocked', async () => {
      const { escalateAbandonedBlocked } = await import('./workflow-reconciler-blocked');
      return escalateAbandonedBlocked(nowMs);
    });
    // Reset todo tasks stranded in an undispatchable workflowStatus so the
    // scheduler stops burning selections on them every cycle.
    const undispatchableTodos = await runHealPass('healUndispatchableTodo', () =>
      healUndispatchableTodo(nowMs),
    );
    // Restore intake question pauses that were cleared without an answer — a
    // dropped pause is invisible in the UI (every "waiting on a human"
    // affordance keys off awaiting_question) AND keeps the scheduler
    // re-selecting the task, which is how task 656 wedged in enqueue/cancel.
    const questionPauses = await runHealPass('healOrphanedQuestionPause', async () => {
      const { healOrphanedQuestionPause } = await import('./workflow-reconciler-question-pause');
      return healOrphanedQuestionPause(nowMs);
    });
    // Auto-adopt a stale question's recommended option once it has sat
    // unattended past RAPITAS_QUESTION_AUTO_ANSWER_MS (default 60m) — an
    // absent operator (nights, incident response) must not stall a task
    // indefinitely at awaiting_question.
    const questionAutoAnswered = await runHealPass('healStaleQuestionAutoAnswer', async () => {
      const { healStaleQuestionAutoAnswer } =
        await import('./workflow-reconciler-question-auto-answer');
      const { autoAnswered } = await healStaleQuestionAutoAnswer(new Date(nowMs));
      return autoAnswered;
    });
    const orphanTasks = await runHealPass('flagOrphanTasks', () => flagOrphanTasks(nowMs));
    // Re-run auto-approval lost by a save request that died mid-flight
    // (critic-gate wall time > client timeout) — plan_created + active
    // auto-approve policy must never sit forever.
    const autoApproveStalls = await runHealPass('healAutoApproveStalls', async () => {
      const { healAutoApproveStalls } = await import('./workflow-reconciler-autoapprove');
      return healAutoApproveStalls(nowMs);
    });
    // Cancel queued items for already-terminal tasks — the dequeue-time guard
    // never fires while the runner is idle, so these otherwise sit forever
    // polluting queueDepth (tasks 537/540/545). No nowMs: terminality is
    // instant, not staleness-based.
    const staleQueueItemsCancelled = await runHealPass('sweepStaleQueueItems', async () => {
      const { sweepStaleQueueItems } = await import('./workflow-reconciler-queue-sweep');
      return sweepStaleQueueItems();
    });
    // Reclaim 'running' residue nobody else touches while the process lives —
    // one such item blocks EVERY dequeue via the cross-session running count,
    // silently wedging auto-run (task 618). Cancel-only, never requeue.
    const staleRunningItemsReleased = await runHealPass('sweepStaleRunningItems', async () => {
      const { sweepStaleRunningItems } = await import('./workflow-reconciler-queue-stall');
      return sweepStaleRunningItems(nowMs);
    });
    // Detect `running=0 かつ queued>0` persisting past the threshold (consumer
    // dead/wedged) and kick the idempotent WorkflowRunner + surface it (task 618).
    const queueStarvationHandled = await runHealPass('detectQueueStarvation', async () => {
      const { detectQueueStarvation } = await import('./workflow-reconciler-queue-stall');
      return detectQueueStarvation(nowMs);
    });
    // Detection-only self-incident watch, LAST on purpose: the repair passes
    // above run first, so anything they just healed is no longer reported as
    // an incident this cycle (fewer false positives). Self-throttled to ~5m.
    const selfIncidentsFiled = await runHealPass('runSelfIncidentWatch', async () => {
      const { runSelfIncidentWatch } = await import('./self-incident-watcher');
      return runSelfIncidentWatch(nowMs);
    });
    // Detection-only zero-progress spin watch (task 653): a theme reporting
    // 'running' whose current task has produced NO AgentExecution for the whole
    // threshold window. Notify-only — placed with the detection passes so every
    // repair pass above gets its chance to clear the spin first.
    const zeroProgressDetected = await runHealPass('detectZeroProgressWhileRunning', async () => {
      const { detectZeroProgressWhileRunning } =
        await import('./workflow-reconciler-zero-progress');
      return detectZeroProgressWhileRunning(nowMs);
    });
    const counts = {
      zombieSessions,
      phantomWorktrees,
      orphanTasks,
      completedDesyncs,
      requeuedOrphans,
      blockedEvidenceCorrected,
      statusDesyncsHealed,
      retriedBlocked,
      blockedEscalated,
      undispatchableTodos,
      questionPauses,
      questionAutoAnswered,
      autoApproveStalls,
      staleQueueItemsCancelled,
      staleRunningItemsReleased,
      queueStarvationHandled,
      selfIncidentsFiled,
      zeroProgressDetected,
    };
    if (Object.values(counts).some((n) => n > 0)) {
      log.info(counts, '[reconciler] repaired divergences');
    }
    return counts;
  } catch (err) {
    log.warn({ err }, '[reconciler] pass failed');
    return empty;
  } finally {
    inFlight = false;
  }
}

/**
 * Runs a single heal pass in isolation: a throw is logged and treated as
 * "0 healed this cycle" for that pass only, so it never blocks the other
 * (unrelated) heal passes in the same `reconcileOnce()` call. The next
 * scheduled cycle retries this pass again.
 *
 * @param name - Pass name, for the log line. / パス名（ログ用）
 * @param fn - The heal-pass call to run. / 実行するヒールパス
 * @returns The pass's healed count, or 0 if it threw. / 修復件数（失敗時は0）
 */
export async function runHealPass(name: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    log.warn({ err, pass: name }, '[reconciler] heal pass failed — continuing with the rest');
    return 0;
  }
}

/** Start the periodic reconciler (idempotent). */
export function startWorkflowReconciler(): void {
  if (timer) return;
  setTimeout(() => void reconcileOnce(), STARTUP_DELAY_MS);
  timer = setInterval(() => void reconcileOnce(), RECONCILE_INTERVAL_MS);
  log.info('[reconciler] started');
}

/** Stop the periodic reconciler. */
export function stopWorkflowReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
