/** Claim one role's trial in the database, including across concurrent workers. */
import { prisma } from '../../config/database';
import type { CandidateRow } from './prompt-evolution-auto-approve-shared';

/** A serializable predicate read prevents two candidates from claiming the same role. */
export async function claimStagedRole(
  candidate: CandidateRow,
  evidenceJson: string,
): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const active = await tx.promptEvolution.findMany({
        where: { status: 'staged', basePromptKey: candidate.basePromptKey },
        select: { id: true },
        take: 1,
      });
      if (active.length) return false;
      const claimed = await tx.promptEvolution.updateMany({
        where: {
          id: candidate.id,
          status: 'proposed',
          basePromptKey: candidate.basePromptKey,
          afterPrompt: candidate.afterPrompt ?? '',
          evidenceJson: candidate.evidenceJson,
        },
        data: { status: 'staged', evidenceJson },
      });
      return claimed.count === 1;
    },
    { isolationLevel: 'Serializable' },
  );
}
