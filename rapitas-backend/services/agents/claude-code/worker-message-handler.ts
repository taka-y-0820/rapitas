/**
 * worker-message-handler
 *
 * Pure(ish) handler for messages emitted by the output-parser Worker
 * thread. Extracted from agent-core.ts to keep that file under the
 * 500-line per-file limit. The handler operates on a `WorkerMessageContext`
 * — an interface implemented by `ClaudeCodeAgent` — so this module does
 * not import the class directly and there is no circular dependency.
 */
import type { ChildProcess } from 'child_process';
import { updateWaitingStateFromDetection, tolegacyQuestionType } from '../question-detection';
import type { QuestionWaitingState } from '../question-detection';
import type { WorkerOutputMessage, WorkerInputMessage } from '../../../workers/output-parser-types';
import { createLogger } from '../../../config/logger';
import { pickPrimaryModel } from './model-attribution';
import type { AgentArtifact, AgentExecutionResult, GitCommitInfo } from '../base-agent';

/**
 * Snapshot of the stream-json `result` event captured by the parser worker.
 * Mirrors `WorkerResultEvent` minus the display fields.
 */
export interface WorkerResultUsageSnapshot {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Model id with the largest token share in `modelUsage`. */
  modelName?: string;
  /** Total assistant turns (= LLM API calls) reported by stream-json `result.num_turns`. */
  numTurns?: number;
}

const logger = createLogger('claude-code-agent');
// Records actual incoming activity, never a timer-generated claim of progress.
const lastThinkingEmission = new WeakMap<WorkerMessageContext, number>();
const THINKING_ACTIVITY_INTERVAL_MS = 30_000;

/**
 * Mutable state and callbacks the Worker message handler needs to
 * touch on the host agent. ClaudeCodeAgent satisfies this shape via
 * `/** @internal *\/`-marked public fields and proxy methods.
 */
export interface WorkerMessageContext {
  // ─── Read-only ───────────────────────────────────────────────────────
  readonly logPrefix: string;
  readonly resumeSessionId: string | undefined;
  readonly process: ChildProcess | null;
  readonly activeTools: Map<string, { name: string; startTime: number; info: string }>;
  /** The model id the router instructed this execution to run (`config.model`). */
  readonly instructedModel: string | undefined;

  // ─── Mutable state (direct field access) ─────────────────────────────
  outputBuffer: string;
  /** Clean FINAL assistant message from the stream-json `result` event. */
  finalResultText: string;
  claudeSessionId: string | null;
  detectedQuestion: QuestionWaitingState;
  hasFileModifyingToolCalls: boolean;
  workerArtifacts: AgentArtifact[];
  workerCommits: GitCommitInfo[];
  /**
   * Most recent `result` event payload from stream-json, or null when not
   * yet received. Captured so the agent can include real cost/usage in its
   * AgentExecutionResult.
   */
  workerResultUsage: WorkerResultUsageSnapshot | null;
  onParseComplete: (() => void) | null;
  parserWorker: Worker | null;
  status: string;

  // ─── Callbacks (proxy to BaseAgent's protected emitters) ─────────────
  emitOutputInternal(output: string, isError?: boolean): void;
  emitQuestionDetectedInternal(info: {
    question: string;
    questionType: ReturnType<typeof tolegacyQuestionType>;
    questionDetails?: unknown;
    questionKey?: unknown;
    claudeSessionId?: string;
  }): void;
  killProcessForQuestionInternal(): void;
}

/**
 * Dispatch a single message from the output-parser Worker.
 *
 * @param ctx - Mutable agent state + emitter callbacks. / 状態とコールバック
 * @param msg - Typed Worker output message. / Workerメッセージ
 */
