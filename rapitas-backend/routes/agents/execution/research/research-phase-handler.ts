import { writeBlockedTask } from '../../../../services/workflow/blocked-task-write';
/**
 * execution/research-phase-handler
 *
 * Post-execution handler for research-mode agent runs. Completely independent
 * of the development pipeline: reads the agent's stdout, saves research.md via
 * the workflow API, reverts any code changes, and advances the workflow to the
 * next phase.
 * Report harvesting/validation lives in research-report-harvester.ts, the code
 * diff revert in research-diff-revert.ts, and the post-save workflow advance in
 * research-workflow-advance.ts — this file orchestrates them and owns the
 * save / critic-rejection / failure branching.
 * Separated from execute-post-handler.ts to keep each file under 500 lines.
 */

import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { harvestResearchReport } from './research-report-harvester';
import { revertResearchDiffIfDirty } from './research-diff-revert';
import { advanceAfterResearchSave } from './research-workflow-advance';

const log = createLogger('routes:agent-execution:research-phase-handler');

/** Shape of the result returned by agentWorkerManager.executeTask. */
interface ExecuteTaskResult {
  success: boolean;
  waitingForInput?: boolean;
  output?: string;
  errorMessage?: string;
  executionTimeMs?: number;
}

/** Parameters for handleResearchResult. */
export interface HandleResearchResultParams {
  result: ExecuteTaskResult;
  taskIdNum: number;
  sessionId: number;
  executionDir: string;
  researchTempOutputFile?: string | null;
}

/**
 * Research-mode post-handler. Completely independent of the development
 * pipeline:
 *   - reads the temp file codex's -o flag wrote (its final markdown)
 *   - uploads it to the workflow API as research.md
 *   - reverts ANY git diff (research must not modify code)
 *   - marks the task as `in_progress` so the user can advance to the
 *     plan/implement phase; on hard failure marks `blocked`
 *
 * @param params - Research execution context / リサーチ実行コンテキスト
 */
