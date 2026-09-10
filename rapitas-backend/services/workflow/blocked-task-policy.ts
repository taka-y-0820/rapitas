/**
 * blocked-task-policy
 *
 * Single source of truth for blocked-task self-heal thresholds and the pure
 * exclusion classifier shared by the requeue (blind retry) and escalation
 * passes. Not responsible for any DB access or side effects — keeping both
 * passes on the same constants/classification prevents them from drifting
 * apart and double-handling (or double-skipping) the same task.
 */

/**
 * Auto-retry a BLOCKED task at most this many times before leaving it blocked
 * for the user. Blocked auto-created tasks otherwise sit forever, holding the
 * backlog promotion cap and starving the loop (observed: 5 blocked tasks =
 * cap 5 → idle with 20 open concerns un-promoted). A bounded retry re-runs
 * them — most were blocked by a since-fixed bug and now pass; genuine failures
 * exhaust the budget and stay blocked. / blocked タスクの自動再試行上限。
 */
export const MAX_BLOCKED_RETRY = 2;

/**
 * Wait this long after a task was blocked before auto-retrying — let the dust
 * settle (don't race the run that just blocked it) and avoid hammering a task
 * that re-blocks instantly. / blocked 後この時間待ってから再試行。
 */
export const BLOCKED_RETRY_SETTLE_MS = 3 * 60 * 1000;

/**
 * Don't re-queue orphans/blocked tasks older than this — ancient ones are
 * likely abandoned. NOTE: this bounds the RETRY query only. Old blocked tasks
 * must still be visible to evidence correction and escalation (task 615) —
 * excluding them there turns "no retry" into permanent abandonment.
 */
export const MAX_ORPHAN_REQUEUE_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Interval between re-escalation notifications for a blocked task that stays
 * unresolved past its first (permanent, one-shot) escalation. Far longer than
 * the minute/settle-order thresholds above to avoid notification fatigue, but
 * short enough to bound task 666's observed 39-hour silent stall to roughly
 * this length. / 再エスカレーション間隔（初回エスカレーション後も未解決の場合）。
 */
export const BLOCKED_REESCALATION_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * WorkflowTransition.cause recorded when a verify-repair loop is cut off for
 * NON-CONVERGENCE (task 619): the same acceptance criterion was flagged
 * unaddressed by 2+ repair bounces. Lives here (dependency-free policy module)
 * so verify-self-repair (writer) and both reconciler passes (readers) share
 * one constant without a circular import.
 */
export const VERIFY_NON_CONVERGENCE_CAUSE = 'verify_repair_non_convergence';

/**
 * WorkflowTransition.cause recorded when a lightweight PR-only recovery
 * attempt (task 681) fails for a task blocked by `verify_pr_not_created`.
 * Lives here (dependency-free policy module) so blocked-pr-retry-recovery
 * (writer) and workflow-reconciler-requeue (reader, gating a single attempt
 * per blocked window) share one constant without a circular import. NOT part
 * of {@link classifyBlockedExclusion}'s exclusion set by design — the
 * lightweight retry runs BEFORE the blind-retry/escalation split and either
 * completes the task or falls through unchanged to that existing logic (see
 * plan.md §実装者への申し送り事項 #3).
 */
export const PR_RETRY_LIGHTWEIGHT_CAUSE = 'verify_pr_retry_lightweight';

/**
 * Escalate a task blocked by repeated PR-creation failures
 * (`verify_pr_not_created`) after this many total occurrences, independent of
 * `MAX_BLOCKED_RETRY` (task 713).
 *
 * Before this constant existed, "escalate after 3 PR-creation failures" was
 * only an EMERGENT property of two independently-tuned budgets interacting:
 * one lightweight PR-only retry (blocked-pr-retry-recovery.ts) precedes each
 * full reset, and `MAX_BLOCKED_RETRY` full resets are allowed, so exhaustion
 * happened to land on the 3rd `verify_pr_not_created` (1 lightweight retry +
 * 2 full-reset rounds). That alignment was never guaranteed by any single
 * piece of code — changing `MAX_BLOCKED_RETRY` alone would silently shift it.
 * This constant makes "escalate within 3 PR-creation failures" a direct,
 * testable criterion on the actual failure count, so it holds regardless of
 * `MAX_BLOCKED_RETRY`'s value. / PR作成失敗の直接的な早期エスカレーション基準
 */
