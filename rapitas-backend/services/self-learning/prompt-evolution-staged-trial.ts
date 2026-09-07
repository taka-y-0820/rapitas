/**
 * PromptEvolutionStagedTrial
 *
 * Injection side of the LIMITED TRIAL a candidate runs before it can be
 * adopted role-wide. A `staged` candidate is not injected into every run:
 * each phase of the target role is assigned to the control arm or the
 * intervention arm, so the two arms accumulate comparable evidence on real
 * tasks.
 *
 * Assignment uses PERMUTED BLOCKS of size 2 rather than strict alternation.
 * Blocks keep the arms balanced (every pair contains one of each, so a trial
 * stopped at any point has comparable arm sizes), while the order WITHIN each
 * block is drawn from the candidate's own random seed. Strict alternation is
 * balanced too, but it is predictable: the arm becomes a deterministic
 * function of position, so any systematic pattern in which tasks arrive in
 * even vs odd slots (task size, time of day, which theme is running) is
 * confounded with the intervention.
 *
 * Not responsible for judging the accumulated evidence (that is
 * prompt-evolution-auto-approve) nor for the approved-addendum path
 * (getApprovedRoleAddendum in prompt-evolution-worker), which stays untouched
 * so an approved rollout is never mixed with a trial.
 */
import { randomBytes } from 'crypto';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { addendumVersionHash, readComparisonRecord } from './comparison/prompt-comparison-store';
import { reserveTrialSlot } from './comparison/prompt-comparison-trial-manifest';
import { resolveEvaluationBudget } from './comparison/prompt-comparison-alpha-ledger';
export { assignArm } from './comparison/prompt-comparison-randomization';
import type { ComparisonAssignment } from './comparison/prompt-comparison-types';
import { MAX_ADDENDUM_CHARS } from './prompt-evolution-worker';

const log = createLogger('self-learning:prompt-evolution-staged-trial');

/** evidenceJson key holding how many phases this candidate has been assigned to. */
export const STAGED_SAMPLE_COUNT_KEY = 'stagedSampleCount';

/** evidenceJson key holding the per-candidate randomisation seed (issued at staging). */
export const TRIAL_RANDOM_SEED_KEY = 'trialRandomSeed';

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
 * The manifest serializes prospective slots and preserves their seed and both
 * prompt versions. Repeated tasks reuse their slot. The old evidenceJson
 * counter is not authoritative and is never reset or overwritten here. Legacy multiple-staged rows drain oldest first; one
 * candidate per role is used, so two candidates can never be mixed into the
 * same role's prompt.
 *
 * @param role - Workflow role about to run. / 実行直前のロール
 * @param taskId - Task the phase belongs to. / 対象タスクID
 * @param controlVersion - Version of the approved text this task would receive. / 対照の版
 * @returns Arm assignment and the text to inject, or null when nothing is staged. / 割当と注入文 or null
 */
export async function getStagedRoleAddendumForTrial(
  role: string,
  taskId: number,
  controlVersion: string | null = null,
): Promise<StagedTrialAssignment | null> {
  try {
    const row = await prisma.promptEvolution.findFirst({
      where: { basePromptKey: `workflow_role_${role}`, status: 'staged' },
      orderBy: { id: 'asc' },
      select: { id: true, afterPrompt: true, evidenceJson: true },
    });
    const text = row?.afterPrompt?.trim().slice(0, MAX_ADDENDUM_CHARS);
    if (!row || !text) return null;

    const evidence = parseEvidence(row.evidenceJson);
    if (resolveEvaluationBudget(row.id, 0).issue) return null;
    const reservation = reserveTrialSlot(
      {
        promptEvolutionId: row.id,
        role,
        candidateVersion: addendumVersionHash(text),
        controlVersion,
        seed:
          typeof evidence[TRIAL_RANDOM_SEED_KEY] === 'string'
            ? (evidence[TRIAL_RANDOM_SEED_KEY] as string)
            : randomBytes(16).toString('hex'),
      },
      taskId,
      () => {
        const record = readComparisonRecord(row.id);
        return !!record && record.arms.every((cell) => cell.runs.length === 0);
      },
    );
    if (reservation.issue !== null) {
      log.warn(
        { id: row.id, issue: reservation.issue },
        '[prompt-evolution] Trial assignment held',
      );
      return null;
    }
    const { arm } = reservation.slot;

    const version = arm === 'candidate' ? addendumVersionHash(text) : null;
    log.info(
      { taskId, role, promptEvolutionId: row.id, arm, version },
      '[prompt-evolution] Staged candidate assigned to a comparison arm',
    );
    return {
      assignment: {
        promptEvolutionId: row.id,
        assignmentId: reservation.slot.id,
        controlVersion,
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