export function handleWorkerMessage(ctx: WorkerMessageContext, msg: WorkerOutputMessage): void {
  switch (msg.type) {
    case 'system-event':
      if (msg.sessionId) {
        ctx.claudeSessionId = msg.sessionId;
        logger.info(`${ctx.logPrefix} Session ID captured: ${ctx.claudeSessionId}`);
        // In resume mode, verify session ID matches the requested one
        if (ctx.resumeSessionId && ctx.resumeSessionId !== msg.sessionId) {
          logger.warn(
            `${ctx.logPrefix} WARNING: Requested session ${ctx.resumeSessionId} but got ${msg.sessionId}`,
          );
          const mismatchWarning = `\n[Warning] Failed to resume specified session (${ctx.resumeSessionId.substring(0, 8)}...). Continuing with new session (${msg.sessionId.substring(0, 8)}...). Previous context may have been lost.\n`;
          ctx.outputBuffer += mismatchWarning;
          ctx.emitOutputInternal(mismatchWarning);
        }
      }
      if (msg.subtype === 'error') {
        logger.error(`${ctx.logPrefix} System error event: ${msg.errorMessage}`);
      }
      // NOTE: thinking_tokens fires once per internal "thinking" chunk and
      // carries no text of its own (see lifecycle-patterns.ts) — during a long
      // thinking burst this repeated the SAME line dozens of times into the
      // persisted output/execution log with zero added information. Collapse
      // consecutive repeats at the source, while retaining one received event
      // every 30 seconds so observers can distinguish activity from silence.
      // This is activity evidence, not evidence of successful task progress.
      if (msg.subtype === 'thinking_tokens' && msg.displayOutput) {
        const now = Date.now();
        const lastEmission = lastThinkingEmission.get(ctx);
        if (
          ctx.outputBuffer.endsWith(msg.displayOutput) &&
          lastEmission !== undefined &&
          now - lastEmission < THINKING_ACTIVITY_INTERVAL_MS
        ) {
          break;
        }
        lastThinkingEmission.set(ctx, now);
      }
      if (msg.displayOutput) {
        ctx.outputBuffer += msg.displayOutput;
        ctx.emitOutputInternal(msg.displayOutput);
      }
      break;

    case 'assistant-message':
      if (msg.displayOutput) {
        ctx.outputBuffer += msg.displayOutput;
        ctx.emitOutputInternal(msg.displayOutput);
      }
      // Track active tools on the main thread for reference at close time
      for (const tool of msg.toolUses) {
        ctx.activeTools.set(tool.id, {
          name: tool.name,
          startTime: Date.now(),
          info: tool.info,
        });
      }
      break;

    case 'user-message':
      if (msg.displayOutput) {
        ctx.outputBuffer += msg.displayOutput;
        ctx.emitOutputInternal(msg.displayOutput);
      }
      // Reflect tool completion
      for (const result of msg.toolResults) {
        if (result.toolUseId) {
          ctx.activeTools.delete(result.toolUseId);
        }
      }
      break;

    case 'result-event':
      if (msg.displayOutput) {
        ctx.outputBuffer += msg.displayOutput;
        ctx.emitOutputInternal(msg.displayOutput);
      }
      // Capture the clean final assistant message (no narration / tool logs).
      // Investigation phases save this instead of the noisy outputBuffer.
      if (typeof msg.result === 'string' && msg.result.trim()) {
        ctx.finalResultText = msg.result;
      }
      ctx.workerResultUsage = {
        costUsd: msg.costUsd,
        inputTokens: msg.usage?.inputTokens,
        outputTokens: msg.usage?.outputTokens,
        cacheReadInputTokens: msg.usage?.cacheReadInputTokens,
        cacheCreationInputTokens: msg.usage?.cacheCreationInputTokens,
        modelName: pickPrimaryModel(msg.modelUsage, ctx.instructedModel),
        numTurns: msg.numTurns,
      };
      break;

    case 'question-detected': {
      const detectionResult = msg.detectionResult;
      logger.info(`${ctx.logPrefix} AskUserQuestion tool detected via Worker!`);

      // Update question waiting state
      ctx.detectedQuestion = updateWaitingStateFromDetection(detectionResult);

      logger.info(
        { questionKey: ctx.detectedQuestion.questionKey },
        `${ctx.logPrefix} Question key generated`,
      );

      // Emit question detection immediately to trigger DB update
      ctx.status = 'waiting_for_input';
      ctx.emitQuestionDetectedInternal({
        question: detectionResult.questionText,
        questionType: tolegacyQuestionType(ctx.detectedQuestion.questionType),
        questionDetails: ctx.detectedQuestion.questionDetails,
        questionKey: ctx.detectedQuestion.questionKey,
        claudeSessionId: ctx.claudeSessionId || undefined,
      });

      if (msg.displayOutput) {
        ctx.outputBuffer += msg.displayOutput;
        ctx.emitOutputInternal(msg.displayOutput);
      }

      // Stop the process; will resume via --resume after user answers
      logger.info(`${ctx.logPrefix} Stopping process to wait for user response`);
      setTimeout(() => {
        if (ctx.process && !ctx.process.killed) {
          logger.info(`${ctx.logPrefix} Stopping process after stabilization delay (5s)`);
          ctx.killProcessForQuestionInternal();
        }
      }, 5000);
      break;
    }

    case 'tool-tracking':
      if (msg.hasFileModifyingToolCalls) {
        ctx.hasFileModifyingToolCalls = true;
        logger.info(`${ctx.logPrefix} File-modifying tool detected via Worker`);
      }
      break;

    case 'raw-output':
      if (msg.displayOutput) {
        ctx.outputBuffer += msg.displayOutput;
        ctx.emitOutputInternal(msg.displayOutput);
      }
      break;

    case 'artifacts-parsed':
      ctx.workerArtifacts = msg.data.artifacts;
      logger.info(
        `${ctx.logPrefix} Artifacts parsed by Worker: ${ctx.workerArtifacts.length} items`,
      );
      break;

    case 'commits-parsed':
      ctx.workerCommits = msg.data.commits;
      logger.info(`${ctx.logPrefix} Commits parsed by Worker: ${ctx.workerCommits.length} items`);
      break;

    case 'parse-complete':
      logger.info(`${ctx.logPrefix} Worker parse-complete received`);
      if (ctx.onParseComplete) {
        ctx.onParseComplete();
        ctx.onParseComplete = null;
      }
      // Terminate the Worker
      try {
        ctx.parserWorker?.postMessage({ type: 'terminate' } satisfies WorkerInputMessage);
      } catch {
        // Worker already terminated
      }
      ctx.parserWorker = null;
      break;

    case 'error':
      logger.error({ stack: msg.stack }, `${ctx.logPrefix} Worker error: ${msg.message}`);
      break;
  }
}

// Re-export types so callers don't need a second import path.
export type { AgentExecutionResult };