export const MAX_PR_RECOVERY_ATTEMPTS = 3;

/**
 * Default verify→implement repair budget when UserSettings.verifyRepairLimit
 * is unset. Single source of truth shared by verify-self-repair's
 * resolveMaxRepairs and {@link resolveVerifyRepairLimit} below — the two
 * previously hardcoded different fallbacks (2 vs 3), which only diverged when
 * no UserSettings row existed (task 705). / 修復予算の既定値（単一ソース）
 *
 * NOTE (task 727): task#710 observed 4 `verify_repair` bounces in one window
 * despite this default being 2 — unconfirmed whether the live UserSettings
 * row had `verifyRepairLimit` set above the default (UI-configurable, see
 * {@link resolveVerifyRepairLimit}) or the count/limit comparison itself has
 * a gap. `blocked-task-policy.test.ts` pins this default and exercises the
 * UserSettings override at 2/3/4 so a future regression here is caught.
 */
export const DEFAULT_VERIFY_REPAIR_LIMIT = Math.max(
  0,
  parseInt(process.env.RAPITAS_MAX_VERIFY_REPAIRS ?? '2', 10) || 2,
);

/**
 * Default CI-failure -> implement repair budget (task 837). Single source of
 * truth shared by ci-self-repair's attemptCiRepair and
 * self-incident-watcher's dynamic repeat-loop threshold — previously defined
 * only inside ci-self-repair.ts, which self-incident-watcher.ts cannot safely
 * import from (it re-exports prisma via workflow-queue.ts from a different
 * module path than the one self-incident-watcher.test.ts mocks).
 */
export const DEFAULT_MAX_CI_REPAIRS = Math.max(
  0,
  parseInt(process.env.RAPITAS_MAX_CI_REPAIRS ?? '2', 10) || 2,
);

/**
 * `Task.workflowStatus` values that count as "a human already advanced this
 * task past its blocked point" for {@link healBlockedStatusDesync}-style
 * checks (task 802). `draft`/`research_done` are excluded — the plan has not
 * been approved yet, so there is no evidence a human reviewed and pushed the
 * task forward; `awaiting_question` is excluded because it is a dedicated
 * pause state owned by the existing escalation pass, not a desync.
 */
export const HUMAN_ADVANCED_WORKFLOW_STATUSES: readonly string[] = [
  'plan_created',
  'plan_approved',
  'in_progress',
  'verify_done',
];

/**
 * `WorkflowTransition.cause` values that count as an explicit human decision to
 * resume a task out of its CURRENT blocked hold, for
 * {@link healBlockedStatusDesync}-style checks (task 905). A bare `actor:'user'`
 * row is not enough on its own — task894 showed a stale, unrelated user
 * transition (`intake_question_answered`, a spec-question answer that resets
 * `workflowStatus` to `draft` and carries no resume intent) being accepted as
 * proof that a LATER, separately re-applied block was meant to be lifted.
 * Add a new cause here only when it represents a deliberate, gate-passing
 * human action taken with the task's blocked/failed status already in view
 * (e.g. a new resume API) — do not add causes that merely happen to carry
 * `actor:'user'` for unrelated reasons.
 */
export const EXPLICIT_RESUME_CAUSES: readonly string[] = [
  'task_retried',
  'manual_status_change',
  'manual_plan_approved',
  'manual_plan_rejected',
  'question_resolved',
];

