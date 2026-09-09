/**
 * AutoRestartMergedCodeScheduler
 *
 * Detects commits merged to origin/<primary branch> that this process is not
 * running yet (merged-but-inactive code) and, when the system is idle and the
 * autoRestartOnMergedCode toggle is on, fast-forwards the checkout and
 * triggers the shared shutdown sequence (exit 75 → dev.js relaunch).
 * Deliberately independent from dev-restart-on-dry (different comparison base
 * and trigger); not responsible for selecting or creating tasks.
 */
import { createLogger } from '../../../config/logger';
import { createNotification } from '../../communication/notification-service';
import { scheduleShutdownSequence } from '../../system/shutdown-sequence';
import { getAgentSystemSnapshot } from '../../../routes/agents/system/agent-system-router';
import { countLiveTrackedProcesses } from '../../agents/agent-process-tracker';
import { AutoMergeWatcher } from '../../workflow/auto-merge-watcher';
import { decideAutoRestart } from './decision';
import {
  classifyMergeUrgency,
  decideBoundaryRestart,
  resolveRestartMinIntervalMs,
  resolveRestartUiQuietMs,
  resolveRestartMaxDeferrals,
} from './boundary-policy';
import {
  captureStartupCommit,
  fetchAndCountAhead,
  isWorkingTreeClean,
  fastForwardToRemote,
  listChangedPaths,
} from './git-io';
import {
  readAutoRestartEnabled,
  readLastRestartAt,
  writeLastRestartAt,
  readDeferCount,
  writeDeferCount,
} from './settings-store';
import { getLastUiRequestAt } from './ui-activity-tracker';

const logger = createLogger('auto-restart-merged-code-scheduler');

// 15 min — a modest fetch cadence; the fetch is a small network call but this
// still runs forever, so keep it slower than the 5s-class pollers.
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
// 30 min — flapping guard between two auto-restarts (acceptance criterion 2c).
const DEFAULT_MIN_RESTART_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Resolves the fetch/check interval from the environment.
 *
 * @returns Interval in milliseconds / チェック間隔（ミリ秒）
 */
