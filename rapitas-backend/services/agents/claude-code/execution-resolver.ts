/**
 * execution-resolver
 *
 * Builds the post-parse resolution callback that decides whether a Claude
 * Code execution succeeded, failed, was interrupted, or is waiting for
 * input. Extracted from agent-core.ts to keep that file under the 500-line
 * per-file limit. Data-driven: receives the agent's mutable state via a
 * `ResolverContext` and the bound `resolve()` callback from the outer
 * Promise. All status mutations go through `ctx.status = ...`.
 */
import { tolegacyQuestionType } from '../question-detection';
import type { QuestionWaitingState } from '../question-detection';
import type { AgentArtifact, AgentExecutionResult, GitCommitInfo } from '../base-agent';
import { checkGitDiff } from './git-diff-checker';
import { createLogger } from '../../../config/logger';
import { notifyAuthenticationFailure } from '../../communication/notification-service';
import type { WorkerResultUsageSnapshot } from './worker-message-handler';
import {
  detectApiOverload,
  detectAuthFailure,
  detectModelMismatch,
  detectPromptTooLong,
} from './execution-resolver-early-failures';
import { PROMPT_TOO_LONG_MARKER } from './failure-reason-markers';

const logger = createLogger('claude-code-agent');

/** Read/write state the resolver needs from the host agent. */
export interface ResolverContext {
  readonly logPrefix: string;
  readonly resumeSessionId: string | undefined;
  readonly continueConversation: boolean | undefined;

  outputBuffer: string;
  /** Clean FINAL assistant message from the stream-json `result` event. */
  finalResultText: string;
  errorBuffer: string;
  lineBuffer: string;
  detectedQuestion: QuestionWaitingState;
  claudeSessionId: string | null;
  hasFileModifyingToolCalls: boolean;
  idleTimeoutForceKilled: boolean;
  wallClockTimeoutForceKilled: boolean;
  workerResultUsage: WorkerResultUsageSnapshot | null;

  // Mutated by the resolver
  status: string;

  // BaseAgent emit proxy
  emitOutputInternal(output: string, isError?: boolean): void;
}

/**
 * Build the resolution callback used after the Worker finishes parsing.
 * Determines success/failure based on question detection, exit code, and git diff.
 *
 * @param ctx - Mutable agent state + emitter callback. / 状態とコールバック
 * @param code - Process exit code / プロセス終了コード
 * @param workDir - Working directory for git diff check / git diffチェック用の作業ディレクトリ
 * @param startTime - Execution start timestamp / 実行開始タイムスタンプ
 * @param resolve - Promise resolver from execute() / execute()のPromiseリゾルバー
 * @param getArtifacts - Lazy getter for the parsed artifacts / アーティファクト取得
 * @param getCommits - Lazy getter for the parsed commits / コミット取得
 * @param checkPlanCreated - Whether a plan was saved awaiting approval (so "no
 *   code changes" is a pause, not a failure). / 承認待ちのプラン作成有無
 * @param investigationMode - Skip the git-diff check and succeed on meaningful
 *   output (mirrors the codex contract). Empty output falls through to the
 *   no-change failure path. / 有意な出力があれば成功、空ならフォールスルー
 * @returns Callback to invoke after Worker finishes / Worker終了後に呼び出すコールバック
 */
