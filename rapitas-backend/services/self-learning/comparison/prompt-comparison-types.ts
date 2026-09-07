/**
 * PromptComparisonTypes
 *
 * Shared type definitions for the current-vs-candidate prompt comparison
 * ("shadow run") system: same model, same budget, same sample tasks, run
 * under both the current and candidate prompt with knowledge on/off, so a
 * PromptEvolution candidate's success-rate/cost/duration delta and internal
 * failure causes can be recorded before it is staged to real tasks. Kept
 * dependency-free — same policy as experiment-types.ts — so the pure module
 * (prompt-comparison-metrics) and the I/O module (prompt-comparison-store /
 * prompt-comparison-runner) never form cycles.
 */

/** Which prompt version a shadow run used. */
export type ComparisonArm = 'current' | 'candidate';

/** Whether shared-knowledge injection was enabled for a shadow run. */
export type KnowledgeCondition = 'with' | 'without';

/**
 * Internal cause of a non-successful shadow run, separated from the boolean
 * success flag so verdicts are not skewed by causes unrelated to prompt
 * quality (infra outages, an operator cancelling the run).
 */
export type FailureCause = 'infra_failure' | 'user_cancelled' | 'implementation_error';

/** Comparison verdict for one PromptEvolution candidate. */
export type ComparisonVerdict = 'improved' | 'regressed' | 'inconclusive' | 'insufficient_data';

/** One shadow run's outcome within an arm/knowledge cell. */
export interface ComparisonRun {
  /** Set only when a missing file outcome is recovered from its terminal session. */
  recoveredFromSessionId?: number;
  assignmentId?: string;
  controlVersion?: string | null;
  taskId: number;
  executionId: number;
  success: boolean;
  costUsd: number;
  durationMs: number;
  /** null when the run succeeded. */
  failureCause: FailureCause | null;
  /** Workflow role the run executed, for live (non-shadow) trial runs. */
  role?: string;
  /**
   * Whether the candidate addendum text was ACTUALLY appended to the prompt.
   * An assignment alone does not prove intervention: the injection can fail
   * (unreadable row, empty text) after the arm was picked, and counting such a
   * run as `candidate` would credit the intervention arm with a run that never
   * saw the intervention.
   */
  injected?: boolean;
  /** Checksum of the addendum text actually injected; null on the control arm. */
  injectedVersion?: string | null;
  /**
   * Model the run actually executed on, for audit. Arm assignment does not
   * stratify by model, so a reader needs this to tell a prompt effect from a
   * routing difference.
   */
  modelName?: string | null;
}

/**
 * One task-phase's assignment to a comparison arm, produced when the role
 * context is built and carried through to the phase's completion so the run
 * can be attributed to the arm (and the exact injected version) it actually
 * ran under.
 */
export interface ComparisonAssignment {
  assignmentId?: string;
  controlVersion?: string | null;
  /** PromptEvolution candidate under trial. */
  promptEvolutionId: number;
  /** Workflow role the candidate targets. */
  role: string;
  /** Arm this phase was assigned to. */
  arm: ComparisonArm;
  /** True only when the addendum text reached the prompt (always false on `current`). */
  injected: boolean;
  /** Checksum of the injected text; null on the control arm or a failed injection. */
  injectedVersion: string | null;
}

/** All shadow runs for one (arm, knowledge) cell. */
export interface ComparisonCell {
  arm: ComparisonArm;
  knowledge: KnowledgeCondition;
  runs: ComparisonRun[];
}

/** Aggregated current-vs-candidate delta for the `with`-knowledge cells. */
export interface ComparisonSummary {
  successRateDelta: number;
  costDelta: number;
  durationDeltaMs: number;
  /** Baseline (current arm) mean duration, used for the duration tolerance check. */
  baselineDurationMs: number;
  /**
   * Baseline (current arm) mean cost. `costDelta` is an ABSOLUTE USD figure,
   * so the cost tolerance can only be applied as a fraction of this — without
   * it a $0.20 tolerance means "5% worse" on an expensive role and "20x worse"
   * on a cheap one (concern #9231).
   */
  baselineCostUsd: number;
  /** Per-arm success rate, kept so the delta's standard error can be computed. */
  currentSuccessRate: number;
  /** Per-arm counted runs (infra failures excluded), for the standard error. */
  currentSampleSize: number;
  /** Per-arm success rate, kept so the delta's standard error can be computed. */
  candidateSuccessRate: number;
  /** Per-arm counted runs (infra failures excluded), for the standard error. */
  candidateSampleSize: number;
  /**
   * Raw per-arm counts. The adoption gate's Fisher exact test needs integer
   * cell counts, not rates: reconstructing them by multiplying a rate back out
   * would reintroduce rounding right where the decision is made.
   */
  currentSuccessCount: number;
  currentFailureCount: number;
  candidateSuccessCount: number;
  candidateFailureCount: number;
  /** Smaller of the two arms' counted runs — the binding sample constraint. */
  sampleSize: number;
  excludedForInfraFailure: number;
  verdict: ComparisonVerdict;
  uncertainty: 'low' | 'medium' | 'high';
}

/** Full persisted comparison record for one PromptEvolution candidate. */
export interface ComparisonRecord {
  promptEvolutionId: number;
  role: string;
  modelName: string;
  budgetUsd: number;
  createdAt: string;
  /** 'in_progress' while shadow runs are still executing; discarded on restart. */
  status: 'in_progress' | 'done';
  sampleTaskIds: number[];
  arms: ComparisonCell[];
  summary: ComparisonSummary | null;
  /** Checksum of the knowledge content injected during the `with` runs, for audit only. */
  knowledgeSnapshotHash: string | null;
  /** Task ids the approved candidate is limited to (set via the /stage endpoint). */
  stagedTaskIds: number[] | null;
}
