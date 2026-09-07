/**
 * theme-auto-run-scheduler
 *
 * Single global poller that drives per-theme task auto-execution.
 * Each tick (~12 s) it:
 *  1. Finds all running/stopping/paused ThemeAutoRun records.
 *  2. For stopping themes: cancels queue items and stops in-flight executions.
 *  3. For paused themes: checks whether a waiting_approval gate was resolved.
 *  4. For running themes: checks completion/failure of the current task,
 *     then enqueues the next eligible task.
 *
 * Execution is ALWAYS delegated to the existing WorkflowRunner via
 * WorkflowQueueService.enqueue() — the scheduler never spawns agents itself.
 * Global auto-run concurrency = AUTO_RUN_GLOBAL_MAX_CONCURRENCY (default 1).
 * This is a separate limit from WorkflowRunner.maxConcurrency (which governs
 * ALL queue items including subtasks).
 *
 * The class is a thin delegation layer (task 628): the per-branch bodies live
 * in auto-run-lifecycle.ts, auto-run-advance-active.ts and
 * auto-run-advance-select.ts as prisma-injected free functions.
 */
import { prisma } from '../../../config';
import { createLogger } from '../../../config/logger';
import { resolveTaskThemeId } from '../../task/task-resolver';
import { WorkflowRunner } from '../workflow-runner';
import { recordStartupCommit, maybeRestartForUpdate } from './dev-restart-on-dry';
import { POLL_INTERVAL_MS, getGlobalAutoRunActiveCount } from './auto-run-selection';
import {
  findByStatuses,
  resumeAutoRun,
  getAutoRunState,
  isPausedAutoRunStatus,
  PAUSED_AUTO_RUN_STATUSES,
  type ThemeAutoRunState,
} from './theme-auto-run-service';
import {
  processStoppingThemesImpl,
  processIdleThemesImpl,
  processPausedThemesImpl,
  stopThemeExecutionImpl,
  broadcastAutoRunUpdateImpl,
} from './auto-run-lifecycle';
import { advanceActiveTask } from './auto-run-advance-active';
import { selectAndEnqueueNextTask } from './auto-run-advance-select';

const log = createLogger('theme-auto-run-scheduler');

export class ThemeAutoRunScheduler {
  private static instance: ThemeAutoRunScheduler;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // NOTE: the former `queue` / `agentWorkerManager` fields were removed (task 628) —
  // the extracted free functions call the same singletons via getInstance().
  // Per-theme epoch ms when the merge-barrier hold began (task 573 C). Memory-
  // only on purpose: a restart simply restarts the hold window.
  private barrierHoldSince = new Map<number, number>();

  static getInstance(): ThemeAutoRunScheduler {
    if (!ThemeAutoRunScheduler.instance) {
      ThemeAutoRunScheduler.instance = new ThemeAutoRunScheduler();
    }
    return ThemeAutoRunScheduler.instance;
  }

  /** Start the scheduler (idempotent). */
  start(): void {
    // CRITICAL: the WorkflowRunner is what actually DEQUEUES and executes queued
    // items (via advanceWorkflow → role agent). It is only auto-started by
    // AIOrchestra.enqueueTask — which this scheduler bypasses by enqueuing
    // through WorkflowQueueService directly. Without this, auto-run items sit at
    // 'queued' forever and never run (observed: tasks enqueued but no agent ran).
    // startProcessing() is idempotent, so calling it on every start() is safe.
    WorkflowRunner.getInstance().startProcessing();

    // Capture the commit this backend booted on so the optional dry-restart only
    // fires once new commits actually land (avoids restarting on every dry tick).
    void recordStartupCommit();

    if (this.running) return;
    this.running = true;
    this.tick();
    this.pollTimer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    log.info('[ThemeAutoRunScheduler] Started');
  }

  /** Stop the scheduler (does NOT stop in-flight tasks — use stopAutoRun() for that). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('[ThemeAutoRunScheduler] Stopped');
  }

  /**
   * Recover on server restart:
   *  - Any ThemeAutoRun still in 'running'/'paused' OR idle-but-ARMED
   *    (enabled:true) should resume — start the scheduler so its tick drives them.
   *  - 'stopping' records are cleaned up (the previous execution was killed by
   *    the restart; treat as idle).
   *
   * CRITICAL for the perpetual loop: an `all_done` theme parks at status:'idle'
   * with enabled:true (armed) waiting for processIdleThemes to auto-resume it when
   * work reappears. But processIdleThemes only runs while the scheduler is
   * TICKING. If recovery resumed only 'running'/'paused', ANY restart while a
   * theme was idle (including the self-deploy restart, which fires precisely at
   * the 0-agent all_done quiet point) would leave the scheduler stopped and the
   * loop permanently dead. Resuming on enabled:true closes that self-defeating gap.
   */
  async recoverOnStartup(): Promise<void> {
    // Clean up 'stopping' records left from a crash during stop
    await prisma.themeAutoRun.updateMany({
      where: { status: 'stopping' },
      data: { status: 'idle', enabled: false, currentTaskId: null },
    });

    const running = await findByStatuses(['running', ...PAUSED_AUTO_RUN_STATUSES]);
    const armed = await prisma.themeAutoRun
      .count({ where: { enabled: true, status: 'idle' } })
      .catch(() => 0);
    if (running.length > 0 || armed > 0) {
      log.info(
        `[ThemeAutoRunScheduler] Resuming after restart (running/paused=${running.length}, armed-idle=${armed})`,
      );
      this.start();
    }
  }

