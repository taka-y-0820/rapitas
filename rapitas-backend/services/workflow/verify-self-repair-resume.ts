/**
 * verify-self-repair-resume
 *
 * Handles self-driving the WorkflowRunner after a verify→implement bounce, and
 * telemetry identification of the bounce's caller. Not responsible for
 * repair-budget judgement or feedback generation.
 */
import { prisma } from '../../config/database';
import { enqueueCommittedRepair, type RepairQueueReceipt } from './verify-repair-queue';
import { createLogger } from '../../config/logger';

const log = createLogger('workflow:verify-self-repair');

/**
 * Call sites of `attemptVerifyRepair`, for repair-budget telemetry only
 * (task 749) — never used for control flow. A path not matching any entry
 * resolves to 'unknown'.
 */
const REPAIR_CALLER_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['file-save/status-transition', 'http_save'],
  ['file-save/verify-adversarial-review', 'adversarial_review'],
  ['file-save/verify-commit-pr-gate-blocked', 'commit_pr_gate'],
  ['workflow-api-executor', 'api_executor'],
  ['workflow-cli-executor-verify-gate', 'cli_epilogue'],
];

/**
 * Best-effort caller attribution from the call stack — telemetry only, so
 * next time this task's budget is exceeded (task#603/#710) the recorded
 * transition metadata identifies which of the several call sites raced.
 *
 * @returns A known caller label, or 'unknown'. / 呼び出し元識別子
 */
export function resolveRepairCaller(): string {
  const stack = new Error().stack ?? '';
  for (const [needle, label] of REPAIR_CALLER_LABELS) if (stack.includes(needle)) return label;
  return 'unknown';
}

/** Resume only the committed repair version; queue admission rechecks durable stop intent. */
export async function ensureRunnerResumes(
  taskId: number,
  receipt: RepairQueueReceipt,
): Promise<void> {
  const result = await enqueueCommittedRepair(prisma, taskId, receipt);
  if (result === 'held' || result === 'scheduler_owned') {
    log.info({ taskId, result }, '[verify-repair] No extra repair dispatch');
    return;
  }
  const { WorkflowRunner } = await import('./workflow-runner');
  WorkflowRunner.getInstance().startProcessing();
}
