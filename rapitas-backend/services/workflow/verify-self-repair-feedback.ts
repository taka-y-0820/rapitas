/**
 * verify-self-repair-feedback
 *
 * Handles verify.md repair-feedback generation for verify-self-repair: numeric
 * tally sanitisation, failure-location extraction, and marker-wrapped
 * block merge/write. Not responsible for repair-budget judgement or state
 * transitions.
 */
import { createLogger } from '../../config/logger';
import { readWorkflowFile, writeWorkflowFile } from './workflow-file-utils';

const log = createLogger('workflow:verify-self-repair');

export {
  REPAIR_FEEDBACK_START,
  REPAIR_FEEDBACK_END,
  sanitizeRepairReason,
  buildRepairFeedbackBlock,
  mergeRepairFeedback,
} from './verify-repair-feedback-content';
import { buildRepairFeedbackBlock, mergeRepairFeedback } from './verify-repair-feedback-content';

/**
 * Write the verify failure back to verify.md so the re-run implementer reads
 * it as feedback (the implementer context surfaces verify.md). Best-effort.
 *
 * @param taskId - Task id / タスクID
 * @param reason - Validator summary / バリデータの要約
 * @param verifyContent - The rejected verify.md (fallback when the file is unreadable) / 却下されたverify.md
 * @param attempt - 1-based attempt number / 試行回数
 */
export async function writeRepairFeedback(
  taskId: number,
  reason: string,
  verifyContent: string,
  attempt: number,
): Promise<void> {
  try {
    // Belongs on verify.md, not question.md (Q&A) — the implementer re-reads it.
    const prior = (await readWorkflowFile(taskId, 'verify')) ?? verifyContent ?? '';
    const block = buildRepairFeedbackBlock(reason, attempt, verifyContent);
    await writeWorkflowFile(taskId, 'verify', mergeRepairFeedback(prior, block));
  } catch (err) {
    log.warn({ err, taskId }, '[verify-repair] Failed to write repair feedback to verify.md');
  }
}
