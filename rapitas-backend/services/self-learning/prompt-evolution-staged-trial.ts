/**
 * PromptEvolutionStagedTrial
 *
 * Injection side of the LIMITED TRIAL a candidate runs before it can be
 * adopted role-wide. A `staged` candidate is not injected into every run:
 * each phase of the target role is assigned, alternately and deterministically,
 * to the control arm (no addendum) or the intervention arm (addendum
 * appended), so the two arms accumulate comparable evidence on real tasks.
 *
 * Not responsible for judging the accumulated evidence (that is
 * prompt-evolution-auto-approve) nor for the approved-addendum path
 * (getApprovedRoleAddendum in prompt-evolution-worker), which stays untouched
 * so an approved rollout is never mixed with a trial.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { addendumVersionHash } from './comparison/prompt-comparison-store';
import type { ComparisonAssignment } from './comparison/prompt-comparison-types';
import { MAX_ADDENDUM_CHARS } from './prompt-evolution-worker';

const log = createLogger('self-learning:prompt-evolution-staged-trial');

/** evidenceJson key holding how many phases this candidate has been assigned to. */
export const STAGED_SAMPLE_COUNT_KEY = 'stagedSampleCount';

/** One phase's arm assignment plus the text to inject when it is the candidate arm. */
export interface StagedTrialAssignment {
  /**
   * The assignment as it stands BEFORE injection: `injected` is false and
   * `injectedVersion` null until the caller confirms the text reached the
   * prompt. An assignment is not evidence of an intervention.
   */
  assignment: ComparisonAssignment;
  /** Addendum to append, or null on the control arm. */
  addendum: string | null;
  /** Checksum of `addendum`, or null on the control arm. */
  version: string | null;
}

function parseEvidence(raw: string | null): Record<string, unknown> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* unreadable evidence — start fresh rather than dropping the counter */
  }
  return {};
}

/**
 * Assign the next phase of `role` to a comparison arm for the role's staged
 * candidate, if one exists.
 *
 * Alternation is driven by a PERSISTED counter rather than a random draw, so
 * the arm sequence is reproducible in tests and survives a restart (the
 * counter lives in PromptEvolution.evidenceJson, not in memory). Only the
 * newest staged candidate per role is used, so two candidates can never be
 * mixed into the same role's prompt.
 *
 * @param role - Workflow role about to run. / 実行直前のロール
 * @param taskId - Task the phase belongs to. / 対象タスクID
 * @returns Arm assignment and the text to inject, or null when nothing is staged. / 割当と注入文 or null
 */
export async function getStagedRoleAddendumForTrial(
  role: string,
  taskId: number,
): Promise<StagedTrialAssignment | null> {
  try {
    const row = await prisma.promptEvolution.findFirst({
      where: { basePromptKey: `workflow_role_${role}`, status: 'staged' },
      orderBy: { id: 'desc' },
      select: { id: true, afterPrompt: true, evidenceJson: true },
    });
    const text = row?.afterPrompt?.trim().slice(0, MAX_ADDENDUM_CHARS);
    if (!row || !text) return null;

    const evidence = parseEvidence(row.evidenceJson);
    const previous =
      typeof evidence[STAGED_SAMPLE_COUNT_KEY] === 'number'
        ? (evidence[STAGED_SAMPLE_COUNT_KEY] as number)
        : 0;
    // Odd draws take the intervention so the very first assignment is a
    // control run — the baseline must exist before anything is compared to it.
    const arm = previous % 2 === 1 ? 'candidate' : 'current';

    await prisma.promptEvolution.update({
      where: { id: row.id },
      data: {
        evidenceJson: JSON.stringify({ ...evidence, [STAGED_SAMPLE_COUNT_KEY]: previous + 1 }),
      },
    });

    const version = arm === 'candidate' ? addendumVersionHash(text) : null;
    log.info(
      { taskId, role, promptEvolutionId: row.id, arm, version },
      '[prompt-evolution] Staged candidate assigned to a comparison arm',
    );
    return {
      assignment: {
        promptEvolutionId: row.id,
        role,
        arm,
        injected: false,
        injectedVersion: null,
      },
      addendum: arm === 'candidate' ? text : null,
      version,
    };
  } catch (err) {
    log.warn({ err, taskId, role }, '[prompt-evolution] Staged trial assignment failed');
    return null;
  }
}
