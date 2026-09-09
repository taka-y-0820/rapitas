/**
 * fallback-decision
 *
 * Decides whether a finished agent execution needs a fallback (re-run on a
 * different provider). Extracted from task-executor.ts (file-size policy).
 * Not responsible for picking the fallback agent or running it.
 */
import type { AgentExecutionResult } from '../base-agent';
import { createLogger } from '../../../config/logger';

const logger = createLogger('task-executor');

/**
 * Check if execution needs fallback based on result and output.
 *
 * @param result - Final agent execution result. / エージェント実行結果
 * @param agentType - Agent type that produced the result. / 実行エージェント種別
 * @param disableFallback - Skip the provider-error scan on success. / 成功時スキャンの無効化
 * @param executionId - Execution id for log correlation. / ログ相関用の実行ID
 * @returns Fallback decision and the scanned error blob. / 判定と対象エラーブロブ
 */
export async function checkNeedsFallback(
  result: AgentExecutionResult,
  agentType: string,
  disableFallback?: boolean,
  executionId?: number,
): Promise<{ needsFallback: boolean; errorBlob: string }> {
  const successOutput = typeof result.output === 'string' ? result.output : '';
  const errorBlob = `${result.errorMessage ?? ''}\n${successOutput.slice(-4000)}`;

  // NOTE: A wall-clock force-kill is a budget decision by our own idle-monitor,
  // never provider evidence — bail out BEFORE the unconditional `!result.success`
  // fallback below (the kill can resolve as either success or failure) so no
  // provider gets classified/cooled down for it (task 546; task 545 saw gemini
  // cooled down after a claude-code wall-clock kill was misread as rate_limit).
  if (result.failureType === 'wall_clock_timeout') {
    return { needsFallback: false, errorBlob };
  }

  // NOTE: A cancelled execution (user stop or wall-clock self-termination) is an
  // intentional stop, not provider evidence — starting a fallback agent for it
  // would run an agent the user/system deliberately halted (#808).
  if (result.failureType === 'cancelled') {
    return { needsFallback: false, errorBlob };
  }

  // NOTE: A prompt-too-long failure is a request-size problem, not provider
  // evidence — falling back to a different provider would neither fix the
  // oversized session context nor deserve a provider cooldown (task 900).
  // Short-circuits BEFORE classifyAgentError so a resume-mode "Prompt is too
  // long" failure never triggers the diagnoseErrorWithLlm cost either.
  if (result.failureType === 'prompt_too_long') {
    return { needsFallback: false, errorBlob };
  }

  let needsFallback = !result.success;

  // Successful prose/code may legitimately discuss 429 or provider limits.
  // Only explicit error metadata can contradict success; never scan task output.
  if (!needsFallback && !disableFallback && result.errorMessage?.trim()) {
    const { classifyAgentError } = await import('../../ai/agent-error-classifier');
    const { agentTypeToProvider } = await import('../../ai/agent-fallback');
    const hint = agentTypeToProvider(agentType) ?? undefined;
    const classified = classifyAgentError(result.errorMessage, { hint, strict: true });

    if (classified?.retryWithFallback) {
      needsFallback = true;
      logger.warn(
        {
          executionId,
          agentType,
          classifiedAs: classified.reason,
          providerImplicated: classified.provider,
        },
        '[TaskExecutor] Detected provider error in successful output — forcing fallback',
      );
    }
  }

  return { needsFallback, errorBlob };
}
