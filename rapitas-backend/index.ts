// Setup global error handlers
import { setupGlobalErrorHandlers, errorHandler } from './middleware';
setupGlobalErrorHandlers();

// Initialize unified error capture (local ring buffer + optional Sentry).
// Must run before any module that could throw at import time.
import { initErrorCapture } from './services/system/error-capture';
initErrorCapture();

import { createLogger } from './config/logger';
const log = createLogger('server');

import { ensureDesktopSqliteDatabase } from './config/desktop-sqlite';
await ensureDesktopSqliteDatabase();

// Validate environment variables at startup
import { validateEnvironment } from './config/env-validation';
validateEnvironment();

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';

// All modular routes are registered via registerAllRoutes() in register-routes.ts.
import { registerAllRoutes } from './register-routes';
import { handleTopLevelHealthCheck } from './routes/system/top-level-health-route';

// Import shared database client
import { prisma, ensureDatabaseConnection } from './config';

import {
  orchestrator,
  workerManager,
  setServerStopCallback,
} from './services/core/orchestrator-instance';

import { realtimeService } from './services/communication/realtime-service';

// Ensure database connection before starting server
await ensureDatabaseConnection();

import {
  resolveBindHost,
  createApiTokenGuard,
  createCrossSiteGuard,
} from './middleware/local-auth';
import {
  recordUiRequest,
  UI_SOURCE_HEADER,
  UI_SOURCE_VALUE,
} from './services/scheduling/auto-restart-merged-code/ui-activity-tracker';

const app = new Elysia();

// CSRF backstop: reject cross-site state-changing requests even in the default
// tokenless loopback deployment (a browser tab on any site can POST to
// 127.0.0.1 otherwise). Registered first so it runs before route handlers.
app.onRequest(createCrossSiteGuard());

// Exposure guard: when RAPITAS_API_TOKEN is set (required for any non-loopback
// bind), every request must carry it. No-op in the default loopback deployment.
const apiTokenGuard = createApiTokenGuard();
if (apiTokenGuard) {
  app.onRequest(apiTokenGuard);
}

// UI-activity recorder: requests the frontend tags with `X-Rapitas-Source: ui`
// mark the user as active so the task-boundary self-restart defers instead of
// dropping their connection mid-use. Pure side effect — never blocks a request,
// and requests without the header change nothing (fail-open).
app.onRequest(({ request }) => {
  if (request.headers.get(UI_SOURCE_HEADER) === UI_SOURCE_VALUE) {
    recordUiRequest(Date.now());
  }
});

// Apply middleware
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'tauri://localhost'];
// NOTE: credentials:true + wildcard origin would let ANY site read
// authenticated responses (cookies/tokens attach cross-origin). A
// misconfigured CORS_ORIGIN must fail at startup, not ship silently.
if (corsOrigins.some((o) => o === '*' || o === 'null')) {
  throw new Error(
    'CORS_ORIGIN must not contain "*" or "null" while credentials are enabled — list explicit origins.',
  );
}
app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    // NOTE: X-Rapitas-Source lets the (cross-origin) frontend tag user-originated
    // requests for the UI-quiet restart gate; without it the preflight strips it.
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Rapitas-Source'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // NOTE: Preflight impact assessment for the X-Rapitas-Source rollout (task #570):
    // the apiClient path already sends Content-Type: application/json on every
    // request, so it was preflighted before the header existed — zero new OPTIONS
    // there. Net-new preflights come only from fetchWithRetry GETs that used to be
    // simple requests. @elysiajs/cors defaults maxAge to 5s, which would re-issue
    // OPTIONS roughly every 5s for polling GETs (~2x request volume); 7200s is
    // Chrome's preflight-cache cap and bounds that churn to once per 2h per route.
    maxAge: 7200,
  }),
);

// Ensure all responses are JSON formatted
app.onBeforeHandle(({ set }) => {
  set.headers['Content-Type'] = 'application/json; charset=utf-8';
});

// Apply error handler middleware (ensures JSON error responses)
app.use(errorHandler);

