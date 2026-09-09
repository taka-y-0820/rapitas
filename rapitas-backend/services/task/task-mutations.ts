/**
 * Task Mutations
 *
 * Public API for task creation and updates, including label management,
 * user behavior recording, and study streak tracking.
 * Private create helpers live in task-create-helpers.ts.
 * Does NOT handle suggestions, cleanup utilities, or query-only operations.
 */
import { PrismaClient } from '../../generated/prisma-postgres';
import { createLogger } from '../../config/logger';
import { UserBehaviorService } from '../../src/services/user-behavior-service';
import { notifyTaskCompleted, createNotification } from '../communication/notification-service';
import { buildNotificationI18n } from '../communication/notification-i18n';
import { onGeneratedTaskCompleted } from '../scheduling/recurring-task-service';
import { createSubtask, createParentTask } from './task-create-helpers';
import { syncParentStatusFromSubtasks } from './task-parent-status-sync';
import { realtimeService } from '../communication/realtime-service';
import { syncTaskToCalendar } from '../scheduling/task-calendar-sync';
import {
  linkTaskToMiss,
  autoLinkMatchingMisses,
  resolveSearchMissForTask,
} from '../search/search-miss-service';

type PrismaInstance = InstanceType<typeof PrismaClient>;

const logger = createLogger('task-mutations');

/**
 * Common Prisma include for task queries that return the full task shape.
 *
 * NOTE: Exported so sub-modules (task-create-helpers, etc.) can share this without duplication.
 */
export const TASK_FULL_INCLUDE = {
  subtasks: { orderBy: { createdAt: 'asc' as const } },
  theme: true,
  project: true,
  milestone: true,
  examGoal: true,
  taskLabels: { include: { label: true } },
} as const;

/** Input shape for task creation. */
export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: string;
  labelIds?: number[];
  estimatedHours?: number;
  actualHours?: number;
  dueDate?: string;
  subject?: string;
  parentId?: number;
  projectId?: number;
  milestoneId?: number;
  themeId?: number;
  examGoalId?: number;
  isDeveloperMode?: boolean;
  isAiTaskAnalysis?: boolean;
  /** Structured spec — stored as JSON-array strings (mirrors `labels`). */
  goals?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  /** SearchMiss ID to link on creation — bridges gap resolution flow. */
  searchMissId?: number;
}

/**
 * Recalculates a parent's actualHours as the sum of its subtasks' actualHours.
 *
 * The parent's stored work time must always reflect the subtask total once
 * subtasks carry their own hours, so both the create and update paths call this.
 *
 * @param prisma - Prisma client instance / Prismaクライアント
 * @param parentId - Parent task ID / 親タスクID
 */
async function recalcParentActualHours(prisma: PrismaInstance, parentId: number) {
  const siblings = await prisma.task.findMany({
    where: { parentId },
    select: { actualHours: true },
  });
  const parentActual = siblings.reduce((sum, s) => sum + (s.actualHours ?? 0), 0);
  await prisma.task.update({
    where: { id: parentId },
    data: { actualHours: parentActual > 0 ? parentActual : null },
  });
}

/**
 * Creates a task (parent or subtask) based on whether parentId is provided.
 *
 * @param prisma - Prisma client instance / Prismaクライアント
 * @param input - Task creation input / タスク作成入力
 * @returns Created task with full includes / フルインクルード付きの作成タスク
 */
