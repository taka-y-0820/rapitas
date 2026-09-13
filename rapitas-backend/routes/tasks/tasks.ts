/**
 * Tasks API Routes
 * Core task CRUD operations
 * Business logic is delegated to task-service.ts
 */
import { Elysia, t } from 'elysia';
import { prisma } from '../../config/database';
import { AppError, ValidationError } from '../../middleware/error-handler';
import { createLogger } from '../../config/logger';
import {
  createTask,
  updateTask,
  cleanupDuplicateSubtasks,
  cleanupAllDuplicateSubtasks,
  attachBlockedCauses,
} from '../../services/task/task-service';
import { removeWorktree } from '../../services/agents/orchestrator/git-operations/worktree/worktree-ops';
import { warnIfSubtaskCreatedDuringDisabledSplit } from '../../services/workflow/subtask-split-guard';
import { getProjectRoot } from '../../config';
import { cleanupCompletedTasks } from '../../services/task/completed-task-cleanup';
import { computeTaskActiveTime } from '../../services/agent-execution/task-active-time';
import { TASK_NOT_FOUND, INVALID_ID } from '../../utils/common/error-messages';
import { retryTask } from './task-retry-handler';

import { QueryOptimizers } from '../../utils/database/prisma-optimization';

const logger = createLogger('tasks');

