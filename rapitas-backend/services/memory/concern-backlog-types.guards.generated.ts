/**
 * concern-backlog-types.guards.generated
 *
 * 自動生成ファイル — 手動編集不可。再生成: `bun run gen:type-guards`
 * ソース: scripts/gen-type-guards.ts
 *
 * 命名規約:
 *   is*     — 型ガード: unknown 値が対象型かを boolean で返す
 *   narrow* — narrowing: DB 等からの raw string を対象型へ変換し、不正値を fallback で返す
 */

import type {
  ConcernType,
  ConcernSeverity,
  ConcernStatus,
  ConcernFilingOutcome,
  ConcernFilingReason,
} from './concern-backlog-types';
import {
  CONCERN_TYPES,
  CONCERN_SEVERITIES,
  CONCERN_STATUSES,
  CONCERN_FILING_OUTCOMES,
  CONCERN_FILING_REASONS,
} from './concern-backlog-types';

import { isOneOf } from '../../utils/common/type-guards';

/**
 * Type guard: narrows an unknown value to ConcernType.
 *
 * @param s - Value to test. / 検査する値
 * @returns True when `s` is a valid ConcernType. / 有効なConcernTypeの場合true
 */
export function isConcernType(s: unknown): s is ConcernType {
  return isOneOf(s, CONCERN_TYPES);
}

/**
 * Type guard: narrows an unknown value to ConcernSeverity.
 *
 * @param s - Value to test. / 検査する値
 * @returns True when `s` is a valid ConcernSeverity. / 有効なConcernSeverityの場合true
 */
export function isConcernSeverity(s: unknown): s is ConcernSeverity {
  return isOneOf(s, CONCERN_SEVERITIES);
}

/**
 * Type guard: narrows an unknown value to ConcernStatus.
 *
 * @param s - Value to test. / 検査する値
 * @returns True when `s` is a valid ConcernStatus. / 有効なConcernStatusの場合true
 */
export function isConcernStatus(s: unknown): s is ConcernStatus {
  return isOneOf(s, CONCERN_STATUSES);
}

/**
 * Narrows a DB string (or null/undefined) to ConcernStatus, returning a fallback
 * when the value is absent or unrecognised.
 *
 * @param s - Raw value from the database. / DBからの生の値
 * @param fallback - Value to return when `s` is invalid. Defaults to `'open'`. / 無効時に返す値
 * @returns A valid ConcernStatus. / 有効なConcernStatus
 */
export function narrowConcernStatus(
  s: string | null | undefined,
  fallback: ConcernStatus = 'open',
): ConcernStatus {
  return isConcernStatus(s) ? s : fallback;
}

/**
 * Type guard: narrows an unknown value to ConcernFilingOutcome.
 *
 * @param s - Value to test. / 検査する値
 * @returns True when `s` is a valid ConcernFilingOutcome. / 有効なConcernFilingOutcomeの場合true
 */
export function isConcernFilingOutcome(s: unknown): s is ConcernFilingOutcome {
  return isOneOf(s, CONCERN_FILING_OUTCOMES);
}

/**
 * Narrows a DB string (or null/undefined) to ConcernFilingOutcome, returning a fallback
 * when the value is absent or unrecognised.
 *
 * @param s - Raw value from the database. / DBからの生の値
 * @param fallback - Value to return when `s` is invalid. Defaults to `'created'`. / 無効時に返す値
 * @returns A valid ConcernFilingOutcome. / 有効なConcernFilingOutcome
 */
export function narrowConcernFilingOutcome(
  s: string | null | undefined,
  fallback: ConcernFilingOutcome = 'created',
): ConcernFilingOutcome {
  return isConcernFilingOutcome(s) ? s : fallback;
}

/**
 * Type guard: narrows an unknown value to ConcernFilingReason.
 *
 * @param s - Value to test. / 検査する値
 * @returns True when `s` is a valid ConcernFilingReason. / 有効なConcernFilingReasonの場合true
 */
export function isConcernFilingReason(s: unknown): s is ConcernFilingReason {
  return isOneOf(s, CONCERN_FILING_REASONS);
}

/**
 * Narrows a DB string (or null/undefined) to ConcernFilingReason, returning a fallback
 * when the value is absent or unrecognised.
 *
 * @param s - Raw value from the database. / DBからの生の値
 * @param fallback - Value to return when `s` is invalid. Defaults to `'new'`. / 無効時に返す値
 * @returns A valid ConcernFilingReason. / 有効なConcernFilingReason
 */
export function narrowConcernFilingReason(
  s: string | null | undefined,
  fallback: ConcernFilingReason = 'new',
): ConcernFilingReason {
  return isConcernFilingReason(s) ? s : fallback;
}
