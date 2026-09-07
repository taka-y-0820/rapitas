/**
 * PromptEvolutionAutoApproveShared
 *
 * Types and evidence helpers shared by the unattended gate's orchestrator
 * (prompt-evolution-auto-approve) and its two steps (-stage, -evaluate).
 *
 * Kept in its own module rather than on the orchestrator so the steps can
 * import them without importing the orchestrator that imports them back —
 * barrel-style cycles are prohibited (FOLDER_ORGANIZATION_POLICY §4). Holds no
 * decision logic: every rule lives in the step that applies it.
 */
import { prisma } from '../../config/database';

export interface AutoApproveResult {
  /** Rows moved `proposed` → `staged` (limited trial started). / 限定試行を開始した件数 */
  staged: number;
  /** Rows moved `staged` → `approved` on measured evidence. / 実測に基づき全体採用した件数 */
  approved: number;
  /** Rows rejected: unusable text, or a measured regression. / 却下・撤回した件数 */
  rejected: number;
  /** Rows deliberately left where they are this run. / 今回は現状維持とした件数 */
  withheld: number;
}

/** Free-form audit stamps on PromptEvolution.evidenceJson. */
export type Evidence = Record<string, unknown>;

/** The PromptEvolution columns both steps read. */
export interface CandidateRow {
  id: number;
  basePromptKey: string | null;
  afterPrompt: string | null;
  evidenceJson: string | null;
}

/** Prisma `select` matching CandidateRow, shared so the two steps cannot drift. */
export const CANDIDATE_SELECT = {
  id: true,
  basePromptKey: true,
  afterPrompt: true,
  evidenceJson: true,
} as const;

/**
 * Parse a row's evidenceJson into a mutable object.
 *
 * @param raw - Stored evidenceJson. / 保存済みの証跡JSON
 * @returns Parsed object, or {} when unusable. / パース結果
 */
export function parseEvidence(raw: string | null): Evidence {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object') return parsed as Evidence;
  } catch {
    /* unreadable evidence — start fresh rather than dropping the stamp */
  }
  return {};
}

/**
 * Persist an evidence object without touching the row's status.
 *
 * @param id - PromptEvolution row id. / 対象ID
 * @param evidence - Evidence object to persist. / 保存する証跡
 */
export async function stampEvidence(id: number, evidence: Evidence): Promise<void> {
  await prisma.promptEvolution.update({
    where: { id },
    data: { evidenceJson: JSON.stringify(evidence) },
  });
}
