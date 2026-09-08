/**
 * theme-auto-run
 *
 * HTTP routes for per-theme auto-execution control.
 *
 * POST /themes/:id/auto-run  { action: 'start' | 'pause' | 'stop', order?: 'priority' | 'created' }
 * GET  /themes/:id/auto-run  → ThemeAutoRunState
 */
import { Elysia, t } from 'elysia';
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import {
  getOrCreateAutoRun,
  startAutoRun,
  pauseAutoRun,
  stopAutoRun,
  toPublicAutoRunState,
} from '../../services/workflow/auto-run/theme-auto-run-service';
import { ThemeAutoRunScheduler } from '../../services/workflow/auto-run/theme-auto-run-scheduler';
import { logCycleEvent } from '../../services/observability';
import { HTTP_STATUS } from '../../utils/common/http-status';

const log = createLogger('routes:theme-auto-run');

export const themeAutoRunRoutes = new Elysia()

  /**
   * GET /themes/:id/auto-run — return the current auto-run state for a theme.
   */
  .get('/themes/:id/auto-run', async (context) => {
    const themeId = parseInt((context.params as { id: string }).id);
    if (!Number.isFinite(themeId)) {
      context.set.status = HTTP_STATUS.BAD_REQUEST;
      return { success: false, error: 'Invalid theme ID' };
    }

    try {
      const state = await getOrCreateAutoRun(themeId);

      // Enrich with current task info if one is active
      let currentTask = null;
      if (state.currentTaskId) {
        currentTask = await prisma.task.findUnique({
          where: { id: state.currentTaskId },
          select: { id: true, title: true, status: true, workflowStatus: true },
        });
      }

      // Count remaining eligible tasks for this theme
      const remainingCount = await prisma.task.count({
        where: {
          themeId,
          status: { in: ['todo', 'in-progress'] },
          OR: [
            { workflowStatus: null },
            { workflowStatus: { notIn: ['completed', 'verify_done', 'awaiting_question'] } },
          ],
          workflowDisabled: false,
          parentId: null,
        },
      });

      return {
        success: true,
        autoRun: toPublicAutoRunState(state),
        currentTask,
        remainingCount,
      };
    } catch (err) {
      log.error({ err, themeId }, '[theme-auto-run] Failed to get state');
      context.set.status = HTTP_STATUS.INTERNAL_SERVER_ERROR;
      return { success: false, error: 'Failed to retrieve auto-run state' };
    }
  })

  /**
   * POST /themes/:id/auto-run — control auto-run (start / pause / stop).
   */
  .post(
    '/themes/:id/auto-run',
    async (context) => {
      const themeId = parseInt((context.params as { id: string }).id);
      if (!Number.isFinite(themeId)) {
        context.set.status = HTTP_STATUS.BAD_REQUEST;
        return { success: false, error: 'Invalid theme ID' };
      }

      const body = context.body as { action?: string; order?: string } | null;
      const action = body?.action;
      const order = (body?.order === 'created' ? 'created' : 'priority') as 'priority' | 'created';

      if (!['start', 'pause', 'stop'].includes(action ?? '')) {
        context.set.status = HTTP_STATUS.BAD_REQUEST;
        return { success: false, error: 'action must be one of: start, pause, stop' };
      }

      // Verify the theme exists and is a development theme
      const theme = await prisma.theme.findUnique({
        where: { id: themeId },
        select: { id: true, isDevelopment: true, workingDirectory: true },
      });
      if (!theme) {
        context.set.status = HTTP_STATUS.NOT_FOUND;
        return { success: false, error: 'Theme not found' };
      }
      if (!theme.isDevelopment || !theme.workingDirectory) {
        context.set.status = HTTP_STATUS.BAD_REQUEST;
        return {
          success: false,
          error: '自動実行は開発モードで作業ディレクトリが設定されたテーマのみ利用できます。',
        };
      }

      const scheduler = ThemeAutoRunScheduler.getInstance();

      try {
        let state;
        if (action === 'start') {
          state = await startAutoRun(themeId, order);
          scheduler.start();
          log.info(`[theme-auto-run] Started auto-run for theme ${themeId}`);
          logCycleEvent('theme.started', {
            theme: themeId,
            order,
            msg: 'auto-run started by user',
          });
        } else if (action === 'pause') {
          state = await pauseAutoRun(themeId);
          log.info(`[theme-auto-run] Paused auto-run for theme ${themeId}`);
        } else {
          // stop
          state = await stopAutoRun(themeId);
          log.info(`[theme-auto-run] Stop requested for theme ${themeId}`);
          // Kill EVERY in-flight agent in the theme synchronously — not just
          // state.currentTaskId. When the scheduler has more than one execution
          // alive (a re-dispatched task, a split parent's subtask running under a
          // different taskId, or a stale in-progress task), stopping only the
          // current task leaks the others; that is the "取りこぼし" users hit.
          // stopThemeAgents sweeps the theme's tasks + subtasks, aborts their
          // runner loops, kills executions, and releases all locks. Idempotent, so
          // the scheduler's later cleanup pass is harmless.
          const { stopThemeAgents } = await import('../../services/agents/stop-task-agents');
          const stopResult = await stopThemeAgents(themeId, state.currentTaskId ?? null, {
            errorMessage: 'Cancelled by user (auto-run stop)',
          }).catch((err) => {
            log.error({ err, themeId }, '[theme-auto-run] Failed to stop in-flight agents on stop');
            return { stoppedCount: 0, executionIds: [] as number[] };
          });
          log.info(
            { themeId, stoppedCount: stopResult.stoppedCount },
            `[theme-auto-run] Halted ${stopResult.stoppedCount} in-flight agent(s) for theme ${themeId}`,
          );
        }

        return { success: true, autoRun: toPublicAutoRunState(state) };
      } catch (err) {
        log.error({ err, themeId, action }, '[theme-auto-run] Action failed');
        context.set.status = HTTP_STATUS.INTERNAL_SERVER_ERROR;
        return { success: false, error: 'Auto-run action failed' };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Optional(
        t.Object(
          {
            action: t.Optional(
              t.Union([t.Literal('start'), t.Literal('pause'), t.Literal('stop')]),
            ),
            order: t.Optional(t.Union([t.Literal('priority'), t.Literal('created')])),
          },
          { additionalProperties: false },
        ),
      ),
    },
  );