// Swagger documentation
app.use(
  swagger({
    documentation: {
      info: {
        title: 'Rapitas API',
        version: '1.0.0',
        description: 'Rapitas - AI-powered task management and development automation API',
      },
      tags: [
        { name: 'Tasks', description: 'Task management operations' },
        { name: 'Projects', description: 'Project management operations' },
        { name: 'Themes', description: 'Theme/workspace operations' },
        { name: 'Labels', description: 'Label management operations' },
        { name: 'Milestones', description: 'Milestone management operations' },
        { name: 'Time Entries', description: 'Time tracking operations' },
        { name: 'Comments', description: 'Comment operations' },
        { name: 'Notifications', description: 'Notification operations' },
        { name: 'Settings', description: 'User settings operations' },
        { name: 'GitHub', description: 'GitHub integration operations' },
        { name: 'Approvals', description: 'Approval workflow operations' },
        {
          name: 'AI Agents',
          description: 'AI agent execution and configuration',
        },
        {
          name: 'SSE',
          description: 'Server-Sent Events for real-time updates',
        },
        {
          name: 'Study',
          description: 'Study-related features (exam goals, streaks)',
        },
        { name: 'Resources', description: 'Resource management' },
        { name: 'AI Chat', description: 'AI chat functionality' },
        { name: 'Developer Mode', description: 'Developer mode configuration' },
      ],
    },
    path: '/api/docs',
    exclude: ['/api/docs', '/api/docs/json'],
  }),
);

// Apply all modular routes (82 Elysia instances, organized by domain)
registerAllRoutes(app);

// Top-level aggregate health check. Several docs/CI references (SETUP.md,
// .github/workflows/performance.yml) historically hit a bare `/health` that
// never existed — only the namespaced `/agents/health` did. This folds in the
// SAME data `/agents/system-status` already computes (via the shared
// getAgentSystemSnapshot()) plus process uptime, so operators/CI have one
// fast, read-only endpoint instead of needing to know the `/agents` prefix.
app.get('/health', handleTopLevelHealthCheck);

// Warm-up tasks (schedulers, memory system, agent worker manager, recovery)
// are imported here but deliberately NOT invoked until AFTER app.listen() —
// see runStartupWarmup() below. Previously they were all kicked off before
// listen, which forced the single JS thread to run CPU-heavy init (model
// loads, recovery scans, child-process spawns) before it could serve any
// request. An already-open task-detail page then stalled long enough to hit
// the frontend's 30s request timeout on every (re)start.
import { BehaviorScheduler } from './src/services/behavior-scheduler';
import { initializeMemorySystem, shutdownMemorySystem } from './services/memory';
import { AIOrchestra } from './services/workflow/ai-orchestra';
import { migrateLegacyWorkflowFiles } from './services/workflow/workflow-legacy-migrator';
import { backfillWorkflowFilesToDatabase } from './services/workflow/workflow-db-backfill';
import { migrateStudyGoals } from './services/learning/study-goal-migration';
import { startBacklogScheduler } from './services/scheduling/backlog-scheduler';
import { startEventLoopLagWatchdog } from './services/system/event-loop-lag-watchdog';
import { startBackupScheduler } from './services/system/backup-scheduler';
import { startWorktreeCleanupScheduler } from './services/scheduling/worktree-cleanup-scheduler';
import { startDecisionTraceConsistencyScheduler } from './services/scheduling/decision-trace-consistency-scheduler';
import { startAutoRestartMergedCodeScheduler } from './services/scheduling/auto-restart-merged-code';
import { startMemoReminderScheduler } from './services/scheduling/memo-reminder-scheduler';
import { AutoMergeWatcher } from './services/workflow/auto-merge-watcher';
import { startWorkflowReconciler } from './services/workflow/workflow-reconciler';
import { startResourceTelemetryIfEnabled } from './services/system/resource-telemetry';

// Start server
const PORT = parseInt(process.env.PORT || '3001', 10);
// NOTE: Loopback by default — the API has no user auth and its agent endpoints
// can run arbitrary code, so LAN exposure (the previous 0.0.0.0 bind) was an
// unauthenticated-RCE surface. Explicit IPv4 loopback also keeps the IPv6
// zombie-socket interference fix intact. Non-loopback requires RAPITAS_BIND_HOST
// + RAPITAS_API_TOKEN (see middleware/local-auth.ts).
const BIND_HOST = resolveBindHost();
app.listen({
  port: PORT,
  hostname: BIND_HOST,
  idleTimeout: 30, // 30-second idle timeout to prevent CLOSE_WAIT accumulation
  // NOTE: reusePort is intentionally OFF. It previously let a fresh process bind
  // a SECOND listen socket on top of one orphaned by a force-killed predecessor;
  // Windows then split incoming connections between the live and the dead socket,
  // and the requests routed to the dead one hung (HTTP 000). Without reusePort a
  // dirty port fails fast at bind (EADDRINUSE), so dev.js can detect a true
  // zombie socket and tell the user to reboot instead of masking it as a hang.
});
log.info(`Rapitas backend running on http://${BIND_HOST}:${PORT}`);

