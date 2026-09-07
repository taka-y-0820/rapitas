/** Preserve runtime-stage failures as evidence rather than silently omitting the check. */
import type { VerificationCheck } from './automated-verifier';
import { createLogger } from '../../../config/logger';
const log = createLogger('verification:runtime-stage');
export async function runRuntimeVerificationStage(
  workdir: string,
  taskId?: number,
): Promise<VerificationCheck | null> {
  try {
    const { runRuntimeSmokeCheck } = await import('./runtime-smoke');
    return await runRuntimeSmokeCheck(workdir, 'adhoc', taskId);
  } catch (err) {
    log.warn({ err, workdir }, 'Runtime verification could not execute');
    return {
      name: 'runtime',
      ran: false,
      ok: false,
      unverifiable: true,
      errorCount: 0,
      details: `Runtime verification unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
