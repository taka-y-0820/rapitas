/**
 * workflow-runner-item-helpers
 *
 * Small standalone helpers for WorkflowRunner's per-item execution loop:
 * max-iteration budget resolution, phase-timeout role resolution, and the
 * subtask-parent failure notification. Extracted from workflow-runner.ts
 * (file-size split); contains no queue/dispatch logic.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { resolveTaskWorkflowState, resolveTaskForPlanApproval } from '../task/task-resolver';
import type { WorkflowRole, WorkflowAdvanceResult } from './workflow-types';
import type { TaskWorkflowState } from '../task/task-resolver';

const log = createLogger('workflow-runner');

// Upper bound for the per-phase role lookup used to pick the timeout backstop
// (task 546). This is NOT an agent/phase timeout value — it only caps how long
// the runner waits for the (normally memory-cached) mode-config read before
// falling back to the role-less default backstop.
const ROLE_RESOLVE_BUDGET_MS = 1000;

/**
 * Resolve the max phase-iteration budget for a single workflow item's loop.
 * NOTE: Long-run knob. 20 phases fits the normal pipeline + a couple of
 * repair bounces; raise RAPITAS_RUNNER_MAX_ITERATIONS (together with
 * AUTO_RUN_MAX_TASK_WALL_MS and verifyRepairLimit / RAPITAS_MAX_CI_REPAIRS)
 * to let a task iterate implement→evaluate for hours. Floor of 1 keeps a
 * typo from disabling execution entirely.
 *
 * @returns Max iterations for the phase loop. / フェーズループの最大反復回数
 */
export function resolveMaxIterations(): number {
  return Math.max(1, parseInt(process.env.RAPITAS_RUNNER_MAX_ITERATIONS ?? '20', 10) || 20);
}

/**
 * Resolve the phase-timeout backstop for the phase about to run, based on the
 * role that phase dispatches as. Fail-open: role resolution is a timeout
 * refinement only — if it throws or is slow (cold DB read), fall back to the
 * role-less default backstop instead of failing/stalling the phase.
 *
 * @param task - Current task workflow state (for workflowMode). / タスク状態
 * @param currentStatus - The phase about to run. / これから実行するフェーズ
 * @returns Phase timeout in milliseconds. / フェーズタイムアウト(ミリ秒)
 */
export async function resolvePhaseTimeoutMs(
  task: TaskWorkflowState,
  currentStatus: string,
): Promise<number> {
  let nextRole: WorkflowRole | undefined;
  try {
    const rolePromise = (async () => {
      const { getModeSettings, buildRoleByStatus } = await import('./workflow-mode-config');
      const { narrowWorkflowMode } = await import('./workflow-types.guards.generated');
      const modeSettings = await getModeSettings(narrowWorkflowMode(task.workflowMode));
      return buildRoleByStatus(modeSettings)[currentStatus];
    })();
    // Swallow a rejection that lands after the race is lost — the try/catch
    // below only observes rejections that happen while racing.
    rolePromise.catch(() => {});
    nextRole = await Promise.race([
      rolePromise,
      new Promise<undefined>((res) => setTimeout(res, ROLE_RESOLVE_BUDGET_MS, undefined)),
    ]);
  } catch (roleResolveErr) {
    log.warn(
      { err: roleResolveErr, taskId: task.id, currentStatus },
      '[WorkflowRunner] Role resolution for phase timeout failed — using the default backstop',
    );
  }
  const { getPhaseTimeoutMs } = await import('../agents/execution-timeouts');
  return getPhaseTimeoutMs(nextRole);
}

/**
 * Whether a `plan_created` task should skip the waiting_approval pause and
 * advance immediately — either the task itself or (for a subtask) the global
 * user setting opted into auto-approval.
 *
 * @param taskId - Task sitting at plan_created. / plan_created のタスクID
 * @returns true when the plan should auto-approve. / 自動承認すべきなら true
 */
