/**
 * incident-signature-detectors
 *
 * Pure detection predicates for the self-incident watcher: stagnation of a
 * non-terminal task, tri-state desync across Task/AgentSession/AgentExecution,
 * and an intake question left unanswered too long. DB-independent by design —
 * every input is a plain snapshot assembled by the caller, so each detector is
 * unit-testable. NOT responsible for evidence gathering or concern filing.
 * The same-cause repeat-loop detector lives in incident-signature-repeat-loop
 * and is re-exported here (barrel) for backward compatibility — see task 855.
 */
import { ACTIVE_EXEC } from './workflow-reconciler-requeue';
export {
  detectRepeatLoop,
  isRepairBounceCause,
  REPEAT_LOOP_WINDOW_MS,
  REPEAT_LOOP_MIN_COUNT,
  INVARIANT_REPEAT_LOOP_MIN_COUNT,
} from './incident-signature-repeat-loop';
export type { RepeatLoopTransition } from './incident-signature-repeat-loop';

/** Idle time after which a non-terminal task counts as stagnant (default 30m). */
export const STAGNATION_THRESHOLD_MS =
  parseInt(process.env.RAPITAS_INCIDENT_STAGNATION_MS ?? '', 10) || 30 * 60 * 1000;

/**
 * Grace period after a deliberate recovery transition during which the `todo × advanced-workflow`
 * shape is EXPECTED, not anomalous (default 30m). Rationale (#636): requeueOrphanTasks resets
 * status to 'todo' while keeping workflowStatus on purpose so auto-run resumes mid-workflow —
 * the watcher fired Pattern B 59s later and filed the reconciler's own heal as a high-severity
 * bug. 30m matches STAGNATION_THRESHOLD_MS: past that a still-undispatched task is caught by
 * detectStagnation anyway, so shrinking Pattern B here does not open a detection gap.
 */
export const DESYNC_RECOVERY_SETTLE_MS =
  parseInt(process.env.RAPITAS_INCIDENT_DESYNC_SETTLE_MS ?? '', 10) || 30 * 60 * 1000;

/**
 * Grace period after a failed session's own last update during which Pattern A
 * (`session_failed_execution_active`) is EXPECTED, not anomalous (default 130s).
 * Rationale (#718): the verify post-save pipeline marks a session failed while its own
 * execution is still running the pipeline (jury ~120s + commit/PR); DESYNC_RECOVERY_SETTLE_MS's
 * 30m is sized for the longer-lived Pattern B and would delay hung-execution detection here.
 */
export const PATTERN_A_SETTLE_MS =
  parseInt(process.env.RAPITAS_INCIDENT_PATTERN_A_SETTLE_MS ?? '', 10) || 130_000;

/**
 * Transition causes that DELIBERATELY produce `task.status='todo'` with an
 * advanced workflowStatus: `reconciler_requeue` keeps workflowStatus so resume
 * re-enters at the right phase (workflow-reconciler-requeue);
 * `artifact_reuse_fastforward` advances workflowStatus of a still-todo task
 * before dispatch (artifact-reuse-reconciler); `task_retried` resets status to
 * 'todo' while rolling workflowStatus back to a resume point — see
 * `routes/tasks/task-retry-handler.ts` `resolveRollbackTarget()`/`retryTask()`
 * (#680, task #672 filed 139s after a `task_retried` to research_done, then
 * self-resolved to done/completed via normal dispatch with no data repair,
 * confirming the shape is transient/self-healing). `blocked_auto_retry` is NOT
 * here — it resets workflowStatus to 'draft', which Pattern B never matches.
 * `agent_lifecycle_shutdown_revert` / `manual_execution_stop_revert` /
 * `stale_execution_recovery_revert` (task 709): three more paths revert
 * `task.status` to 'todo' without touching `workflowStatus` — backend
 * shutdown (`lifecycle-manager.ts`), a manual stop (`stop-route.ts`), and
 * stale-execution recovery (`stale-recovery-helpers.ts` `updateAffectedTasks`).
 * Before task 709 none recorded a `WorkflowTransition`, so
 * `isWithinRecoveryGrace` had no row to find and Pattern B fired immediately
 * on a shape these paths create on purpose (task #602). `workflow_queue_
 * enqueue_failed` (786) / `auto_run_stop_revert` (830): ditto, via enqueue() / `stopThemeExecutionImpl`.
 * `manual_execution_stop_withdraw` (#875): stop-execution({withdraw:true}) —
 * same shape immediately after the call, but unlike the other causes here it
 * is also PERMANENTLY excluded via `manuallyWithdrawn` once the grace window
 * passes (see detectStagnation/detectTriStateDesync).
 */
