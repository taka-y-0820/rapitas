/**
 * CodexCliAgent — JSON Event Handler
 *
 * Processes individual JSON lines emitted by the Codex CLI `--json` mode.
 * Handles message, user, result, and system event types, mutating shared
 * runner state in place and invoking callbacks for output and questions.
 * Not responsible for process spawning, timeouts, or prompt building.
 */

import {
  detectQuestionFromToolCall,
  updateWaitingStateFromDetection,
  tolegacyQuestionType,
} from '../question-detection';
import { formatToolInfo } from './output-parser';
import { canonicalToolName } from '../common/tool-name-canonicalizer';
import { createLogger } from '../../../config/logger';
import type { ProcessRunnerState, ProcessRunnerCallbacks } from './process-runner';
import type { CodexCliAgentConfig } from './types';

const logger = createLogger('codex-cli-agent/json-event-handler');

/**
 * Shape of the `item` payload on official `--json` `item.*` events, per
 * https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts.
 * Fields beyond `agent_message`/`command_execution` are not implemented
 * (unconfirmed shapes) — see the `item.completed` default branch below.
 */
type CodexItemPayload = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number;
  status?: 'in_progress' | 'completed' | 'failed';
};

/**
 * Process a single parsed JSON event object from Codex CLI stdout.
 * Mutates state and invokes callbacks for any display output or question detection.
 *
 * @param json - Parsed JSON event object / パースされたJSONイベントオブジェクト
 * @param state - Shared mutable runner state / 共有される可変ランナー状態
 * @param callbacks - Callbacks into the owning agent / 所有エージェントへのコールバック
 * @param config - Agent configuration for timeout calculation / タイムアウト計算用のエージェント設定
 * @param logPrefix - Log prefix for context-specific logging / ログ出力用プレフィックス
 */
