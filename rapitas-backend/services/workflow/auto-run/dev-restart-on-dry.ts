/**
 * dev-restart-on-dry
 *
 * Optional dev-mode auto-restart. When a theme's auto-run runs out of work (the
 * quiet point with no live agents) AND the local checkout has new commits since
 * this backend started, gracefully restart so committed fixes take effect before
 * more tasks are created. Gated behind UserSettings.restartOnAutoRunDry, a global
 * no-agent check, a "HEAD actually moved" check, and a rate limit.
 *
 * Only meaningful under the dev orchestrator (dev.js relaunches the process on
 * exit code 75). Not responsible for selecting/creating tasks.
 */
import { execFile } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { prisma } from '../../../config/database';
import { createLogger } from '../../../config/logger';
import { AgentOrchestrator } from '../../agents/agent-orchestrator';
import { WorkflowRunner } from '../workflow-runner';
import { logCycleEvent } from '../../observability';
import { realtimeService } from '../../communication/realtime-service';

const execFileAsync = promisify(execFile);
const log = createLogger('auto-run:dev-restart');

/** dev.js relaunches the backend when it exits with this code. */
const RESTART_EXIT_CODE = 75;
/** Never auto-restart more often than this (avoid restart loops). */
const MIN_RESTART_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Hard ceiling on graceful shutdown before we exit anyway. A restart must NEVER
 * leave the backend wedged (not serving, not relaunching) just because shutdown
 * hung — exit(75) so dev.js relaunches regardless.
 */
const SHUTDOWN_BUDGET_MS = 30_000;

let startupCommit: string | null = null;
let lastRestartAt = 0;
let restarting = false;
let lastDiagAt = 0;

/**
 * Throttled diagnostic: records WHICH gate turned a self-deploy attempt into a
 * no-op. maybeRestartForUpdate now fires on every task boundary, so this would
 * spam — emit at most once per minute. Exists to settle "why did self-deploy
 * never fire during continuous auto-run?"; safe to remove once confirmed.
 */
function diag(gate: string, detail?: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastDiagAt < 60_000) return;
  lastDiagAt = now;
  log.info({ gate, ...detail }, `[dev-restart] no-op at gate: ${gate}`);
}