export const tasksRoutes = new Elysia({ prefix: '/tasks' })
  // Test endpoint
  .get('/test', async () => {
    return { message: 'test endpoint working' };
  })

  // Resolve the working directory + label for an integrated terminal opened
  // from a task: prefer the task's active git worktree, else its configured
  // working directory, else the repo root.
  .get(
    '/:id/terminal-context',
    async ({ params, set }) => {
      const id = parseInt(params.id, 10);
      if (Number.isNaN(id)) {
        set.status = 400;
        return { error: 'Invalid task id' };
      }
      const task = await prisma.task.findUnique({
        where: { id },
        select: {
          title: true,
          workingDirectory: true,
          theme: { select: { workingDirectory: true } },
        },
      });
      if (!task) {
        set.status = 404;
        return { error: 'Task not found' };
      }
      const session = await prisma.agentSession.findFirst({
        where: { worktreePath: { not: null }, config: { taskId: id } },
        orderBy: { id: 'desc' },
        select: { worktreePath: true },
      });
      // Resolution order: active worktree → task dir → theme dir → repo root.
      const cwd =
        session?.worktreePath ||
        task.workingDirectory ||
        task.theme?.workingDirectory ||
        getProjectRoot();
      return { cwd, title: task.title };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // Get task statistics
  .get('/statistics', async ({ set }) => {
    try {
      // byCategory used to be computed by loading every top-level task's
      // theme relation into JS (`findMany` with no `take`) — an O(task count)
      // query that got slower as the table grew and was the single heaviest
      // request this endpoint made (holding a connection open long enough to
      // trip the frontend's 15s api-client timeout under load). themeId is
      // indexed (see schema/core.prisma's @@index([themeId])), so grouping by
      // it is a proper DB-side aggregate; themes themselves are few enough
      // (tens, not thousands) to load in full and join in JS.
      const [stats, themeCounts, themes] = await Promise.all([
        QueryOptimizers.getTaskStatistics(prisma, { parentId: null }),
        prisma.task.groupBy({
          by: ['themeId'],
          where: { parentId: null },
          _count: { _all: true },
        }),
        prisma.theme.findMany({ select: { id: true, categoryId: true } }),
      ]);

      const themeIdToCategoryId = new Map(themes.map((t) => [t.id, t.categoryId ?? 0]));
      const byCategory: Record<number, number> = {};
      for (const tc of themeCounts) {
        const catId = tc.themeId != null ? (themeIdToCategoryId.get(tc.themeId) ?? 0) : 0;
        byCategory[catId] = (byCategory[catId] || 0) + tc._count._all;
      }

      return {
        total: stats.total,
        byStatus: stats.byStatus,
        byCategory,
      };
    } catch (error) {
      // NOTE: BUG FIX — this previously returned 200 on failure. The frontend
      // (fetchTaskStatistics in task-api.ts) relies on a non-2xx status to
      // trigger its fallback (recompute stats from GET /tasks); a 200 with an
      // `{error}` body silently bypassed that fallback and returned malformed
      // data (missing total/byStatus/byCategory) to callers instead.
      logger.error({ err: error }, 'Statistics endpoint error');
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  })

  // Get all tasks (supports incremental fetch via `since` param)
  .get('/', async (context) => {
    const { query } = context;
    const { projectId, milestoneId, priority, since, dueDateOn } = query as {
      projectId?: string;
      milestoneId?: string;
      priority?: string;
      since?: string;
      /** Filter to tasks whose dueDate falls on this UTC date (YYYY-MM-DD). */
      dueDateOn?: string;
    };

    const baseWhere = {
      parentId: null,
      ...(projectId && { projectId: parseInt(projectId) }),
      ...(milestoneId && { milestoneId: parseInt(milestoneId) }),
      ...(priority && { priority }),
      ...(dueDateOn && {
        dueDate: {
          // NOTE: No trailing Z — uses local timezone midnight so JST/local dates match
          // what the browser stored (new Date('YYYY-MM-DD') in JS = UTC midnight, but
          // task creation typically stores local midnight; match by local range here).
          gte: new Date(`${dueDateOn}T00:00:00.000`),
          lte: new Date(`${dueDateOn}T23:59:59.999`),
        },
      }),
    };

    // If `since` is provided, return only tasks updated after that timestamp + total count
    if (since) {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        throw new ValidationError('Invalid `since` parameter');
      }

      const [updated, totalCount, allIds] = await Promise.all([
        prisma.task.findMany({
          where: {
            ...baseWhere,
            // Surface a parent when EITHER it changed OR any of its subtasks
            // changed. A subtask status change does not bump the parent's
            // updatedAt, so without the subtask clause the parent's nested
            // `subtasks` (and the card's progress bar / status) never refreshed.
            OR: [
              { updatedAt: { gt: sinceDate } },
              { subtasks: { some: { updatedAt: { gt: sinceDate } } } },
            ],
          },
          include: {
            subtasks: {
              orderBy: { createdAt: 'asc' },
            },
            theme: true,
            project: true,
            milestone: true,
            examGoal: true,
            taskLabels: {
              include: {
                label: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.task.count({ where: baseWhere }),
        // Get all current task IDs (for deletion detection)
        prisma.task.findMany({
          where: baseWhere,
          select: { id: true },
        }),
      ]);

      await attachBlockedCauses(prisma, updated);

      return {
        tasks: updated,
        totalCount,
        activeIds: allIds.map((t) => t.id), // List of currently active task IDs
        since: sinceDate.toISOString(),
        incremental: true,
      };
    }

    // Full fetch (no `since`) — with pagination
    const page = query.page ? parseInt(query.page as string) : undefined;
    const pageSize = query.limit ? Math.min(parseInt(query.limit as string), 500) : undefined;

    const tasks = await prisma.task.findMany({
      where: baseWhere,
      include: {
        subtasks: {
          orderBy: { createdAt: 'asc' },
        },
        theme: true,
        project: true,
        milestone: true,
        examGoal: true,
        taskLabels: {
          include: {
            label: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      ...(pageSize && { take: pageSize }),
      ...(page && pageSize && { skip: (page - 1) * pageSize }),
    });

    await attachBlockedCauses(prisma, tasks);

    if (page && pageSize) {
      const totalCount = await prisma.task.count({ where: baseWhere });
      return {
        tasks,
        totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      };
    }

    return tasks;
  })

  // Get task by ID
  .get('/:id', async (context) => {
    const { params } = context;
    const id = parseInt(params.id);
    if (isNaN(id)) {
      throw new ValidationError(INVALID_ID);
    }

    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        subtasks: {
          orderBy: { createdAt: 'asc' },
        },
        theme: true,
        project: true,
        milestone: true,
        examGoal: true,
        taskLabels: {
          include: {
            label: true,
          },
        },
      },
    });
    if (!task) return task;

    // Cumulative active time / current-cycle wall-clock / per-role breakdown
    // (task #560). Additive fields only — existing consumers are unaffected.
    // Best-effort: an aggregation failure must never break the task detail.
    try {
      const timing = await computeTaskActiveTime(prisma, id);
      return { ...task, ...timing };
    } catch (error) {
      logger.warn({ err: error, taskId: id }, '[tasks] active-time aggregation failed');
      return task;
    }
  })

  // Create task
  .post(
    '/',
    async (context) => {
      const { body } = context;
      try {
        const created = await createTask(prisma, body as Parameters<typeof createTask>[1]);
        // Detection net for the disabled subtask-split chain (task 545) —
        // fire-and-forget so the guard can never delay or fail the creation.
        if (created?.parentId) {
          void warnIfSubtaskCreatedDuringDisabledSplit(created).catch(() => {});
        }
        return created;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error instanceof Error && error.message.includes('見つかりません')) {
          throw new AppError(400, error.message);
        }
        logger.error({ err: error }, '[tasks] Failed to create task');
        throw new AppError(500, 'タスクの作成に失敗しました');
      }
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        status: t.Optional(t.String()),
        priority: t.Optional(t.String()),
        labels: t.Optional(t.Array(t.String())),
        labelIds: t.Optional(t.Array(t.Number())),
        estimatedHours: t.Optional(t.Number()),
        dueDate: t.Optional(t.String()),
        subject: t.Optional(t.String()),
        parentId: t.Optional(t.Number()),
        projectId: t.Optional(t.Number()),
        milestoneId: t.Optional(t.Number()),
        themeId: t.Optional(t.Number()),
        examGoalId: t.Optional(t.Number()),
        isDeveloperMode: t.Optional(t.Boolean()),
        isAiTaskAnalysis: t.Optional(t.Boolean()),
        goals: t.Optional(t.Array(t.String())),
        constraints: t.Optional(t.Array(t.String())),
        acceptanceCriteria: t.Optional(t.Array(t.String())),
        searchMissId: t.Optional(t.Number()),
      }),
    },
  )

  // Update task
  .patch(
    '/:id',
    async (context) => {
      const { params, body } = context;
      const taskId = parseInt(params.id);
      if (isNaN(taskId)) {
        throw new ValidationError(INVALID_ID);
      }
      return await updateTask(prisma, taskId, body as Parameters<typeof updateTask>[2]);
    },
    {
      // NOTE: Length caps on free-text fields prevent an unbounded-payload DoS
      // (e.g. a multi-MB `description`) from reaching the DB layer. Mirrors the
      // field whitelist in UpdateTaskInput (task-mutations.ts); all optional.
      body: t.Object(
        {
          title: t.Optional(t.String({ maxLength: 500 })),
          description: t.Optional(t.String({ maxLength: 20000 })),
          themeId: t.Optional(t.Number()),
          status: t.Optional(t.String({ maxLength: 100 })),
          priority: t.Optional(t.String({ maxLength: 100 })),
          labels: t.Optional(t.String({ maxLength: 2000 })),
          labelIds: t.Optional(t.Array(t.Number())),
          estimatedHours: t.Optional(t.Nullable(t.Number())),
          actualHours: t.Optional(t.Nullable(t.Number())),
          dueDate: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
          startedAt: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
          subject: t.Optional(t.String({ maxLength: 500 })),
          projectId: t.Optional(t.Number()),
          milestoneId: t.Optional(t.Number()),
          examGoalId: t.Optional(t.Number()),
          autoApprovePlan: t.Optional(t.Boolean()),
          goals: t.Optional(t.Array(t.String({ maxLength: 20000 }), { maxItems: 200 })),
          constraints: t.Optional(t.Array(t.String({ maxLength: 20000 }), { maxItems: 200 })),
          acceptanceCriteria: t.Optional(
            t.Array(t.String({ maxLength: 20000 }), { maxItems: 200 }),
          ),
          isProtected: t.Optional(t.Boolean()),
        },
        // NOTE: additionalProperties left permissive (not false) — updateTask()
        // already destructures only the whitelisted fields above and silently
        // drops the rest, and unlike execute-route's body this one has many
        // long-tail callers; hard-rejecting unknown fields risked breaking a
        // caller that (harmlessly) sends an extra field.
        { additionalProperties: true },
      ),
    },
  )

  // Retry a task that auto-run parked as blocked (or that failed): return it to
  // 'todo' so the next selection picks it up. Without this the only recovery
  // path was manually editing the status — blocked tasks just accumulated.
  .post('/:id/retry', async (context) => {
    const { params, set, headers } = context;
    const id = parseInt(params.id);
    if (isNaN(id)) {
      throw new ValidationError(INVALID_ID);
    }
    const retryRequestId = headers['idempotency-key']?.trim() || crypto.randomUUID();
    set.headers['x-retry-request-id'] = retryRequestId;
    const updated = await retryTask(id, (code) => void (set.status = code), retryRequestId);
    return updated ?? { error: TASK_NOT_FOUND };
  })

  // Delete task
  .delete(
    '/:id',
    async (context) => {
      const { params, set } = context;
      const id = parseInt(params.id);
      if (isNaN(id)) {
        throw new ValidationError(INVALID_ID);
      }

      // Guard: a protected task is blocked from deletion to prevent accidental
      // loss. This is the single choke point for ALL manual delete paths (card
      // context menu, detail page, bulk list delete) since they all hit DELETE
      // /:id. Checked before any worktree cleanup so we never touch a task we
      // are not going to delete.
      const guard = await prisma.task.findUnique({
        where: { id },
        select: { isProtected: true },
      });
      if (guard?.isProtected) {
        set.status = 409;
        return { error: '保護されたタスクは削除できません' };
      }

      // Clean up any worktrees associated with this task before deletion
      try {
        const task = await prisma.task.findUnique({
          where: { id },
          select: { workingDirectory: true, theme: { select: { workingDirectory: true } } },
        });

        if (task) {
          // Find any agent sessions with worktrees for this task
          const sessionsWithWorktrees = await prisma.agentSession.findMany({
            where: {
              worktreePath: { not: null },
              config: {
                taskId: id,
              },
            },
            select: {
              id: true,
              worktreePath: true,
            },
          });

          const baseDir = task.workingDirectory ?? task.theme?.workingDirectory ?? getProjectRoot();

          for (const session of sessionsWithWorktrees) {
            if (!session.worktreePath) continue;
            try {
              const removed = await removeWorktree(baseDir, session.worktreePath);
              if (!removed) {
                logger.warn(`[tasks] worktree remove refused: task ${id} ${session.worktreePath}`);
                continue;
              }
              await prisma.agentSession.update({
                where: { id: session.id },
                data: { worktreePath: null },
              });
              logger.info(`[tasks] Cleaned up worktree for task ${id}: ${session.worktreePath}`);
            } catch (worktreeError) {
              logger.warn(
                { err: worktreeError },
                `[tasks] Failed to clean up worktree for task ${id}: ${session.worktreePath}`,
              );
            }
          }
        }
      } catch (cleanupError) {
        logger.warn(
          { err: cleanupError },
          `[tasks] Failed to clean up worktrees for task ${id}, proceeding with deletion`,
        );
      }

      return await prisma.task.delete({
        where: { id },
      });
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )

  // Delete duplicate subtasks (under a specific task)
  .post('/:id/cleanup-duplicates', async (context) => {
    const { params } = context;
    const parentId = parseInt(params.id);
    if (isNaN(parentId)) {
      throw new ValidationError(INVALID_ID);
    }

    const parentTask = await prisma.task.findUnique({ where: { id: parentId } });
    if (!parentTask) {
      throw new ValidationError(TASK_NOT_FOUND);
    }

    const deletedIds = await cleanupDuplicateSubtasks(prisma, parentId);
    return {
      success: true,
      deletedCount: deletedIds.length,
      deletedIds,
      message:
        deletedIds.length > 0
          ? `${deletedIds.length}件の重複サブタスクを削除しました`
          : '重複サブタスクはありませんでした',
    };
  })

  // Prune old COMPLETED tasks: keep the most recent N, delete older ones after
  // capturing their knowledge (skip extraction when already recorded). Also
  // removes each task's workflow md files and git worktrees. Manual trigger.
  // Body: { keepRecent?: number, dryRun?: boolean }. Use dryRun first to preview.
  .post(
    '/cleanup-completed',
    async (context) => {
      const body = (context.body ?? {}) as {
        keepRecent?: number;
        dryRun?: boolean;
        themeId?: number | null;
      };
      const result = await cleanupCompletedTasks({
        keepRecent: typeof body.keepRecent === 'number' ? body.keepRecent : undefined,
        dryRun: body.dryRun === true,
        themeId: typeof body.themeId === 'number' ? body.themeId : null,
      });
      const scope = result.themeId !== null ? `テーマ#${result.themeId}` : '全テーマ';
      return {
        success: true,
        message: result.dryRun
          ? `[${scope}] ${result.candidateCount}件が削除対象です（直近${result.keepRecent}件は保持・dryRun）`
          : `[${scope}] ${result.deletedCount}件の完了タスクを削除しました（ナレッジ記録 ${result.knowledgeRecorded} / 記録済み ${result.alreadyRecorded} / サブタスク未完でスキップ ${result.skippedWithOpenSubtasks}）`,
        ...result,
      };
    },
    {
      body: t.Optional(
        t.Object({
          keepRecent: t.Optional(t.Number({ minimum: 0 })),
          dryRun: t.Optional(t.Boolean()),
          themeId: t.Optional(t.Union([t.Number(), t.Null()])),
        }),
      ),
    },
  )

  // Bulk delete duplicate subtasks across all tasks
  .post('/cleanup-all-duplicates', async () => {
    const { deletedIds, affectedParents } = await cleanupAllDuplicateSubtasks(prisma);
    return {
      success: true,
      deletedCount: deletedIds.length,
      deletedIds,
      affectedParentCount: affectedParents.length,
      affectedParentIds: affectedParents,
      message:
        deletedIds.length > 0
          ? `${affectedParents.length}件のタスクから${deletedIds.length}件の重複サブタスクを削除しました`
          : '重複サブタスクはありませんでした',
    };
  })

  // Bulk delete all subtasks under a specific task
  .delete(
    '/:id/subtasks',
    async (context) => {
      const { params } = context;
      const parentId = parseInt(params.id);
      if (isNaN(parentId)) {
        throw new ValidationError(INVALID_ID);
      }

      const parentTask = await prisma.task.findUnique({
        where: { id: parentId },
      });

      if (!parentTask) {
        throw new ValidationError(TASK_NOT_FOUND);
      }

      const subtasks = await prisma.task.findMany({
        where: { parentId },
        select: { id: true },
      });

      const deletedCount = subtasks.length;

      await prisma.task.deleteMany({
        where: { parentId },
      });

      logger.info(`[tasks] Deleted all ${deletedCount} subtasks for parent task ${parentId}`);

      return {
        success: true,
        deletedCount,
        message:
          deletedCount > 0
            ? `${deletedCount}件のサブタスクを削除しました`
            : '削除するサブタスクがありませんでした',
      };
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )

  // Delete selected subtasks by ID
  .post(
    '/:id/subtasks/delete-selected',
    async ({ params, body }) => {
      const parentId = parseInt(params.id);
      if (isNaN(parentId)) {
        throw new ValidationError(INVALID_ID);
      }

      const { subtaskIds } = body as { subtaskIds: number[] };

      if (!subtaskIds || subtaskIds.length === 0) {
        throw new ValidationError('削除するサブタスクが指定されていません');
      }

      const parentTask = await prisma.task.findUnique({
        where: { id: parentId },
      });

      if (!parentTask) {
        throw new ValidationError(TASK_NOT_FOUND);
      }

      // Verify subtasks belong to this parent
      const validSubtasks = await prisma.task.findMany({
        where: { id: { in: subtaskIds }, parentId },
        select: { id: true },
      });

      const validIds = validSubtasks.map((s: { id: number }) => s.id);
      const invalidIds = subtaskIds.filter((id) => !validIds.includes(id));

      if (invalidIds.length > 0) {
        logger.warn(
          `[tasks] Some subtask IDs are invalid or don't belong to parent ${parentId}: ${invalidIds.join(', ')}`,
        );
      }

      // Delete only valid subtasks
      const deleteResult = await prisma.task.deleteMany({
        where: {
          id: { in: validIds },
          parentId,
        },
      });

      logger.info(
        `[tasks] Deleted ${deleteResult.count} selected subtasks for parent task ${parentId}`,
      );

      return {
        success: true,
        deletedCount: deleteResult.count,
        deletedIds: validIds,
        invalidIds,
        message:
          deleteResult.count > 0
            ? `${deleteResult.count}件のサブタスクを削除しました`
            : '削除するサブタスクがありませんでした',
      };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object(
        {
          subtaskIds: t.Array(t.Number(), { maxItems: 500 }),
        },
        { additionalProperties: false },
      ),
    },
  );