export async function shouldAutoApprovePlan(taskId: number): Promise<boolean> {
  const taskForApproval = await resolveTaskForPlanApproval(taskId);
  const userSettings = await prisma.userSettings.findFirst();
  const isSubtask = taskForApproval?.parentId != null;
  return !!(
    taskForApproval?.autoApprovePlan ||
    userSettings?.autoApprovePlan ||
    (isSubtask && (userSettings as Record<string, unknown>)?.autoApproveSubtaskPlan)
  );
}

/**
 * Race a phase's advanceWorkflow call against its timeout backstop.
 *
 * @param orchestrator - Orchestrator exposing advanceWorkflow. / ワークフロー進行を持つオーケストレータ
 * @param taskId - Task whose phase is advancing. / 進行対象タスクID
 * @param phaseTimeoutMs - Timeout backstop in milliseconds. / タイムアウト(ミリ秒)
 * @returns The phase result, or rejects with the timeout error. / フェーズ結果
 */
export async function raceWorkflowAdvance(
  orchestrator: { advanceWorkflow(taskId: number): Promise<WorkflowAdvanceResult> },
  taskId: number,
  phaseTimeoutMs: number,
): Promise<WorkflowAdvanceResult> {
  // NOTE: Breadcrumb for the silent first-advance hang after a restart
  // (2026-08-30: 16 min with zero log lines). If this line is the last one
  // before silence, the hang is inside advanceWorkflow — between this log and
  // the next stage log (preflight done → overlap guard → prepare → probe).
  log.info({ taskId, phaseTimeoutMs }, '[WorkflowRunner] Advancing workflow (race armed)');
  const executionPromise = orchestrator.advanceWorkflow(taskId);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      const mins = Math.round(phaseTimeoutMs / 60000);
      reject(new Error(`Phase execution timeout for task ${taskId} (${mins} minutes)`));
    }, phaseTimeoutMs);
  });
  return Promise.race([executionPromise, timeoutPromise]);
}

/**
 * Brief wait between phases (DB update stabilization), abortable.
 *
 * @param signal - Abort signal (auto-run stop). / 中断シグナル
 */
export async function waitBeforeNextPhase(signal: AbortSignal): Promise<void> {
  await new Promise((resolve) => {
    const waitTimeout = setTimeout(resolve, 1000);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(waitTimeout);
        resolve(undefined);
      },
      { once: true },
    );
  });
}

/**
 * When a SUBTASK's queue item ends in a non-completed terminal state, the
 * 'completed' path that normally notifies the parent never runs — so the
 * parent's "all siblings terminal" gate (onSubtaskCompleted) is never
 * re-evaluated and the parent hangs forever at in-progress. Terminalize the
 * subtask's task.status and notify the parent so it can finalize (as blocked
 * when a subtask failed). No-op for non-subtasks (parentId === null).
 *
 * @param taskId - The failed subtask's id / 失敗したサブタスクID
 */
export async function notifyParentOnSubtaskFailure(taskId: number): Promise<void> {
  try {
    const task = await resolveTaskWorkflowState(taskId);
    if (!task?.parentId) return;
    // 'failed' is terminal for onSubtaskCompleted's all-siblings-done gate.
    if (!['done', 'failed', 'cancelled', 'archived'].includes(task.status)) {
      await prisma.task
        .update({ where: { id: taskId }, data: { status: 'failed', completedAt: new Date() } })
        .catch(() => {});
    }
    const { onSubtaskCompleted } = await import('./subtask-completion-handler');
    await onSubtaskCompleted(taskId).catch((err) => {
      log.warn({ err, taskId }, '[WorkflowRunner] Parent finalize after subtask failure failed');
    });
  } catch (err) {
    log.warn({ err, taskId }, '[WorkflowRunner] notifyParentOnSubtaskFailure failed');
  }
}

/** Stop a failed phase before retrying, including a CLI abandoned by its timeout. */
export async function stopFailedPhaseAgents(taskId: number, errorMessage: string): Promise<void> {
  try {
    const { stopTaskAgents } = await import('../agents/stop-task-agents');
    await stopTaskAgents(taskId, { errorMessage: `Phase failed: ${errorMessage}` });
  } catch (err) {
    log.warn({ err, taskId }, '[WorkflowRunner] Failed to stop agents after phase error');
  }
}