/** Reason a blocked task is excluded from the blind auto-retry. */
export type BlockedExclusionReason =
  | 'awaiting_question'
  | 'verify_no_convergence'
  | 'abandoned_old'
  | 'verify_repair_exhausted'
  | 'retry_cap_exhausted'
  | 'pr_recovery_exhausted';

/** Classification of a blocked task: retryable, or an exclusion reason. */
export type BlockedClassification = BlockedExclusionReason | 'retryable';

/** Input facts for {@link classifyBlockedExclusion}. */
export interface BlockedClassificationInput {
  workflowStatus: string | null;
  /** Time since the task row last moved (ms). / 最終更新からの経過時間 */
  ageMs: number;
  /** verify_repair transitions since the last manual retry. / 修復回数 */
  repairs: number;
  verifyRepairLimit: number;
  /** blocked_auto_retry transitions so far. / 自動再試行回数 */
  attempts: number;
  /**
   * True when a VERIFY_NON_CONVERGENCE_CAUSE transition exists in the current
   * repair window — the task was cut off for repeating the same acceptance
   * criterion, so blind retry would just replay the non-converging loop.
   * / 非収束打ち切り済みか
   */
  nonConverged?: boolean;
  /**
   * Total `verify_pr_not_created` transitions ever recorded for the task
   * (unwindowed — a full reset discards the implementation but the PR-creation
   * failure pattern persists, task 713). Drives the `pr_recovery_exhausted`
   * classification independently of `attempts`. / PR作成失敗の累計回数
   */
  prNotCreatedCount?: number;
}

/**
 * Resolve the verify→implement repair budget from user settings, matching
 * verify-self-repair's resolveMaxRepairs (default 2, positive numbers only).
 *
 * @param settings - UserSettings row (or null when unavailable). / 設定行
 * @returns The effective repair limit. / 有効な修復上限
 */
export function resolveVerifyRepairLimit(
  settings: { verifyRepairLimit?: number | null } | null,
): number {
  return typeof settings?.verifyRepairLimit === 'number' && settings.verifyRepairLimit > 0
    ? settings.verifyRepairLimit
    : DEFAULT_VERIFY_REPAIR_LIMIT;
}

/**
 * Classify why a blocked task is excluded from blind auto-retry (or that it is
 * retryable). Must stay logically equivalent to requeueBlockedTasks' skip
 * conditions — escalation uses this to pick up exactly the tasks retry leaves
 * behind, so a drift here double-escalates tasks retry is about to handle.
 *
 * @param input - Task facts. / 判定材料
 * @returns Exclusion reason, or 'retryable' when the blind retry applies. / 分類結果
 */
export function classifyBlockedExclusion(input: BlockedClassificationInput): BlockedClassification {
  // Order matters: a paused question ALWAYS wins (never blind-retry it,
  // whatever its age/budget), then age (an ancient task is out of the retry
  // query entirely), then the budget/cap exclusions retry itself applies.
  if (input.workflowStatus === 'awaiting_question') return 'awaiting_question';
  // Non-convergence beats age/budget: the cutoff already established that
  // re-running cannot help (same criterion never progressed), whatever the
  // remaining retry budget says.
  if (input.nonConverged) return 'verify_no_convergence';
  if (input.ageMs > MAX_ORPHAN_REQUEUE_AGE_MS) return 'abandoned_old';
  if (input.repairs >= input.verifyRepairLimit) return 'verify_repair_exhausted';
  // Checked before the generic retry cap (task 713): a task blocked purely by
  // repeated PR-creation failures is classified by that specific failure mode
  // — see MAX_PR_RECOVERY_ATTEMPTS — rather than the coincidentally-aligned
  // generic budget below, which drifts if MAX_BLOCKED_RETRY ever changes.
  if ((input.prNotCreatedCount ?? 0) >= MAX_PR_RECOVERY_ATTEMPTS) return 'pr_recovery_exhausted';
  if (input.attempts >= MAX_BLOCKED_RETRY) return 'retry_cap_exhausted';
  return 'retryable';
}
