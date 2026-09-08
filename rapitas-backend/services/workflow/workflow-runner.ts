/**
 * Workflow Runner Service
 *
 * Dequeues tasks and executes each workflow phase asynchronously.
 * Uses the existing WorkflowOrchestrator for phase progression.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { WorkflowQueueService, type QueueItem } from './workflow-queue';
import { WorkflowOrchestrator } from './workflow-orchestrator';
import { resolveTaskWorkflowState, taskRowConfirmedAbsent } from '../task/task-resolver';
import {
  logPhaseTransition,
  broadcastRunnerStatus,
  broadcastItemUpdate,
} from './workflow-runner-events';
import { isShutdownError } from '../agents/orchestrator/shutdown-error';
import { waitForVerifyCompletion } from './workflow-runner-verify-settle';
import {
  resolveMaxIterations,
  resolvePhaseTimeoutMs,
  notifyParentOnSubtaskFailure,
  shouldAutoApprovePlan,
  raceWorkflowAdvance,
  waitBeforeNextPhase,
  stopFailedPhaseAgents,
} from './workflow-runner-item-helpers';
import { taskVanishedMessage } from './queue-vanished-task-policy';
import type { RunnerStatus, ActiveExecution } from './workflow-runner.types';

export type { RunnerStatus } from './workflow-runner.types';

const log = createLogger('workflow-runner');

export class WorkflowRunner {
  private static instance: WorkflowRunner;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // NOTE: Extended from 5s to 10s — phases take minutes; 10s adds at most 10s
  // of inter-phase latency which is imperceptible but halves idle DB query rate.
  private pollIntervalMs = 10_000;
  private processedTotal = 0;
  private activeExecutions = new Map<number, ActiveExecution>();
  private queue: WorkflowQueueService;
  private orchestrator: WorkflowOrchestrator;

  private constructor() {
    this.queue = WorkflowQueueService.getInstance();
    this.orchestrator = WorkflowOrchestrator.getInstance();
  }

  static getInstance(): WorkflowRunner {
    if (!WorkflowRunner.instance) {
      WorkflowRunner.instance = new WorkflowRunner();
    }
    return WorkflowRunner.instance;
  }

  /**
   * Whether the polling loop is currently active.
   *
   * The queue-stall reconciler needs this to tell two situations apart that
   * look identical from the queue table: a runner that has stopped (kicking it
   * helps) and a runner that is alive but not claiming items (kicking it is a
   * no-op). Without it the reconciler logged "restarted WorkflowRunner" 78
   * times in one day against a runner that answered "Already running" every
   * time (measured 2026-08-28).
   *
   * @returns true while the poll loop is running. / ポーリング稼働中は true
   */
  isProcessing(): boolean {
    return this.running;
  }

  /**
   * Start the queue monitoring and processing loop.
   */
  startProcessing(intervalMs?: number): void {
    if (this.running) {
      log.warn('[WorkflowRunner] Already running');
      return;
    }

    this.running = true;
    if (intervalMs) this.pollIntervalMs = intervalMs;

    log.info(`[WorkflowRunner] Started processing (poll interval: ${this.pollIntervalMs}ms)`);
    this.broadcastStatus('runner_started');

    // Process once immediately, then start interval
    this.processQueue();
    this.pollTimer = setInterval(() => this.processQueue(), this.pollIntervalMs);
  }

  /**
   * Graceful shutdown.
   */
  async stopProcessing(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Cancel active executions. Aborting the controller only stops the loop
    // from starting the NEXT phase — the agent process spawned for the CURRENT
    // phase keeps running until killed. stopTaskAgents kills every in-flight
    // agent for the task so shutdown actually halts work in progress.
    const { stopTaskAgents } = await import('../agents/stop-task-agents');
    for (const [itemId, exec] of this.activeExecutions) {
      exec.abortController.abort();
      await stopTaskAgents(exec.taskId, { errorMessage: 'Runner shutdown' }).catch((e) => {
        log.warn({ err: e, taskId: exec.taskId }, '[WorkflowRunner] Failed to stop agents');
      });
      try {
        await this.queue.updateStatus(itemId, 'queued', {
          errorMessage: 'Runner shutdown - returned to queue',
        });
      } catch (e) {
        log.warn({ err: e }, `[WorkflowRunner] Failed to requeue item ${itemId}`);
      }
    }
    this.activeExecutions.clear();

    log.info('[WorkflowRunner] Stopped processing');
    this.broadcastStatus('runner_stopped');
  }

  /**
   * Abort the in-flight phase loop(s) for a task. Used by stop paths (auto-run
   * stop / manual stop) so the runner does NOT advance to or retry another
   * phase after the agent is killed. Without this, a stop that landed between
   * phases let the loop spawn the next phase's agent — the agent "wouldn't
   * stop". Combined with the cancelled-item retry guard in WorkflowQueueService.
   *
   * @param taskId - The task whose in-flight execution should be aborted. / 中断対象タスクID
   * @returns Number of executions aborted. / 中断した実行数
   */
  abortTask(taskId: number): number {
    let aborted = 0;
    for (const exec of this.activeExecutions.values()) {
      if (exec.taskId === taskId && !exec.abortController.signal.aborted) {
        exec.abortController.abort();
        aborted++;
      }
    }
    if (aborted > 0) {
      log.info(`[WorkflowRunner] Aborted ${aborted} in-flight execution(s) for task ${taskId}`);
    }
    return aborted;
  }

  /**
   * Get runner status.
   */
  getStatus(): RunnerStatus {
    return {
      isRunning: this.running,
      activeItems: this.activeExecutions.size,
      processedTotal: this.processedTotal,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  /**
   * Dequeue items and process them.
   */
  private async processQueue(): Promise<void> {
    if (!this.running) return;

    try {
      // Dequeue while there are free slots
      while (this.activeExecutions.size < this.queue.getMaxConcurrency()) {
        const item = await this.queue.dequeue();
        if (!item) break;

        // Start execution async (fire-and-forget)
        this.executeWorkflowItem(item);
      }
    } catch (error) {
      log.error({ err: error }, '[WorkflowRunner] Error in processQueue');
    }
  }

  /**
   * Execute the entire workflow for a single task asynchronously.
   */
  private async executeWorkflowItem(item: QueueItem): Promise<void> {
    const abortController = new AbortController();
    const execution: ActiveExecution = {
      queueItemId: item.id,
      taskId: item.taskId,
      startedAt: new Date(),
      currentPhase: item.currentPhase,
      abortController,
    };

    this.activeExecutions.set(item.id, execution);
    this.broadcastItemUpdate(item.id, item.taskId, 'execution_started', item.currentPhase);

    try {
      // Progress workflow from current phase to completion (with infinite loop prevention)
      let continueLoop = true;
      const maxIterations = resolveMaxIterations();
      let iterationCount = 0;

      while (continueLoop && !abortController.signal.aborted && iterationCount < maxIterations) {
        iterationCount++;
        // Check current workflowStatus
        const task = await resolveTaskWorkflowState(item.taskId);
        if (!task) {
          // Confirmed-vanished-task guard: the task row was CONFIRMED absent
          // (not a transient lookup failure), most often because the
          // dequeue-time guard in queue-dequeue-candidate.ts missed it (the
          // task was deleted AFTER dispatch). Cancel without consuming a
          // retry — retrying can never make a deleted row reappear, and doing
          // so previously wrote a meaningless task.blocked (task 651: task
          // 648). Not a `throw`: this must not go through retryIfPossible.
          if (await taskRowConfirmedAbsent(item.taskId)) {
            await this.queue.updateStatus(item.id, 'cancelled', {
              errorMessage: taskVanishedMessage(item.taskId),
              currentPhase: execution.currentPhase,
            });
            log.warn(
              `[WorkflowRunner] Task ${item.taskId} row confirmed absent — cancelling item ${item.id} without retry`,
            );
            this.broadcastItemUpdate(
              item.id,
              item.taskId,
              'execution_error',
              execution.currentPhase,
            );
            continueLoop = false;
            break;
          }
          throw new Error(`Task ${item.taskId} not found`);
        }

        const currentStatus = task.workflowStatus || 'draft';
        execution.currentPhase = currentStatus;

        // Completion check.
        // `verify_done` alone is not terminal: verify.md may have been written
        // while requested commit/PR/merge automation failed. Only `completed`
        // (or a done task for backwards compatibility) closes the queue item.
        if (
          currentStatus === 'completed' ||
          (currentStatus === 'verify_done' && task.status === 'done')
        ) {
          await this.queue.updateStatus(item.id, 'completed', {
            currentPhase: currentStatus,
            result: JSON.stringify({ completedAt: new Date().toISOString() }),
          });
          this.broadcastItemUpdate(item.id, item.taskId, 'workflow_completed', currentStatus);

          // Propagate completion to the parent when this was a subtask. The
          // subtask reaches its terminal state here (queue-driven), not via the
          // task API, so this is the path that must notify the parent. The
          // handler no-ops for non-subtasks (parentId === null).
          if (task.parentId) {
            const { onSubtaskCompleted } = await import('./subtask-completion-handler');
            onSubtaskCompleted(item.taskId).catch((err) => {
              log.warn(
                { err, taskId: item.taskId, parentId: task.parentId },
                '[WorkflowRunner] Failed to propagate subtask completion to parent',
              );
            });
          }

          continueLoop = false;
          break;
        }

        if (currentStatus === 'verify_done') {
          // verify.md was just saved; the commit/PR/merge completion automation
          // runs ASYNCHRONOUSLY and then flips task.status→done (or moves the task
          // to self-repair / leaves it verify_done on a real, persistent failure).
          // Polling can land in the brief window AFTER verify_done is set but
          // BEFORE that automation finishes — declaring 'failed' there made the UI
          // flash a misleading "blocked"/"failed" for ~20-30s before the task
          // actually completed. Wait (bounded) for it to settle before judging.
          const settled = await waitForVerifyCompletion(item.taskId, abortController.signal);
          if (settled === 'completed') {
            await this.queue.updateStatus(item.id, 'completed', {
              currentPhase: 'completed',
              result: JSON.stringify({ completedAt: new Date().toISOString() }),
            });
            this.broadcastItemUpdate(item.id, item.taskId, 'workflow_completed', 'completed');
            if (task.parentId) {
              const { onSubtaskCompleted } = await import('./subtask-completion-handler');
              onSubtaskCompleted(item.taskId).catch((err) => {
                log.warn(
                  { err, taskId: item.taskId, parentId: task.parentId },
                  '[WorkflowRunner] Failed to propagate subtask completion to parent',
                );
              });
            }
            continueLoop = false;
            break;
          }
          if (settled === 'moved') {
            // The task left verify_done (e.g. self-repair bounced it back to
            // in_progress). Re-loop to handle the new phase instead of failing.
            continue;
          }
          if (abortController.signal.aborted) {
            // The grace window ended because auto-run was STOPPED, not because the
            // task failed — don't mark it failed; the stop path owns the outcome.
            continueLoop = false;
            break;
          }
          // 'stuck': still verify_done after the grace window — a real, persistent
          // completion-gate failure, so surfacing it as failed is now correct.
          await this.queue.updateStatus(item.id, 'failed', {
            currentPhase: currentStatus,
            errorMessage:
              'verify.md was saved, but the task did not pass the completion gate. Check commit/PR/merge automation results.',
          });
          this.broadcastItemUpdate(item.id, item.taskId, 'execution_failed', currentStatus);
          await notifyParentOnSubtaskFailure(item.taskId);
          continueLoop = false;
          break;
        }

        // plan_created: check auto-approve setting before waiting
        if (currentStatus === 'plan_created') {
          if (await shouldAutoApprovePlan(item.taskId)) {
            // NOTE: Auto-approve — skip waiting and advance immediately. Keep
            // task.status in sync with the workflow phase so the subtask-
            // completion handler (which reads both fields) never sees a stale
            // status and strands the parent.
            await prisma.task.update({
              where: { id: item.taskId },
              data: { workflowStatus: 'plan_approved', status: 'in-progress' },
            });
            this.broadcastItemUpdate(item.id, item.taskId, 'phase_completed', 'plan_created');
            log.info(`[WorkflowRunner] Plan auto-approved for task ${item.taskId}`);
            continue;
          }

          await this.queue.updateStatus(item.id, 'waiting_approval', {
            currentPhase: 'plan_created',
          });
          this.broadcastItemUpdate(item.id, item.taskId, 'waiting_approval', 'plan_created');
          continueLoop = false;
          break;
        }

        // Log phase transition
        await this.logPhaseTransition(item.taskId, currentStatus, 'advancing');

        // Execute next phase (with timeout)
        this.broadcastItemUpdate(item.id, item.taskId, 'phase_started', currentStatus);

        // Resolve the role the phase about to run dispatches as, so the backstop
        // stays above the implementer's raised wall-clock cap (task 546). Resolved
        // BEFORE advanceWorkflow so no await sits between the execution promise
        // and the race below (an early rejection there would surface as an
        // unhandled rejection).
        const phaseTimeoutMs = await resolvePhaseTimeoutMs(task, currentStatus);
        const result = await raceWorkflowAdvance(this.orchestrator, item.taskId, phaseTimeoutMs);
        // Stop owns the queue item even when the old phase returns a replan/skip result.
        if (abortController.signal.aborted) {
          continueLoop = false;
          break;
        }
        if (result.superseded) {
          await this.queue.updateStatus(item.id, 'queued', { currentPhase: result.status });
          this.broadcastItemUpdate(item.id, item.taskId, 'execution_requeued', result.status);
          continueLoop = false;
          break;
        }

        // Another trigger already holds the task's execution lock and is
        // running this phase (the per-task mutex collapsed a duplicate). Do NOT
        // fail the item — return it to the queue so the next poll re-checks
        // once the in-flight phase has advanced the workflowStatus.
        if (result.skipped) {
          log[result.held ? 'debug' : 'info'](
            { taskId: item.taskId, phase: currentStatus, held: result.held },
            result.held
              ? `[WorkflowRunner] Implementer held (${result.held}) — re-queuing item`
              : '[WorkflowRunner] Phase already running elsewhere — re-queuing item',
          );
          await this.queue.updateStatus(item.id, 'queued', { currentPhase: currentStatus });
          this.broadcastItemUpdate(item.id, item.taskId, 'execution_requeued', currentStatus);
          continueLoop = false;
          break;
        }

        if (!result.success) {
          // Surface WHY the phase failed. This used to be swallowed — only the
          // generic "Max retries (3) exceeded" surfaced — which hid root causes
          // like "role has no agent assigned" behind a silent retry loop.
          log.warn(
            { taskId: item.taskId, phase: currentStatus, role: result.role, error: result.error },
            `[WorkflowRunner] Phase failed for task ${item.taskId}: ${result.error ?? 'unknown error'}`,
          );
          // Persist the reason on the queue item so it is visible after retries.
          const retried = await this.queue.retryIfPossible(item.id, result.error ?? undefined);
          if (!retried) {
            this.broadcastItemUpdate(item.id, item.taskId, 'execution_failed', currentStatus);
          } else {
            this.broadcastItemUpdate(item.id, item.taskId, 'execution_retrying', currentStatus);
          }
          continueLoop = false;
          break;
        }

        // Stop here if the run was aborted (e.g. auto-run stopped) — even when
        // the phase just succeeded. Advancing / writing 'running' would resurrect
        // the queue item that the stop path cancelled and spawn the next phase's
        // agent, so the "stop" would never actually stop.
        if (abortController.signal.aborted) {
          log.info(
            { taskId: item.taskId, phase: currentStatus },
            '[WorkflowRunner] Execution aborted — stopping loop without advancing',
          );
          continueLoop = false;
          break;
        }

        // Phase completion notification + logging
        await this.logPhaseTransition(item.taskId, currentStatus, result.status);
        await this.queue.updateStatus(item.id, 'running', {
          currentPhase: result.status,
        });
        this.broadcastItemUpdate(item.id, item.taskId, 'phase_completed', result.status);

        // Brief wait before next phase (DB update stabilization + abort check)
        await waitBeforeNextPhase(abortController.signal);
      }

      if (iterationCount >= maxIterations) {
        throw new Error(`Maximum iterations (${maxIterations}) exceeded for task ${item.taskId}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // NOTE: Shutdown errors are graceful interruptions — requeue without consuming retry budget.
      // Mirrors stopProcessing() at line 99 which also uses updateStatus(..., 'queued', ...).
      if (isShutdownError(error)) {
        log.warn(`[WorkflowRunner] Task ${item.taskId} interrupted by shutdown — requeued`);
        try {
          await this.queue.updateStatus(item.id, 'queued', {
            errorMessage: 'Shutdown - returned to queue',
          });
        } catch (requeueError) {
          log.warn(
            { err: requeueError },
            `[WorkflowRunner] Failed to requeue item ${item.id} after shutdown`,
          );
        }
        this.broadcastItemUpdate(item.id, item.taskId, 'execution_error', execution.currentPhase);
        return;
      }

      log.error(`[WorkflowRunner] Execution error for task ${item.taskId}: ${errorMsg}`);

      await stopFailedPhaseAgents(item.taskId, errorMsg);

      try {
        const retried = await this.queue.retryIfPossible(item.id, errorMsg);
        if (!retried) {
          await this.queue.updateStatus(item.id, 'failed', { errorMessage: errorMsg });
          // Terminal failure (no retry left) — let a split parent finalize.
          await notifyParentOnSubtaskFailure(item.taskId);
        }
      } catch (retryError) {
        log.error({ err: retryError }, `[WorkflowRunner] Failed to retry/fail item ${item.id}`);
      }
      this.broadcastItemUpdate(item.id, item.taskId, 'execution_error', execution.currentPhase);
    } finally {
      this.activeExecutions.delete(item.id);
      this.processedTotal++;
    }
  }

  /**
   * Resume a queue item after approval.
   */
  async resumeAfterApproval(taskId: number): Promise<boolean> {
    const item = await this.queue.findByTaskId(taskId);
    if (!item || item.status !== 'waiting_approval') {
      return false;
    }

    await this.queue.updateStatus(item.id, 'queued', { currentPhase: 'plan_approved' });
    log.info(`[WorkflowRunner] Resumed task ${taskId} after approval`);

    // Will be picked up in the next poll cycle
    return true;
  }

  /** Delegate: record + broadcast a phase transition (see workflow-runner-events). */
  private async logPhaseTransition(
    taskId: number,
    previousPhase: string,
    newPhase: string,
  ): Promise<void> {
    await logPhaseTransition(taskId, previousPhase, newPhase);
  }

  /** Delegate: broadcast runner lifecycle status (see workflow-runner-events). */
  private broadcastStatus(event: string): void {
    broadcastRunnerStatus(event, this.getStatus());
  }

  /** Delegate: broadcast a queue-item update (see workflow-runner-events). */
  private broadcastItemUpdate(itemId: number, taskId: number, event: string, phase: string): void {
    broadcastItemUpdate(itemId, taskId, event, phase, this.activeExecutions.size);
  }
}