export const MANUAL_STOP_WITHDRAW_CAUSE = 'manual_execution_stop_withdraw';

const RECOVERY_REQUEUE_CAUSES = new Set([
  'reconciler_requeue',
  'artifact_reuse_fastforward',
  'task_retried',
  'agent_lifecycle_shutdown_revert',
  'manual_execution_stop_revert',
  'stale_execution_recovery_revert',
  'workflow_queue_enqueue_failed',
  'auto_run_stop_revert',
  MANUAL_STOP_WITHDRAW_CAUSE,
]);

/**
 * Wait time after which an unanswered intake question counts as stale (default
 * 24h). Rationale: tasks #578/#579 sat in awaiting_question for 4 days
 * (raised 2026-08-13T13:48:35Z, found 2026-08-17) with zero notifications —
 * 24h turns that into a daily reminder while staying quiet for same-day answers.
 */
export const UNANSWERED_QUESTION_THRESHOLD_MS =
  parseInt(process.env.RAPITAS_INCIDENT_UNANSWERED_MS ?? '', 10) || 24 * 60 * 60 * 1000;

/** Task statuses that are terminal — a finished task can never be stagnant. */
const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled', 'archived', 'completed']);

/**
 * Workflow statuses proving the workflow advanced at least one step. A task
 * whose status is still 'todo' while its workflowStatus is one of these is
 * desynced ('draft' = consistent not-started; 'awaiting_question' = a
 * legitimate pause, excluded everywhere else in the reconciler too).
 */
const ADVANCED_WORKFLOW_STATUSES = new Set([
  'research_done',
  'plan_created',
  'plan_approved',
  'in_progress',
  'verify_done',
  'completed',
]);

/** Session statuses that mean the session terminally failed. */
const FAILED_SESSION_STATUSES = new Set(['failed', 'cancelled']);

/**
 * Execution statuses that still represent a live agent — the SSOT is
 * ACTIVE_EXEC (workflow-reconciler-requeue); wrapped in a Set for O(1) lookup.
 */
const ACTIVE_EXECUTION_STATUSES = new Set(ACTIVE_EXEC);

/** Snapshot of one task used by the stagnation detector. */
export interface StagnationInput {
  taskStatus: string;
  workflowStatus: string | null;
  /** Most recent activity (task update or workflow transition), epoch ms. */
  lastActivityAtMs: number;
  /** True when an ACTIVE_EXEC-status AgentExecution exists for the task. */
  hasLiveExecution: boolean;
  /** True when any AgentExecution exists for the task, regardless of status. */
  hasAnyExecution: boolean;
  /** True when a queued/running/waiting_approval WorkflowQueueItem exists. */
  hasActiveQueueItem: boolean;
  /**
   * Whether this task can structurally gain a live execution or queue item
   * at all — `false` when `Task.workflowDisabled`/`UserSettings.
   * workflowDisabledGlobally` is set, the task's theme is not a development
   * theme (`Theme.isDevelopment === false`), or the theme's auto-run is
   * disabled (`ThemeAutoRun.enabled === false`). Such a task can never
   * dispatch, so the "no execution, no queue" shape is a legitimate
   * indefinite wait, not stagnation (task #860, e.g. task #811 in a
   * non-development theme). `null`/`undefined` (unresolved) is treated as
   * managed — mirrors `themeAutoRunEnabled`: incomplete input must never
   * silently widen suppression.
   */
  isWorkflowManaged?: boolean | null;
  /**
   * True when the task's newest relevant transition cause is
   * MANUAL_STOP_WITHDRAW_CAUSE — the operator explicitly withdrew this task
   * via stop-execution({withdraw:true}) and decided not to resume it (#875).
   * `null`/`undefined` (unresolved) leaves the task subject to detection —
   * mirrors the other optional gates' fail-open convention.
   */
  manuallyWithdrawn?: boolean | null;
  nowMs: number;
  thresholdMs?: number;
}

