/**
 * execution-dashboard routes
 *
 * GET /workflow/execution-dashboard — task #870. Aggregates every active (and
 * recently-finished) WorkflowQueueItem across all tasks into the dashboard's
 * five-plus-two display states, with per-task repair-bounce counts and stall
 * evaluation. GET /workflow/execution-dashboard/:taskId returns the same
 * derivation plus the full chronological transition history for drilldown.
 * GET /workflow/execution-dashboard/export streams the transition history as
 * CSV. Thin layer — all state-derivation logic lives in
 * services/workflow/execution-dashboard-service.ts.
 */
import { Elysia, t } from 'elysia';
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import {
  countRepairBounces,
  deriveExecutionState,
  evaluateStall,
  FREQUENT_FAILURE_THRESHOLD,
} from '../../services/workflow/execution-dashboard-service';

const log = createLogger('routes:execution-dashboard');

/** Upper bound on tasks returned by the list endpoint — see plan.md エッジケースの方針. */
const MAX_DASHBOARD_TASKS = 50;

/** How far back "recently completed/failed" tasks are still shown on the list. */
const RECENT_TERMINAL_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Default stall threshold used when UserSettings has not been migrated yet or has no row. */
const DEFAULT_STALL_THRESHOLD_MINUTES = 5;

/**
 * Reads the user-configurable stall threshold via a cast — the column may be
 * pending Prisma client regeneration (same pattern as
 * services/workflow/auto-run/dev-restart-on-dry.ts's restartEnabled()).
 *
 * @returns The configured threshold in minutes, or the default (5) when unset/unmigrated. / 停滞閾値(分)
 */
async function readStallThresholdMinutes(): Promise<number> {
  const settings = (await prisma.userSettings.findFirst().catch(() => null)) as {
    executionStallThresholdMinutes?: number | null;
  } | null;
  return settings?.executionStallThresholdMinutes ?? DEFAULT_STALL_THRESHOLD_MINUTES;
}

