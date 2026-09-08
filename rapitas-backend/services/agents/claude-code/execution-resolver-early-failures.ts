/**
 * ExecutionResolverEarlyFailures
 *
 * Pure regex predicates execution-resolver.ts runs against the combined
 * output/error buffer BEFORE the generic exit-code failure path, so a handful
 * of well-known CLI failure signatures (model mismatch, auth failure, API
 * overload, prompt-too-long) get a clear cause instead of being swallowed by
 * a generic "process exited with code N" failure. Extracted from
 * execution-resolver.ts unchanged (regex and semantics) purely to keep that
 * file under the 500-line hard limit before adding a new predicate. Not
 * responsible for building the resolved AgentExecutionResult — see
 * execution-resolver.ts.
 */

/**
 * Detects Claude Code's "selected model is invalid" message — printed when
 * SmartRouter picks an OpenAI/codex model id for a claude-code agent.
 *
 * @param blob - Combined stdout + stderr buffer. / 標準出力とエラー出力の結合バッファ
 * @returns true when the model-mismatch message is present. / モデル不一致メッセージがあれば true
 */
export function detectModelMismatch(blob: string): boolean {
  return /There'?s an issue with the selected model.*Run --model to pick a different/i.test(blob);
}

/**
 * Detects a Claude CLI authentication failure (expired/invalid credentials).
 *
 * @param blob - Combined stdout + stderr buffer. / 標準出力とエラー出力の結合バッファ
 * @returns true when an authentication-failure message is present. / 認証失敗メッセージがあれば true
 */
export function detectAuthFailure(blob: string): boolean {
  return /Invalid authentication credentials|Failed to authenticate|API\s*Error:?\s*401|OAuth token (?:has )?expired|Please run\s+\/login/i.test(
    blob,
  );
}

/**
 * Detects an UNRECOVERED API 529 overload — only meaningful when the process
 * was also force-killed for idling (a 529 that was retried and recovered
 * exits cleanly and never reaches this check).
 *
 * @param blob - Combined stdout + stderr buffer. / 標準出力とエラー出力の結合バッファ
 * @param idleTimeoutForceKilled - Whether the process was force-killed for idling. / アイドルハングでforce-killされたか
 * @returns true when an unrecovered 529 overload is present. / 未回復の529過負荷があれば true
 */
export function detectApiOverload(blob: string, idleTimeoutForceKilled: boolean): boolean {
  return (
    idleTimeoutForceKilled && /API\s*Error:?\s*529|529\s+Overloaded|overloaded_error/i.test(blob)
  );
}

/**
 * Detects Claude Code CLI reporting the prompt/accumulated session context
 * was too long (task 900, task 894: confirmed real text "Prompt is too
 * long"). Distinct from auth/transient failures — `--resume` against the same
 * session will very likely repeat this failure regardless of retry.
 *
 * @param blob - Combined stdout + stderr buffer. / 標準出力とエラー出力の結合バッファ
 * @returns true when a prompt/context-too-long message is present. / 入力長超過メッセージがあれば true
 */
export function detectPromptTooLong(blob: string): boolean {
  return /Prompt is too long|input is too long|context length exceeded|maximum context length/i.test(
    blob,
  );
}
