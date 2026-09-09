/**
 * ShutdownSequence
 *
 * Shared graceful-shutdown sequence (close SSE → close listening socket →
 * stop agents → exit). Extracted from agent-system-router.ts so both the
 * /shutdown and /restart routes and the auto-restart-merged-code scheduler
 * can trigger the exact same exit path.
 * Not responsible for deciding WHEN to shut down — callers own that.
 */
import { stopServer } from '../core/orchestrator-instance';
import { shutdownExecutionOwners } from './shutdown-execution-owners';
import { realtimeService } from '../communication/realtime-service';
import { createLogger } from '../../config/logger';

const log = createLogger('services:shutdown-sequence');

// Upper bound for the whole SSE-close → socket-close → agent-shutdown sequence.
// Generous enough for gracefulShutdown to stop agents and save state.
const SHUTDOWN_WATCHDOG_MS = 30_000;

/**
 * Schedule the common shutdown sequence (close SSE → close listening socket →
 * stop agents) and exit with the given code. Shared by /shutdown and /restart.
 *
 * A watchdog forces the exit if any step never settles — a hung await here
 * previously left the process alive with no listener, so the restart the user
 * requested silently never happened.
 *
 * @param prefix - Log prefix, e.g. '[restart]' / ログ接頭辞
 * @param exitCode - Process exit code (75 tells dev.js to restart) / 終了コード
 */
export function scheduleShutdownSequence(prefix: string, exitCode: number): void {
  setTimeout(async () => {
    const watchdog = setTimeout(() => {
      log.error({ exitCode }, `${prefix} Shutdown watchdog fired — forcing process exit`);
      process.exit(exitCode);
    }, SHUTDOWN_WATCHDOG_MS);
    try {
      log.info(`${prefix} Closing all SSE connections...`);
      realtimeService.shutdown();

      log.info(`${prefix} Closing listening socket first for quick port release...`);
      await stopServer();
      log.info(`${prefix} Listening socket closed, port released.`);

      log.info(`${prefix} Stopping agents and saving state...`);
      await shutdownExecutionOwners();
      log.info(`${prefix} Agent shutdown completed.`);
    } catch (error) {
      log.error({ err: error }, `${prefix} Graceful shutdown error`);
    } finally {
      clearTimeout(watchdog);
      log.info({ exitCode }, `${prefix} Exiting process...`);
      setTimeout(() => process.exit(exitCode), 200);
    }
  }, 300);
}