/** Escapes a single CSV field per RFC 4180 (quotes any value containing a comma/quote/newline). */
function csvField(value: string | number | null): string {
  const str = value === null ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

interface TaskDashboardRow {
  taskId: number;
  title: string;
  state: ReturnType<typeof deriveExecutionState>;
  repairCount: number;
  frequentFailure: boolean;
  stalled: boolean;
  elapsedMinutes: number;
  currentPhase: string;
  themeId: number | null;
  updatedAt: Date;
}

/**
 * Builds one task's dashboard row from its queue item + transition summary.
 *
 * @param queueItem - Queue item fields needed for derivation. / キュー項目
 * @param task - Task title/themeId, or null if the task row is missing. / タスク情報
 * @param latestTransitionCause - Most recent transition cause, or null. / 直近遷移cause
 * @param repairCount - Raw verify_repair/ci_repair count. / 修復回数
 * @param nowMs - Current time (ms). / 現在時刻
 * @param thresholdMinutes - Configured stall threshold. / 停滞閾値(分)
 * @returns One dashboard row. / ダッシュボード表示用の1タスク分の行
 */
function buildRow(
  queueItem: {
    taskId: number;
    status: string;
    currentPhase: string;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
  },
  task: { title: string; themeId: number | null } | null,
  latestTransitionCause: string | null,
  repairCount: number,
  nowMs: number,
  thresholdMinutes: number,
): TaskDashboardRow {
  const state = deriveExecutionState(queueItem.status, latestTransitionCause);
  const stall = evaluateStall({
    status: queueItem.status,
    queuedAt: queueItem.queuedAt,
    startedAt: queueItem.startedAt,
    nowMs,
    thresholdMinutes,
  });
  return {
    taskId: queueItem.taskId,
    title: task?.title ?? `#${queueItem.taskId}`,
    state,
    repairCount,
    frequentFailure: repairCount >= FREQUENT_FAILURE_THRESHOLD,
    stalled: stall.stalled,
    elapsedMinutes: stall.elapsedMinutes,
    currentPhase: queueItem.currentPhase,
    themeId: task?.themeId ?? null,
    updatedAt: queueItem.updatedAt,
  };
}

export const executionDashboardRoutes = new Elysia({ prefix: '/workflow' })
  /** Cross-task list: every active + recently-finished task's derived dashboard state. */
  .get(
    '/execution-dashboard',
    async ({ query, set }) => {
      const themeIdFilter = query.themeId !== undefined ? parseInt(query.themeId, 10) : undefined;

      try {
        const nowMs = Date.now();
        const recentSince = new Date(nowMs - RECENT_TERMINAL_WINDOW_MS);

        const [thresholdMinutes, allActiveOrRecent] = await Promise.all([
          readStallThresholdMinutes(),
          prisma.workflowQueueItem.findMany({
            where: {
              OR: [
                { status: { in: ['queued', 'running', 'waiting_approval'] } },
                { status: { in: ['completed', 'failed'] }, updatedAt: { gte: recentSince } },
              ],
            },
            select: {
              taskId: true,
              themeId: true,
              status: true,
              currentPhase: true,
              queuedAt: true,
              startedAt: true,
              updatedAt: true,
            },
            orderBy: { updatedAt: 'desc' },
          }),
        ]);

        const filtered = themeIdFilter
          ? allActiveOrRecent.filter((item) => item.themeId === themeIdFilter)
          : allActiveOrRecent;

        const totalActiveCount = filtered.length;
        const truncated = totalActiveCount > MAX_DASHBOARD_TASKS;
        const page = filtered.slice(0, MAX_DASHBOARD_TASKS);
        const taskIds = page.map((item) => item.taskId);

        const [tasks, latestTransitions, repairCounts] = await Promise.all([
          prisma.task.findMany({
            where: { id: { in: taskIds } },
            select: { id: true, title: true, themeId: true },
          }),
          Promise.all(
            taskIds.map((taskId) =>
              prisma.workflowTransition.findFirst({
                where: { taskId },
                orderBy: { createdAt: 'desc' },
                select: { cause: true },
              }),
            ),
          ),
          Promise.all(
            taskIds.map((taskId) =>
              prisma.workflowTransition.count({
                where: { taskId, cause: { in: ['verify_repair', 'ci_repair'] } },
              }),
            ),
          ),
        ]);

        const taskById = new Map(tasks.map((t) => [t.id, t]));

        const rows = page.map((item, i) =>
          buildRow(
            item,
            taskById.get(item.taskId) ?? null,
            latestTransitions[i]?.cause ?? null,
            repairCounts[i] ?? 0,
            nowMs,
            thresholdMinutes,
          ),
        );

        return {
          success: true,
          stallThresholdMinutes: thresholdMinutes,
          totalActiveCount,
          truncated,
          tasks: rows,
        };
      } catch (err) {
        log.error({ err }, '[execution-dashboard] failed to build dashboard list');
        set.status = 500;
        return { success: false, error: 'failed to build execution dashboard' };
      }
    },
    { query: t.Object({ themeId: t.Optional(t.String()) }) },
  )

  /**
   * Export: one task's full history (taskId) or all currently-listed tasks
   * (sinceHours, default 24). `format` selects csv (default) or json — the
   * task description's acceptance criteria require both.
   */
  .get(
    '/execution-dashboard/export',
    async ({ query, set }) => {
      const taskId = query.taskId !== undefined ? parseInt(query.taskId, 10) : undefined;
      const sinceHours = query.sinceHours !== undefined ? parseInt(query.sinceHours, 10) || 24 : 24;
      const format = query.format === 'json' ? 'json' : 'csv';

      try {
        let taskIds: number[];
        if (taskId !== undefined) {
          const task = await prisma.task.findUnique({
            where: { id: taskId },
            select: { id: true },
          });
          if (!task) {
            set.status = 404;
            return { success: false, error: 'task not found' };
          }
          taskIds = [taskId];
        } else {
          const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
          const items = await prisma.workflowQueueItem.findMany({
            where: {
              OR: [
                { status: { in: ['queued', 'running', 'waiting_approval'] } },
                { status: { in: ['completed', 'failed'] }, updatedAt: { gte: since } },
              ],
            },
            select: { taskId: true },
          });
          taskIds = items.map((i) => i.taskId);
        }

        const [transitions, tasks] = await Promise.all([
          prisma.workflowTransition.findMany({
            where: { taskId: { in: taskIds } },
            orderBy: [{ taskId: 'asc' }, { createdAt: 'asc' }],
            select: {
              id: true,
              taskId: true,
              fromStatus: true,
              toStatus: true,
              cause: true,
              phase: true,
              actor: true,
              createdAt: true,
            },
          }),
          prisma.task.findMany({
            where: { id: { in: taskIds } },
            select: { id: true, title: true },
          }),
        ]);
        const titleById = new Map(tasks.map((t) => [t.id, t.title]));
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

        if (format === 'json') {
          const rows = transitions.map((t) => ({
            taskId: t.taskId,
            taskTitle: titleById.get(t.taskId) ?? '',
            transitionId: t.id,
            fromStatus: t.fromStatus,
            toStatus: t.toStatus,
            cause: t.cause,
            phase: t.phase,
            actor: t.actor,
            createdAt: t.createdAt.toISOString(),
          }));
          set.headers['Content-Type'] = 'application/json; charset=utf-8';
          set.headers['Content-Disposition'] =
            `attachment; filename="execution-log-${timestamp}.json"`;
          return JSON.stringify(rows);
        }

        const header = [
          'taskId',
          'taskTitle',
          'transitionId',
          'fromStatus',
          'toStatus',
          'cause',
          'phase',
          'actor',
          'createdAt',
        ];
        const lines = [header.join(',')];
        for (const t of transitions) {
          lines.push(
            [
              csvField(t.taskId),
              csvField(titleById.get(t.taskId) ?? ''),
              csvField(t.id),
              csvField(t.fromStatus),
              csvField(t.toStatus),
              csvField(t.cause),
              csvField(t.phase),
              csvField(t.actor),
              csvField(t.createdAt.toISOString()),
            ].join(','),
          );
        }
        const csv = lines.join('\n');

        set.headers['Content-Type'] = 'text/csv; charset=utf-8';
        set.headers['Content-Disposition'] =
          `attachment; filename="execution-log-${timestamp}.csv"`;
        return csv;
      } catch (err) {
        log.error({ err, taskId }, '[execution-dashboard] failed to export CSV');
        set.status = 500;
        return { success: false, error: 'failed to export execution log' };
      }
    },
    {
      query: t.Object({
        taskId: t.Optional(t.String()),
        sinceHours: t.Optional(t.String()),
        format: t.Optional(t.String()),
      }),
    },
  )

  /** Single-task drilldown: derived state plus full chronological transition history. */
  .get('/execution-dashboard/:taskId', async ({ params, set }) => {
    const taskId = parseInt(params.taskId, 10);
    if (!Number.isFinite(taskId)) {
      set.status = 400;
      return { success: false, error: 'invalid taskId' };
    }

    try {
      const nowMs = Date.now();
      const [thresholdMinutes, queueItem, task, transitions] = await Promise.all([
        readStallThresholdMinutes(),
        prisma.workflowQueueItem.findFirst({
          where: { taskId },
          orderBy: { updatedAt: 'desc' },
          select: {
            taskId: true,
            status: true,
            currentPhase: true,
            queuedAt: true,
            startedAt: true,
            updatedAt: true,
          },
        }),
        prisma.task.findUnique({ where: { id: taskId }, select: { title: true, themeId: true } }),
        prisma.workflowTransition.findMany({
          where: { taskId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            fromStatus: true,
            toStatus: true,
            cause: true,
            phase: true,
            actor: true,
            createdAt: true,
          },
        }),
      ]);

      if (!queueItem) {
        set.status = 404;
        return { success: false, error: 'task not found' };
      }

      const latestTransitionCause = transitions.length
        ? transitions[transitions.length - 1].cause
        : null;
      const repairCount = countRepairBounces(transitions);
      const row = buildRow(
        queueItem,
        task,
        latestTransitionCause,
        repairCount,
        nowMs,
        thresholdMinutes,
      );

      return {
        success: true,
        taskId,
        title: row.title,
        state: row.state,
        repairCount: row.repairCount,
        frequentFailure: row.frequentFailure,
        stalled: row.stalled,
        elapsedMinutes: row.elapsedMinutes,
        currentPhase: row.currentPhase,
        transitions,
      };
    } catch (err) {
      log.error({ err, taskId }, '[execution-dashboard] failed to build task drilldown');
      set.status = 500;
      return { success: false, error: 'failed to build task drilldown' };
    }
  });

export default executionDashboardRoutes;
