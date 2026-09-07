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
import { createHash } from 'crypto';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { addendumVersionHash } from './comparison/prompt-comparison-store';
import type { ComparisonArm, ComparisonAssignment } from './comparison/prompt-comparison-types';
import { MAX_ADDENDUM_CHARS } from './prompt-evolution-worker';

const log = createLogger('self-learning:prompt-evolution-staged-trial');

/** evidenceJson key holding how many phases this candidate has been assigned to. */
export const STAGED_SAMPLE_COUNT_KEY = 'stagedSampleCount';

/** evidenceJson key holding the per-candidate randomisation seed (issued at staging). */
export const TRIAL_RANDOM_SEED_KEY = 'trialRandomSeed';

/** Assignments per permuted block. Two keeps the arms balanced at every pair. */
const BLOCK_SIZE = 2;

/**
 * Which arm the `count`-th assignment of a candidate falls into, using
 * permuted blocks of two driven by the candidate's own seed.
 *
 * Deterministic given (seed, count) so a restart replays the same sequence and
 * tests can pin it, yet unpredictable from the task or its position because
 * the seed is drawn from a CSPRNG at staging time.
 *
 * @param seed - Per-candidate randomisation seed. / 候補ごとのシード
 * @param count - Assignments already made for this candidate. / 既存の割当数
 * @returns The arm for this assignment. / このフェーズのアーム
 */
export function assignArm(seed: string, count: number): ComparisonArm {
  const blockIndex = Math.floor(count / BLOCK_SIZE);
  const positionInBlock = count % BLOCK_SIZE;
  const digest = createHash('sha256').update(`${seed}:${blockIndex}`).digest();
  // One bit per block decides the order of that block's two slots. Both arms
  // still appear exactly once per block, so balance never depends on the draw.
  const candidateFirst = (digest[digest.length - 1] & 1) === 1;
  const candidateSlot = candidateFirst ? 0 : 1;
  return positionInBlock === candidateSlot ? 'candidate' : 'current';
}

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
 * The block sequence is driven by a PERSISTED counter plus the candidate's
 * persisted seed rather than a fresh random draw per call, so the assignment
 * is reproducible in tests and survives a restart (both live in
 * PromptEvolution.evidenceJson, not in memory). Only the newest staged
 * candidate per role is used, so two candidates can never be mixed into the
 * same role's prompt.
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
    const seed =
      typeof evidence[TRIAL_RANDOM_SEED_KEY] === 'string'
        ? (evidence[TRIAL_RANDOM_SEED_KEY] as string)
        : String(row.id);
    const arm = assignArm(seed, previous);

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