export async function createTask(prisma: PrismaInstance, input: CreateTaskInput) {
  const { parentId, title, labelIds, searchMissId, ...rest } = input;

  const task = parentId
    ? await createSubtask(prisma, parentId, title, labelIds, rest)
    : await createParentTask(prisma, title, labelIds, rest);

  // NOTE: A subtask created with actualHours must roll into the parent's
  // total immediately — the update-path rollup never fires for creates.
  if (task && parentId && rest.actualHours) {
    await recalcParentActualHours(prisma, parentId);
  }

  // NOTE: Adding a subtask must recompute the parent's status the same way a
  // subtask status CHANGE does (operator request 2026-09-03) — e.g. a new
  // todo subtask under an all-done parent reopens it to in-progress. The
  // sync's own guards (workflow-managed done deferral, no-op on same status)
  // apply unchanged.
  if (task && parentId) {
    await syncParentStatusFromSubtasks(prisma, parentId);
  }

  // NOTE: Broadcast task creation via SSE for real-time list updates.
  if (task) {
    // NOTE: Gap resolution — link SearchMiss to the new task so it can be resolved on completion.
    // If searchMissId is provided (task created from SearchMissPanel), link directly.
    // Otherwise, fall back to title-match auto-linking for tasks created via normal flow.
    if (searchMissId) {
      linkTaskToMiss(prisma, searchMissId, task.id).catch(() => {});
    } else {
      autoLinkMatchingMisses(prisma, task.id, title).catch(() => {});
    }

    realtimeService.sendTaskUpdate(task.id, 'task_created', {
      taskId: task.id,
      title: task.title,
      status: task.status,
      parentId: task.parentId,
      timestamp: new Date().toISOString(),
    });

    // Persist a Notification row so the bell shows the new task and the
    // user can jump straight to its detail page. `link: /tasks/:id` is
    // what `NotificationBell` wraps in <Link>, giving us the click-to-
    // navigate behavior for free. Best-effort: a notification failure
    // must NEVER block the actual task creation.
    prisma.notification
      .create({
        data: {
          type: 'task_created',
          title: parentId ? 'サブタスクを作成しました' : 'タスクを作成しました',
          message: task.title,
          link: `/tasks/${task.id}`,
          metadata: JSON.stringify({
            taskId: task.id,
            parentId: task.parentId ?? null,
            i18n: buildNotificationI18n(parentId ? 'task_created_subtask' : 'task_created', {
              taskTitle: task.title,
            }),
          }),
        },
      })
      .catch(() => {
        /* notification failure is non-fatal */
      });
  }

  return task;
}

/** Input shape for task updates. */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  themeId?: number;
  status?: string;
  priority?: string;
  labels?: string;
  labelIds?: number[];
  estimatedHours?: number | null;
  actualHours?: number | null;
  dueDate?: string | null;
  startedAt?: string | null;
  subject?: string;
  projectId?: number;
  milestoneId?: number;
  examGoalId?: number;
  autoApprovePlan?: boolean;
  goals?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  isProtected?: boolean;
}

/**
 * Updates a task's fields, labels, streaks, and user behavior records.
 *
 * @param prisma - Prisma client instance / Prismaクライアント
 * @param taskId - Task ID to update / 更新するタスクID
 * @param input - Fields to update / 更新フィールド
 * @returns Updated task with full includes / フルインクルード付きの更新タスク
 * @throws {Error} When the task is not found / タスクが見つからない場合
 */