/**
 * Detects a stagnant non-terminal task: no activity for the threshold while no
 * agent is running, nothing is queued, and no legitimate wait state applies.
 * Only in-flight tasks qualify — a pure todo backlog item that never started
 * (workflowStatus draft/null, no execution ever, not in-progress) is skipped.
 * Deliberately withdrawn tasks are excluded (#875, see StagnationInput.manuallyWithdrawn).
 *
 * @param input - Task snapshot (see StagnationInput). / タスクの現在状態スナップショット
 * @returns Staleness in ms when stagnant, otherwise null. / 停滞時はstaleMs、非停滞はnull
 */
export function detectStagnation(input: StagnationInput): { staleMs: number } | null {
  if (TERMINAL_TASK_STATUSES.has(input.taskStatus)) return null;
  if (input.workflowStatus === 'completed' || input.workflowStatus === 'awaiting_question') {
    return null;
  }
  // Task cannot structurally dispatch (workflow disabled / non-development
  // theme / theme auto-run disabled) → the wait is legitimate and
  // indefinite, not stagnation (#860).
  if (input.isWorkflowManaged === false) return null;
  // Deliberately withdrawn via stop-execution({withdraw:true}) (#875) — the
  // operator has already decided not to resume this task; repeating the
  // same finding every watch pass forever is noise, not signal.
  if (input.manuallyWithdrawn) return null;
  // NOTE: null must count as not-started — `null !== 'draft'` alone would
  // misclassify a workflowStatus-less task as advanced.
  const isInFlight =
    (input.workflowStatus !== null && input.workflowStatus !== 'draft') ||
    input.hasAnyExecution ||
    input.taskStatus === 'in-progress';
  if (!isInFlight) return null;
  if (input.hasLiveExecution || input.hasActiveQueueItem) return null;
  const staleMs = input.nowMs - input.lastActivityAtMs;
  if (staleMs < (input.thresholdMs ?? STAGNATION_THRESHOLD_MS)) return null;
  return { staleMs };
}

/** Snapshot of one task's cross-entity state for the tri-state desync detector. */
export interface TriStateDesyncInput {
  taskStatus: string;
  workflowStatus: string | null;
  /** Status of the task's most recently updated AgentSession (null = none). */
  latestSessionStatus: string | null;
  /** Status of that session's most recent AgentExecution (null = none). */
  latestExecutionStatus: string | null;
  /** Cause of the task's newest workflow transition (null/undefined = unknown). */
  latestTransitionCause?: string | null;
  /** createdAt of that transition, epoch ms (null/undefined = unknown). */
  latestTransitionAtMs?: number | null;
  /** Recent transitions to scan for a recovery cause; empty/omitted falls back to latestTransitionCause/latestTransitionAtMs (#775). */
  recentTransitions?: { cause: string; createdAtMs: number }[];
  /** updatedAt of that AgentSession, epoch ms — feeds only the Pattern A settle-window guard. */
  latestSessionUpdatedAtMs?: number | null;
  /**
   * Whether the task's theme has auto-run enabled (`ThemeAutoRun.enabled`).
   * `false` makes Pattern B's `todo` × advanced-`workflowStatus` shape a
   * legitimate indefinite wait rather than an anomaly: a retry against a
   * paused theme resets `status` to 'todo' to resume once dispatched, but a
   * paused theme never dispatches, so the shape outlives
   * DESYNC_RECOVERY_SETTLE_MS and Pattern B fired forever (task #715, e.g.
   * tasks #602/#646/#647, themeId=25). `null`/`undefined` (unresolved) is
   * treated as enabled — mirrors isWithinRecoveryGrace: incomplete input must
   * never silently widen suppression.
   */
  themeAutoRunEnabled?: boolean | null;
  /**
   * True when the task's newest relevant transition cause is
   * MANUAL_STOP_WITHDRAW_CAUSE — the operator explicitly withdrew this task
   * via stop-execution({withdraw:true}) and decided not to resume it (#875).
   * `null`/`undefined` (unresolved) leaves the task subject to detection —
   * mirrors themeAutoRunEnabled's fail-open convention.
   */
  manuallyWithdrawn?: boolean | null;
  /** Current time (ms) — the recovery grace guard needs it to age the transition. */
  nowMs?: number;
  /** Pattern B recovery grace override (default DESYNC_RECOVERY_SETTLE_MS). */
  settleMs?: number;
  /** Pattern A settle-window override (default PATTERN_A_SETTLE_MS). */
  patternASettleMs?: number;
}