  /**
   * Hook: called when a plan is approved for a task.
   * If the task's theme was paused waiting for approval, resume it.
   *
   * @param taskId - The task whose plan was just approved / 承認されたタスクID
   */
  async onPlanApproved(taskId: number): Promise<void> {
    const task = await resolveTaskThemeId(taskId);
    if (!task?.themeId) return;

    const state = await getAutoRunState(task.themeId);
    if (state?.status === 'paused_approval' && state.currentTaskId === taskId) {
      await resumeAutoRun(task.themeId);
      log.info(
        `[ThemeAutoRunScheduler] Theme ${task.themeId} resumed after plan approval for task ${taskId}`,
      );
      this.broadcastAutoRunUpdate(task.themeId);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal tick
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      // NOTE: Single query for all statuses; split in JS to avoid 4 DB roundtrips per tick.
      const allStates = await findByStatuses([
        'stopping',
        'running',
        ...PAUSED_AUTO_RUN_STATUSES,
        'idle',
      ]);
      const byStatus = (s: string) => allStates.filter((r) => r.status === s);

      await this.processStoppingThemes(byStatus('stopping'));
      await this.processRunningThemes(byStatus('running'));
      await this.processPausedThemes(allStates.filter((r) => isPausedAutoRunStatus(r.status)));
      const idleTimedOut = await this.processIdleThemes(byStatus('idle'));

      // Apply committed fixes during the brief 0-agent gap BETWEEN tasks. The
      // all_done branch alone (advanceTheme → maybeRestartForUpdate) missed this:
      // with auto-create refilling the queue the theme rarely reaches all_done,
      // and even then the just-finished agent's count still lagged > 0, so the
      // restart was skipped and fixes NEVER auto-deployed (observed: cycles=0
      // while monitoring). Poll it here instead — maybeRestartForUpdate restarts
      // ONLY when (a) no agent is executing (active==0 → a RUNNING agent is never
      // interrupted), (b) a theme is still enabled (a STOPPED system, enabled:0,
      // never self-reboots — the original reason this was removed is now covered
      // by that gate), (c) HEAD moved past the startup commit, and (d) the 10-min
      // rate limit allows it. That is exactly "apply when idle + something new,
      // without disturbing work".
      // Design point 7 (task 784): an idle-stop that fired this tick takes
      // priority over the dev restart — skip it for this pass (afterwards the
      // stopped theme's enabled:false keeps the no-armed-theme gate closed).
      if (idleTimedOut) {
        log.info('[ThemeAutoRunScheduler] idle-stop fired — skipping dev restart this tick');
      } else {
        await maybeRestartForUpdate(0);
      }
    } catch (err) {
      log.error({ err }, '[ThemeAutoRunScheduler] Tick error');
    }
  }

  /** Handle themes in 'stopping' status: cancel queue items and stop the agent. */
  private async processStoppingThemes(stopping: ThemeAutoRunState[]): Promise<void> {
    await processStoppingThemesImpl(prisma, stopping);
  }

  /**
   * Auto-resume idle-but-armed themes once new work appears, run the idle-stop
   * timer, and re-arm idle-stopped themes (see auto-run-lifecycle).
   *
   * @returns true when this tick idle-stopped at least one theme. / この tick でタイムアウト停止したテーマがあれば true
   */
  private async processIdleThemes(idle: ThemeAutoRunState[]): Promise<boolean> {
    return processIdleThemesImpl(prisma, idle);
  }

  /** For paused themes, check whether approval was granted and auto-resume. */
  private async processPausedThemes(paused: ThemeAutoRunState[]): Promise<void> {
    await processPausedThemesImpl(prisma, paused);
  }

  /** Core logic: advance running themes to their next task. */
  private async processRunningThemes(running: ThemeAutoRunState[]): Promise<void> {
    if (running.length === 0) return;

    const globalActive = await getGlobalAutoRunActiveCount(prisma);

    for (const state of running) {
      try {
        await this.advanceTheme(
          state.themeId,
          state.currentTaskId,
          state.order,
          globalActive,
          state.lastRunAt,
        );
      } catch (err) {
        log.error({ err }, `[ThemeAutoRunScheduler] Error advancing theme ${state.themeId}`);
      }
    }
  }

  /**
   * Advance a single running theme by one step.
   *
   * @param themeId - Theme to advance / 進めるテーマID
   * @param currentTaskId - Currently tracked task (may be null) / 現在のタスクID
   * @param order - Task selection order / タスク選択順序
   * @param globalActive - Current global auto-run active count / グローバルアクティブ数
   */
  private async advanceTheme(
    themeId: number,
    currentTaskId: number | null,
    order: 'priority' | 'created',
    globalActive: number,
    lastRunAt: string | null,
  ): Promise<void> {
    if (currentTaskId) {
      await advanceActiveTask(
        prisma,
        themeId,
        currentTaskId,
        order,
        globalActive,
        lastRunAt,
        this.barrierHoldSince,
      );
      return;
    }

    await selectAndEnqueueNextTask(prisma, themeId, order, globalActive, this.barrierHoldSince);
  }

  /**
   * Stop a theme's current execution: cancel queue items and kill the in-flight agent.
   *
   * @param themeId - Theme to stop / 停止するテーマID
   * @param currentTaskId - Currently tracked task ID / 現在のタスクID
   */
  // NOTE: No longer called inside the class (the lifecycle/advance-active modules call
  // stopThemeExecutionImpl directly) but retained for the SchedulerInternal test
  // contract in theme-auto-run-scheduler.test-support.ts, hence the TS6133 suppression.
  // @ts-expect-error TS6133 — intentionally unused private delegate (task 628)
  private async stopThemeExecution(themeId: number, currentTaskId: number | null): Promise<void> {
    await stopThemeExecutionImpl(prisma, themeId, currentTaskId);
  }

  /** Broadcast SSE update for a theme's auto-run state change. */
  private broadcastAutoRunUpdate(themeId: number): void {
    broadcastAutoRunUpdateImpl(themeId);
  }
}
