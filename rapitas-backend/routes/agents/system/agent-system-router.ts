/**
 * Agent System Router
 *
 * Handles diagnostics, system status, encryption checks, and graceful shutdown.
 */
import { Elysia } from 'elysia';
import { prisma } from '../../../config/database';
import { orchestrator } from '../../../services/core/orchestrator-instance';
import { isEncryptionKeyConfigured } from '../../../utils/common/encryption';
import { createLogger } from '../../../config/logger';
import { scheduleShutdownSequence } from '../../../services/system/shutdown-sequence';
import { AuthenticationError } from '../../../middleware/error-handler';
import { getActivePreviewCount } from '../../../services/agents/preview/preview-session-manager';
import {
  isResumableInterrupted,
  getCurrentActiveExecutionIds,
  getLiveTaskIdsForActiveExecutions,
} from '../../../services/agents/resumable-execution';

const log = createLogger('routes:agent-system');

/**
 * Verify admin access for sensitive system endpoints.
 * Skipped in development mode for convenience (dev.js calls these).
 *
 * @param headers - Request headers / リクエストヘッダー
 * @throws AuthenticationError in production without valid token
 */
function requireAdmin(headers: Record<string, string | undefined>): void {
  if (process.env.NODE_ENV === 'development') return;
  const token = headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_SECRET) {
    throw new AuthenticationError('Admin authentication required');
  }
}

// NOTE: scheduleShutdownSequence moved to services/system/shutdown-sequence.ts —
// the auto-restart-merged-code scheduler became a second caller, and the exit
// path belongs in the service layer, not a router.

/**
 * Snapshot of live agent activity: how many executions are actually running,
 * how many DB rows claim to be running/pending, how many are stranded
 * `interrupted`, and how deep the auto-run queue is. Shared by `/agents/system-status`
 * and the top-level `/health` aggregate (see index.ts) so both report identical
 * numbers from one code path instead of drifting.
 *
 * @returns Snapshot fields plus a derived overall `status` label / システム状態スナップショット
 */
