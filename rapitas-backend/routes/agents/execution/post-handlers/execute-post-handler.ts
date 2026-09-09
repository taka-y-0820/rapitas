import { writeBlockedTask } from '../../../../services/workflow/blocked-task-write';
/**
 * execution/execute-post-handler
 *
 * Async post-execution handler called inside the `.then()` block after the
 * agent worker resolves. Orchestrates the terminal-state guard, the
 * research/development mode split, and the success/failure dispatch.
 * Separated from execute-route.ts to keep each file under 300 lines.
 *
 * Research-mode handling is delegated to research-phase-handler.ts, the
 * success path to success-execution-handler.ts, hard-failure reconciliation
 * to hard-failure-reconciler.ts, and the dev-mode planning advance to
 * dev-mode-planning-advance.ts (the latter two re-exported here so existing
 * consumers keep importing from this module).
 * Pure output utilities live in research-output-utils.ts.
 */

import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { handleResearchResult } from '../research/research-phase-handler';
import { handleSuccessfulExecution } from './success-execution-handler';
import { reconcileHardFailure } from './hard-failure-reconciler';

const log = createLogger('routes:agent-execution:post-handler');

/** Shape of the result returned by agentWorkerManager.executeTask. */
export interface ExecuteTaskResult {
  success: boolean;
  waitingForInput?: boolean;
  output?: string;
  errorMessage?: string;
  executionTimeMs?: number;
}

/** Parameters passed to handleExecuteResult. */
export interface HandleExecuteResultParams {
  result: ExecuteTaskResult;
  taskIdNum: number;
  sessionId: number;
  configId: number;
  taskTitle: string;
  workDir: string;
  executionDir: string;
  branchName?: string;
  /** Execution mode — `research` runs the lightweight investigation flow. */
  mode?: 'research' | 'development';
  /** When mode === 'research', the temp file codex's -o flag wrote to. */
  researchTempOutputFile?: string | null;
}

// NOTE: Re-exported so existing consumers (execute-route.ts and both
// execute-post-handler test files) keep importing these from this module's
// historical path after the split.
export { advanceManagedPlanningPhase } from './dev-mode-planning-advance';
export { reconcileHardFailure } from './hard-failure-reconciler';

/**
 * Handles the async result of a task execution: updates task/session status,
 * creates code review approval, and removes the worktree on success.
 *
 * @param params - Execution context and result / 実行コンテキストと結果
 */
export async function handleExecuteResult(params: HandleExecuteResultParams): Promise<void> {
  const {
    result,
    taskIdNum,
    sessionId,
    configId,
    taskTitle,
    workDir,
    executionDir,
    branchName,
    mode,
    researchTempOutputFile,
  } = params;

  // A task that already reached the terminal `completed` state DURING the run
  // needs no post-processing at all. A conflict-resolution task completes via
  // conflict_resolution_completed the moment it saves verify.md, yet it is often
  // dispatched in `research` mode — so the research-mode pipeline below (revert +
  // advance to the next phase) would clobber the completion back to in-progress
  // ("[調査完了]…進行中に戻す"), and the dev-mode failure-signal path would block
  // it. Guard ALL of it here, before the mode split, so a completed task is never
  // regressed by any downstream handler.
  const terminalCheck = await prisma.task
    .findUnique({ where: { id: taskIdNum }, select: { status: true, workflowStatus: true } })
    .catch(() => null);
  if (terminalCheck?.workflowStatus === 'completed' || terminalCheck?.status === 'done') {
    log.info(
      { taskId: taskIdNum, mode },
      '[API] Task already completed during the run — skipping all post-execution processing',
    );
    return;
  }

  // RESEARCH MODE: completely separate pipeline. We:
  //   1. Read the temp file codex wrote via -o (its final markdown).
  //   2. Save it to the workflow API as research.md.
  //   3. ANY git diff is reverted (research must not modify code).
  //   4. Skip AI review / commit / PR / verification entirely.
  if (mode === 'research') {
    await handleResearchResult({
      result,
      taskIdNum,
      sessionId,
      executionDir,
      researchTempOutputFile,
    });
    return;
  }

  if (result.waitingForInput) {
    log.info(`[API] Task ${taskIdNum} is waiting for user input, setting status to 'blocked'`);
    await writeBlockedTask(prisma, taskIdNum).catch((e: unknown) => {
      log.error({ err: e }, `[API] Failed to update task ${taskIdNum} status to in_progress`);
    });

    await prisma.agentSession
      .update({
        where: { id: sessionId },
        data: { status: 'running', lastActivityAt: new Date() },
      })
      .catch((e: unknown) => {
        log.error({ err: e }, `[API] Failed to update session ${sessionId} status to running`);
      });
    return;
  }

  if (result.success) {
    await handleSuccessfulExecution({
      result,
      taskIdNum,
      sessionId,
      configId,
      taskTitle,
      workDir,
      executionDir,
      branchName,
    });
  } else {
    log.error(
      { errorMessage: result.errorMessage },
      `[API] Execution failed for task ${taskIdNum}`,
    );
    await reconcileHardFailure({
      taskId: taskIdNum,
      sessionId,
      errorMessage: result.errorMessage || 'Execution failed',
      logPrefix: '[API]',
    });
  }
}
