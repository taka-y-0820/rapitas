/**
 * Resume Completion
 *
 * Async post-resume completion logic: task status updates, approval requests,
 * and notification creation after orchestrator.resumeInterruptedExecution()
 * settles. Shared by the manual resume route AND the automatic resume path
 * (auto-resume.ts). Not responsible for route definitions or deciding
 * whether to resume. (Moved from routes/agents/execution-management —
 * this is service logic, not routing.)
 */

import { prisma } from '../../../config';
import { createLogger } from '../../../config/logger';
import { orchestrator } from '../../core/orchestrator-instance';
import { ResumeLockConflictError } from './execution-resume';

const log = createLogger('routes:agent-resume');

type TaskInfo = {
  id: number;
  title: string;
  description: string | null;
  theme: { name: string | null; workingDirectory: string | null } | null;
};

type ExecutionInfo = {
  sessionId: number;
  session: {
    config: {
      id: number;
      taskId: number;
    } | null;
  };
};

/**
 * Runs orchestrator.resumeInterruptedExecution and handles the async result:
 * updates task status, creates approval requests, and sends notifications.
 * Designed to be called without awaiting — fire-and-forget after returning HTTP response.
 *
 * @param executionId - DB id of the interrupted execution / 中断された実行のDB ID
 * @param execution - Execution record with session/config included / セッション/config付きの実行レコード
 * @param task - Task associated with the execution / 実行に関連するタスク
 * @param workingDirectory - Verified working directory / 検証済み作業ディレクトリ
 * @param timeout - Resume timeout in milliseconds / 再開タイムアウト（ミリ秒）
 */
export function handleResumeCompletion(
  executionId: number,
  execution: ExecutionInfo,
  task: TaskInfo,
  workingDirectory: string,
  timeout: number,
): void {
  orchestrator
    .resumeInterruptedExecution(executionId, { timeout })
    .then(async (result) => {
      if (result.success && !result.waitingForInput) {
        await updateTaskStatusOnSuccess(task, execution, workingDirectory);
      } else if (result.waitingForInput) {
        log.info(`[resume] Task ${task.id} is waiting for input after resume`);
      } else {
        await handleResumeFailure(task, execution, result.errorMessage);
      }
    })
    .catch(async (error) => {
      if ((error as Error)?.name === 'ExecutionCancelledError') {
        log.info({ taskId: task.id, executionId }, '[resume] Cancelled; preserving stop state');
        return;
      }
      if (
        error instanceof ResumeLockConflictError ||
        (error as Error)?.name === 'ResumeLockConflictError'
      ) {
        log.info(
          { taskId: task.id },
          '[resume] Skipped: task-execution lock already held by another run',
        );
        return;
      }
      log.error({ err: error }, '[resume] Resume execution error');
      await handleResumeError(task, execution, error);
    });
}

/**
 * Updates task and session status when resume completes successfully, then
 * notifies that the resumed work finished (the task's PR is opened directly).
 */
async function updateTaskStatusOnSuccess(
  task: TaskInfo,
  execution: ExecutionInfo,
  workingDirectory: string,
): Promise<void> {
  const currentTask = await prisma.task.findUnique({ where: { id: task.id } });
  const wfStatus = currentTask?.workflowStatus;

  if (wfStatus === 'completed') {
    // A CLI exit only completes this execution. The workflow owns acceptance,
    // verification and PR/merge gates; unknown/draft cannot establish success.
    // CAS also preserves a stop or newer task state arriving after the read.
    const updated = await prisma.task.updateMany({
      where: {
        id: task.id,
        workflowStatus: 'completed',
        status: { in: ['in-progress'] },
      },
      data: { status: 'done', completedAt: new Date() },
    });
    if (updated.count > 0) log.info(`[resume] Updated task ${task.id} status to 'done'`);
  } else {
    log.info(
      `[resume] Execution ended; task ${task.id} awaits workflow gates (${wfStatus ?? 'unknown'})`,
    );
  }

  await prisma.agentSession
    .updateMany({
      where: { id: execution.sessionId, status: { in: ['pending', 'running'] } },
      data: { status: 'completed', completedAt: new Date() },
    })
    .catch((err: unknown) => {
      log.warn(
        { err, sessionId: execution.sessionId },
        '[resume] Failed to mark session as completed',
      );
    });

  // Code-review approval was removed — the task's PR is opened directly. Just
  // notify that the resumed work completed.
  const diff = await orchestrator.getFullGitDiff(workingDirectory);
  const hadChanges = Boolean(diff && diff !== 'No changes detected');
  await prisma.notification.create({
    data: {
      type: 'agent_execution_complete',
      title: hadChanges ? 'エージェント実行完了（再開後）' : 'エージェント実行完了（変更なし）',
      message: hadChanges
        ? `「${task.title}」の再開した作業が完了しました。`
        : `「${task.title}」の再開した作業が完了しましたが、コード変更はありませんでした。`,
      link: `/tasks/${task.id}`,
    },
  });
}

/**
 * Handles the case where orchestrator.resumeInterruptedExecution resolves with success=false.
 */
async function handleResumeFailure(
  task: TaskInfo,
  execution: ExecutionInfo,
  errorMessage: string | undefined,
): Promise<void> {
  await prisma.task.updateMany({
    where: { id: task.id, status: { in: ['in-progress'] } },
    data: { status: 'todo' },
  });
  log.info(`[resume] Reverted task ${task.id} status to 'todo' due to failure`);

  await prisma.agentSession
    .updateMany({
      where: { id: execution.sessionId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: errorMessage || 'Execution failed after resume',
      },
    })
    .catch(() => {});

  await prisma.notification.create({
    data: {
      type: 'agent_error',
      title: '再開した実行が失敗',
      message: `「${task.title}」の再開した作業が失敗しました: ${errorMessage}`,
      link: `/tasks/${task.id}`,
    },
  });
}

/**
 * Handles the case where orchestrator.resumeInterruptedExecution rejects.
 */
async function handleResumeError(
  task: TaskInfo,
  execution: ExecutionInfo,
  error: Error,
): Promise<void> {
  await prisma.task
    .updateMany({
      where: { id: task.id, status: { in: ['in-progress'] } },
      data: { status: 'todo' },
    })
    .catch((err: unknown) => {
      log.warn({ err, taskId: task.id }, "[resume] Failed to revert task status to 'todo'");
    });
  log.info(`[resume] Reverted task ${task.id} status to 'todo' due to error`);

  await prisma.agentSession
    .updateMany({
      where: { id: execution.sessionId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: error.message || 'Resume execution error',
      },
    })
    .catch((err: unknown) => {
      log.warn(
        { err, sessionId: execution.sessionId },
        '[resume] Failed to mark session as failed',
      );
    });

  await prisma.notification.create({
    data: {
      type: 'agent_error',
      title: '実行再開エラー',
      message: `「${task.title}」の再開中にエラーが発生しました: ${error.message}`,
      link: `/tasks/${task.id}`,
    },
  });
}
