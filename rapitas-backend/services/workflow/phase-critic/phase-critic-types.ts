/**
 * Phase Critic Types
 *
 * Shared types for the research/plan critic gate. Types only — no runtime logic.
 */

/** Which workflow artifact is being critiqued. */
export type CriticPhase = 'research' | 'plan';

/** One critic lens's verdict on the artifact. */
export interface CriticVerdict {
  /** The lens that produced this verdict (e.g. 'completeness'). */
  lens: string;
  /** True when the artifact is acceptable from this lens. */
  pass: boolean;
  /** 0..100 how serious the problems are (0 when pass). */
  severity: number;
  /** Concrete issues the downstream phase must address. */
  issues: string[];
}

/** Aggregated verdict across all lenses. */
export interface PhaseCritiqueResult {
  /** 'fail' bounces the phase; 'pass' proceeds; 'unknown' = critics unavailable (fail-open). */
  verdict: 'pass' | 'fail' | 'unknown';
  /** Highest severity seen. */
  severity: number;
  /** De-duplicated issues from the failing lenses (bounded). */
  reasons: string[];
  /** True when the critic judged with part of its input truncated (task 911). */
  inputTruncated?: boolean;
  /** False when any lens failed; partial verdicts are not full evaluation evidence. */
  evaluationComplete?: boolean;
}