export function buildResolveAfterParse(
  ctx: ResolverContext,
  code: number | null,
  workDir: string,
  startTime: number,
  resolve: (result: AgentExecutionResult) => void,
  getArtifacts: () => AgentArtifact[],
  getCommits: () => GitCommitInfo[],
  checkPlanCreated?: () => Promise<boolean>,
  investigationMode?: boolean,
  resourceStats?: { cpuTimeMs: number | null; peakRssKb: number | null },
): () => void {
  return () => {
    const artifacts = getArtifacts();
    const commits = getCommits();
    const executionTimeMs = Date.now() - startTime;
    const usage = ctx.workerResultUsage;
    // The clean final assistant message — investigation phases save this
    // instead of the noisy concatenated outputBuffer. Folded into usageFields
    // so every resolve() path below carries it.
    const finalMessage = ctx.finalResultText?.trim() || undefined;
    /** Spread real-cost fields (from stream-json `result`) into the resolved value. */
    const usageFields: Partial<AgentExecutionResult> = {
      ...(usage
        ? {
            costUsd: usage.costUsd,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            modelName: usage.modelName,
            tokensUsed:
              (usage.inputTokens ?? 0) +
              (usage.outputTokens ?? 0) +
              (usage.cacheReadInputTokens ?? 0) +
              (usage.cacheCreationInputTokens ?? 0),
            // NOTE: num_turns from stream-json result = total assistant LLM calls for this CLI session.
            llmCallCount: usage.numTurns,
            finalMessage,
          }
        : { finalMessage }),
      // Resource telemetry (task #714) — merged unconditionally (even when
      // sampling never captured a value) so every resolve() branch below
      // carries the same keys via `...usageFields`, matching the waitingForInput
      // exception noted in plan.md (the sampler is stopped before close, so a
      // value is already final by the time any branch runs).
      cpuTimeMs: resourceStats?.cpuTimeMs ?? null,
      peakRssKb: resourceStats?.peakRssKb ?? null,
    };

    // Tags the fact of a wall-clock kill (regardless of success/failure below) so
    // downstream fallback-decision logic can skip provider-error classification —
    // a wall-clock kill is not evidence of a provider issue (task 546).
    const forceKillFields: Partial<AgentExecutionResult> = ctx.wallClockTimeoutForceKilled
      ? { failureType: 'wall_clock_timeout' }
      : {};

    logger.info(`${ctx.logPrefix} Running question detection...`);
    logger.info(
      { detectedQuestion: ctx.detectedQuestion },
      `${ctx.logPrefix} detectedQuestion from stream`,
    );

    const hasQuestion = ctx.detectedQuestion.hasQuestion;
    const question = ctx.detectedQuestion.question;
    const questionKey = ctx.detectedQuestion.questionKey;
    const questionDetails = ctx.detectedQuestion.questionDetails;
    const questionType = tolegacyQuestionType(ctx.detectedQuestion.questionType);

    logger.info(
      `${ctx.logPrefix} Final question detection - hasQuestion: ${hasQuestion}, questionType: ${questionType}, questionKey: ${JSON.stringify(questionKey)}, exitCode: ${code}`,
    );

    // Detect Claude Code's "selected model is invalid" message early so the
    // execution is reported as failed instead of slipping through as a 1.3s
    // success (SmartRouter picked an OpenAI/codex model id for a claude-code
    // agent). The combined output is short and would otherwise pass the exit-code check.
    const modelMismatchHit = detectModelMismatch(ctx.outputBuffer + '\n' + ctx.errorBuffer);
    if (modelMismatchHit) {
      logger.error(
        { logPrefix: ctx.logPrefix, executionTimeMs },
        '[claude-code] Model rejected by CLI — likely a provider/agent mismatch (e.g. codex-* model passed to claude-code). Failing fast.',
      );
      ctx.status = 'failed';
      resolve({
        success: false,
        output: ctx.outputBuffer,
        artifacts,
        commits,
        executionTimeMs,
        waitingForInput: false,
        claudeSessionId: ctx.claudeSessionId || undefined,
        errorMessage:
          'Claude Code rejected the selected model. The orchestrator picked a model from a different provider (likely codex-/gpt- family) and routed it to a claude-code agent. Re-run after the role-resolver agent-switch lands; if the issue persists check WorkflowRoleConfig.preferredProviderOverride for this role.',
        ...usageFields,
        ...forceKillFields,
      });
      return;
    }

    // Detect a Claude CLI authentication failure BEFORE the generic exit-code
    // path — otherwise it silently burns retries across every queued task
    // (observed: task 322 failed ~12x, $6.17 in-flight). Fire a deduplicated
    // notification so the user knows to re-authenticate; fire-and-forget so a
    // notify error never blocks resolve().
    const authFailureHit = detectAuthFailure(ctx.outputBuffer + '\n' + ctx.errorBuffer);
    if (authFailureHit) {
      logger.error(
        { logPrefix: ctx.logPrefix, executionTimeMs },
        '[claude-code] Authentication failed (expired/invalid credentials). Failing fast and notifying the user to re-authenticate.',
      );
      void notifyAuthenticationFailure().catch(() => {});
      ctx.status = 'failed';
      resolve({
        success: false,
        output: ctx.outputBuffer,
        artifacts,
        commits,
        executionTimeMs,
        waitingForInput: false,
        claudeSessionId: ctx.claudeSessionId || undefined,
        errorMessage:
          'Claude CLI の認証に失敗しました（認証情報の期限切れ/無効）。統合ターミナルで `claude login`（またはこのセッションで /login）を実行して再認証してください。再認証後、ブロックされたタスクは自動で再試行されます。',
        ...usageFields,
        ...forceKillFields,
      });
      return;
    }

    // Detect the CLI reporting the prompt/session context was too long (task
    // 894: "Prompt is too long"). --resume of the SAME session reloads the
    // already-too-large transcript, so it would repeat this failure —
    // tagged so phase-session-resume.ts / execution-resume.ts stop resuming it.
    const promptTooLongHit = detectPromptTooLong(ctx.outputBuffer + '\n' + ctx.errorBuffer);
    if (promptTooLongHit) {
      logger.error(
        { logPrefix: ctx.logPrefix, executionTimeMs },
        '[claude-code] Prompt/context too long — failing fast so the session is excluded from future resumes.',
      );
      ctx.status = 'failed';
      resolve({
        success: false,
        output: ctx.outputBuffer,
        artifacts,
        commits,
        executionTimeMs,
        waitingForInput: false,
        claudeSessionId: ctx.claudeSessionId || undefined,
        failureType: 'prompt_too_long',
        errorMessage: `${PROMPT_TOO_LONG_MARKER}Claude Code CLI reported the prompt/context was too long (exit code ${code}). The session's accumulated transcript has likely exceeded the model's context window — resuming this same session via --resume will very likely repeat this failure. Cold-start with a short structured handoff instead.`,
        ...usageFields,
        ...forceKillFields,
      });
      return;
    }

    // NOTE: When a question is detected, enter waiting_for_input regardless of exit code.
    // Claude Code may exit with non-zero even after outputting a question.
    if (hasQuestion) {
      ctx.status = 'waiting_for_input';
      logger.info(`${ctx.logPrefix} Setting status to waiting_for_input (exitCode: ${code})`);
      logger.info(
        `${ctx.logPrefix} Question detected (${questionType}): ${question.substring(0, 200)}`,
      );
      logger.info({ questionKey }, `${ctx.logPrefix} Question key`);
      logger.info(`${ctx.logPrefix} Session ID for resume: ${ctx.claudeSessionId}`);
      ctx.emitOutputInternal(`\n${ctx.logPrefix} Waiting for answer...\n`);
      resolve({
        success: true, // Technically successful but not complete
        output: ctx.outputBuffer,
        artifacts,
        commits,
        executionTimeMs,
        waitingForInput: true,
        question,
        questionType,
        questionDetails,
        questionKey,
        claudeSessionId: ctx.claudeSessionId || undefined,
        ...usageFields,
        ...forceKillFields,
      });
      return;
    }

    // Build a detailed error message on failure
    let errorMessage: string | undefined;
    if (code !== 0) {
      const errorParts: string[] = [];
      errorParts.push(`Process exited with code ${code}`);

      if (ctx.resumeSessionId) {
        // NOTE: Neutral label only — asserting "session expired" caused false-positive SESSION_FAILURE_RE matches.
        errorParts.push(`\n\n【Session Resume Mode】Session ID: ${ctx.resumeSessionId}`);
      } else if (ctx.continueConversation) {
        errorParts.push(`\n\n【Conversation Continue Mode】\nUsing --continue flag`);
      }

      if (ctx.errorBuffer.trim()) {
        errorParts.push(`\n\n【Standard Error Output】\n${ctx.errorBuffer.trim()}`);
      }

      if (ctx.outputBuffer.trim()) {
        errorParts.push(`\n${ctx.outputBuffer.trim().slice(-1000)}`);
      }

      if (ctx.lineBuffer.trim()) {
        errorParts.push(`\n\n【Unprocessed Buffer】\n${ctx.lineBuffer.trim().slice(-500)}`);
      }

      // NOTE: Neutral short-execution warning — asserting session failure here fed SESSION_FAILURE_RE false positives
      if (executionTimeMs < 10000) {
        errorParts.push(`\n\n【Warning】Execution time of ${executionTimeMs}ms is very short.`);
      }

      errorMessage = errorParts.join('');
      logger.info(
        `${ctx.logPrefix} Detailed error message constructed (${errorMessage.length} chars)`,
      );
    }

    // Return as failure on error exit, unless the process was force-killed due to idle hang
    if (code !== 0 && !ctx.idleTimeoutForceKilled) {
      logger.info(
        `${ctx.logPrefix} No question detected, setting status to failed (exitCode: ${code})`,
      );
      ctx.status = 'failed';
      resolve({
        success: false,
        output: ctx.outputBuffer,
        artifacts,
        commits,
        executionTimeMs,
        waitingForInput: false,
        claudeSessionId: ctx.claudeSessionId || undefined,
        errorMessage,
        ...usageFields,
        ...forceKillFields,
      });
      return;
    }

    // A force-kill after an UNRECOVERED API overload is a real failure, not a
    // benign "finished work then hung" exit (observed: "[Result: success]" +
    // exit 1 + "API Error: 529 Overloaded"). A 529 that was retried and
    // RECOVERED (clean exit) is unaffected — gated on the force-kill path only.
    const apiOverloadHit = detectApiOverload(
      ctx.outputBuffer + '\n' + ctx.errorBuffer,
      ctx.idleTimeoutForceKilled,
    );
    if (apiOverloadHit) {
      logger.error(
        `${ctx.logPrefix} Force-killed after an unrecovered API overload (529). Failing so the phase retries instead of being marked complete on partial output.`,
      );
      ctx.status = 'failed';
      resolve({
        success: false,
        output: ctx.outputBuffer,
        artifacts,
        commits,
        executionTimeMs,
        waitingForInput: false,
        claudeSessionId: ctx.claudeSessionId || undefined,
        errorMessage: `${errorMessage ?? `Process exited with code ${code}`}\n\n【API Overload】Provider returned 529 Overloaded and retries were exhausted; the run did not complete.`,
        ...usageFields,
        ...forceKillFields,
      });
      return;
    }

    if (ctx.idleTimeoutForceKilled) {
      logger.info(
        `${ctx.logPrefix} Process was force-killed due to idle hang (exitCode: ${code}). Proceeding to git diff check for completion determination.`,
      );
    }

    // investigation mode (research/plan/review): file mutation is blocked by
    // --disallowedTools, so git diff is ALWAYS empty by design. Skipping the
    // diff check here prevents a successful read-only phase from being reported
    // as a "no code changes" failure (which fired a spurious ERROR log + daily
    // false concern). Mirrors the codex contract (success === exit 0).
    if (investigationMode) {
      const hasMeaningfulOutput =
        (finalMessage?.length ?? 0) > 0 || ctx.outputBuffer.trim().length >= 200;
      if (hasMeaningfulOutput) {
        logger.info(
          `${ctx.logPrefix} Investigation mode: meaningful output present, resolving as success (skipping git diff check)`,
        );
        ctx.status = 'completed'; // determineExecutionStatus remaps to post_processing for investigation
        resolve({
          success: true,
          output: ctx.outputBuffer,
          artifacts,
          commits,
          executionTimeMs,
          waitingForInput: false,
          claudeSessionId: ctx.claudeSessionId || undefined,
          ...usageFields,
          ...forceKillFields,
        });
        return;
      }
      // empty output → fall through to the existing no-change failure path
      logger.info(
        `${ctx.logPrefix} Investigation mode: output is empty, falling through to no-change failure path`,
      );
    }

    // NOTE: On success (code === 0) or idle-hang kill, verify actual changes via git diff.
    // File-modifying tools (Write/Edit) may have been called in plan mode (EnterPlanMode)
    // or via sub-agents (Task) without actually modifying files.
    logger.info(`${ctx.logPrefix} Process exited successfully, verifying actual code changes...`);
    logger.info(`${ctx.logPrefix} hasFileModifyingToolCalls: ${ctx.hasFileModifyingToolCalls}`);

    checkGitDiff(workDir, ctx.logPrefix)
      .then(async (hasChanges) => {
        if (hasChanges) {
          logger.info(`${ctx.logPrefix} Git diff confirmed changes, setting status to completed`);
          ctx.status = 'completed';
          resolve({
            success: true,
            output: ctx.outputBuffer,
            artifacts,
            commits,
            executionTimeMs,
            waitingForInput: false,
            claudeSessionId: ctx.claudeSessionId || undefined,
            ...usageFields,
            ...forceKillFields,
          });
        } else if (ctx.hasFileModifyingToolCalls) {
          // NOTE: File-modifying tools were used but not reflected in git diff
          // (rare case, e.g. agent committed & reset). Trust tool usage as completed.
          logger.info(
            `${ctx.logPrefix} No git changes but file-modifying tools were used, setting status to completed`,
          );
          ctx.status = 'completed';
          resolve({
            success: true,
            output: ctx.outputBuffer,
            artifacts,
            commits,
            executionTimeMs,
            waitingForInput: false,
            claudeSessionId: ctx.claudeSessionId || undefined,
            ...usageFields,
            ...forceKillFields,
          });
        } else if (checkPlanCreated && (await checkPlanCreated().catch(() => false))) {
          // A plan was saved and the task is awaiting approval. The agent
          // correctly stopped at the approval gate, so this is a successful
          // pause — not a failure. The approval workflow drives the next step.
          logger.info(
            `${ctx.logPrefix} No code changes, but a plan was created — awaiting approval (treating as success, not failure)`,
          );
          ctx.status = 'completed';
          resolve({
            success: true,
            output: ctx.outputBuffer,
            artifacts,
            commits,
            executionTimeMs,
            waitingForInput: false,
            claudeSessionId: ctx.claudeSessionId || undefined,
            ...usageFields,
            ...forceKillFields,
          });
        } else {
          // Only planning was done — no implementation
          logger.info(
            `${ctx.logPrefix} No git changes and no file-modifying tools used - agent likely only planned without implementing`,
          );
          ctx.status = 'failed';
          resolve({
            success: false,
            output: ctx.outputBuffer,
            artifacts,
            commits,
            executionTimeMs,
            waitingForInput: false,
            claudeSessionId: ctx.claudeSessionId || undefined,
            errorMessage:
              'Agent output a plan but no actual code changes were made. Please review the prompt and re-execute.',
            ...usageFields,
            ...forceKillFields,
          });
        }
      })
      .catch((err) => {
        logger.warn({ err }, `${ctx.logPrefix} Git diff check failed`);
        if (ctx.hasFileModifyingToolCalls) {
          // File-modifying tools were used — likely implemented
          logger.info(
            `${ctx.logPrefix} Git diff failed but file-modifying tools were used, setting status to completed`,
          );
          ctx.status = 'completed';
          resolve({
            success: true,
            output: ctx.outputBuffer,
            artifacts,
            commits,
            executionTimeMs,
            waitingForInput: false,
            claudeSessionId: ctx.claudeSessionId || undefined,
            ...usageFields,
            ...forceKillFields,
          });
        } else {
          // No file-modifying tools used — treat as failure
          logger.info(
            `${ctx.logPrefix} Git diff failed and no file-modifying tools used, setting status to failed`,
          );
          ctx.status = 'failed';
          resolve({
            success: false,
            output: ctx.outputBuffer,
            artifacts,
            commits,
            executionTimeMs,
            waitingForInput: false,
            claudeSessionId: ctx.claudeSessionId || undefined,
            errorMessage:
              'Could not verify agent execution results. Code changes cannot be confirmed.',
            ...usageFields,
            ...forceKillFields,
          });
        }
      });
  };
}