function resolveIntervalMs(): number {
  const raw = process.env.RAPITAS_AUTO_RESTART_MERGED_CODE_INTERVAL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Resolves the minimum interval between auto-restarts from the environment.
 *
 * @returns Minimum restart interval in milliseconds / 最低再起動間隔（ミリ秒）
 */
function resolveMinRestartIntervalMs(): number {
  const raw = process.env.RAPITAS_AUTO_RESTART_MERGED_CODE_MIN_INTERVAL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_RESTART_INTERVAL_MS;
}

export class AutoRestartMergedCodeScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private startupCommit: string | null = null;

  /**
   * Start the periodic merged-code check. No-op outside the dev orchestrator
   * (dev.js relaunches on exit 75; nothing else does, so exiting elsewhere
   * would orphan the backend — same guard as dev-restart-on-dry).
   *
   * @param intervalMs - Check interval in milliseconds (defaults to env / 15 min) / チェック間隔（ミリ秒）
   */
  async start(intervalMs?: number): Promise<void> {
    if (this.isRunning) {
      logger.warn('[AutoRestartMergedCode] Already running, ignoring start request');
      return;
    }
    if (process.env.TAURI_BUILD !== 'true') {
      logger.debug('[AutoRestartMergedCode] TAURI_BUILD != true — scheduler disabled');
      return;
    }

    this.startupCommit = await captureStartupCommit();
    if (!this.startupCommit) {
      logger.warn('[AutoRestartMergedCode] Could not capture startup commit — scheduler disabled');
      return;
    }

    const interval = intervalMs ?? resolveIntervalMs();
    logger.info(
      { startupCommit: this.startupCommit, intervalMs: interval },
      '[AutoRestartMergedCode] Starting scheduler',
    );
    this.isRunning = true;

    // First check immediately so a restart that already lags origin doesn't
    // wait a full interval to notice.
    this.runOnce().catch((error) => {
      logger.error({ err: error }, '[AutoRestartMergedCode] Initial check failed');
    });

    this.intervalId = setInterval(() => {
      this.runOnce().catch((error) => {
        logger.error({ err: error }, '[AutoRestartMergedCode] Scheduled check failed');
      });
    }, interval);
  }

  /**
   * Stop the periodic merged-code check.
   */
  stop(): void {
    if (!this.isRunning) {
      logger.debug('[AutoRestartMergedCode] Not running, ignoring stop request');
      return;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('[AutoRestartMergedCode] Stopped');
  }

  /**
   * Check if the scheduler is currently running.
   *
   * @returns True if running / 実行中の場合true
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * One detection/decision/execution cycle. Public so tests can drive it
   * directly; the interval calls it on schedule.
   *
   * @returns True when a restart was triggered this cycle / 今回のサイクルで再起動を発火したか
   */
  async runOnce(): Promise<boolean> {
    // Cheapest gate first: skip all git I/O while the toggle is off.
    const settingEnabled = readAutoRestartEnabled();
    if (!settingEnabled) return false;
    if (!this.startupCommit) return false;

    const branch = process.env.RAPITAS_PRIMARY_BRANCH || 'develop';
    const aheadCount = await fetchAndCountAhead(this.startupCommit, branch);
    if (aheadCount === null || aheadCount <= 0) return false;

    // Restart-timing governance: only merges touching the loop machinery
    // itself may restart from this poller. Everything else (UI-only, feature
    // work) is batched until the next task boundary (evaluateBoundaryRestart),
    // so per-merge restart churn — and each restart's aux-CLI orphaning
    // exposure — is bounded by task boundaries, not merge frequency.
    const changedPaths = await listChangedPaths(this.startupCommit, branch);
    if (classifyMergeUrgency(changedPaths) !== 'immediate') {
      logger.debug(
        { aheadCount, changedFiles: changedPaths.length },
        '[AutoRestartMergedCode] Non-machinery merge — batched until next task boundary',
      );
      return false;
    }

    const snapshot = await getAgentSystemSnapshot();
    if (snapshot.activeExecutionsDegraded) return false;
    const lastRestartAt = readLastRestartAt();
    const decision = decideAutoRestart({
      aheadCount,
      activeExecutions: snapshot.activeExecutions,
      runningExecutions: snapshot.runningExecutions,
      queueDepth: snapshot.queueDepth,
      isShuttingDown: snapshot.isShuttingDown,
      settingEnabled,
      msSinceLastRestart: lastRestartAt === 0 ? null : Date.now() - lastRestartAt,
      minRestartIntervalMs: resolveMinRestartIntervalMs(),
    });
    if (!decision.shouldRestart) {
      logger.debug({ reason: decision.reason, aheadCount }, '[AutoRestartMergedCode] gated');
      return false;
    }

    // Never pull over uncommitted work (self-dev agents edit the primary checkout).
    if (!(await isWorkingTreeClean())) {
      logger.warn('[AutoRestartMergedCode] Working tree dirty — skipping pull/restart this tick');
      return false;
    }

    // Without this pull, exit(75) relaunches on the SAME old commit: dev.js's
    // ensurePrimaryBranch never pulls, and PR merge skips primary-checkout sync.
    if (!(await fastForwardToRemote(branch))) {
      return false;
    }

    // Re-confirm idleness right before firing: an execution may have started
    // during fetch/pull. aheadCount stays non-zero next tick (startup-commit
    // base), so a skipped restart is retried, not lost.
    const recheck = await getAgentSystemSnapshot();
    if (
      recheck.activeExecutionsDegraded ||
      recheck.isShuttingDown ||
      recheck.activeExecutions > 0 ||
      recheck.runningExecutions > 0 ||
      recheck.queueDepth > 0
    ) {
      logger.info(
        {
          isShuttingDown: recheck.isShuttingDown,
          activeExecutions: recheck.activeExecutions,
          runningExecutions: recheck.runningExecutions,
          queueDepth: recheck.queueDepth,
        },
        '[AutoRestartMergedCode] Busy at final recheck — restart deferred to next tick',
      );
      return false;
    }

    await createNotification({
      type: 'system',
      title: '自動再起動',
      message: `未活性コミット${aheadCount}件を活性化するため再起動します`,
    }).catch((err) => {
      logger.warn({ err }, '[AutoRestartMergedCode] Notification failed — restarting anyway');
    });
    writeLastRestartAt(Date.now());
    logger.warn(
      { aheadCount, branch, startupCommit: this.startupCommit },
      '[AutoRestartMergedCode] Restarting to activate merged code',
    );
    scheduleShutdownSequence('[auto-restart]', 75);
    return true;
  }

  // Serializes concurrent boundary evaluations (multiple theme ticks can hit
  // a task boundary at once) so two evaluations can never double-fire.
  private boundaryEvaluationInFlight = false;

  /**
   * Task-boundary restart evaluation. Called by the auto-run scheduler AFTER
   * a task finished and BEFORE the next one is selected (a natural 0-agent
   * quiescence point), and only after dev-restart-on-dry declined (the caller
   * returns on its true, so the two paths never double-fire in one tick).
   *
   * Activates ANY pending merge (machinery or batched) once every quiescence
   * gate passes: no executions, no queued work, no live aux CLI children, no
   * merge mid-processing, rate limit satisfied, and the UI quiet — a UI-active
   * boundary defers (bounded by RAPITAS_RESTART_MAX_DEFERRALS, then forced).
   * Shares the poller's last-restart stamp so the two merged-code paths keep
   * a single rate limit, but uses its own minimum interval env.
   *
   * @returns True when a restart was triggered (caller must stop its tick) / 再起動を発火したか
   */
  async evaluateBoundaryRestart(): Promise<boolean> {
    if (this.boundaryEvaluationInFlight) return false;
    this.boundaryEvaluationInFlight = true;
    try {
      // Same cheap gates as the poller: toggle first (no git I/O while off),
      // and startupCommit doubles as the "scheduler actually started under
      // the dev orchestrator" guard (start() is a no-op outside TAURI_BUILD).
      if (!readAutoRestartEnabled()) return false;
      if (!this.startupCommit) return false;

      const branch = process.env.RAPITAS_PRIMARY_BRANCH || 'develop';
      const aheadCount = await fetchAndCountAhead(this.startupCommit, branch);
      if (aheadCount === null || aheadCount <= 0) return false;

      const snapshot = await getAgentSystemSnapshot();
      if (snapshot.activeExecutionsDegraded) return false;
      const lastRestartAt = readLastRestartAt();
      const lastUiAt = getLastUiRequestAt();
      const deferCount = readDeferCount();
      const now = Date.now();
      const decision = decideBoundaryRestart({
        aheadCount,
        isShuttingDown: snapshot.isShuttingDown,
        activeExecutions: snapshot.activeExecutions,
        runningExecutions: snapshot.runningExecutions,
        queueDepth: snapshot.queueDepth,
        auxChildren: countLiveTrackedProcesses('cli-agent'),
        isMerging: AutoMergeWatcher.getInstance().isMerging(),
        msSinceLastRestart: lastRestartAt === 0 ? null : now - lastRestartAt,
        minRestartIntervalMs: resolveRestartMinIntervalMs(),
        msSinceLastUiActivity: lastUiAt === 0 ? null : now - lastUiAt,
        uiQuietMs: resolveRestartUiQuietMs(),
        deferCount,
        maxDeferrals: resolveRestartMaxDeferrals(),
      });

      if (decision.action === 'wait') {
        logger.debug(
          { reason: decision.reason, aheadCount },
          '[AutoRestartMergedCode] Boundary restart gated — retrying at a later boundary',
        );
        return false;
      }
      if (decision.action === 'defer') {
        writeDeferCount(decision.nextDeferCount);
        logger.info(
          { deferCount: decision.nextDeferCount, aheadCount },
          '[AutoRestartMergedCode] UI active at task boundary — restart deferred',
        );
        return false;
      }

      // restart: clean-tree check → ff → notify → stamps → shutdown (exit 75).
      if (!(await isWorkingTreeClean())) {
        logger.warn('[AutoRestartMergedCode] Working tree dirty at boundary — restart skipped');
        return false;
      }
      if (!(await fastForwardToRemote(branch))) {
        return false;
      }
      const recheck = await getAgentSystemSnapshot();
      if (
        recheck.activeExecutionsDegraded ||
        recheck.isShuttingDown ||
        recheck.activeExecutions > 0 ||
        recheck.runningExecutions > 0 ||
        recheck.queueDepth > 0 ||
        countLiveTrackedProcesses('cli-agent') > 0 ||
        AutoMergeWatcher.getInstance().isMerging()
      )
        return false;
      await createNotification({
        type: 'system',
        title: '自動再起動',
        message: `タスク境界で未活性コミット${aheadCount}件を活性化するため再起動します`,
      }).catch((err) => {
        logger.warn({ err }, '[AutoRestartMergedCode] Notification failed — restarting anyway');
      });
      writeLastRestartAt(Date.now());
      writeDeferCount(0);
      logger.warn(
        { aheadCount, branch, reason: decision.reason, startupCommit: this.startupCommit },
        '[AutoRestartMergedCode] Task-boundary restart to activate merged code',
      );
      scheduleShutdownSequence('[auto-restart-boundary]', 75);
      return true;
    } finally {
      this.boundaryEvaluationInFlight = false;
    }
  }
}

// Singleton instance for global use
let globalScheduler: AutoRestartMergedCodeScheduler | null = null;

/**
 * Get the global auto-restart-merged-code scheduler instance.
 *
 * @returns Global scheduler instance / グローバルスケジューラインスタンス
 */
export function getAutoRestartMergedCodeScheduler(): AutoRestartMergedCodeScheduler {
  if (!globalScheduler) {
    globalScheduler = new AutoRestartMergedCodeScheduler();
  }
  return globalScheduler;
}

/**
 * Start the global auto-restart-merged-code scheduler.
 *
 * @param intervalMs - Optional check interval in milliseconds / オプションのチェック間隔（ミリ秒）
 */
export async function startAutoRestartMergedCodeScheduler(intervalMs?: number): Promise<void> {
  await getAutoRestartMergedCodeScheduler().start(intervalMs);
}

/**
 * Stop the global auto-restart-merged-code scheduler.
 */
export function stopAutoRestartMergedCodeScheduler(): void {
  getAutoRestartMergedCodeScheduler().stop();
}

export { decideAutoRestart } from './decision';
export type { AutoRestartDecisionInput, AutoRestartDecision } from './decision';
export { classifyMergeUrgency, decideBoundaryRestart } from './boundary-policy';
export type {
  BoundaryRestartInput,
  BoundaryRestartDecision,
  MergeUrgency,
  BoundaryRestartAction,
} from './boundary-policy';
export { readAutoRestartEnabled, writeAutoRestartEnabled } from './settings-store';
