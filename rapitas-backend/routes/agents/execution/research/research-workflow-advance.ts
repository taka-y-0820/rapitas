/**
 * execution/research-workflow-advance
 *
 * Advances the workflow after a research report was successfully saved:
 * updates task/session status, records the transition, flips the
 * AgentExecution row, emits the completion timeline event, and schedules
 * the next workflow phase.
 * Separated from research-phase-handler.ts to keep each file under 500 lines.
 */

import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { recordTransition } from '../../../../services/workflow/transition-recorder';
import { checkWorkflowInvariants } from '../../../../services/workflow/workflow-invariants';
import { readPromptLanguage } from '../../../../services/system/prompt-language-store';
import { getTaskExecutionCancellationVersion } from '../../../../services/agents/task-execution-lock';

const log = createLogger('routes:agent-execution:research-workflow-advance');

/** Parameters for advanceAfterResearchSave. */
export interface AdvanceAfterResearchSaveParams {
  taskIdNum: number;
  sessionId: number;
  researchMarkdown: string;
  revertedDiff: boolean;
}

/**
 * Update task / session status and advance the workflow after research.md
 * was saved (and the phase critic did not reject it).
 *
 * @param params - Post-save workflow advance context / 保存後のワークフロー前進コンテキスト
 */
export async function advanceAfterResearchSave(
  params: AdvanceAfterResearchSaveParams,
): Promise<void> {
  const { taskIdNum, sessionId, researchMarkdown, revertedDiff } = params;
  const cancellationVersion = getTaskExecutionCancellationVersion(taskIdNum);
  const current = () => getTaskExecutionCancellationVersion(taskIdNum) === cancellationVersion;

  // Transition workflowStatus from 'draft' → 'research_done' so the next
  // phase (planner) is reachable. Without this, role-resolver still picks
  // 'researcher' for the next run because the workflow tracker thinks
  // research isn't done yet — that's the "後続のフェーズが実行されない" symptom.
  const taskBefore = await prisma.task
    .findUnique({
      where: { id: taskIdNum },
      select: { workflowStatus: true, workflowMode: true, updatedAt: true },
    })
    .catch(() => null);
  if (!current() || !taskBefore) return;
  const currentWf = taskBefore?.workflowStatus ?? 'draft';
  const nextWfStatus = currentWf === 'draft' ? 'research_done' : currentWf;

  const updated = await prisma.task
    .update({
      where: { id: taskIdNum, updatedAt: taskBefore.updatedAt },
      // task.status is hyphenated; workflowStatus uses the underscore form.
      data: { status: 'in-progress', workflowStatus: nextWfStatus },
    })
    .then(() => true)
    .catch((e) => {
      log.warn({ err: e, taskId: taskIdNum }, '[API] Failed to update task');
      return false;
    });
  if (!updated || !current()) return;
  if (currentWf !== nextWfStatus) {
    const violations = await checkWorkflowInvariants(taskIdNum);
    if (!current()) return;
    await recordTransition({
      taskId: taskIdNum,
      fromStatus: currentWf,
      toStatus: nextWfStatus,
      actor: 'researcher',
      cause: 'phase_completed:researcher',
      phase: 'research',
      sessionId,
      metadata: {
        revertedDiff,
        reportChars: researchMarkdown.length,
      },
      invariantViolation: violations.length > 0,
      invariantMessage:
        violations.length > 0
          ? violations.map((v) => `${v.code}:${v.message}`).join(' | ')
          : undefined,
    });
    // Task 766: attempt missing_file self-repair AFTER the transition above
    // is recorded (research-phase counterpart to status-transition.ts).
    const missingFileViolation = violations.find((v) => v.code === 'missing_file');
    if (missingFileViolation) {
      const { repairMissingFile } = await import('../../../../services/workflow/invariant-repair');
      if (!current()) return;
      await repairMissingFile(taskIdNum, missingFileViolation).catch((err) => {
        log.warn({ err, taskId: taskIdNum }, '[API] repairMissingFile threw — failing open');
        return { repaired: false as const };
      });
    }
  }
  if (!current()) return;
  await prisma.agentSession
    .update({
      where: { id: sessionId, status: { notIn: ['cancelled', 'canceled', 'canceling'] } },
      data: {
        status: 'completed',
        completedAt: new Date(),
        errorMessage: revertedDiff
          ? 'Research saved successfully. Note: agent attempted code changes — reverted.'
          : null,
      },
    })
    .catch((e) => log.warn({ err: e, sessionId }, '[API] Failed to set session completed'));

  // Flip the AgentExecution row from `post_processing` (set when codex
  // exited 0 in research mode) to `completed`, now that research.md has
  // actually been saved and the workflow has been advanced. This is what
  // the FE Log Viewer Header reads to paint the green "完了" badge —
  // emitting it BEFORE this point caused the user-reported "途中で完了"
  // symptom because the badge appeared while the post-handler was still
  // running.
  if (!current()) return;
  await prisma.agentExecution
    .updateMany({
      where: { sessionId, status: 'post_processing' },
      data: { status: 'completed', completedAt: new Date() },
    })
    .catch((e) =>
      log.warn(
        { err: e, sessionId },
        '[API] Failed to flip post_processing → completed on AgentExecution',
      ),
    );

  // Emit the success timeline event NOW (deferred from task-executor.ts
  // for investigation mode) so external listeners only see the event
  // after research.md is on disk and the workflow has been queued for
  // the next phase.
  try {
    if (!current()) return;
    const { appendEvent } = await import('../../../../services/memory/timeline');
    const latestExec = await prisma.agentExecution
      .findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, agentConfig: { select: { agentType: true } } },
      })
      .catch(() => null);
    if (latestExec) {
      if (!current()) return;
      await appendEvent({
        eventType: 'agent_execution_completed',
        actorType: 'agent',
        actorId: latestExec.agentConfig?.agentType ?? 'codex',
        payload: {
          executionId: latestExec.id,
          taskId: taskIdNum,
          success: true,
          phase: 'research',
        },
        correlationId: `execution_${latestExec.id}`,
      }).catch(() => {});
    }
  } catch {
    /* timeline emission is best-effort */
  }

  log.info(
    { taskId: taskIdNum, workflowStatus: nextWfStatus, mode: taskBefore?.workflowMode },
    '[API] Research phase completed',
  );

  // Auto-advance to the next workflow phase (planner) after research.
  // PREVIOUSLY this only fired when `currentWf === 'draft'`, which broke
  // re-runs: if the task had been reset (reset-route does not clear
  // workflowStatus) the status was already `research_done` from the last
  // attempt, the condition returned false, and the planner phase never
  // started — leaving the FE stuck on the "completed" badge of the codex
  // execution log without any further activity. The orchestrator already
  // no-ops when the role's output file already exists, so it is safe to
  // call advanceWorkflow regardless of the previous status as long as
  // the task is in a managed workflow mode.
  const isManagedMode =
    taskBefore?.workflowMode === 'comprehensive' ||
    taskBefore?.workflowMode === 'standard' ||
    taskBefore?.workflowMode === 'lightweight';
  const advanceableStatuses = new Set(['draft', 'research_done', 'plan_approved', 'in_progress']);
  const nextPhaseLabel: Record<string, string> = {
    draft: 'researcher',
    research_done: 'planner',
    plan_approved: 'implementer',
    in_progress: 'verifier',
  };
  if (!current()) return;
  if (isManagedMode && advanceableStatuses.has(nextWfStatus)) {
    const nextPhase = nextPhaseLabel[nextWfStatus] ?? 'unknown';
    log.info(
      {
        taskId: taskIdNum,
        mode: taskBefore?.workflowMode,
        fromStatus: nextWfStatus,
        nextPhase,
      },
      '[API] Next phase queued',
    );
    // 1s delay so the workflowStatus update commits before the next phase
    // reads it via role-resolver.
    setTimeout(async () => {
      try {
        const { WorkflowOrchestrator } =
          await import('../../../../services/workflow/workflow-orchestrator');
        // Normal owner-scoped release keeps this version; an explicit stop increments it.
        if (getTaskExecutionCancellationVersion(taskIdNum) !== cancellationVersion) return;
        await WorkflowOrchestrator.getInstance().advanceWorkflow(taskIdNum, readPromptLanguage());
        log.info({ taskId: taskIdNum, nextPhase }, '[API] Auto-advanced workflow after research');
      } catch (advanceErr) {
        log.error(
          { err: advanceErr, taskId: taskIdNum },
          '[API] Auto-advance to next phase failed (user can re-run manually)',
        );
      }
    }, 1000);
  } else {
    log.warn(
      {
        taskId: taskIdNum,
        isManagedMode,
        nextWfStatus,
        mode: taskBefore?.workflowMode,
      },
      '[API] No next phase queued — workflow is in a non-advanceable state (waiting for user action or already terminal)',
    );
  }
}