export async function updateTask(prisma: PrismaInstance, taskId: number, input: UpdateTaskInput) {
  const { labelIds, ...fields } = input;

  const currentTask = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, parentId: true, workflowStatus: true, updatedAt: true },
  });

  if (!currentTask) {
    throw new Error(`タスク(ID: ${taskId})が見つかりません`);
  }

  const reopening = currentTask.status === 'done' && fields.status === 'todo';

  // Record streak
  if (fields.status === 'done') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await prisma.studyStreak.upsert({
      where: { date: today },
      update: { tasksCompleted: { increment: 1 } },
      create: { date: today, studyMinutes: 0, tasksCompleted: 1 },
    });
  }

  await prisma.task.update({
    where: {
      id: taskId,
      ...((fields.status === 'blocked' || reopening) && { updatedAt: currentTask.updatedAt }),
    },
    data: {
      // Make a manual re-block a new revision even within the same millisecond.
      ...(fields.status === 'blocked' && {
        updatedAt: new Date(Math.max(Date.now(), currentTask.updatedAt.getTime() + 1)),
      }),
      ...(fields.title && { title: fields.title }),
      ...(fields.description !== undefined && { description: fields.description }),
      ...(fields.themeId !== undefined && { themeId: fields.themeId }),
      ...(fields.status && { status: fields.status }),
      ...(fields.status === 'done' && { completedAt: new Date() }),
      // Reopening must not leave a terminal workflow badge/state behind.
      // Retain artifacts; normal file-save guards validate their reuse.
      ...(reopening && {
        completedAt: null,
        startedAt: null,
        ...(currentTask.workflowStatus === 'completed' && { workflowStatus: 'draft' }),
      }),
      // Keep workflowStatus in lock-step when a workflow task is marked done.
      // The card badge reads workflowStatus, so a task completed via the kanban
      // (or any path through updateTask) would otherwise still show "進行中"
      // because only `status` flipped to done. Only touch genuine workflow tasks
      // (workflowStatus set) that aren't already completed; leave plain tasks be.
      ...(fields.status === 'done' &&
        currentTask?.workflowStatus &&
        currentTask.workflowStatus !== 'completed' && { workflowStatus: 'completed' }),
      ...(fields.status === 'in-progress' &&
        currentTask?.status !== 'in-progress' && { startedAt: new Date() }),
      ...(fields.priority && { priority: fields.priority }),
      ...(fields.labels && { labels: fields.labels }),
      ...(fields.estimatedHours !== undefined && { estimatedHours: fields.estimatedHours }),
      ...(fields.actualHours !== undefined && { actualHours: fields.actualHours }),
      ...(fields.dueDate !== undefined && {
        dueDate: fields.dueDate ? new Date(fields.dueDate) : null,
      }),
      ...(fields.startedAt !== undefined && {
        startedAt: fields.startedAt ? new Date(fields.startedAt) : null,
      }),
      ...(fields.subject !== undefined && { subject: fields.subject }),
      ...(fields.projectId !== undefined && { projectId: fields.projectId }),
      ...(fields.milestoneId !== undefined && { milestoneId: fields.milestoneId }),
      ...(fields.examGoalId !== undefined && { examGoalId: fields.examGoalId }),
      ...(fields.autoApprovePlan !== undefined && { autoApprovePlan: fields.autoApprovePlan }),
      ...(fields.isProtected !== undefined && { isProtected: fields.isProtected }),
      // NOTE: Structured spec stored as JSON-array strings, mirroring `labels`.
      ...(fields.goals !== undefined && { goals: JSON.stringify(fields.goals) }),
      ...(fields.constraints !== undefined && { constraints: JSON.stringify(fields.constraints) }),
      ...(fields.acceptanceCriteria !== undefined && {
        acceptanceCriteria: JSON.stringify(fields.acceptanceCriteria),
      }),
    },
  });

  // Update labels
  if (labelIds !== undefined) {
    await prisma.taskLabel.deleteMany({ where: { taskId } });
    if (labelIds.length > 0) {
      await prisma.taskLabel.createMany({
        data: labelIds.map((labelId) => ({ taskId, labelId })),
      });
    }
  }

  const updatedTask = await prisma.task.findUnique({
    where: { id: taskId },
    include: TASK_FULL_INCLUDE,
  });

  // Record user behavior (parent tasks only)
  if (!currentTask?.parentId && updatedTask) {
    if (fields.status && currentTask?.status !== fields.status) {
      if (fields.status === 'in-progress' && currentTask?.status !== 'in-progress') {
        await UserBehaviorService.recordTaskStarted(taskId, updatedTask);
      } else if (fields.status === 'done' && currentTask?.status !== 'done') {
        // Instrumentation for the complete-triggered event-loop stall bursts
        // (2026-09-05 17:47, concern #514): WARN any completion hook >1s.
        const timedWarn = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
          const t0 = Date.now();
          try {
            return await run();
          } finally {
            const tookMs = Date.now() - t0;
            if (tookMs > 1000) logger.warn({ taskId, label, tookMs }, 'Slow completion hook');
          }
        };
        await timedWarn('recordTaskCompleted', () =>
          UserBehaviorService.recordTaskCompleted(taskId, updatedTask),
        );
        notifyTaskCompleted(taskId, updatedTask.title).catch((err) => {
          logger.warn({ err, taskId }, 'Failed to send task completion notification');
        });
        // Trigger next recurring task generation if this was a generated task
        onGeneratedTaskCompleted(prisma, updatedTask).catch((err) => {
          logger.warn({ err, taskId }, 'Failed to generate next recurring task');
        });
        // NOTE: Auto-extract knowledge from completed tasks — connects Task → KnowledgeEntry.
        import('../memory/task-knowledge-extractor')
          .then(({ extractKnowledgeFromTask }) => {
            void timedWarn('extractKnowledge', () => extractKnowledgeFromTask(taskId)).catch(
              (err) => {
                logger.warn({ err, taskId }, 'Failed to extract knowledge from completed task');
              },
            );
          })
          .catch((err) => {
            // NOTE: Unlike the inner catch above (which logs an extraction
            // failure), this outer catch fires when the extractor MODULE
            // itself couldn't even be imported. Without this log there was
            // zero signal that knowledge extraction never ran at all for
            // this completed task.
            logger.warn({ err, taskId }, 'Failed to load knowledge extractor module');
          });
      }
    }

    if (
      fields.title ||
      fields.description !== undefined ||
      fields.priority ||
      fields.themeId !== undefined
    ) {
      await UserBehaviorService.recordBehavior('task_updated', {
        taskId,
        themeId: updatedTask.themeId ?? undefined,
        metadata: {
          changes: {
            title: fields.title !== undefined,
            description: fields.description !== undefined,
            priority: fields.priority !== undefined,
            themeId: fields.themeId !== undefined,
          },
        },
      });
    }
  }

  // NOTE: When a subtask's actualHours is updated, recalculate the parent's
  // actualHours as the sum of all sibling actualHours so the parent always
  // reflects total time spent across its subtasks.
  if (fields.actualHours !== undefined && currentTask.parentId) {
    await recalcParentActualHours(prisma, currentTask.parentId);
  }

  // NOTE: When a subtask's status changes, recompute the parent's status from
  // all sibling statuses. See task-parent-status-sync.ts for the rule and why
  // it defers 'done' to onSubtaskCompleted for workflow-managed parents.
  if (fields.status !== undefined && currentTask.parentId) {
    await syncParentStatusFromSubtasks(prisma, currentTask.parentId);
  }

  // Subtask completion: when a SUBTASK (has parentId) is marked done via the
  // task API, check whether all siblings are done and finalize the parent.
  // NOTE: this MUST live outside the `!currentTask?.parentId` (parent-only)
  // block above — it was previously nested inside it with a contradictory
  // `currentTask?.parentId` guard, making it dead code that never ran, so a
  // split parent was never driven to completion after its subtasks finished.
  if (fields.status === 'done' && currentTask?.parentId && updatedTask) {
    const parentId = currentTask.parentId;
    import('../workflow/subtask-completion-handler')
      .then(({ onSubtaskCompleted }) => {
        onSubtaskCompleted(taskId).catch((err) => {
          // FAIL RECOVERABLE, not silent: onSubtaskCompleted is the ONLY driver of
          // parent finalization, and it fires again only when a SIBLING completes.
          // If this is the last sibling, a swallowed failure here would strand the
          // parent forever with no further trigger. Notify so a human can retry
          // finalization (via the parent task) instead of it silently vanishing.
          logger.warn({ err, taskId, parentId }, 'Failed to handle subtask completion');
          createNotification({
            type: 'system',
            title: 'サブタスク完了処理に失敗',
            message: `サブタスク #${taskId} の完了処理でエラーが発生しました。親タスク #${parentId} が完了しない場合は手動確認してください。`,
            link: `/tasks?taskId=${parentId}`,
            metadata: { taskId, parentId, reason: 'subtask_completion_handler_failed' },
          }).catch(() => {});
        });
      })
      .catch(() => {});
  }

  // NOTE: Resolve linked SearchMiss records when a task is marked done.
  // SearchMiss is task-hierarchy-agnostic, so this fires for both parent tasks and subtasks.
  if (fields.status === 'done') {
    resolveSearchMissForTask(prisma, taskId).catch((err) => {
      logger.warn({ err, taskId }, 'Failed to resolve search miss for task');
    });
  }

  // Replacing the acceptance criteria invalidates every repair reason recorded
  // against the OLD ones. Those reasons cite criteria by NUMBER, and the numbers
  // now point at different criteria, so the convergence detector counts a stale
  // indictment against a criterion nobody has ever failed. Observed on task 672:
  // the criteria were corrected mid-flight and the next single bounce tripped
  // the cutoff using two pre-correction reasons.
  //
  // Recorded as an activity so the detector can bound its window on it, exactly
  // as it already bounds on `task_retried`.
  if (fields.acceptanceCriteria !== undefined && updatedTask) {
    await prisma.activityLog
      .create({
        data: {
          taskId,
          action: 'acceptance_criteria_changed',
          metadata: JSON.stringify({ count: fields.acceptanceCriteria.length }),
        },
      })
      .catch((err: unknown) =>
        logger.warn({ err, taskId }, '[task] criteria-change activity not recorded (non-fatal)'),
      );
  }

  // NOTE: Broadcast task update via SSE — enables real-time sync across all connected clients.
  if (updatedTask) {
    const eventType =
      fields.status === 'done'
        ? 'task_completed'
        : fields.status
          ? 'task_status_changed'
          : 'task_updated';

    realtimeService.sendTaskUpdate(taskId, eventType, {
      taskId,
      status: updatedTask.status,
      title: updatedTask.title,
      priority: updatedTask.priority,
      themeId: updatedTask.themeId,
      timestamp: new Date().toISOString(),
    });

    // NOTE: Bidirectional sync — task dueDate changes propagate to calendar events.
    if (fields.dueDate !== undefined) {
      syncTaskToCalendar(taskId, updatedTask.dueDate, updatedTask.title).catch((err) => {
        logger.warn({ err, taskId }, 'Task-to-calendar sync failed');
      });
    }
  }

  return updatedTask;
}