/** Which desync pattern was detected. */
export type TriStateDesyncKind =
  | 'session_failed_execution_active'
  | 'todo_status_workflow_advanced';

/**
 * True when a recovery cause fired within the grace window (#636); scans
 * `recentTransitions` if given, else falls back to the single
 * `latestTransitionCause`/`latestTransitionAtMs` pair (#775).
 */
function isWithinRecoveryGrace(input: TriStateDesyncInput): boolean {
  if (input.nowMs === undefined) return false;
  const nowMs = input.nowMs;
  const settleMs = input.settleMs ?? DESYNC_RECOVERY_SETTLE_MS;
  const list = input.recentTransitions?.length
    ? input.recentTransitions
    : input.latestTransitionCause != null && input.latestTransitionAtMs != null
      ? [{ cause: input.latestTransitionCause, createdAtMs: input.latestTransitionAtMs }]
      : [];
  return list.some((t) => RECOVERY_REQUEUE_CAUSES.has(t.cause) && nowMs - t.createdAtMs < settleMs);
}

/**
 * True when the session's own last update is within the Pattern A settle
 * window (#718). Requires BOTH timestamps — with either missing the guard
 * stays off, so detection sensitivity never silently degrades (mirrors
 * isWithinRecoveryGrace).
 */
function isWithinPatternASettle(input: TriStateDesyncInput): boolean {
  if (input.latestSessionUpdatedAtMs == null || input.nowMs === undefined) return false;
  return (
    input.nowMs - input.latestSessionUpdatedAtMs < (input.patternASettleMs ?? PATTERN_A_SETTLE_MS)
  );
}

/**
 * Detects a Task/AgentSession/AgentExecution state contradiction. Pattern A
 * (session terminally failed but its execution still active) is checked first
 * and wins when both apply — the session/execution anomaly is the more urgent
 * signal — EXCEPT within PATTERN_A_SETTLE_MS of the session's own last update
 * (see isWithinPatternASettle, #718). Pattern B: task.status still 'todo'
 * while the workflow advanced —
 * EXCEPT within the recovery grace window after a cause in
 * RECOVERY_REQUEUE_CAUSES (reconciler_requeue / artifact_reuse_fastforward /
 * task_retried), which produces exactly that shape by design (see
 * isWithinRecoveryGrace; past the window detectStagnation covers a
 * still-undispatched task, so the detection net keeps a backstop) —
 * EXCEPT ALSO when the task's theme has auto-run disabled
 * (`themeAutoRunEnabled === false`), where the shape is an indefinite,
 * legitimate wait rather than a transient one (task #715, see
 * TriStateDesyncInput.themeAutoRunEnabled) — EXCEPT ALSO when the task was
 * deliberately withdrawn (#875, see TriStateDesyncInput.manuallyWithdrawn).
 *
 * @param input - Cross-entity state snapshot. / 三面の状態スナップショット
 * @returns Detected pattern + human-readable summary, or null. / 検出結果またはnull
 */
