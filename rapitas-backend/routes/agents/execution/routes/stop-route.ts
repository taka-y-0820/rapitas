/**
 * execution/stop-route
 *
 * POST /tasks/:id/stop-execution — halts ALL running agents for the task,
 * cancels pending executions/queue items, reverts uncommitted git changes,
 * cleans up worktrees, and releases the execution lock.
 */

import { Elysia, t } from 'elysia';
import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { AgentWorkerManager } from '../../../../services/agents/agent-worker-manager';
import { stopTaskAgents } from '../../../../services/agents/stop-task-agents';
import {
  getAutoRunState,
  finalizeStop,
  isAutoRunHandlingTask,
} from '../../../../services/workflow/auto-run/theme-auto-run-service';
import { releaseTaskExecutionLock } from '../shared/execution-lock';
import { removeWorktree } from '../../../../services/agents/orchestrator/git-operations/worktree/worktree-ops';
import { resolveTaskWorkingDirectory } from '../../../../services/task/task-resolver';
import { recordTransition } from '../../../../services/workflow/transition-recorder';
import { MANUAL_STOP_WITHDRAW_CAUSE } from '../../../../services/workflow/incident-signature-detectors';

const log = createLogger('routes:agent-execution:stop');
const agentWorkerManager = AgentWorkerManager.getInstance();

export const stopRoute = new Elysia().post(
  '/tasks/:id/stop-execution',
  async (context) => {
    const { params, body } = context;
    const taskId = parseInt(params.id);
    const withdraw = body?.withdraw === true;

    try {
      const task = await resolveTaskWorkingDirectory(taskId);
      const workingDirectory = task?.workingDirectory || task?.theme?.workingDirectory || null;

      // Cancel any pending/queued workflow items so the runner won't re-pick the
      // task right after we stop it.
      await prisma.workflowQueueItem
        .updateMany({
          where: {
            taskId,
            status: { in: ['queued', 'running', 'waiting_approval'] },
          },
          data: {
            status: 'cancelled',
            completedAt: new Date(),
            errorMessage: 'Cancelled by user',
          },
        })
        .catch((err) => {
          log.warn({ err, taskId }, '[stop-execution] Failed to cancel workflow queue items');
        });

      // Collect the worktree-bearing sessions BEFORE stopping, so we can clean
      // them up after the agents are killed.
      const sessionsToClean = await prisma.agentSession
        .findMany({
          where: { config: { taskId }, worktreePath: { not: null } },
          select: { id: true, worktreePath: true },
        })
        .catch(() => [] as { id: number; worktreePath: string | null }[]);

      // Kill EVERY in-flight agent for the task (not just the first found) and
      // release the execution lock. This is the single source of truth shared
      // with the auto-run scheduler and the workflow runner.
      const { stoppedCount } = await stopTaskAgents(taskId, { errorMessage: 'Cancelled by user' });

      // Mark the task's active sessions cancelled so the FE doesn't show them
      // as live after the agents are gone.
      await prisma.agentSession
        .updateMany({
          where: { config: { taskId }, status: { in: ['active', 'running', 'pending'] } },
          data: { status: 'cancelled', completedAt: new Date(), errorMessage: 'Cancelled by user' },
        })
        .catch((err) => {
          log.warn({ err, taskId }, '[stop-execution] Failed to cancel agent sessions');
        });

      // If the theme's auto-run is the actor driving THIS task, halt the loop
      // now (before the status reset below). Otherwise the scheduler either
      // re-selects the just-reset 'todo' task or advances to the next task and
      // launches a fresh agent mid-stop — the "press stop, it runs again" bug.
      // finalizeStop is immediate (idle + disabled + currentTaskId=null), so it
      // doesn't depend on the next scheduler tick. Only fires when auto-run is
      // actually running this task — a manual single-task stop is unaffected.
      if (task?.themeId != null) {
        const autoRunState = await getAutoRunState(task.themeId).catch(() => null);
        if (isAutoRunHandlingTask(autoRunState, taskId)) {
          await finalizeStop(task.themeId).catch((err) =>
            log.warn(
              { err, taskId, themeId: task.themeId },
              '[stop-execution] Failed to halt theme auto-run',
            ),
          );
          log.info(
            `[stop-execution] Halted theme ${task.themeId} auto-run (was running task ${taskId})`,
          );
        }
      }

      // Revert uncommitted changes in the task's working directory.
      if (workingDirectory) {
        try {
          await agentWorkerManager.revertChanges(workingDirectory);
          log.info(`[stop-execution] Reverted changes in ${workingDirectory}`);
        } catch (revertError) {
          log.error({ err: revertError }, '[stop-execution] Failed to revert changes');
        }
      }

      // Clean up any worktrees the sessions created.
      if (workingDirectory) {
        for (const session of sessionsToClean) {
          if (!session.worktreePath) continue;
          try {
            const removed = await removeWorktree(workingDirectory, session.worktreePath);
            if (removed) {
              await prisma.agentSession.update({
                where: { id: session.id },
                data: { worktreePath: null },
              });
              log.info(`[stop-execution] Cleaned up worktree: ${session.worktreePath}`);
            } else {
              log.warn(`[stop-execution] removeWorktree refused: ${session.worktreePath}`);
            }
          } catch (worktreeError) {
            log.error(
              { err: worktreeError },
              `[stop-execution] Failed to clean up worktree: ${session.worktreePath}`,
            );
          }
        }
      }

      // NOTE: Reset task status to 'todo' so it doesn't stay in a limbo state.
      try {
        const current = await prisma.task
          .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
          .catch(() => null);
        const workflowStatus = current?.workflowStatus ?? null;
        await prisma.task.update({ where: { id: taskId }, data: { status: 'todo' } });
        log.info(`[stop-execution] Reset task ${taskId} status to 'todo'`);
        // Record the revert so isWithinRecoveryGrace (incident-signature-detectors.ts)
        // can grant this deliberate `status='todo'` × advanced `workflowStatus`
        // shape its recovery grace period (task 709: previously unrecorded,
        // causing an immediate Pattern B false positive — task #602).
        await recordTransition({
          taskId,
          fromStatus: workflowStatus,
          toStatus: workflowStatus ?? 'draft',
          actor: 'user',
          cause: withdraw ? MANUAL_STOP_WITHDRAW_CAUSE : 'manual_execution_stop_revert',
          metadata: {
            reason: withdraw ? 'manual_stop_execution_withdraw' : 'manual_stop_execution',
          },
        }).catch(() => {});
      } catch (taskErr) {
        log.error({ err: taskErr }, `[stop-execution] Failed to reset task ${taskId} status`);
      }

      // stopTaskAgents already releases the lock, but call again defensively in
      // case no execution row existed yet a lock was somehow held.
      releaseTaskExecutionLock(taskId);

      if (stoppedCount === 0) {
        return {
          success: true,
          stoppedCount,
          withdrawn: withdraw,
          message: 'No running execution found; cleaned up queue items and worktrees',
        };
      }

      return {
        success: true,
        stoppedCount,
        withdrawn: withdraw,
        message: 'Execution(s) stopped and changes reverted',
      };
    } catch (error) {
      log.error({ err: error }, '[stop-execution] Database error');
      releaseTaskExecutionLock(taskId);
      return {
        success: false,
        error: 'Database error occurred. Failed to stop execution.',
        message: 'Failed to stop execution due to database error',
      };
    }
  },
  {
    params: t.Object({
      id: t.String(),
    }),
    body: t.Optional(
      t.Object({
        withdraw: t.Optional(t.Boolean()),
      }),
    ),
  },
);