// Set server stop callback for proper port release during graceful shutdown.
// NOTE: stop(true) force-closes ALL active connections, not just the listener.
// Long-lived frontend connections (SSE, executing-tasks polling, health checks)
// never finish on their own; a graceful stop() leaves them half-open and they
// orphan as CLOSE_WAIT sockets under the dying PID — the root cause of the
// port-3001 zombie-socket lockups that previously required a Windows reboot.
// MUST be awaited: this callback's block body previously dropped app.stop(true)'s
// promise (no `return`/`await`), so `await stopServer()` in the /restart route
// resolved before the force-close actually finished — process.exit(75) could
// then fire mid-teardown, which is exactly how the connections above got
// orphaned under a PID that no longer exists.
setServerStopCallback(async () => {
  await app.stop(true);
});

/**
 * Run heavy startup warm-up AFTER the listener is open, one task at a time and
 * yielding to the event loop between each, so the single JS thread stays free
 * to answer requests during boot (fixes the "task-detail page open across a
 * restart hits the 30s request timeout" symptom).
 *
 * Every task is individually timed and logged (`warmupMs`) so a slow/blocking
 * initializer is identifiable from the logs instead of guessed at.
 */
const runStartupWarmup = async (): Promise<void> => {
  const yieldToLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  const timed = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
    const startedAt = Date.now();
    try {
      await fn();
      log.info({ warmupMs: Date.now() - startedAt }, `Warm-up: ${label} ready`);
    } catch (err) {
      log.error({ err, warmupMs: Date.now() - startedAt }, `Warm-up: ${label} failed`);
    }
  };

  // Brief grace so the listener can answer the first in-flight requests
  // before we start CPU-heavy init on the single JS thread.
  await new Promise((resolve) => setTimeout(resolve, 250));

  await timed('behavior-scheduler', () => BehaviorScheduler.start());
  await yieldToLoop();
  await timed('memory-system', () => initializeMemorySystem());
  await yieldToLoop();
  await timed('ai-orchestra-recovery', () => AIOrchestra.getInstance().recoverOnStartup());
  await yieldToLoop();
  await timed('legacy-workflow-migration', () => migrateLegacyWorkflowFiles());
  await yieldToLoop();
  await timed('workflow-db-backfill', () => backfillWorkflowFilesToDatabase());
  await yieldToLoop();
  await timed('study-goal-migration', () => migrateStudyGoals());
  await yieldToLoop();
  await timed('agent-worker-manager', () => workerManager.initialize());
  await yieldToLoop();
  // Schedulers only register intervals — cheap, grouped at the end.
  await timed('backlog-scheduler', () => startBacklogScheduler());
  startEventLoopLagWatchdog();
  await timed('backup-scheduler', () => startBackupScheduler());
  await timed('worktree-cleanup-scheduler', () => startWorktreeCleanupScheduler());
  await timed('decision-trace-consistency-scheduler', () =>
    startDecisionTraceConsistencyScheduler(),
  );
  await timed('auto-restart-merged-code-scheduler', () => startAutoRestartMergedCodeScheduler());
  await timed('memo-reminder-scheduler', () => startMemoReminderScheduler());
  await timed('auto-merge-watcher', () => AutoMergeWatcher.getInstance().start());
  await timed('workflow-reconciler', () => startWorkflowReconciler());
  await timed('resource-telemetry', () => startResourceTelemetryIfEnabled());

  log.info('Startup warm-up complete');
};

// Fire-and-forget: never blocks the listener; each task self-reports timing.
void runStartupWarmup();

