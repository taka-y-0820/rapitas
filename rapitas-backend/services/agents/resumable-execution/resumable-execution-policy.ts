/**
 * Resumable Execution Policy
 *
 * Single source of truth for "is this task terminal (and therefore its
 * interrupted AgentExecution rows are not resumable)". Shared by
 * `/agents/system-status`, `/agents/resumable-executions`, and the legacy
 * `/agents/interrupted-executions` so the three endpoints agree on what
 * counts as an operationally relevant interruption.
 */

/** Task.status values that make any interrupted execution under them non-resumable. */
export const TERMINAL_TASK_STATUSES = [
  'done',
  'completed',
  'cancelled',
  'failed',
  'archived',
] as const;

/** Task.workflowStatus values that make any interrupted execution under them non-resumable. */
export const TERMINAL_WORKFLOW_STATUSES = ['completed'] as const;

export interface ResumabilityTaskInfo {
  id?: number | null;
  status?: string | null;
  workflowStatus?: string | null;
}

/**
 * Whether a task is terminal — i.e. cannot have a legitimately resumable execution.
 * A missing task (null/undefined) is treated as non-terminal, matching the prior
 * `resumable-executions` behavior of only excluding a row when the task is known
 * to be terminal.
 *
 * @param task - Task status fields, or null/undefined if unknown / タスクの状態、不明ならnull/undefined
 * @returns true if the task is terminal / タスクが終端状態ならtrue
 */
export function isTaskTerminal(task: ResumabilityTaskInfo | null | undefined): boolean {
  if (!task) return false;
  if (task.status && (TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status))
    return true;
  if (
    task.workflowStatus &&
    (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(task.workflowStatus)
  ) {
    return true;
  }
  return false;
}

/**
 * Whether an `interrupted` execution is an operationally relevant resume candidate
 * (as opposed to a stale row left behind by a task that already finished, or one
 * whose task already has a fresh execution running elsewhere).
 *
 * @param execution - Execution status / 実行のstatus
 * @param task - Owning task's status fields / 所属タスクの状態
 * @param liveTaskIds - Task IDs that currently have a live (running/waiting) execution elsewhere; that task's older `interrupted` row must not be double-counted / 現在ライブ実行を持つタスクID集合(重複計上防止用)
 * @returns true if this execution is a real resume candidate / 本当に再開候補ならtrue
 */
export function isResumableInterrupted(
  execution: { status: string },
  task: ResumabilityTaskInfo | null | undefined,
  liveTaskIds: Set<number> = new Set(),
): boolean {
  if (execution.status !== 'interrupted') return false;
  if (task?.id != null && liveTaskIds.has(task.id)) return false;
  return !isTaskTerminal(task);
}
