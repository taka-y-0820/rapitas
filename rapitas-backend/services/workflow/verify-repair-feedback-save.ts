/** Save feedback with the repair's state and audit transaction; never swallows failure. */
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma-postgres';
import { buildRepairFeedbackBlock, mergeRepairFeedback } from './verify-repair-feedback-content';

export async function saveCommittedRepairFeedback(
  tx: Prisma.TransactionClient,
  taskId: number,
  reason: string,
  verifyContent: string,
  attempt: number,
  existing: { content: string; sha256: string; sizeBytes: number } | null,
): Promise<void> {
  const open = await tx.task.findFirst({
    where: { parentId: taskId, status: { notIn: ['done', 'failed', 'cancelled', 'archived'] } },
    select: { id: true },
  });
  if (open) throw new Error('Repair feedback held: parent has open subtasks');
  if (existing)
    await tx.workflowFileVersion.create({ data: { taskId, fileType: 'verify', ...existing } });
  const content = mergeRepairFeedback(
    verifyContent,
    buildRepairFeedbackBlock(reason, attempt, verifyContent),
  );
  const data = {
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
  await tx.workflowFile.upsert({
    where: { taskId_fileType: { taskId, fileType: 'verify' } },
    create: { taskId, fileType: 'verify', ...data },
    update: data,
    select: { id: true },
  });
}
