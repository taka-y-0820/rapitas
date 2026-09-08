/** Lifecycle admission for a reviewed replan; callers must supply fresh transactional reads. */
export interface ReplanLifecycleSnapshot {
  status: string;
  workflowStatus: string | null;
  updatedAt: Date;
  latestExecutionStatus: string | null;
  latestStopCause: string | null;
  themeStatus: string | null;
  priorReplans: number;
}

/** Fail closed for unavailable/invalid counters, protected states, and stale evaluation. */
export function rejectReplanLifecycle(
  current: ReplanLifecycleSnapshot,
  evaluatedUpdatedAt: Date,
): string | null {
  if (current.updatedAt.getTime() !== evaluatedUpdatedAt.getTime()) return 'stale_task';
  if (current.status !== 'in-progress') return 'protected_task_status';
  if (!['plan_approved', 'in_progress', 'verify_done'].includes(current.workflowStatus ?? '')) {
    return 'protected_workflow_status';
  }
  if (
    ['cancelled', 'canceled', 'canceling', 'cancelling'].includes(
      current.latestExecutionStatus ?? '',
    )
  ) {
    return 'execution_stopped';
  }
  if (current.latestStopCause !== null) return 'stop_not_resumed';
  if (current.themeStatus === 'stopping' || current.themeStatus?.startsWith('paused')) {
    return 'theme_paused';
  }
  if (!Number.isSafeInteger(current.priorReplans) || current.priorReplans < 0)
    return 'invalid_budget';
  if (current.priorReplans >= 3) return 'budget_exhausted';
  return null;
}