// Signal handling from bun --watch (for dev:simple mode)
// Close SSE connections immediately on SIGTERM/SIGINT to prevent CLOSE_WAIT accumulation
let isShuttingDown = false;
const handleProcessSignal = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`Received ${signal}, initiating graceful shutdown...`);

  // Force exit timer (force exit after 8 seconds)
  const forceExitTimer = setTimeout(() => {
    log.error('Graceful shutdown timeout, forcing exit...');
    process.exit(1);
  }, 8000);

  try {
    // Step 1: Close the listener AND force-close every active connection.
    // stop(true) is critical: a plain stop() only rejects new connections and
    // waits for in-flight ones to finish, but the frontend's persistent polling /
    // SSE connections never finish, so they would be left half-open and orphan as
    // CLOSE_WAIT sockets when the process exits (zombie-socket port lockup).
    log.info('Step 1: Stopping listener + force-closing active connections...');
    try {
      // Awaited — previously fire-and-forget, so the process could reach
      // process.exit() below before the force-close actually completed (and
      // a rejection here would have been an unhandled promise rejection
      // instead of landing in this catch block).
      await app.stop(true);
    } catch (error) {
      log.error({ err: error }, 'Error stopping listener');
    }

    // Step 1.5: Stop AI Orchestra runner
    log.info('Step 1.5: Stopping AI Orchestra runner...');
    try {
      const { WorkflowRunner } = await import('./services/workflow/workflow-runner');
      await WorkflowRunner.getInstance().stopProcessing();
    } catch (error) {
      log.error({ err: error }, 'Error stopping workflow runner');
    }

    // Step 1.6: Stop memory system
    log.info('Step 1.6: Stopping memory system...');
    shutdownMemorySystem();

    // Step 2: Close all SSE connections (cleanup existing connections)
    log.info('Step 2: Closing SSE connections...');
    const clientCount = realtimeService.getClientCount();
    realtimeService.shutdown();
    log.info({ clientCount }, `Closed ${clientCount} SSE client(s).`);

    // Step 3: Wait for connections to drain
    // Need some time for TCP sockets to close completely
    log.info('Step 3: Waiting for connections to drain...');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 3.5: Local LLM server cleanup
    log.info('Step 3.5: Cleaning up local LLM server...');
    try {
      const { cleanupLocalLLM } = await import('./services/local-llm');
      cleanupLocalLLM();
    } catch {
      // ignore if module not loaded
    }

    // Step 4: Shutdown Agent Worker Manager
    log.info('Step 4: Shutting down Agent Worker Manager...');
    try {
      await workerManager.gracefulShutdown();
      log.info('Agent Worker Manager shutdown completed.');
    } catch (error) {
      log.error({ err: error }, 'Error shutting down Agent Worker Manager');
    }

    // Step 5: Close database connection
    log.info('Step 5: Closing database connection...');
    try {
      await prisma.$disconnect();
      log.info('Database connection closed.');
    } catch (error) {
      log.error({ err: error }, 'Error closing database connection');
    }

    clearTimeout(forceExitTimer);

    // Give TCP stack time to release sockets
    log.info('Waiting for socket cleanup...');
    setTimeout(() => {
      log.info('Shutdown complete.');
      process.exit(0);
    }, 500);
  } catch (error) {
    log.error({ err: error }, 'Error during shutdown');
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
};

process.on('SIGTERM', () => handleProcessSignal('SIGTERM'));
process.on('SIGINT', () => handleProcessSignal('SIGINT'));
// Windows: SIGBREAK fires on Ctrl+Break and (often) console-window close; SIGHUP
// covers parent-terminated / hangup paths. Registering them is a no-op where the
// signal never fires, so it is safe cross-platform.
process.on('SIGBREAK', () => handleProcessSignal('SIGBREAK'));
process.on('SIGHUP', () => handleProcessSignal('SIGHUP'));

// Last-resort synchronous safety net. If the process exits through a path that
// bypassed the async handler above (e.g. an unexpected process.exit()), still
// force-close the listener + active connections so nothing is left in CLOSE_WAIT
// on port 3001. Bun's server.stop(true) is synchronous-safe to call here.
process.on('exit', () => {
  try {
    app.server?.stop(true);
  } catch {
    /* best-effort: nothing more we can do during exit */
  }
});

// An uncaught exception would otherwise terminate the process via Bun's default
// handler, which skips the async drain window — closing the listener at the JS
// layer but exiting before the Windows kernel finishes tearing the socket down,
// leaving it orphaned as a zombie LISTEN on port 3001 (needs a reboot). Route it
// through the SAME graceful shutdown (force-close connections + drain) so the
// port is always released cleanly even on a crash.
process.on('uncaughtException', (err) => {
  log.error({ err }, 'Uncaught exception — shutting down gracefully to avoid zombie sockets');
  handleProcessSignal('uncaughtException');
});

// NOTE: An unhandled rejection is NOT necessarily fatal and MUST NOT tear down
// the live backend — doing so would sever in-flight agent work and the agent's
// own self-connection (see CLAUDE.md). Log it for triage; a genuinely fatal
// error surfaces as the uncaughtException handled above.
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled promise rejection (non-fatal; backend stays up)');
});

