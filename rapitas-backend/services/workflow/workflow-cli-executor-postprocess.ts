/**
 * Workflow CLI Executor Post-Processing
 *
 * Runs after a phase's status has been resolved: cleans up stray root-level
 * workflow files, flips the AgentExecution row from post_processing to
 * completed for investigation phases, emits the deferred timeline event, and
 * auto-advances the workflow to the next phase. Not responsible for status
 * resolution itself (see workflow-cli-executor-epilogue).
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { cleanupRootWorkflowFiles, readWorkflowFile } from './workflow-file-utils';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';

// NOTE: Same logger name as the executor body — keeps the observed log `name`
// field identical after the file split.
const log = createLogger('workflow-cli-executor');

/**
 * Run post-execution housekeeping: clean up stray root-level workflow files,
 * flip the AgentExecution row from post_processing to completed for
 * investigation phases, emit the deferred timeline event, and auto-advance
 * the workflow to the next phase (implementer after research/plan, or
 * implementer after an in-run plan auto-approval).
 *
 * @param params - Post-processing inputs (task, transition, session, language, outcome, advance callback) / 後処理入力一式
 */
export async function runPostProcessing(params: {
  taskId: number;
  transition: RoleTransition;
  session: { id: number };
  language: 'ja' | 'en';
  effectiveSuccess: boolean;
  phaseStatus: WorkflowAdvanceResult['status'];
  isInvestigationPhase: boolean;
  advanceWorkflow: (taskId: number, language: 'ja' | 'en') => Promise<WorkflowAdvanceResult>;
}): Promise<void> {
  const {
    taskId,
    transition,
    session,
    language,
    effectiveSuccess,
    phaseStatus,
    isInvestigationPhase,
    advanceWorkflow,
  } = params;

  try {
    await cleanupRootWorkflowFiles(taskId);
  } catch (cleanupError) {
    log.warn({ err: cleanupError }, '[WorkflowCLIExecutor] Cleanup warning');
  }

  // Flip the AgentExecution row from `post_processing` (set when codex
  // exited 0 in investigation mode) to `completed` now that the role's
  // output file has been validated and saved. Without this, downstream
  // jobs like the distillation worker skip the execution because they
  // refuse to act on a non-completed row, and the FE's "完了" badge
  // never lights up for planner / verifier phases.
  if (effectiveSuccess && isInvestigationPhase) {
    try {
      // NOTE: completedAt is NOT re-stamped here — saveExecutionResult already
      // recorded the actual CLI exit time. Re-stamping would fold the epilogue
      // (critic gate, artifact save) into the row's wall span (task #560).
      // Read the ids BEFORE the flip so the ledger knows which rows this call
      // owns — but never let that read stand between the phase and its
      // completion: a failure here must cost a ledger row, not the flip.
      let flipped: { id: number }[] = [];
      try {
        flipped = await prisma.agentExecution.findMany({
          where: { sessionId: session.id, status: 'post_processing' },
          select: { id: true },
        });
      } catch (lookupErr) {
        log.warn(
          { err: lookupErr, taskId, sessionId: session.id },
          '[WorkflowCLIExecutor] Could not enumerate post_processing rows — flip proceeds, ledger row skipped',
        );
      }
      await prisma.agentExecution.updateMany({
        where: { sessionId: session.id, status: 'post_processing' },
        data: { status: 'completed' },
      });
      log.info(
        { taskId, role: transition.role, outputFile: transition.outputFile },
        '[WorkflowCLIExecutor] AgentExecution flipped post_processing → completed',
      );

      // This is where an investigation phase actually reaches a terminal state.
      // saveExecutionResult saw `post_processing` and skipped the learning
      // ledger, so without recording here the research / plan / verify phases —
      // including the one that ASSESSES the complexity — never appear in it.
      // Keyed off the rows this call itself flipped, so a repeated postprocess
      // records nothing the second time.
      if (flipped.length > 0) {
        const { recordExecutionOutcome } =
          await import('../self-learning/workflow-learning-recorder');
        for (const row of flipped) {
          await recordExecutionOutcome(prisma as never, row.id, 'completed');
        }
      }
    } catch (flipErr) {
      log.warn(
        { err: flipErr, taskId, sessionId: session.id },
        '[WorkflowCLIExecutor] Failed to flip post_processing → completed',
      );
    }
    // Emit the deferred timeline event now that the artifact is on disk.
    try {
      const { appendEvent } = await import('../memory/timeline');
      const latestExec = await prisma.agentExecution
        .findFirst({
          where: { sessionId: session.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, agentConfig: { select: { agentType: true } } },
        })
        .catch(() => null);
      if (latestExec) {
        await appendEvent({
          eventType: 'agent_execution_completed',
          actorType: 'agent',
          actorId: latestExec.agentConfig?.agentType ?? 'codex',
          payload: {
            executionId: latestExec.id,
            taskId,
            success: true,
            phase: transition.role,
          },
          correlationId: `execution_${latestExec.id}`,
        }).catch(() => {});
      }
    } catch {
      /* timeline emission is best-effort */
    }
    log.info(
      { taskId, role: transition.role, outputFile: transition.outputFile },
      `[WorkflowCLIExecutor] ${transition.role} phase completed`,
    );
    log.info(
      {
        taskId,
        fromRole: transition.role,
        nextWorkflowStatus: transition.nextStatus,
      },
      '[WorkflowCLIExecutor] Next phase queued',
    );
  }

  // Research concluded no change (auto-run path). The HTTP-save and dev-mode
  // routes already complete directly from this verdict, but THIS flow — the
  // one auto-run actually uses — advanced to the implementer regardless:
  // 27 of 31 no-change tasks in the week to 2026-08-30 burned
  // plan/implement/verify/jury on work research had already ruled out.
  if (effectiveSuccess && transition.role === 'researcher') {
    try {
      const research = await readWorkflowFile(taskId, 'research').catch(() => null);
      const { researchConcludesNoChange } = await import('./completion-gate');
      if (research && researchConcludesNoChange(research)) {
        await prisma.task.update({
          where: { id: taskId },
          data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
        });
        const { recordTransition } = await import('./transition-recorder');
        await recordTransition({
          taskId,
          fromStatus: phaseStatus ?? 'research_done',
          toStatus: 'completed',
          actor: 'system',
          cause: 'research_no_change_complete',
          phase: 'research',
          metadata: { via: 'cli_executor' },
        }).catch(() => {});
        log.info(
          { taskId },
          '[WorkflowCLIExecutor] Research concluded no change — completed without implement/verify',
        );
        return;
      }
    } catch (err) {
      // Fail open: a broken check must not stop the normal phase advance.
      log.warn(
        { err, taskId },
        '[WorkflowCLIExecutor] no-change check failed — advancing normally',
      );
    }
  }
  const canAutoAdvance =
    effectiveSuccess &&
    (transition.role === 'implementer' ||
      (phaseStatus === 'plan_approved' &&
        transition.role !== 'verifier' &&
        transition.role !== 'auto_verifier'));
  if (canAutoAdvance) {
    try {
      const queueOwner = await prisma.workflowQueueItem.findFirst({
        where: { taskId, status: 'running' },
        select: { id: true },
      });
      // WorkflowRunner already loops through phases for its acquired item.
      // A second timer competes for the execution lock and requeues that owner.
      if (queueOwner) return;
    } catch (error) {
      log.error({ err: error, taskId }, '[WorkflowCLIExecutor] Cannot determine next-phase owner');
      return;
    }
  }
  // Auto-start verification phase after implementer completes
  if (effectiveSuccess && transition.role === 'implementer') {
    log.info('[WorkflowCLIExecutor] Implementer done, auto-starting verifier...');
    // NOTE: 1s delay to ensure DB updates have committed before the next phase reads them.
    setTimeout(() => {
      advanceWorkflow(taskId, language).catch((error) => {
        log.error({ err: error }, '[WorkflowCLIExecutor] Failed to auto-advance to verifier');
      });
    }, 1000);
  } else if (
    effectiveSuccess &&
    phaseStatus === 'plan_approved' &&
    transition.role !== 'implementer' &&
    transition.role !== 'verifier' &&
    transition.role !== 'auto_verifier'
  ) {
    // The plan was created AND auto-approved during THIS run — typically because
    // the agent did research+plan in a single pass. The auto-advance that would
    // normally start the implementer fires when plan.md is saved, but at that
    // moment this very execution was still running, so it was blocked. Nothing
    // retried after it finished, leaving the workflow stalled at plan_approved
    // with no implementer execution and no further logs. Start the implementer
    // here now that this phase has actually completed.
    log.info(
      { taskId, role: transition.role },
      '[WorkflowCLIExecutor] Plan approved within this run — auto-starting implementer...',
    );
    setTimeout(() => {
      advanceWorkflow(taskId, language).catch((error) => {
        log.error({ err: error }, '[WorkflowCLIExecutor] Failed to auto-advance to implementer');
      });
    }, 1000);
  }
}
