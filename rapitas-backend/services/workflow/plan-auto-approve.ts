/**
 * plan-auto-approve
 *
 * Single source of truth for "should the plan be auto-approved" — used by
 * BOTH the HTTP path (`PUT /workflow/tasks/:id/files/plan` → handleSaveFile)
 * AND the orchestrator path (`workflow-cli-executor` → writeWorkflowFile).
 *
 * Previously this logic lived only in the HTTP handler. When the planner
 * phase started saving plan.md via the orchestrator's direct
 * filesystem write (no HTTP round-trip), the auto-approve check was
 * silently skipped — leaving the task stuck at `plan_created` even when
 * the user had `userSettings.autoApprovePlan = true` configured.
 */
import { ExecutionCancelledError } from '../agents/execution-cancelled-error';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { recordTransition } from './transition-recorder';
import { getTaskExecutionCancellationVersion } from '../agents/task-execution-lock';

const log = createLogger('plan-auto-approve');

/** A manual rejection remains a human gate until a later manual approval. */
async function isManualPlanApprovalHeld(taskId: number): Promise<boolean> {
  try {
    const decision = await prisma.workflowTransition.findFirst({
      where: { taskId, cause: { in: ['manual_plan_rejected', 'manual_plan_approved'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { cause: true },
    });
    return decision?.cause === 'manual_plan_rejected';
  } catch (err) {
    log.warn({ err, taskId }, '[plan-auto-approve] Cannot verify manual approval; holding');
    return true;
  }
}

/**
 * Resolves whether the plan WILL be auto-approved for this task: task-level flag
 * OR the global userSettings flag OR (for subtasks) the subtask flag — the SAME
 * condition maybeAutoApprovePlan uses to flip the status.
 *
 * NOTE: the agent prompt must branch on this EFFECTIVE value, not just the
 * task-level flag. Otherwise, with only the global setting enabled, the prompt
 * tells the agent to "stop and wait for approval" while the plan is silently
 * auto-approved — so the run ends at plan.md and never implements.
 *
 * @param taskId - Task whose plan policy is being resolved. / 対象タスク
 * @returns True when the plan will be auto-approved. / 自動承認されるか
 */
export async function resolveEffectiveAutoApprovePlan(taskId: number): Promise<boolean> {
  const [userSettings, task] = await Promise.all([
    prisma.userSettings.findFirst().catch(() => null),
    prisma.task
      .findUnique({ where: { id: taskId }, select: { autoApprovePlan: true, parentId: true } })
      .catch(() => null),
  ]);
  if (!task) return false;
  if (await isManualPlanApprovalHeld(taskId)) return false;
  const isSubtask = task.parentId !== null && task.parentId !== undefined;
  const settings = userSettings as Record<string, unknown> | null;
  return (
    !!task.autoApprovePlan ||
    !!settings?.autoApprovePlan ||
    (isSubtask && !!settings?.autoApproveSubtaskPlan)
  );
}

export interface PlanAutoApproveResult {
  /** Effective status after this helper runs. */
  newStatus: 'plan_created' | 'plan_approved';
  /** True when status was flipped from plan_created → plan_approved. */
  autoApproved: boolean;
  /** Reason recorded in the transition log when autoApproved=true. */
  reason?: string;
}

/**
 * Inspect the task / global settings and flip workflowStatus to
 * `plan_approved` when auto-approval is enabled. Idempotent: calling this
 * with a task that's already plan_approved is a no-op. Failures are
 * downgraded to WARN — auto-approve is a convenience, not a correctness
 * requirement.
 *
 * @param taskId - Task whose plan was just saved. / 計画保存対象タスク
 * @param language - Used by the auto-advance call. / 自動進行用の言語
 * @param opts.autoAdvance - When true (default), schedule the next
 *   workflow phase via WorkflowOrchestrator after a 1s delay. Pass false
 *   when the caller wants to drive advance themselves.
 * @returns Resulting status + flag. / 結果ステータスとフラグ
 */
export async function maybeAutoApprovePlan(
  taskId: number,
  language: 'ja' | 'en' = 'ja',
  opts: { autoAdvance?: boolean } = {},
): Promise<PlanAutoApproveResult> {
  const cancellationVersion = getTaskExecutionCancellationVersion(taskId);
  const userSettings = await prisma.userSettings.findFirst().catch(() => null);
  const task = await prisma.task
    .findUnique({
      where: { id: taskId },
      select: {
        autoApprovePlan: true,
        parentId: true,
        workflowStatus: true,
        status: true,
        updatedAt: true,
      },
    })
    .catch(() => null);

  // Already past plan_created — nothing to do.
  if (!task || task.workflowStatus !== 'plan_created') {
    return {
      newStatus: (task?.workflowStatus as 'plan_created' | 'plan_approved') ?? 'plan_created',
      autoApproved: false,
    };
  }

  const isSubtask = task.parentId !== null && task.parentId !== undefined;
  const settingsRecord = userSettings as Record<string, unknown> | null;
  const taskLevel = !!task.autoApprovePlan;
  const globalLevel = !!settingsRecord?.autoApprovePlan;
  const subtaskLevel = isSubtask && !!settingsRecord?.autoApproveSubtaskPlan;

  if (!taskLevel && !globalLevel && !subtaskLevel) {
    return { newStatus: 'plan_created', autoApproved: false };
  }
  if (await isManualPlanApprovalHeld(taskId)) {
    return { newStatus: 'plan_created', autoApproved: false };
  }

  const reason = taskLevel
    ? 'task-level autoApprovePlan setting enabled'
    : subtaskLevel
      ? 'subtask autoApproveSubtaskPlan setting enabled'
      : 'global autoApprovePlan setting enabled';

  if (getTaskExecutionCancellationVersion(taskId) !== cancellationVersion) {
    return { newStatus: 'plan_created', autoApproved: false };
  }
  const approved = await prisma.task.updateMany({
    where: {
      id: taskId,
      workflowStatus: 'plan_created',
      status: 'in-progress',
      updatedAt: task.updatedAt,
    },
    data: { workflowStatus: 'plan_approved', updatedAt: new Date() },
  });
  if (approved.count !== 1) return { newStatus: 'plan_created', autoApproved: false };

  await recordTransition({
    taskId,
    fromStatus: 'plan_created',
    toStatus: 'plan_approved',
    actor: 'system',
    cause: 'auto_approve_plan',
    phase: 'plan',
    metadata: {
      taskLevelAutoApprove: taskLevel,
      globalAutoApprove: globalLevel,
      isSubtask,
      reason,
    },
  });

  // Decision journal: the auto-approval is a prediction too — recording it
  // with decidedBy:'auto' lets calibration stats compare the policy's accuracy
  // against human gate calls. Fire-and-forget.
  void import('../memory/decision-journal')
    .then(async ({ recordPlanDecision }) => {
      const t = await prisma.task
        .findUnique({ where: { id: taskId }, select: { title: true, themeId: true } })
        .catch(() => null);
      return recordPlanDecision({
        taskId,
        approved: true,
        decidedBy: 'auto',
        reason,
        taskTitle: t?.title ?? null,
        themeId: t?.themeId ?? null,
      });
    })
    .catch(() => {});

  await prisma.activityLog
    .create({
      data: {
        taskId,
        action: 'plan_auto_approved',
        metadata: JSON.stringify({
          previousStatus: 'plan_created',
          newStatus: 'plan_approved',
          reason,
          taskLevelSetting: taskLevel,
          globalLevelSetting: globalLevel,
          subtaskAutoApprove: subtaskLevel,
          isSubtask,
        }),
        createdAt: new Date(),
      },
    })
    .catch((err) => {
      log.warn({ err, taskId }, '[plan-auto-approve] Failed to write activity log');
    });

  log.info({ taskId, reason }, '[plan-auto-approve] Plan auto-approved');

  if (opts.autoAdvance !== false) {
    // 1s delay so the workflowStatus update commits before the orchestrator
    // queries it via role-resolver.
    setTimeout(async () => {
      try {
        const { WorkflowOrchestrator } = await import('./workflow-orchestrator');
        if (getTaskExecutionCancellationVersion(taskId) !== cancellationVersion) {
          log.info({ taskId }, '[plan-auto-approve] Stop revoked the scheduled next phase');
          return;
        }
        if (await isManualPlanApprovalHeld(taskId)) return;
        if (getTaskExecutionCancellationVersion(taskId) !== cancellationVersion) return;
        const result = await WorkflowOrchestrator.getInstance().advanceWorkflow(taskId, language);
        log.info(
          { taskId, success: result.success, error: result.error },
          '[plan-auto-approve] Auto-advance after auto-approval',
        );
      } catch (err) {
        if (err instanceof ExecutionCancelledError) {
          log.info(
            { taskId, reason: err.message },
            '[plan-auto-approve] Auto-advance cancelled by stop',
          );
          return;
        }
        log.error({ err, taskId }, '[plan-auto-approve] Auto-advance failed (non-fatal)');
      }
    }, 1000);
  }

  return { newStatus: 'plan_approved', autoApproved: true, reason };
}