export function detectTriStateDesync(
  input: TriStateDesyncInput,
): { kind: TriStateDesyncKind; detail: string } | null {
  if (
    input.latestSessionStatus !== null &&
    FAILED_SESSION_STATUSES.has(input.latestSessionStatus) &&
    input.latestExecutionStatus !== null &&
    ACTIVE_EXECUTION_STATUSES.has(input.latestExecutionStatus)
  ) {
    if (isWithinPatternASettle(input)) return null;
    return {
      kind: 'session_failed_execution_active',
      detail:
        `最新セッションは終端状態(${input.latestSessionStatus})だが、` +
        `配下の最新実行が依然アクティブ(${input.latestExecutionStatus})のまま`,
    };
  }
  if (
    input.taskStatus === 'todo' &&
    input.workflowStatus !== null &&
    ADVANCED_WORKFLOW_STATUSES.has(input.workflowStatus)
  ) {
    if (isWithinRecoveryGrace(input)) return null;
    // Theme auto-run disabled → nothing will ever dispatch this task, so the
    // wait is legitimate and indefinite, not a stuck/corrupted state (#715).
    if (input.themeAutoRunEnabled === false) return null;
    // Deliberately withdrawn via stop-execution({withdraw:true}) (#875) —
    // same rationale as detectStagnation's identically-named gate.
    if (input.manuallyWithdrawn) return null;
    return {
      kind: 'todo_status_workflow_advanced',
      detail: `task.status=todo のまま workflowStatus が前進済み(${input.workflowStatus})`,
    };
  }
  return null;
}

/** Snapshot of one task used by the unanswered-question detector. */
export interface UnansweredQuestionInput {
  workflowStatus: string | null;
  /**
   * The task's own status. A finished task's pending question is moot, but the
   * workflowStatus can lag behind it: task #587 has been `done` since 2026-08-23
   * while its workflowStatus stayed `awaiting_question`, so it re-notified once
   * per window forever. The watcher already selects this field — it just never
   * looked at it.
   */
  taskStatus: string;
  /** createdAt of the latest toStatus='awaiting_question' transition, epoch ms
   * (null = no such transition on record). NOT task.updatedAt — enrichment and
   * other side channels touch updatedAt without answering the question. */
  questionRaisedAtMs: number | null;
  /** True when an `intake_question_answered` transition exists for the task. */
  hasAnsweredQuestion: boolean;
  nowMs: number;
  thresholdMs?: number;
}

/**
 * Detects a task stuck waiting on an unanswered intake question beyond the
 * threshold. An unanswered question NEVER advances on its own (unlike normal
 * stagnation, which detectStagnation deliberately excludes as a legitimate
 * pause), so a long wait means the human was never reached — re-surface it.
 * Answered tasks are excluded even if their status lags (double guard on top
 * of the caller's workflowStatus filter).
 *
 * @param input - Task snapshot (see UnansweredQuestionInput). / タスクの質問待ちスナップショット
 * @returns Wait time in ms when stale, otherwise null. / 放置時はstaleMs、非該当はnull
 */
export function detectUnansweredQuestion(
  input: UnansweredQuestionInput,
): { staleMs: number } | null {
  if (input.workflowStatus !== 'awaiting_question') return null;
  if (TERMINAL_TASK_STATUSES.has(input.taskStatus)) return null;
  if (input.hasAnsweredQuestion) return null;
  // No awaiting_question transition on record → the wait start is unknowable;
  // skip rather than guess (avoids false positives on anomalous histories).
  if (input.questionRaisedAtMs === null) return null;
  const staleMs = input.nowMs - input.questionRaisedAtMs;
  if (staleMs < (input.thresholdMs ?? UNANSWERED_QUESTION_THRESHOLD_MS)) return null;
  return { staleMs };
}