export function processJsonEvent(
  // HACK(agent): eslint disabled — json is truly dynamic per Codex CLI streaming protocol
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any>,
  state: ProcessRunnerState,
  callbacks: ProcessRunnerCallbacks,
  config: CodexCliAgentConfig,
  logPrefix: string,
): void {
  let displayOutput = '';

  switch (json.type) {
    case 'thread.started':
      if (json.thread_id) {
        state.codexSessionId = String(json.thread_id);
        callbacks.onSessionId(state.codexSessionId);
        logger.info(`${logPrefix} Thread ID: ${state.codexSessionId}`);
      }
      break;

    case 'turn.started':
      break;

    case 'error':
      displayOutput += `[Error] ${json.message || json.error || 'unknown'}\n`;
      break;

    case 'turn.failed': {
      const errorMessage =
        typeof json.error?.message === 'string'
          ? json.error.message
          : json.message || json.error || 'unknown';
      displayOutput += `\n[Result: failed]\n${errorMessage}\n`;
      // NOTE: only the first turn.failed within an execution is kept — the
      // earliest failure reason is the most likely root cause, and a later
      // turn.failed (e.g. from a follow-up retry inside the same run) should
      // not overwrite it.
      if (!state.turnFailed) {
        state.turnFailed = true;
        state.turnFailureMessage =
          typeof errorMessage === 'string' ? errorMessage : String(errorMessage);
      }
      break;
    }

    case 'turn.completed':
      displayOutput += `\n[Result: completed]\n`;
      break;

    case 'item.started': {
      const item = json.item as CodexItemPayload | undefined;
      if (item?.type === 'command_execution' && typeof item.id === 'string') {
        const command = typeof item.command === 'string' ? item.command : '(unknown command)';
        state.activeCodexCommands.set(item.id, { command, startedAt: Date.now() });
        displayOutput += `[Command] ${command} を開始しました\n`;
      } else {
        // NOTE: item.type shapes beyond command_execution are unconfirmed
        // against primary source — record the type only, no display/throw.
        logger.info(`${logPrefix} item.started with unhandled item.type: ${item?.type}`);
      }
      break;
    }

    case 'item.updated':
      // NOTE: item.updated repeats the same item as it streams, so acting on
      // it here would duplicate the [Command]/[Command Done] lines already
      // emitted by item.started/item.completed. Intentional full no-op.
      break;

    case 'item.completed': {
      const item = json.item as CodexItemPayload | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        displayOutput += item.text;
      } else if (item?.type === 'command_execution') {
        const command = typeof item.command === 'string' ? item.command : '(unknown command)';
        const started =
          typeof item.id === 'string' ? state.activeCodexCommands.get(item.id) : undefined;
        const durationLabel = started
          ? `${((Date.now() - started.startedAt) / 1000).toFixed(1)}s, `
          : '';
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const failed = exitCode !== undefined ? exitCode !== 0 : item.status === 'failed';
        const exitLabel = exitCode !== undefined ? `exit ${exitCode}` : (item.status ?? 'unknown');
        const label = failed ? 'Command Failed' : 'Command Done';

        // NOTE: this is a log-visibility distinction only — a non-zero exit
        // from a single command must not, by itself, decide the overall
        // AgentExecutionResult.success. That is governed solely by
        // state.turnFailed (see process-runner-close-result.ts).
        displayOutput += `[${label}] ${command} (${durationLabel}${exitLabel})\n`;
        if (failed) {
          logger.warn(`${logPrefix} ${label}: ${command} (${exitLabel})`);
        } else {
          logger.info(`${logPrefix} ${label}: ${command} (${exitLabel})`);
        }
        if (typeof item.id === 'string') state.activeCodexCommands.delete(item.id);
      } else {
        // NOTE: item.type shapes beyond agent_message/command_execution are
        // unconfirmed against primary source — record the type only.
        logger.info(`${logPrefix} item.completed with unhandled item.type: ${item?.type}`);
      }
      break;
    }

    case 'assistant':
    case 'message':
      if (json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text' && block.text) {
            displayOutput += block.text;
          } else if (block.type === 'tool_use' || block.type === 'function_call') {
            const toolName = block.name || block.function?.name;
            if (toolName === 'AskUserQuestion' || toolName === 'ask_user') {
              logger.info(`${logPrefix} Question tool detected: ${toolName}`);

              const toolInput = block.input || block.function?.arguments;
              const detectionResult = detectQuestionFromToolCall(
                'AskUserQuestion',
                toolInput,
                config.timeout ? Math.floor(config.timeout / 1000) : undefined,
              );

              state.detectedQuestion = updateWaitingStateFromDetection(detectionResult);
              state.status = 'waiting_for_input';

              callbacks.onStatusChange('waiting_for_input');
              callbacks.onQuestionDetected(state.detectedQuestion);
              callbacks.emitQuestionDetected({
                question: detectionResult.questionText,
                questionType: tolegacyQuestionType(state.detectedQuestion.questionType),
                questionDetails: state.detectedQuestion.questionDetails,
                questionKey: state.detectedQuestion.questionKey,
              });

              displayOutput += `\n[質問] ${detectionResult.questionText}\n`;

              // NOTE: Kill process to wait for user response before continuing
              logger.info(`${logPrefix} Stopping process to wait for user response`);
              if (state.process && !state.process.killed) {
                state.process.kill('SIGTERM');
              }
            } else {
              // Canonicalise tool names so the frontend log-pattern table
              // matches uniformly across providers (Codex emits e.g.
              // `Shell` / `apply_patch`; Claude uses `Bash` / `Edit`).
              const canonicalName = canonicalToolName(toolName);
              const toolInfo = formatToolInfo(
                toolName || 'unknown',
                block.input || block.function?.arguments,
              );
              displayOutput += `\n[Tool: ${canonicalName}] ${toolInfo}\n`;
              if (block.id) {
                state.activeTools.set(block.id, {
                  name: canonicalName,
                  startTime: Date.now(),
                  info: toolInfo,
                });
              }
            }
          }
        }
      }
      // Handle simple string content format
      if (typeof json.content === 'string') {
        displayOutput += json.content;
      }
      break;

    case 'user':
      if (json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const activeTool = state.activeTools.get(block.tool_use_id);
            if (activeTool) {
              const duration = ((Date.now() - activeTool.startTime) / 1000).toFixed(1);
              if (block.is_error) {
                displayOutput += `[Tool Error: ${activeTool.name}] (${duration}s)\n`;
              } else {
                displayOutput += `[Tool Done: ${activeTool.name}] (${duration}s)\n`;
              }
              state.activeTools.delete(block.tool_use_id);
            }
          }
        }
      }
      break;

    case 'result':
      if (json.result) {
        const duration = json.duration_ms ? ` (${(json.duration_ms / 1000).toFixed(1)}s)` : '';
        // NOTE: per-run cost intentionally omitted from the log line — actual
        // usage/cost is surfaced separately, not inline as "$0.xxxx".
        displayOutput += `\n[Result: ${json.subtype || 'completed'}${duration}]\n`;
        if (typeof json.result === 'string') {
          displayOutput += json.result + '\n';
        }
      }
      break;

    case 'system':
      if (json.session_id) {
        state.codexSessionId = json.session_id;
        callbacks.onSessionId(json.session_id);
        logger.info(`${logPrefix} Session ID: ${state.codexSessionId}`);
      }

      if (json.subtype === 'error' || json.error) {
        logger.error({ systemError: json }, `${logPrefix} System error`);

        // NOTE: Special handling for gpt-4o model unavailability on ChatGPT accounts
        if (json.error && json.error.includes('gpt-4o') && json.error.includes('ChatGPT account')) {
          displayOutput += `[エラー] ChatGPTアカウントではgpt-4oモデルは使用できません。\n`;
          displayOutput += `[ヒント] 代わりにgpt-4-turboまたはgpt-3.5-turboをお使いください。\n`;
        } else {
          displayOutput += `[System Error: ${json.error || json.subtype || 'unknown'}]\n`;
        }
      } else if (json.subtype !== 'init') {
        displayOutput += `[System: ${json.subtype || 'info'}]\n`;
      }
      break;

    default:
      logger.info({ eventType: json.type }, `${logPrefix} Unknown event type: ${json.type}`);
  }

  if (displayOutput) {
    state.outputBuffer += displayOutput;
    callbacks.emitOutput(displayOutput);
  }
}
