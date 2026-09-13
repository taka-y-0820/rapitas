/**
 * execution-dashboard-service
 *
 * Pure, DB-independent state-derivation for the execution visualization
 * dashboard (task 870): maps a WorkflowQueueItem's status and latest
 * transition cause into one of the dashboard's five display states (plus
 * failed/cancelled), counts raw self-repair bounces, and evaluates stall by
 * elapsed time against a user-configurable threshold. Not responsible for
 * querying Prisma or building HTTP responses — see
 * routes/workflow/execution-dashboard.routes.ts.
 */

/** Causes that indicate a self-repair bounce (verify/CI sent a phase back for another attempt). */
const REPAIR_BOUNCE_CAUSES = new Set(['verify_repair', 'ci_repair']);

/** Dashboard display state — the five task-description phases plus failed/cancelled. */
export type ExecutionDashboardState =
  | 'queued'
  | 'running'
  | 'repairing'
  | 'awaiting_judgement'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Warning threshold for "このタスク頻繁に失敗中" (task description's fixed
 * value, not user-configurable — see plan.md 設計判断の根拠).
 */
export const FREQUENT_FAILURE_THRESHOLD = 3;

/**
 * Counts raw self-repair bounce transitions (verify_repair / ci_repair) with
 * no time window and no actor filtering — the "生の回数" shown to the user.
 * Deliberately distinct from detectRepeatLoop()'s forgiveness-budget logic
 * (incident-signature-repeat-loop.ts), which answers a different question
 * ("has this exceeded its allowed retry budget for concern-filing purposes").
 *
 * @param transitions - Transition cause list (any order). / 対象タスクの遷移一覧
 * @returns Raw count of verify_repair/ci_repair transitions. / 修復バウンス回数
 */
export function countRepairBounces(transitions: { cause: string }[]): number {
  return transitions.filter((t) => REPAIR_BOUNCE_CAUSES.has(t.cause)).length;
}

/**
 * Maps a queue item's status and latest transition cause to a dashboard
 * display state. `repairing` only applies while status is `running` and the
 * most recent transition for the task is a self-repair bounce; `waiting_approval`
 * maps directly to `awaiting_judgement` (used for both plan-approval and
 * verify adversarial-review gates — see plan.md「状態判定ロジック」).
 *
 * @param queueStatus - WorkflowQueueItem.status. / キュー項目の状態
 * @param latestTransitionCause - Most recent WorkflowTransition.cause for the task, or null when none recorded yet. / 直近の遷移cause
 * @returns Dashboard display state. / ダッシュボード表示状態
 */
export function deriveExecutionState(
  queueStatus: string,
  latestTransitionCause: string | null,
): ExecutionDashboardState {
  if (
    queueStatus === 'running' &&
    latestTransitionCause !== null &&
    REPAIR_BOUNCE_CAUSES.has(latestTransitionCause)
  ) {
    return 'repairing';
  }
  switch (queueStatus) {
    case 'queued':
      return 'queued';
    case 'waiting_approval':
      return 'awaiting_judgement';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'running';
    default:
      // Defensive fallback for a future/unknown status value — surfaced as
      // "running" rather than throwing, since the dashboard is read-only.
      return 'running';
  }
}

/** Input for {@link evaluateStall}. */
export interface StallEvaluationInput {
  /** WorkflowQueueItem.status. / キュー項目の状態 */
  status: string;
  /** WorkflowQueueItem.queuedAt. / キュー投入時刻 */
  queuedAt: Date;
  /** WorkflowQueueItem.startedAt, or null if not yet started. / 実行開始時刻 */
  startedAt: Date | null;
  /** Current time (ms epoch). / 現在時刻(ms) */
  nowMs: number;
  /** UserSettings.executionStallThresholdMinutes (already clamped/defaulted by the caller). / 停滞閾値(分) */
  thresholdMinutes: number;
}

/** Result of {@link evaluateStall}. */
export interface StallEvaluationResult {
  /** Whether the task has stalled (no progress for >= thresholdMinutes). / 停滞判定 */
  stalled: boolean;
  /** Minutes elapsed since the reference timestamp (startedAt, falling back to queuedAt). / 経過分 */
  elapsedMinutes: number;
}

/**
 * Evaluates whether a task has stalled: no progress for at least
 * `thresholdMinutes` since it started (falling back to when it was queued, if
 * not yet started). Terminal statuses (completed/failed/cancelled) are never
 * stalled — a finished task cannot be "stuck".
 *
 * @param input - Status, timestamps, current time, and threshold. / 状態・時刻・現在時刻・閾値
 * @returns Stalled flag plus elapsed minutes since the reference timestamp. / 停滞判定＋経過分
 */
export function evaluateStall(input: StallEvaluationInput): StallEvaluationResult {
  const referenceMs = (input.startedAt ?? input.queuedAt).getTime();
  const elapsedMinutes = Math.max(0, Math.round((input.nowMs - referenceMs) / 60000));
  if (input.status === 'completed' || input.status === 'cancelled' || input.status === 'failed') {
    return { stalled: false, elapsedMinutes };
  }
  return { stalled: elapsedMinutes >= input.thresholdMinutes, elapsedMinutes };
}