export async function handleResearchResult(params: HandleResearchResultParams): Promise<void> {
  const { result, taskIdNum, sessionId, executionDir, researchTempOutputFile } = params;

  // 1. Harvest + validate the report from stdout. A `null` return means the
  // report was rejected as inadequate and the harvester already marked the
  // task blocked / session failed — nothing more to do here.
  const harvested = await harvestResearchReport({ result, taskIdNum, sessionId, executionDir });
  if (harvested === null) return;
  const researchMarkdown: string = harvested;
  // The researchTempOutputFile arg is now unused — silence TS by referring
  // to it. Keeping the param for backward compat with older callers.
  void researchTempOutputFile;

  // 2. Save research.md to the workflow API.
  //
  // NOTE: The agent already PUT research.md mid-run; if the phase critic
  // rejected it while the agent was finishing, this harvest re-save would
  // resurrect the rejected artifact byte-for-byte and flip the status forward
  // again (observed on task 539 — the auto-run executor had this guard, the
  // manual path did not). When rejected: skip the save AND the workflow
  // advance below, but still revert code changes and close the session — the
  // critic's rollback owns the workflow status and the bounce re-run
  // regenerates the artifact.
  const savedOk = researchMarkdown.trim().length > 0;
  let criticRejected = false;
  if (savedOk) {
    const session = await prisma.agentSession
      .findUnique({ where: { id: sessionId }, select: { startedAt: true, createdAt: true } })
      .catch(() => null);
    const phaseStartedAt = session?.startedAt ?? session?.createdAt ?? null;
    if (phaseStartedAt) {
      const { criticRejectedSince } =
        await import('../../../../services/workflow/phase-critic/critic-rejection-guard');
      criticRejected = await criticRejectedSince(taskIdNum, 'research', phaseStartedAt);
      if (criticRejected) {
        // In-session recovery (education #5b): the 422 resave-block hands the
        // agent the critic's reasons and the agent saves a REVISED artifact.
        // A live research row after the rejection means exactly that — the
        // rejection was superseded, so run the normal completion path instead
        // of discarding the session's (revised) work. Observed on task 541.
        const { readWorkflowFile } =
          await import('../../../../services/workflow/workflow-file-utils');
        const liveRow = await readWorkflowFile(taskIdNum, 'research').catch(() => null);
        if (liveRow && liveRow.trim().length > 0) {
          log.info(
            { taskId: taskIdNum, sessionId },
            '[API] Critic rejection was superseded by a revised in-session save — proceeding normally',
          );
          criticRejected = false;
        }
      }
    }
  }
  if (savedOk && !criticRejected) {
    try {
      const { writeWorkflowFile, resolveWorkflowDir } =
        await import('../../../../services/workflow/workflow-file-utils');
      const resolved = await resolveWorkflowDir(taskIdNum);
      if (resolved) {
        await writeWorkflowFile(taskIdNum, 'research', researchMarkdown);
        log.info({ taskId: taskIdNum }, '[API] research.md saved via workflow API');
        // NOTE: Refine complexityScore/workflowMode from the code-grounded assessment
        // in research.md. Auto-run does this in workflow-cli-executor; without this
        // call the manual path kept the pre-execution heuristic score (often off by
        // one tier) while auto-run showed an accurate research-assessed score.
        try {
          const { applyResearchAssessedComplexity } =
            await import('../../../../services/workflow/research-complexity');
          await applyResearchAssessedComplexity(taskIdNum, researchMarkdown);
        } catch (cErr) {
          log.warn(
            { err: cErr, taskId: taskIdNum },
            '[API] Failed to apply research-assessed complexity (non-fatal)',
          );
        }
      } else {
        log.warn({ taskId: taskIdNum }, '[API] Could not resolve workflow dir for research.md');
      }
    } catch (saveErr) {
      log.error({ err: saveErr, taskId: taskIdNum }, '[API] Failed to save research.md');
    }
  } else {
    log.warn({ taskId: taskIdNum }, '[API] Research mode produced no markdown output');
  }

  // 3. Hard rule: research must not modify code. Detect and revert any diff
  // or untracked files (isolated worktrees only — never the main checkout).
  const revertedDiff = await revertResearchDiffIfDirty(executionDir, taskIdNum);

  // A no-change research verdict still proceeds through verification and completion gates.
  // 4. Update task / session status AND advance workflow.
  if (savedOk && !criticRejected) {
    await advanceAfterResearchSave({ taskIdNum, sessionId, researchMarkdown, revertedDiff });
  } else if (criticRejected) {
    // Critic rejected the artifact mid-run: the rollback transition already
    // owns the workflow status (draft) and the bounce re-run regenerates the
    // artifact. Close this session cleanly — do NOT advance, do NOT block.
    await prisma.agentSession
      .update({
        where: { id: sessionId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          errorMessage:
            '品質批評ゲートが調査結果を差し戻したため、この実行の成果物は破棄されました。再生成が自動でキューされます。',
        },
      })
      .catch((e) =>
        log.warn({ err: e, sessionId }, '[API] Failed to close session (critic-rejected)'),
      );
    // NOTE: completedAt is NOT re-stamped — saveExecutionResult already recorded
    // the CLI exit time; re-stamping would fold the critic-gate epilogue into
    // the row's wall span (task #560).
    await prisma.agentExecution
      .updateMany({
        where: { sessionId, status: 'post_processing' },
        data: { status: 'completed' },
      })
      .catch((e) =>
        log.warn({ err: e, sessionId }, '[API] Failed to flip execution status (critic-rejected)'),
      );
    log.info(
      { taskId: taskIdNum, sessionId },
      '[API] Research harvest skipped due to critic rejection — session closed without advancing',
    );
  } else {
    await writeBlockedTask(prisma, taskIdNum).catch((e) =>
      log.warn({ err: e, taskId: taskIdNum }, '[API] Failed to set blocked'),
    );
    await prisma.agentSession
      .update({
        where: { id: sessionId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage:
            'Research mode produced no markdown output. Either the agent crashed early or it ignored the research-only instruction. Re-run after checking logs.',
        },
      })
      .catch((e) =>
        log.warn({ err: e, sessionId }, '[API] Failed to set session failed (research mode)'),
      );
  }
}
