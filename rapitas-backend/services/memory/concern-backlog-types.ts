/**
 * concern-backlog-types
 *
 * Types, enum constants, and pure normalization helpers for the 懸念バックログ
 * (Concern Backlog). No DB access or filing logic lives here — that stays in
 * concern-backlog-service.ts, which re-exports this module's values for
 * backward compatibility.
 */
import { narrowEnum } from '../../utils/common/type-guards';
import type { RecurrencePolicy } from './concern-recurrence-policy';

/** What kind of concern this is. */
export const CONCERN_TYPES = ['bug', 'refactor', 'security', 'perf', 'other'] as const;
export type ConcernType = (typeof CONCERN_TYPES)[number];

/** How serious / urgent the concern is. */
export const CONCERN_SEVERITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type ConcernSeverity = (typeof CONCERN_SEVERITIES)[number];
/**
 * Lifecycle state of a concern.
 * `resolved` is reached when a concern published to GitHub has its issue closed
 * (status is pulled from GitHub on sync — see markConcernResolved).
 */
export const CONCERN_STATUSES = ['open', 'task_created', 'dismissed', 'resolved'] as const;
export type ConcernStatus = (typeof CONCERN_STATUSES)[number];

/** A GitHub issue a concern was published to / imported from. */
export interface LinkedIssueRef {
  /** GitHubIssue row id (DB), not the issue number. */
  id: number;
  issueNumber: number;
  url: string;
  /** "open" | "closed" */
  state: string;
}

/** Coerces an arbitrary value to a valid concern type (default 'bug'). */
export function normalizeConcernType(value: unknown): ConcernType {
  return narrowEnum(value, CONCERN_TYPES, 'bug');
}
/** Coerces an arbitrary value to a valid severity (default 'medium'). */
export function normalizeConcernSeverity(value: unknown): ConcernSeverity {
  return narrowEnum(value, CONCERN_SEVERITIES, 'medium');
}

/** Severity → numeric weight, used for ordering (higher = surfaces first). */
export const SEVERITY_WEIGHT: Record<ConcernSeverity, number> = {
  urgent: 0.95,
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

export interface ConcernEntry {
  id: number;
  title: string;
  detail: string;
  type: ConcernType;
  severity: ConcernSeverity;
  /** Code location (file / area) the concern refers to, if known. */
  location: string | null;
  status: ConcernStatus;
  /** Origin label ("agent" | "user" | "vuln_scan" | ...). 'unknown' for pre-source rows. */
  source: string;
  /** Task during whose execution the concern was found, if any. */
  originTaskId: number | null;
  /** Task created from this concern, if converted. */
  createdTaskId: number | null;
  themeId: number | null;
  createdAt: Date;
  /** GitHub issue this concern was published to / imported from, if any. */
  linkedIssue?: LinkedIssueRef | null;
}

export interface SubmitConcernInput {
  title: string;
  detail: string;
  type?: ConcernType;
  severity?: ConcernSeverity;
  location?: string;
  /** Origin: the task being implemented when the concern was spotted. */
  originTaskId?: number;
  themeId?: number;
  /** Origin label: "agent" | "user" | "code_review" | ... */
  source?: string;
  /**
   * Stable de-duplication key. When set, duplicates are detected by this key
   * alone instead of title+detail — use it when the detail carries volatile
   * parts (stack traces, counts, ids) that would otherwise let the same
   * root-cause concern be filed repeatedly. / 同一原因の重複登録を防ぐ安定キー。
   */
  dedupKey?: string;
  recurrencePolicy?: RecurrencePolicy;
}

/**
 * Whether `submitConcern` created a new row, pointed the caller at an
 * existing one it merged into, or suppressed the filing entirely (anti-
 * monoculture). Lets callers (HTTP route, GitHub sync) tell a real filing
 * apart from a no-op instead of reading a bare id (#888).
 */
export const CONCERN_FILING_OUTCOMES = ['created', 'reused', 'suppressed'] as const;
export type ConcernFilingOutcome = (typeof CONCERN_FILING_OUTCOMES)[number];

/** Detailed reason behind a ConcernFilingOutcome, for logs/UI. */
export const CONCERN_FILING_REASONS = [
  'new',
  'recurrence-of-done',
  'dedup-live-duplicate',
  'recurrence-merged-open',
  'near-duplicate',
  'theme-saturation',
] as const;
export type ConcernFilingReason = (typeof CONCERN_FILING_REASONS)[number];

/** Result of `submitConcern`: the anchoring/created row id plus how it got there. */
export interface ConcernFilingResult {
  id: number;
  outcome: ConcernFilingOutcome;
  reason: ConcernFilingReason;
}
