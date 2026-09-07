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
  taskId: number;
  executionId: number;
  success: boolean;
  costUsd: number;
  durationMs: number;
  /** null when the run succeeded. */
  failureCause: FailureCause | null;
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
