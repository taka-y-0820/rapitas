/**
 * queue-dequeue-candidate
 *
 * Per-candidate dispatch evaluation for WorkflowQueueService.dequeue():
 * dependency completion, the confirmed-vanished-task guard, the terminal-task
 * guard, sibling-subtask serialization, and the transactional acquire.
 * Extracted from workflow-queue.ts (file-size split); the candidate loop in
 * workflow-queue.ts calls this once per candidate and moves to the next one
 * when it returns null.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { resolveTaskWorkflowState, taskRowConfirmedAbsent } from '../task/task-resolver';
import { isTaskTerminalForQueue } from './queue-terminal-task-guard';
import { mapToQueueItem } from './queue-item-mapper';
import { taskVanishedMessage } from './queue-vanished-task-policy';
import type { QueueItem, WorkflowQueueItemRow } from './workflow-queue.types';
import { isQueueThemeRunning } from './queue-theme-guard';

const log = createLogger('workflow-queue');

/**
 * Evaluate one dequeue candidate: dependency check, vanished/terminal-task
 * guards, sibling-subtask serialization, and (if all pass) the transactional
 * acquire that promotes it to 'running'.
 *
 * @param candidate - Candidate queue item row. / 候補キュー項目行
 * @param maxConcurrency - Current concurrency limit for the re-check inside
 *   the transaction. / トランザクション内再チェック用の同時実行上限
 * @returns The acquired QueueItem, or null when this candidate cannot be
 *   dispatched (caller should try the next candidate). / 取得できなければ null
 */
export async function tryDequeueCandidate(
  candidate: WorkflowQueueItemRow & { dependencies: string },
  maxConcurrency: number,
): Promise<QueueItem | null> {
  const deps = JSON.parse(candidate.dependencies || '[]') as number[];

  // Check if all dependency tasks are completed (or cancelled)
  if (deps.length > 0) {
    const incompleteDeps = await prisma.workflowQueueItem.count({
      where: {
        taskId: { in: deps },
        orchestraSessionId: candidate.orchestraSessionId,
        status: { notIn: ['completed', 'cancelled'] },
      },
    });
    if (incompleteDeps > 0) return null;
  }

  const candidateTask = await resolveTaskWorkflowState(candidate.taskId);

  // Confirmed-vanished-task guard: the task row was CONFIRMED absent (not a
  // transient lookup failure — see taskRowConfirmedAbsent) between enqueue and
  // dequeue. Dispatching would only fail with "Task not found" after burning a
  // retry and writing a meaningless task.blocked (task 651: task 648).
  // Cancel here, before the costliest step (spawning a phase's agent).
  if (!candidateTask && (await taskRowConfirmedAbsent(candidate.taskId))) {
    await prisma.workflowQueueItem
      .update({
        where: { id: candidate.id },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
          errorMessage: taskVanishedMessage(candidate.taskId),
        },
      })
      .catch(() => {});
    log.info(
      `[WorkflowQueue] Cancelled queue item ${candidate.id} — task ${candidate.taskId} row confirmed absent`,
    );
    return null;
  }

  // Terminal-task guard: a queue item can outlive its task (a
  // completion-era re-dispatch raced the task finishing — task 537 left
  // one 'queued' forever, pinning queueDepth at 1 and dispatching a
  // phantom implementer that failed with "no code changes"). Cancel the
  // stale item instead of dispatching a phase for finished work.
  // Requires POSITIVE terminal evidence — a null lookup can also be a
  // transient DB error and must not destroy a valid queue item.
  if (isTaskTerminalForQueue(candidateTask)) {
    await prisma.workflowQueueItem
      .update({
        where: { id: candidate.id },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
          errorMessage: 'タスクは既に終端状態のため、残留キュー項目を自動キャンセルしました',
        },
      })
      .catch(() => {});
    log.info(
      `[WorkflowQueue] Cancelled stale queue item ${candidate.id} (task ${candidate.taskId} already terminal)`,
    );
    return null;
  }

  // Strict sequential execution for sibling subtasks (same parent): run
  // ONE at a time, in creation (id) order. Plan-split subtasks share the
  // parent's git worktree and often build on each other, so running them
  // concurrently risks conflicts and lower quality — hold a candidate back
  // while any sibling is active, or while an earlier-created sibling is
  // still pending. Non-subtasks (no parentId) are unaffected.
  if (candidateTask?.parentId != null) {
    const siblings = await prisma.task.findMany({
      where: { parentId: candidateTask.parentId, id: { not: candidate.taskId } },
      select: { id: true },
    });
    const siblingIds = siblings.map((s) => s.id);
    if (siblingIds.length > 0) {
      const activeSibling = await prisma.workflowQueueItem.count({
        where: {
          taskId: { in: siblingIds },
          orchestraSessionId: candidate.orchestraSessionId,
          status: { in: ['running', 'waiting_approval'] },
        },
      });
      if (activeSibling > 0) return null; // a sibling is already running

      const earlierIds = siblingIds.filter((id) => id < candidate.taskId);
      if (earlierIds.length > 0) {
        const earlierPending = await prisma.workflowQueueItem.count({
          where: {
            taskId: { in: earlierIds },
            orchestraSessionId: candidate.orchestraSessionId,
            status: { in: ['queued', 'running', 'waiting_approval'] },
          },
        });
        if (earlierPending > 0) return null; // earlier-created sibling goes first
      }
    }
  }

  // Start execution (transaction prevents race conditions)
  if (!(await isQueueThemeRunning(candidate.taskId))) return null;
  const updated = await prisma.$transaction(async (tx) => {
    // Re-check status (another worker may have acquired it)
    const current = await tx.workflowQueueItem.findUnique({
      where: { id: candidate.id },
    });
    if (!current || current.status !== 'queued') {
      return null; // Already acquired by another worker
    }
    if (!(await isQueueThemeRunning(candidate.taskId, tx))) return null;

    // Re-check concurrency limit
    const currentRunning = await tx.workflowQueueItem.count({
      where: { status: 'running' },
    });
    if (currentRunning >= maxConcurrency) {
      return null; // Concurrency limit reached
    }

    return tx.workflowQueueItem.update({
      where: { id: candidate.id },
      data: { status: 'running', startedAt: new Date() },
    });
  });

  if (updated) {
    log.info(`[WorkflowQueue] Dequeued task ${candidate.taskId} (item ${candidate.id})`);
    return mapToQueueItem(updated);
  }
  return null;
}
