/**
 * CodexCliAgent — Process Runner: close result construction
 *
 * Decides whether a finished Codex CLI process counts as a success and
 * builds the final AgentExecutionResult from accumulated runner state.
 * Split out of process-runner.ts (task #879) to keep that file under the
 * COMPONENT_SPLITTING_POLICY.md hard line limit, and to give `close`-status
 * decisions (both here and in process-runner.ts's close handler) a single
 * shared source of truth instead of two separately-maintained `code === 0`
 * checks that can drift apart.
 */

import type { AgentExecutionResult, AgentArtifact, GitCommitInfo } from '../base-agent';
import { tolegacyQuestionType } from '../question-detection';
import type { CodexCliAgentConfig } from './types';
import type { ProcessRunnerState } from './process-runner';

/**
 * Whether a closed Codex CLI process counts as a successful execution.
 * A zero exit code alone is not sufficient — an explicit `turn.failed`
 * event (see json-event-handler.ts) overrides it to a failure even when
 * the process itself exits 0.
 */
export function isSuccessfulClose(code: number | null, state: ProcessRunnerState): boolean {
  return code === 0 && !state.turnFailed;
}

/**
 * Build execution result from process close.
 */
export function buildCloseResult(
  code: number | null,
  state: ProcessRunnerState,
  config: CodexCliAgentConfig,
  startTime: number,
  parseArtifacts: (output: string) => AgentArtifact[],
  parseCommits: (output: string) => GitCommitInfo[],
  resourceStats: { cpuTimeMs: number | null; peakRssKb: number | null } = {
    cpuTimeMs: null,
    peakRssKb: null,
  },
): AgentExecutionResult {
  const executionTimeMs = Date.now() - startTime;
  const artifacts = parseArtifacts(state.outputBuffer);
  const commits = parseCommits(state.outputBuffer);
  const { hasQuestion, question, questionKey, questionDetails } = state.detectedQuestion;
  const questionType = tolegacyQuestionType(state.detectedQuestion.questionType);

  if (hasQuestion) {
    return {
      success: true,
      output: state.outputBuffer,
      artifacts,
      commits,
      executionTimeMs,
      waitingForInput: true,
      question,
      questionType,
      questionDetails,
      questionKey,
      claudeSessionId: state.codexSessionId || undefined,
      modelName: state.actualModel || config.model,
      ...resourceStats,
    };
  }

  let errorMessage: string | undefined;
  if (code !== 0) {
    const parts = [`プロセスがコード ${code} で終了しました`];
    if (state.errorBuffer.trim()) parts.push(`\n\n【標準エラー出力】\n${state.errorBuffer.trim()}`);
    if (state.outputBuffer.trim()) parts.push(`\n${state.outputBuffer.trim().slice(-1000)}`);
    errorMessage = parts.join('');
  } else if (state.turnFailed) {
    errorMessage = state.turnFailureMessage
      ? `Codexターンが失敗しました: ${state.turnFailureMessage}`
      : 'Codexターンが失敗しました (turn.failed イベントを受信)';
  }

  return {
    success: isSuccessfulClose(code, state),
    output: state.outputBuffer,
    artifacts,
    commits,
    executionTimeMs,
    waitingForInput: false,
    claudeSessionId: state.codexSessionId || undefined,
    modelName: state.actualModel || config.model,
    errorMessage,
    ...resourceStats,
  };
}
