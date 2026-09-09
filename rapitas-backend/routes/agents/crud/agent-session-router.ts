import { Elysia } from 'elysia';
import { prisma } from '../../../config/database';
import { createLogger } from '../../../config/logger';

const log = createLogger('routes:agent-session');
import { stopExecutions } from '../../../services/agents/stop-task-agents';
import { orchestrator } from '../../../services/core/orchestrator-instance';
import type { AgentExecutionWithExtras } from '../../../types/agent-execution-types';
import {
  isResumableInterrupted,
  getCurrentActiveExecutionIds,
  getLiveTaskIdsForActiveExecutions,
} from '../../../services/agents/resumable-execution';

/**
 * Agent Session Management Router
 *
 * Handles session detail retrieval, stopping, and resumable execution management.
 */
export const agentSessionRouter = new Elysia({ prefix: '/agents' })

  // Get session details
  .get('/sessions/:id', async (context) => {
    const { params } = context;
    return await prisma.agentSession.findUnique({
      where: { id: parseInt(params.id) },
      include: {
        agentActions: { orderBy: { createdAt: 'desc' } },
        agentExecutions: {
          include: {
            agentConfig: true,
            gitCommits: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  })

  // Stop session
  .post('/sessions/:id/stop', async (context) => {
    const { params } = context;
    const sessionId = parseInt(params.id);

    // Enumerate durable executions: the worker does not own main-process CLIs.
    const executions = await prisma.agentExecution.findMany({
      where: {
        sessionId,
        status: { in: ['running', 'pending', 'waiting_for_input', 'canceling'] },
      },
      select: { id: true },
    });
    await stopExecutions(
      executions.map((execution) => execution.id),
      'Manually stopped',
    );

    // Cancel all running/pending executions in the database
    await prisma.agentExecution.updateMany({
      where: {
        sessionId,
        status: { in: ['running', 'pending', 'waiting_for_input'] },
      },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
        errorMessage: 'Manually stopped',
      },
    });

    await prisma.agentSession.update({
      where: { id: sessionId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'Manually stopped',
      },
    });

    // NOTE: Reset task status to 'todo' so it doesn't stay in 'in-progress' or 'waiting' state
    try {
      const sessionWithConfig = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        include: { config: { select: { taskId: true } } },
      });
      if (sessionWithConfig?.config?.taskId) {
        await prisma.task.update({
          where: { id: sessionWithConfig.config.taskId },
          data: { status: 'todo' },
        });
        log.info(`[session-stop] Reset task ${sessionWithConfig.config.taskId} status to 'todo'`);
      }
    } catch (taskErr) {
      log.warn({ err: taskErr }, '[session-stop] Failed to reset task status');
    }

    return { success: true };
  })

  // Get resumable executions (interrupted or stale running)
  // This handles both intentionally interrupted executions and ones left in "running" state after server restart
  .get('/resumable-executions', async ({ set }) => {
    try {
      // Stale execution recovery is handled at startup by orchestrator.recoverStaleExecutions()
      // This endpoint only reads data — no recovery logic here to avoid race conditions
      // with newly created executions that haven't been added to activeExecutions yet.
      const currentActiveIds = await getCurrentActiveExecutionIds();

      const resumableExecutions = await prisma.agentExecution.findMany({
        where: {
          OR: [
            // Interrupted executions (resumable)
            { status: 'interrupted' },
            // Only executions actually active in memory
            {
              status: { in: ['running', 'waiting_for_input'] },
              id: { in: currentActiveIds.length > 0 ? currentActiveIds : [-1] },
            },
          ],
        },
        include: {
          session: {
            include: {
              config: {
                include: {
                  task: {
                    select: {
                      id: true,
                      title: true,
                      status: true,
                      workflowStatus: true,
                      workflowMode: true,
                      theme: {
                        select: {
                          workingDirectory: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      // Dedupe per task: a task with a LIVE (running / waiting) execution must not
      // also surface its OLD `interrupted` execution. That interrupted row is a
      // stale leftover (a restart or a phase rollover left it behind while the
      // workflow re-dispatched a fresh execution), and showing both makes ONE task
      // appear TWICE in the "in-progress work" modal — one 実行中 and one 中断, which
      // is exactly what the user reported for task 284. Keep the live one; drop the
      // task's interrupted rows when a live execution exists.
      //
      // Resolved from `currentActiveIds` directly (no `take` limit) rather than
      // from this query's own `take: 50` result set, so a live execution outside
      // the top 50 rows still suppresses its task's stale `interrupted` row (task 913).
      const liveTaskIds = await getLiveTaskIdsForActiveExecutions(currentActiveIds);
      // A terminal task's (done/completed/cancelled/failed/archived, or
      // workflowStatus=completed — see resumable-execution-policy.ts)
      // `interrupted` row is NOT resumable work — it is a stale leftover that
      // lingered in the "中断作業" modal after the task finished (task 284
      // completed via a fresh execution but its earlier interrupted row
      // stayed; task 658/execution 2806 is the same pattern via `status=done`).
      const dedupedExecutions = resumableExecutions.filter((e) => {
        if (e.status !== 'interrupted') return true;
        return isResumableInterrupted({ status: e.status }, e.session.config?.task, liveTaskIds);
      });

      return dedupedExecutions.map((exec: (typeof resumableExecutions)[number]) => {
        const execWithExtras = exec as typeof exec & AgentExecutionWithExtras;
        return {
          id: exec.id,
          taskId: exec.session.config?.task?.id,
          taskTitle: exec.session.config?.task?.title,
          sessionId: exec.sessionId,
          status: exec.status,
          claudeSessionId: execWithExtras.claudeSessionId,
          errorMessage: exec.errorMessage,
          output: exec.output?.slice(-500), // Last 500 characters only
          startedAt: exec.startedAt,
          completedAt: exec.completedAt,
          createdAt: exec.createdAt,
          workingDirectory: exec.session.config?.task?.theme?.workingDirectory,
          workflowStatus: exec.session.config?.task?.workflowStatus ?? null,
          workflowMode: exec.session.config?.task?.workflowMode ?? null,
          canResume: exec.status === 'interrupted', // Only interrupted can be resumed
        };
      });
    } catch (error) {
      const errObj = error as { code?: string; message?: string };
      if (errObj?.code === 'P1001') {
        log.warn('[resumable-executions] Database unreachable, skipping');
      } else {
        log.error({ err: error }, '[resumable-executions] Error');
      }
      // 503 (not 200 []) — an empty list must not read as "no interrupted
      // work", it must read as "we couldn't check" (task 913 acceptance
      // criterion: don't report a DB query failure as healthy/normal).
      set.status = 503;
      return [];
    }
  })

  // Legacy endpoint for backwards compatibility
  .get('/interrupted-executions', async ({ set }) => {
    try {
      const currentActiveIds = await getCurrentActiveExecutionIds();
      const liveTaskIds = await getLiveTaskIdsForActiveExecutions(currentActiveIds);

      const interruptedExecutions = await prisma.agentExecution.findMany({
        where: {
          status: 'interrupted',
        },
        include: {
          session: {
            include: {
              config: {
                include: {
                  task: {
                    select: {
                      id: true,
                      title: true,
                      status: true,
                      workflowStatus: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      return interruptedExecutions.map((exec: (typeof interruptedExecutions)[number]) => {
        const execWithExtras = exec as typeof exec & AgentExecutionWithExtras;
        const task = exec.session.config?.task;
        return {
          id: exec.id,
          taskId: task?.id,
          taskTitle: task?.title,
          sessionId: exec.sessionId,
          status: exec.status,
          claudeSessionId: execWithExtras.claudeSessionId,
          errorMessage: exec.errorMessage,
          output: exec.output?.slice(-500), // Last 500 characters only
          startedAt: exec.startedAt,
          completedAt: exec.completedAt,
          createdAt: exec.createdAt,
          canResume: !!execWithExtras.claudeSessionId, // Resumable if Claude Session ID exists (legacy definition — unchanged)
          // Whether this row agrees with `/resumable-executions`'s definition of
          // a real resume candidate (task terminal / has a live execution
          // elsewhere). Kept separate from `canResume` since no known consumer
          // of this legacy endpoint reads `canResume` today (grep: 0 hits) and
          // changing its meaning is not worth the risk.
          isResumableCandidate: isResumableInterrupted({ status: exec.status }, task, liveTaskIds),
        };
      });
    } catch (error) {
      log.error({ err: error }, '[interrupted-executions] Error');
      set.status = 503;
      return [];
    }
  });