/** Current HEAD of the backend's checkout, or null if git is unavailable. */
async function headCommit(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Rate-limit persistence. `lastRestartAt` lives in memory, so it resets to 0 on
 * the very relaunch it is meant to throttle — without this the 10-min floor never
 * spans two restarts (observed: 2 self-deploys 5 min apart). Persist the last
 * restart time to a file in the data dir so the floor survives a relaunch.
 */
function rateLimitStampFile(): string {
  const base = process.env.RAPITAS_DATA_DIR?.trim() || join(homedir(), '.rapitas');
  return join(base, '.dev-restart-last-at');
}

/** Last restart epoch-ms read from disk, or 0 if absent/unreadable. */
function readLastRestartAt(): number {
  try {
    const ts = Number.parseInt(readFileSync(rateLimitStampFile(), 'utf8').trim(), 10);
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

/** Persist the last restart time. Best-effort; a missing stamp only weakens the rate limit. */
function persistLastRestartAt(ts: number): void {
  try {
    const file = rateLimitStampFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(ts));
  } catch {
    // Never let a stamp write failure crash the restart path.
  }
}

/**
 * Capture the commit the backend booted on. Call once at scheduler start so a
 * later dry-restart only fires when HEAD has actually advanced past it.
 */
export async function recordStartupCommit(): Promise<void> {
  if (startupCommit) return;
  startupCommit = await headCommit();
  log.info({ startupCommit }, '[dev-restart] recorded startup commit');
}

/** Whether the toggle is on. Read via cast — the column is pending client regen. */
async function restartEnabled(): Promise<boolean> {
  const s = (await prisma.userSettings.findFirst().catch(() => null)) as {
    restartOnAutoRunDry?: boolean | null;
  } | null;
  return s?.restartOnAutoRunDry === true;
}

/** Check all workers through shared state; unavailable state cannot establish idleness. */
async function persistedWorkIsIdle(): Promise<boolean> {
  try {
    const [executions, phases] = await Promise.all([
      prisma.agentExecution.count({
        where: { status: { in: ['pending', 'running', 'waiting_for_input', 'canceling'] } },
      }),
      prisma.workflowQueueItem.count({ where: { status: 'running' } }),
    ]);
    if (executions > 0 || phases > 0) {
      diag('persisted-work-running', { executions, phases });
      return false;
    }
    return true;
  } catch (err) {
    diag('activity-unavailable');
    log.warn({ err }, '[dev-restart] Cannot establish global idleness — restart deferred');
    return false;
  }
}

/**
 * Gracefully restart when all gates pass: enabled + new commits since boot + no
 * live agents anywhere + not rate-limited. Returns true when a restart was kicked
 * off (so the caller skips backlog promotion / idling this pass).
 *
 * @param themeId - The theme whose auto-run just ran dry. / 枯渇したテーマID
 * @returns Whether a restart was initiated. / 再起動を開始したか
 */
export async function maybeRestartForUpdate(themeId: number): Promise<boolean> {
  if (restarting) return true;

  // Only self-restart under the desktop dev orchestrator (dev.js sets TAURI_BUILD
  // and relaunches on exit 75). In web dev / a direct run nothing watches for exit
  // 75, so exiting would ORPHAN the backend and kill the loop — make it a no-op.
  if (process.env.TAURI_BUILD !== 'true') {
    diag('TAURI_BUILD!=true', { tauriBuild: process.env.TAURI_BUILD ?? '(unset)' });
    return false;
  }

  // Cheapest check first (in-memory): require global quiescence so we never kill
  // an in-flight agent. This is safe to call on EVERY tick — a busy loop with a
  // large backlog rarely reaches all_done, but it does briefly hit 0 agents
  // BETWEEN tasks; catching that gap is what lets fixes apply without waiting for
  // the whole backlog to drain.
  const active = AgentOrchestrator.getInstance(prisma).getActiveExecutionCount();
  if (active > 0) {
    diag('active>0', { active });
    return false;
  }

  // 0 live agents is NOT "no work in flight": a workflow sits at 0 agents BETWEEN
  // phases (next phase's agent not yet spawned), and a RETRIED task re-runs phases
  // while its task.status is still 'blocked' (so a task.status check misses it —
  // observed: task 300 re-ran implement at status='blocked', a restart fired and
  // stranded it). The accurate "a phase is mid-flight" signal is a RUNNING
  // workflow queue item: it stays 'running' across the whole multi-phase loop,
  // including the between-phase gaps, regardless of task.status. Restarting then
  // kills the phase and strands the work (worktree lost -> empty output -> block).
  // 'queued' is intentionally EXCLUDED so a full backlog never blocks deploys —
  // only an actively-running workflow does (a genuine task boundary has none).
  // Worker processes own separate orchestrator instances. The parent can see
  // zero local executions while a worker is still researching (task 871).
  if (!(await persistedWorkIsIdle())) return false;
  // A verify run's shell children inherit the listen socket; restarting while
  // one is alive strands the dead backend's :3001 LISTEN (ghost socket —
  // observed three times 2026-08-30/31). Helper children include agent CLIs.
  try {
    const { countActiveHelperChildren } = await import('../../agents/process-priority');
    const helperChildren = countActiveHelperChildren();
    if (helperChildren > 0) {
      diag('helper-children-running', { helperChildren });
      return false;
    }
  } catch {
    // Fail open: the counter is a safety refinement, never a restart blocker.
  }

  if (!(await restartEnabled())) {
    diag('restartOnAutoRunDry=off');
    return false;
  }

  // Respect a user STOP. dev-restart exists only to let the AUTO-RUN loop pick up
  // committed fixes between tasks — it is driven from the scheduler tick, which
  // keeps polling even after every theme is stopped (a user stop sets
  // enabled:false via finalizeStop but does NOT stop the global poller). Without
  // this gate the backend self-reboots on the next commit even though auto-run is
  // off — the observed "stopped auto-run yet it restarted" surprise. Only restart
  // while at least one theme is armed/active (enabled:true).
  const activeAutoRun = await prisma.themeAutoRun
    .count({ where: { enabled: true } })
    .catch(() => 0);
  if (activeAutoRun === 0) {
    diag('no-armed-theme');
    return false;
  }

  const now = Date.now();
  // Use the persisted stamp (not just the in-memory one) so the floor survives
  // the relaunch it throttles.
  const lastAt = Math.max(lastRestartAt, readLastRestartAt());
  if (lastAt && now - lastAt < MIN_RESTART_INTERVAL_MS) {
    diag('rate-limited', { msSinceLast: now - lastAt });
    return false;
  }

  // Only restart when there is genuinely something new to apply.
  const current = await headCommit();
  if (!current || !startupCommit || current === startupCommit) {
    diag('HEAD-unchanged', { startupCommit, current });
    return false;
  }

  // Git/settings reads above yield; a worker may have started in that interval.
  if (!(await persistedWorkIsIdle())) return false;
  restarting = true;
  lastRestartAt = now;
  persistLastRestartAt(now);
  log.warn(
    { themeId, startupCommit, current },
    '[dev-restart] auto-run dry + new commits + no agents — restarting to apply updates',
  );
  // Emitted BEFORE the process exits: a `restart.triggered` line followed by a
  // gap then fresh events is the expected signature of a self-deploy, not a crash.
  logCycleEvent('restart.triggered', {
    theme: themeId,
    from: startupCommit?.slice(0, 12),
    to: current.slice(0, 12),
    cause: 'auto_run_dry_new_commits',
    msg: 'self-restart to apply committed fixes',
  });
  void gracefulRestart();
  return true;
}

/** Graceful shutdown then exit with the restart code dev.js watches for. */
export async function gracefulRestart(): Promise<void> {
  // Broadcast the shared SSE 'shutdown' event before tearing anything down, so
  // the frontend's restart-blocking modal (server-restart-store) can pick it up
  // the same way it already does for auto-restart-merged-code's shutdown path.
  try {
    realtimeService.shutdown();
  } catch (err) {
    log.warn({ err }, '[dev-restart] realtime shutdown broadcast failed; continuing shutdown');
  }
  // Backstop: if gracefulShutdown hangs, exit anyway so the restart can't wedge
  // the backend (neither serving nor relaunching). Resolved path clears this.
  const hardExit = setTimeout(() => {
    log.warn('[dev-restart] shutdown exceeded budget — forcing exit to relaunch');
    process.exit(RESTART_EXIT_CODE);
  }, SHUTDOWN_BUDGET_MS);
  // NOTE: Stop the workflow poller first so it can't pick up 'queued' items
  // after _isShuttingDown=true is set by gracefulShutdown below.
  try {
    await WorkflowRunner.getInstance().stopProcessing();
  } catch (err) {
    log.warn({ err }, '[dev-restart] workflow runner stop error; continuing shutdown');
  }
  try {
    await AgentOrchestrator.getInstance(prisma).gracefulShutdown();
  } catch (err) {
    log.error({ err }, '[dev-restart] graceful shutdown error; exiting anyway');
  }
  clearTimeout(hardExit);
  // Small delay so logs flush + the shutdown settles before the process dies.
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
}
