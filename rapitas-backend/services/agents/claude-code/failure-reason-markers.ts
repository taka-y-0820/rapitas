/**
 * FailureReasonMarkers
 *
 * Single source of truth for the substrings that tag an `AgentExecution.errorMessage`
 * with its failure category (input-length overflow / authentication / transient
 * provider overload), plus the classifier that reads those tags back out. Not
 * responsible for detecting the underlying CLI output patterns that cause a
 * failure (see execution-resolver-early-failures.ts) — only for the shared
 * vocabulary used to tag and later re-classify `errorMessage` strings.
 */

/**
 * Tag execution-resolver.ts adds to `errorMessage` when the Claude Code CLI
 * reported the prompt/context was too long. No equivalent tag existed before
 * task 900 — this is a brand-new marker.
 */
export const PROMPT_TOO_LONG_MARKER = '【Prompt Too Long】';

/**
 * The EXISTING fixed Japanese string execution-resolver.ts already uses for
 * an authentication failure (`authFailureHit`). Referenced here as-is rather
 * than introducing a new bracketed tag, so the established errorMessage text
 * (and execution-resolver.test.ts's assertions against it) never changes.
 */
export const AUTH_FAILURE_MARKER = 'Claude CLI の認証に失敗しました';

/**
 * The EXISTING tag execution-resolver.ts already adds for an unrecovered API
 * 529 overload (`apiOverloadHit`). Referenced here as-is.
 */
export const API_OVERLOAD_MARKER = '【API Overload】';

/** Failure reason a resume/cold-start decision can branch on. */
export type SessionFailureReason = 'prompt_too_long' | 'auth' | 'transient' | 'other';

/**
 * Classify a persisted `AgentExecution.errorMessage` by which marker it
 * carries. Used to decide whether a session with a recent failed resume is
 * still eligible to resume (auth / transient) or must cold-start
 * (prompt_too_long / other — the safe default from the pre-existing guard).
 *
 * @param errorMessage - Persisted error message, or null/undefined if none. / 保存済みのエラーメッセージ
 * @returns The classified reason. / 分類された理由
 */
export function classifySessionFailureReason(
  errorMessage: string | null | undefined,
): SessionFailureReason {
  if (!errorMessage) return 'other';
  if (errorMessage.includes(PROMPT_TOO_LONG_MARKER)) return 'prompt_too_long';
  if (errorMessage.includes(AUTH_FAILURE_MARKER)) return 'auth';
  if (errorMessage.includes(API_OVERLOAD_MARKER)) return 'transient';
  return 'other';
}