// Parent-liveness watchdog. Under `tauri dev` (and some Windows terminal-close
// paths) the parent kills this process WITHOUT delivering SIGINT/SIGTERM — so the
// graceful handler above never runs and the frontend's persistent connections
// orphan as CLOSE_WAIT zombie sockets on port 3001 (the lockup that needed a
// reboot). Polling the parent PID guarantees we still run the graceful shutdown
// (which force-closes every connection) the instant the parent disappears, with
// no dependency on signal delivery.
const PARENT_PID = process.ppid;
// Skip the watchdog in CI / test runs: there the backend is intentionally
// launched as a detached background job (`bun run index.ts & sleep 5`) and
// measured in a LATER step, so the launching shell exits between steps. The
// watchdog would then see its parent gone and self-shut-down before the health
// check — exactly the spurious shutdown that fails the Performance job. Ephemeral
// runners have no zombie-socket concern, so disabling it there is safe.
const isCiOrTest = process.env.CI === 'true' || process.env.NODE_ENV === 'test';
if (PARENT_PID && PARENT_PID > 1 && !isCiOrTest) {
  const parentWatch = setInterval(() => {
    let parentAlive = true;
    try {
      // signal 0 only probes existence; it never actually signals the process.
      process.kill(PARENT_PID, 0);
    } catch (err) {
      // EPERM = process exists but we lack permission (still alive). Anything
      // else (ESRCH) = the parent is gone.
      parentAlive = (err as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (!parentAlive && !isShuttingDown) {
      clearInterval(parentWatch);
      log.warn(
        `Parent process ${PARENT_PID} exited — initiating graceful shutdown to avoid zombie sockets`,
      );
      handleProcessSignal('parent-exit');
    }
  }, 3000);
  // Don't keep the event loop alive solely for this watchdog.
  parentWatch.unref?.();
}

// Startup recovery: mark stale running/pending executions as interrupted
// and update related Task/Session statuses, then auto-resume if enabled
const startupRecovery = async () => {
  // One-time data normalization: legacy agent-execution paths wrote the
  // non-canonical underscore 'in_progress' to task.status (canonical is the
  // hyphenated 'in-progress' — see the frontend StatusConfig). Such tasks render
  // as 'todo' and are missed by status='in-progress' queries, so subtasks
  // appeared stuck after an agent run. Reconcile any existing rows on startup.
  try {
    const normalized = await prisma.task.updateMany({
      where: { status: 'in_progress' },
      data: { status: 'in-progress' },
    });
    if (normalized.count > 0) {
      log.info(
        { count: normalized.count },
        'Startup: normalized legacy in_progress task statuses to in-progress',
      );
    }
  } catch (err) {
    log.warn({ err }, 'Startup: failed to normalize legacy task statuses');
  }

  // Wait for worker process to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Additional wait until worker is ready
  let retries = 0;
  while (!workerManager.getIsWorkerReady() && retries < 20) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    retries++;
  }

  if (!workerManager.getIsWorkerReady()) {
    log.warn('Startup recovery skipped: Worker not ready after 20s');
    return;
  }

  const result = await orchestrator.recoverStaleExecutions();

  if (result.recoveredExecutions > 0) {
    log.info(
      {
        recoveredExecutions: result.recoveredExecutions,
        updatedTasks: result.updatedTasks,
        updatedSessions: result.updatedSessions,
      },
      `Startup recovery: ${result.recoveredExecutions} executions, ${result.updatedTasks} tasks, ${result.updatedSessions} sessions recovered`,
    );
  }

  // Automatically resume interrupted executions. The guarded module replaces
  // the old unguarded per-execution fetch loop: it enforces the resume-attempt
  // budget, a freshness window, and skips executions a newer run already
  // superseded — an unguarded loop could re-launch a crashing run forever.
  // Gating (UserSettings.autoResumeInterruptedTasks + env kill switch) lives
  // inside the module so the lease-sweep path shares it.
  if (result.interruptedExecutionIds.length > 0) {
    try {
      // Brief settle delay so the worker/agent infrastructure finishes booting.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const { autoResumeInterruptedExecutions } =
        await import('./services/agents/orchestrator/auto-resume');
      const startedCount = await autoResumeInterruptedExecutions(result.interruptedExecutionIds);
      log.info(
        { interrupted: result.interruptedExecutionIds.length, resumed: startedCount },
        `Auto-resume: started ${startedCount}/${result.interruptedExecutionIds.length} interrupted executions`,
      );
    } catch (error) {
      log.error({ err: error }, 'Auto-resume check failed');
    }
  }
};

startupRecovery().catch((error) => {
  log.error({ err: error }, 'Startup recovery failed');
});