export async function getAgentSystemSnapshot(): Promise<{
  status: string;
  isShuttingDown: boolean;
  activeExecutions: number;
  runningExecutions: number;
  interruptedExecutions: number;
  interruptedExecutionsHistoryCount: number;
  interruptedExecutionsDegraded: boolean;
  queueDepth: number;
  activePreviewCount: number;
  serverTime: string;
}> {
  // NOTE: Sync getActiveExecutionCount() returns a cached value (0 right after startup).
  // Use the async version when available to get the accurate count from the worker.
  // The worker subprocess isn't ready for the first few seconds after every
  // restart — sendIPCRequest throws 'Worker not ready' during that window, which
  // is an expected, transient condition (this snapshot is polled by the frontend
  // on a timer, so it always lands in that window right after a restart), not a
  // real failure. Fall back to the cached sync count instead of letting it
  // surface as an ERROR-level "Unhandled error" on every single restart.
  const workerMgr = orchestrator as unknown as {
    getActiveExecutionCountAsync?: () => Promise<number>;
  };
  let activeExecutions: number;
  try {
    activeExecutions = workerMgr.getActiveExecutionCountAsync
      ? await workerMgr.getActiveExecutionCountAsync()
      : orchestrator.getActiveExecutionCount?.() || 0;
  } catch (err) {
    log.debug({ err }, '[agent-system] Active count unavailable (worker likely still starting)');
    activeExecutions = orchestrator.getActiveExecutionCount?.() || 0;
  }
  const isShuttingDown = orchestrator.isInShutdown();

  // Count running/pending executions, but EXCLUDE orphaned rows whose task is
  // already terminal/blocked. A blocked or done task cannot have a legitimately
  // live agent — a row left at 'running' there is a stale record (process died,
  // task was blocked) and made the restart dialog falsely warn "1 task running"
  // even though the orchestrator's real active count was 0 (task 223 / exec 686).
  const runningExecutions = await prisma.agentExecution.count({
    where: {
      status: { in: ['running', 'pending'] },
      session: { config: { task: { status: { in: ['todo', 'in-progress'] } } } },
    },
  });

  // Raw count of every `interrupted` row regardless of whether its task can
  // still be resumed — kept as its own field (never removed/renamed) so
  // operators retain the historical total even after the filtering below.
  const interruptedExecutionsHistoryCount = await prisma.agentExecution.count({
    where: {
      status: 'interrupted',
    },
  });

  // Resumability-filtered count: excludes `interrupted` rows whose task is
  // already terminal (done/completed/cancelled/failed/archived, or
  // workflowStatus=completed) and rows whose task already has a live
  // execution running elsewhere — matching the definition `/resumable-executions`
  // uses, so the two endpoints never disagree about what's "operationally
  // interrupted". If this computation itself fails, fall back to the raw
  // count (never silently to 0) and flag `interruptedExecutionsDegraded` so
  // the derived `status` below does not report `healthy` on unverified data.
  let interruptedExecutions = interruptedExecutionsHistoryCount;
  let interruptedExecutionsDegraded = false;
  try {
    const interruptedRows = await prisma.agentExecution.findMany({
      where: { status: 'interrupted' },
      select: {
        session: {
          select: {
            config: {
              select: { task: { select: { id: true, status: true, workflowStatus: true } } },
            },
          },
        },
      },
    });
    const activeExecutionIds = await getCurrentActiveExecutionIds();
    const liveTaskIds = await getLiveTaskIdsForActiveExecutions(activeExecutionIds);
    interruptedExecutions = interruptedRows.filter((row) =>
      isResumableInterrupted({ status: 'interrupted' }, row.session.config?.task, liveTaskIds),
    ).length;
  } catch (err) {
    log.warn(
      { err },
      '[agent-system] Resumable-interrupted computation failed, falling back to raw count',
    );
    interruptedExecutionsDegraded = true;
  }

  // Auto-run backlog depth — cheap indexed count (@@index([status, priority])
  // on WorkflowQueueItem), not a new tracking mechanism.
  const queueDepth = await prisma.workflowQueueItem.count({ where: { status: 'queued' } });

  // NOTE: `interruptedExecutionsDegraded` is checked BEFORE the raw count —
  // a failed computation must never be allowed to read as `healthy` just
  // because the raw-count fallback happens to be 0 (task 913 counter-example).
  let status = 'healthy';
  if (isShuttingDown) status = 'shutting_down';
  else if (activeExecutions > 0) status = 'busy';
  else if (interruptedExecutionsDegraded) status = 'interrupted_executions_unknown';
  else if (interruptedExecutions > 0) status = 'interrupted_executions';

  return {
    status,
    isShuttingDown,
    activeExecutions,
    runningExecutions,
    interruptedExecutions,
    interruptedExecutionsHistoryCount,
    interruptedExecutionsDegraded,
    queueDepth,
    activePreviewCount: getActivePreviewCount(),
    serverTime: new Date().toISOString(),
  };
}

