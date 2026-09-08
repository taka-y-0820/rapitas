/**
 * Workflow Types
 *
 * Shared TypeScript type aliases and interfaces used across workflow
 * orchestration modules. SSOT for WorkflowRole/WorkflowStatus/WorkflowMode types,
 * runtime arrays. Type guards are auto-generated to workflow-types.guards.generated.ts.
 * All consumers must import types/constants from here and guards from the generated file.
 */

/**
 * Runtime array of all valid workflow roles. Derive WorkflowRole from this
 * so the type and the runtime list can never drift apart.
 */
// NOTE: 'reviewer' retired 2026-08 — plan-review is covered by phase-critic +
// adversarial diff-review (independent gates). The role was structurally
// unreachable on the auto-run path (the queue runner always branches away at
// plan_created), and its self-referential nextStatus (plan_created →
// plan_created) was a loop hazard on manual runs.
export const WORKFLOW_ROLES = [
  'researcher',
  'planner',
  'implementer',
  'verifier',
  'auto_verifier',
] as const;

export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

/**
 * Runtime array of all valid workflow file types. Derive WorkflowFileType from this
 * so the type and the runtime validation list can never drift apart.
 */
export const WORKFLOW_FILE_TYPES = ['research', 'question', 'plan', 'verify'] as const;

export type WorkflowFileType = (typeof WORKFLOW_FILE_TYPES)[number];

/**
 * Runtime array of all valid workflow statuses. Derive WorkflowStatus from this
 * so the type and the runtime validation list can never drift apart.
 * NOTE: `awaiting_question` は question.md 保存後のユーザー回答待ち過渡状態。
 * 直前の status を記憶して回答後に戻すことで再実行を継続させる。
 */
export const WORKFLOW_STATUSES = [
  'draft',
  'research_done',
  'plan_created',
  'plan_approved',
  'in_progress',
  'awaiting_question',
  'verify_done',
  'completed',
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * `awaiting_question` の前段にあった status を保持する型。
 * 質問が解消された際にこの値へ戻す。
 */
export type ResumableWorkflowStatus = Exclude<
  WorkflowStatus,
  'awaiting_question' | 'completed' | 'verify_done'
>;

/**
 * Runtime array of all valid workflow modes. Derive WorkflowMode from this
 * so the type and the runtime validation list can never drift apart.
 */
// @gen-guard-fallback: comprehensive
export const WORKFLOW_MODES = ['lightweight', 'standard', 'comprehensive'] as const;

export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

/** Maps a workflow status to the role that should execute next and its expected output. */
export interface RoleTransition {
  role: WorkflowRole;
  /** null for the implementer role, which writes code rather than a workflow file */
  outputFile: WorkflowFileType | null;
  nextStatus: WorkflowStatus;
}

/** Return value of WorkflowOrchestrator.advanceWorkflow and the executor functions. */
export interface WorkflowAdvanceResult {
  /** A committed replan invalidated this phase; re-read state without consuming a failure retry. */
  superseded?: boolean;
  success: boolean;
  role: WorkflowRole;
  status: WorkflowStatus;
  output?: string;
  error?: string;
  executionId?: number;
  /**
   * True when advanceWorkflow returned WITHOUT spawning an agent because
   * another phase was already executing for this task (the per-task mutex was
   * held). Callers must treat this as "still busy, retry later" — NOT a failure.
   * / 別フェーズ実行中のためエージェントを起動せず戻った場合に true。
   */
  skipped?: boolean;
  /**
   * Set with `skipped` when the implementer was HELD (not busy): the files its
   * research/plan names are still changing in another open auto-PR. The runner
   * re-queues the item exactly as for `skipped`; the text is for the log.
   * / 実装フェーズをオープンPRとのファイル重複で保留した理由。
   */
  held?: string;
}