export const agentSystemRouter = new Elysia({ prefix: '/agents' })

  .get('/encryption-status', async () => {
    return {
      isConfigured: isEncryptionKeyConfigured(),
      message: isEncryptionKeyConfigured()
        ? 'Encryption key is properly configured'
        : 'Warning: Encryption key is not set in environment variables. Must be configured for production.',
    };
  })

  .get('/diagnose', async ({ headers }) => {
    requireAdmin(headers);
    const { spawn } = await import('child_process');
    const claudePath = process.env.CLAUDE_CODE_PATH || 'claude';

    log.info('[Diagnose] Testing Claude CLI...');
    log.info({ claudePath }, '[Diagnose] Claude path');
    log.info({ platform: process.platform }, '[Diagnose] Platform');

    const results: {
      step: string;
      success: boolean;
      output?: string;
      error?: string;
      duration?: number;
    }[] = [];

    const versionResult = await new Promise<{
      success: boolean;
      output?: string;
      error?: string;
      duration: number;
    }>((resolve) => {
      const startTime = Date.now();
      const proc = spawn(claudePath, ['--version'], { shell: true });
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        proc.kill();
        resolve({
          success: false,
          error: 'Timeout (10s)',
          duration: Date.now() - startTime,
        });
      }, 10000);

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          success: code === 0,
          output: stdout.trim(),
          error: stderr.trim() || (code !== 0 ? `Exit code: ${code}` : undefined),
          duration: Date.now() - startTime,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: err.message,
          duration: Date.now() - startTime,
        });
      });
    });

    results.push({ step: 'claude --version', ...versionResult });
    log.info({ versionResult }, '[Diagnose] Version check');

    if (versionResult.success) {
      const promptResult = await new Promise<{
        success: boolean;
        output?: string;
        error?: string;
        duration: number;
      }>((resolve) => {
        const startTime = Date.now();

        const isWindows = process.platform === 'win32';
        let proc;

        if (isWindows) {
          const fullCommand = `${claudePath} --dangerously-skip-permissions -p "Say hello"`;
          log.info({ fullCommand }, '[Diagnose] Windows full command');
          proc = spawn('cmd.exe', ['/c', fullCommand], {
            env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
            windowsHide: true,
          });
        } else {
          proc = spawn(claudePath, ['--dangerously-skip-permissions', '-p', 'Say hello'], {
            env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
          });
        }

        let stdout = '';
        let stderr = '';

        const timeout = setTimeout(() => {
          log.info('[Diagnose] Timeout, killing process');
          proc.kill();
          resolve({
            success: false,
            error: 'Timeout (90s)',
            duration: Date.now() - startTime,
          });
        }, 90000);

        proc.stdout?.on('data', (data) => {
          const chunk = data.toString();
          stdout += chunk;
          log.info({ chunk: chunk.substring(0, 100) }, '[Diagnose] stdout chunk');
        });

        proc.stderr?.on('data', (data) => {
          const chunk = data.toString();
          stderr += chunk;
          log.info({ chunk: chunk.substring(0, 100) }, '[Diagnose] stderr chunk');
        });

        proc.on('close', (code) => {
          clearTimeout(timeout);
          log.info({ code, stdoutLength: stdout.length }, '[Diagnose] Process closed');
          resolve({
            success: code === 0,
            output: stdout.substring(0, 500),
            error: stderr.trim() || (code !== 0 ? `Exit code: ${code}` : undefined),
            duration: Date.now() - startTime,
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          log.info({ err }, '[Diagnose] Process error');
          resolve({
            success: false,
            error: err.message,
            duration: Date.now() - startTime,
          });
        });
      });

      results.push({ step: 'simple prompt test', ...promptResult });
      log.info({ promptResult }, '[Diagnose] Prompt test result');
    }

    return {
      claudePath,
      platform: process.platform,
      results,
      allPassed: results.every((r) => r.success),
    };
  })

  .get('/system-status', async () => getAgentSystemSnapshot())

  // Validate agent configuration
  .get('/validate-config', async () => {
    try {
      const agentConfigs = await prisma.aIAgentConfig.findMany({
        select: {
          id: true,
          name: true,
          agentType: true,
          isActive: true,
        },
      });

      let isValid = true;
      const errors: string[] = [];

      const activeConfigs = agentConfigs.filter((config) => config.isActive);
      if (activeConfigs.length === 0) {
        isValid = false;
        errors.push('No active agent configurations found');
      }

      if (!isEncryptionKeyConfigured()) {
        isValid = false;
        errors.push('Encryption key not configured');
      }

      return {
        isValid,
        totalConfigs: agentConfigs.length,
        activeConfigs: activeConfigs.length,
        errors,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        isValid: false,
        errors: [`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        timestamp: new Date().toISOString(),
      };
    }
  })

  // Health check endpoint
  .get('/health', async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;

      return {
        status: 'healthy',
        database: 'connected',
        encryption: isEncryptionKeyConfigured() ? 'configured' : 'not_configured',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return Response.json(
        {
          status: 'unhealthy',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        },
        { status: 503 },
      );
    }
  })

  // Graceful shutdown endpoint (called by dev.js before stopping)
  .post('/shutdown', async ({ headers }) => {
    requireAdmin(headers);
    try {
      log.info('[shutdown] Graceful shutdown requested via API');

      const activeCount = orchestrator.getActiveExecutionCount();

      scheduleShutdownSequence('[shutdown]', 0);

      return {
        success: true,
        message: 'Graceful shutdown initiated',
        activeExecutions: activeCount,
      };
    } catch (error) {
      log.error({ err: error }, '[shutdown] Error');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initiate shutdown',
      };
    }
  })

  // Server restart endpoint (called by frontend or dev tools)
  // Performs graceful shutdown then exits with code 75 to signal dev.js to restart
  .post('/restart', async ({ headers }) => {
    requireAdmin(headers);
    try {
      log.info('[restart] Server restart requested via API');

      const activeCount = orchestrator.getActiveExecutionCount();

      scheduleShutdownSequence('[restart]', 75);

      return {
        success: true,
        message: 'Server restart initiated. Server will stop and restart automatically.',
        activeExecutions: activeCount,
      };
    } catch (error) {
      log.error({ err: error }, '[restart] Error');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initiate restart',
      };
    }
  });
