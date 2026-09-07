/**
 * CodexCliAgent — Process Runner
 *
 * Handles spawning the Codex CLI child process, managing idle/timeout intervals,
 * wiring stdout/stderr/close event handlers, and resolving the execution promise.
 * JSON event processing is delegated to json-event-handler.ts.
 * Not responsible for prompt building or artifact parsing.
 */

import { spawnLowPriority } from '../process-priority';
import type { ChildProcess } from 'child_process';
import type { AgentExecutionResult, AgentArtifact, GitCommitInfo } from '../base-agent';
import type { QuestionWaitingState } from '../question-detection';
import { tolegacyQuestionType } from '../question-detection';
import { createLogger } from '../../../config/logger';
import type { CodexCliAgentConfig } from './types';
import { resolveCliPath } from './types';
import { processJsonEvent } from './json-event-handler';
import { filterCliDiagnosticOutput, shouldHideRawCliLine } from '../cli-output-filter';
import { buildSanitizedSpawnEnv } from '../../../utils/agent';
import {
  registerProcess,
  unregisterProcess,
  killProcessTreeSafely,
  captureDescendants,
} from '../agent-process-tracker';
import { startResourceSampling, stopResourceSampling } from '../process-resource-sampler';
import { formatPromptPreview } from '../../../utils/agent/prompt-preview';

const logger = createLogger('codex-cli-agent/process-runner');

/** Milliseconds of idle stdout before flushing incomplete line buffer. */
const OUTPUT_IDLE_TIMEOUT = 30000;

/** Milliseconds before warning that no output has been received at all. */
const INITIAL_OUTPUT_TIMEOUT = 60000;

/** Interval for idle-check polling. */
const IDLE_CHECK_INTERVAL_MS = 5000;

/** Interval for timeout-check polling. */
const TIMEOUT_CHECK_INTERVAL_MS = 10000;

/** Callbacks the runner needs from the owning agent. */
export type ProcessRunnerCallbacks = {
  emitOutput: (text: string, isError?: boolean) => void;
  emitQuestionDetected: (payload: {
    question: string;
    questionType: import('../base-agent').QuestionType;
    questionDetails: import('../question-detection').QuestionDetails | undefined;
    questionKey: import('../question-detection').QuestionKey | undefined;
  }) => void;
  onSessionId: (sessionId: string) => void;
  onQuestionDetected: (state: QuestionWaitingState) => void;
  onStatusChange: (status: string) => void;
  logPrefix: string;
};

/** Mutable state shared between the runner and the agent class. */
export type ProcessRunnerState = {
  process: ChildProcess | null;
  outputBuffer: string;
  errorBuffer: string;
  lineBuffer: string;
  detectedQuestion: QuestionWaitingState;
  activeTools: Map<string, { name: string; startTime: number; info: string }>;
  codexSessionId: string | null;
  actualModel: string | null;
  status: string;
};

/**
 * Build the final spawn command and args for the given platform.
 */
export function buildSpawnCommand(
  codexPath: string,
  args: string[],
  isWindows: boolean,
): [string, string[]] {
  if (!isWindows) return [codexPath, args];

  const argsString = args
    .map((arg) => {
      if (arg.includes(' ') || arg.includes('&') || arg.includes('|') || arg.includes('\n')) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    })
    .join(' ');

  const quotedPath = codexPath.includes(' ') ? `"${codexPath}"` : codexPath;
  return [`chcp 65001 >NUL 2>&1 && ${quotedPath} ${argsString}`, []];
}

/**
 * Build the environment variables for the Codex CLI process.
 *
 * NOTE: The spawned CLI is prompt-steerable (the task prompt can ask it to
 * print/exfiltrate its own env), so start from a sanitized base — never the
 * raw inherited process.env — to keep ENCRYPTION_KEY/DATABASE_URL/tokens out
 * of its reach. OPENAI_* is kept because the Codex CLI authenticates with it.
 */
export function buildProcessEnv(
  config: CodexCliAgentConfig,
  isWindows: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = buildSanitizedSpawnEnv(
    {
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      CI: '1',
      TERM: 'dumb',
    },
    ['OPENAI_'],
  );

  if (config.apiKey) env.OPENAI_API_KEY = config.apiKey;

  if (isWindows) {
    env.LANG = 'en_US.UTF-8';
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.CHCP = '65001';
  }

  return env;
}

/**
 * Ensure output directory exists before spawn.
 */
async function ensureOutputDirectory(outputPath: string | undefined): Promise<void> {
  if (!outputPath) return;

  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
  } catch {
    // Best-effort; spawn may still succeed if dir exists
  }
}

/** Investigation mode headline mappings */
const INVESTIGATION_HEADLINES: Record<string, string> = {
  research:
    '次の標準入力に含まれる調査タスクを実行し、最終回答を必ず "# 調査レポート" から始めてください。前置きは不要です。',
  plan: '次の標準入力に含まれる実装計画タスクを実行し、最終回答を必ず "# 実装計画" から始めてください。前置きは不要です。"## 設計判断の根拠" と "## 実装チェックリスト" のセクションを必ず含めてください。',
  review:
    '次の標準入力に含まれるレビュータスクを実行し、最終回答を必ず "# レビュー指摘" から始めてください。前置きは不要です。',
  verify:
    '次の標準入力に含まれる検証タスクを実行し、最終回答を必ず "# 検証結果" から始めてください。前置きは不要です。',
};

/** Result of building CLI args */
interface ArgsResult {
  args: string[];
  promptForStdin: string | null;
}

/**
 * Build Codex CLI arguments based on configuration and mode.
 */
function buildCodexArgs(
  config: CodexCliAgentConfig,
  workDir: string,
  prompt: string,
  logPrefix: string,
): ArgsResult {
  const args: string[] = ['exec'];

  // NOTE(security): Unlike Claude Code (`--strict-mcp-config`, see
  // claude-execution-runner.ts), Codex CLI has no single flag that restricts
  // MCP loading to an explicit allowlist and ignores ambient config. Its only
  // documented controls are per-server: `codex mcp disable <name>` (mutates
  // ~/.codex/config.toml persistently — not a per-spawn flag) or
  // `-c mcp_servers.<name>.enabled=false` overrides, both of which require
  // enumerating server names this codebase has no way to know ahead of time
  // (they live in the operator's machine-level ~/.codex/config.toml, not
  // ours). Pointing CODEX_HOME at an isolated directory per spawn was
  // considered but rejected: it would also relocate the session/auth store
  // Codex needs to function, is a larger behavioral change than this hardening
  // pass's scope, and could not be verified here (the Codex CLI is not
  // installed in this environment). Left as a follow-up — track "generic
  // MCP-isolation flag" against future Codex CLI releases.
  // JSON mode for implementation (not investigation)
  if (!config.investigationMode) {
    args.push('--json');
  }
  args.push('--cd', workDir);

  // Sandbox and permission settings
  if (config.investigationMode) {
    args.push('--sandbox', 'read-only');
    args.push('--skip-git-repo-check');
    logger.info(
      `${logPrefix} Investigation mode: --sandbox=read-only, --skip-git-repo-check, NO --json`,
    );
  } else if (config.yolo) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (config.sandboxMode) {
    args.push('--sandbox', config.sandboxMode);
    if (config.outputLastMessageFile) {
      args.push('--output-last-message', config.outputLastMessageFile);
    }
  } else {
    args.push('--full-auto');
  }

  // Model setting (skip in investigation mode)
  if (config.model && !config.investigationMode) {
    const model = normalizeCodexModel(
      config.model,
      !!config.apiKey || !!process.env.OPENAI_API_KEY,
    );
    args.push('-m', model);
  }

  // Prompt handling
  let promptForStdin: string | null = null;
  const resumeId = config.resumeSessionId;

  if (resumeId) {
    args.push('resume', resumeId);
    logger.info(`${logPrefix} Resuming session: ${resumeId}`);
  } else if (config.investigationMode) {
    const outputType = config.investigationOutputType ?? 'research';
    const headline = INVESTIGATION_HEADLINES[outputType] ?? INVESTIGATION_HEADLINES.research;
    args.push(headline);
    promptForStdin = prompt;
  } else {
    args.push(prompt);
  }

  return { args, promptForStdin };
}

/** Cleanup functions for process timers */
interface ProcessTimers {
  cleanupIdle: () => void;
  cleanupTimeout: () => void;
  updateLastOutputTime: () => void;
  markOutputReceived: () => void;
}

/**
 * Create idle and timeout check intervals for process monitoring.
 */
function createProcessTimers(
  state: ProcessRunnerState,
  callbacks: ProcessRunnerCallbacks,
  startTime: number,
  timeout: number,
  resolve: (result: AgentExecutionResult) => void,
): ProcessTimers {
  const { logPrefix } = callbacks;
  let lastOutputTime = Date.now();
  let hasReceivedAnyOutput = false;

  const idleCheckInterval = setInterval(() => {
    const idleTime = Date.now() - lastOutputTime;
    const totalElapsed = Date.now() - startTime;

    if (!hasReceivedAnyOutput && totalElapsed > INITIAL_OUTPUT_TIMEOUT) {
      logger.warn(`${logPrefix} No output received after ${Math.floor(totalElapsed / 1000)}s`);
      callbacks.emitOutput(
        `\n[情報] ${Math.floor(totalElapsed / 1000)}秒経過: Codex は内部処理中です。応答をお待ちください。タイムアウトは ${Math.floor(timeout / 1000)}秒です。\n`,
      );
      hasReceivedAnyOutput = true;
    }

    if (idleTime > OUTPUT_IDLE_TIMEOUT && state.lineBuffer.trim()) {
      logger.info(`${logPrefix} Holding partial stdout line while waiting for newline`);
    }
  }, IDLE_CHECK_INTERVAL_MS);

  const timeoutCheckInterval = setInterval(() => {
    if (state.process && !state.process.killed) {
      if (Date.now() - lastOutputTime >= timeout) {
        clearInterval(timeoutCheckInterval);
        clearInterval(idleCheckInterval);
        callbacks.emitOutput(
          `\n${logPrefix} Execution timed out (no output for ${timeout / 1000}s)\n`,
          true,
        );
        state.process.kill('SIGTERM');
        state.status = 'failed';
        callbacks.onStatusChange('failed');
        resolve({
          success: false,
          output: state.outputBuffer,
          errorMessage: `Execution timed out (no output for ${timeout / 1000}s)`,
          executionTimeMs: Date.now() - startTime,
        });
      }
    }
  }, TIMEOUT_CHECK_INTERVAL_MS);

  return {
    cleanupIdle: () => clearInterval(idleCheckInterval),
    cleanupTimeout: () => clearInterval(timeoutCheckInterval),
    updateLastOutputTime: () => {
      lastOutputTime = Date.now();
    },
    markOutputReceived: () => {
      if (!hasReceivedAnyOutput) {
        hasReceivedAnyOutput = true;
        logger.info(`${logPrefix} First stdout after ${Date.now() - startTime}ms`);
      }
    },
  };
}

/** Line handler for stdout processing */
type StdoutLineHandler = (line: string) => void;

/**
 * Create stdout line handler based on mode.
 */
function createStdoutLineHandler(
  config: CodexCliAgentConfig,
  state: ProcessRunnerState,
  callbacks: ProcessRunnerCallbacks,
): StdoutLineHandler {
  const { logPrefix } = callbacks;

  const appendRawLine = (line: string) => {
    // Investigation mode: keep ALL bytes for post-handler parsing
    if (config.investigationMode) {
      state.outputBuffer += line + '\n';
      callbacks.emitOutput(line + '\n');
      return;
    }
    // Implementation mode: filter and truncate
    if (shouldHideRawCliLine(line)) return;
    const displayLine = line.length > 240 ? `${line.slice(0, 237)}...` : line;
    state.outputBuffer += displayLine + '\n';
    callbacks.emitOutput(displayLine + '\n');
  };

  return (line: string) => {
    if (!line.trim()) return;

    try {
      const json = JSON.parse(line);
      logger.info(`${logPrefix} Event: ${json.type}`);
      processJsonEvent(json, state, callbacks, config, logPrefix);
    } catch {
      // Filter non-JSON output (e.g., chcp on Windows)
      const trimmed = line.trim();
      if (
        !trimmed ||
        /^Active code page:/i.test(trimmed) ||
        /^現在のコード ページ:/i.test(trimmed) ||
        /^chcp\s/i.test(trimmed)
      ) {
        logger.info(`${logPrefix} Filtered non-JSON: ${trimmed.substring(0, 100)}`);
        return;
      }
      logger.info(`${logPrefix} Raw output: ${line.substring(0, 200)}`);
      appendRawLine(line);
    }
  };
}

/**
 * Build execution result from process close.
 */
function buildCloseResult(
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
  }

  return {
    success: code === 0,
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

/**
 * Spawn the Codex CLI process and wire up all event handlers.
 * Resolves with an AgentExecutionResult when the process exits.
 */
export async function spawnCodexProcess(
  config: CodexCliAgentConfig,
  workDir: string,
  prompt: string,
  state: ProcessRunnerState,
  callbacks: ProcessRunnerCallbacks,
  startTime: number,
  parseArtifacts: (output: string) => AgentArtifact[],
  parseCommits: (output: string) => GitCommitInfo[],
): Promise<AgentExecutionResult> {
  const { logPrefix } = callbacks;
  const timeout = config.timeout ?? 900000;

  // Ensure output directory exists
  await ensureOutputDirectory(config.outputLastMessageFile);

  const isWindows = process.platform === 'win32';
  const codexPath = await resolveCliPath(
    process.env.CODEX_CLI_PATH || (isWindows ? 'codex.cmd' : 'codex'),
  );

  return new Promise((resolve) => {
    // Build CLI arguments
    const { args, promptForStdin } = buildCodexArgs(config, workDir, prompt, logPrefix);

    const argsForLog = args.map((a, i) =>
      i === args.length - 1 && a.length > 100 ? `<prompt:${a.length}chars>` : a,
    );
    logger.info(
      `${logPrefix} Platform: ${process.platform}, Codex: ${codexPath}, Timeout: ${timeout}ms, Prompt: ${prompt.length} chars`,
    );
    logger.info(`${logPrefix} Spawn argv: ${JSON.stringify([codexPath, ...argsForLog])}`);
    logger.info(`${logPrefix} Spawn cwd: ${workDir}`);

    callbacks.emitOutput(`${logPrefix} Starting execution...\n`);
    callbacks.emitOutput(`${logPrefix} Model: ${config.model ?? 'default'}\n`);
    callbacks.emitOutput(`${logPrefix} Working directory: ${workDir}\n`);
    callbacks.emitOutput(`${logPrefix} Timeout: ${timeout / 1000}s\n`);
    // One line only — untagged continuation lines render as agent narrative (formatPromptPreview).
    callbacks.emitOutput(`${logPrefix} Prompt: ${formatPromptPreview(prompt)}\n\n`);

    try {
      const [finalCommand, finalArgs] = buildSpawnCommand(codexPath, args, isWindows);
      const env = buildProcessEnv(config, isWindows);

      state.process = spawnLowPriority(finalCommand, finalArgs, {
        cwd: workDir,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      if (state.process.stdout) state.process.stdout.setEncoding('utf8');
      if (state.process.stderr) state.process.stderr.setEncoding('utf8');

      logger.info(`${logPrefix} Process spawned with PID: ${state.process.pid}`);
      callbacks.emitOutput(`${logPrefix} Process PID: ${state.process.pid}\n`);

      // Track the PID so a crash of the parent backend (or a hung codex
      // process outliving its own timeout) can still be found and reaped by
      // dev.js's startup cleanup / cleanupZombieProcesses — previously ONLY
      // claude-execution-runner.ts's spawn registered here, so codex CLI
      // processes were invisible to the zombie sweep (and not `bun.exe`, so
      // killStrayBunProcesses' name-based scan misses them too).
      if (state.process.pid) {
        registerProcess({
          pid: state.process.pid,
          role: 'cli-agent',
          startedAt: new Date().toISOString(),
          parentPid: process.pid,
        });
        startResourceSampling(state.process.pid);
      }

      // Write prompt to stdin for investigation mode
      if (state.process.stdin) {
        if (promptForStdin) {
          try {
            state.process.stdin.setDefaultEncoding('utf8');
            state.process.stdin.write(promptForStdin);
          } catch (writeErr) {
            logger.warn(
              { err: writeErr },
              `${logPrefix} Failed to write prompt body to codex stdin`,
            );
          }
        }
        state.process.stdin.end();
      }

      state.lineBuffer = '';

      // Setup process timers
      const timers = createProcessTimers(state, callbacks, startTime, timeout, resolve);
      const handleStdoutLine = createStdoutLineHandler(config, state, callbacks);

      // Handle stdout
      state.process.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        state.lineBuffer += chunk;
        timers.updateLastOutputTime();
        timers.markOutputReceived();

        const lines = state.lineBuffer.split('\n');
        state.lineBuffer = lines.pop() || '';
        for (const line of lines) handleStdoutLine(line);
      });

      // Handle stderr
      state.process.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        state.errorBuffer += output;
        timers.updateLastOutputTime();

        const modelMatch = output.match(/(?:^|\n)model:\s*([^\r\n]+)/i);
        if (modelMatch?.[1]) state.actualModel = modelMatch[1].trim();

        const filtered = filterCliDiagnosticOutput(output, { provider: 'codex' });
        if (filtered.display) {
          state.outputBuffer += filtered.display;
          callbacks.emitOutput(filtered.display, filtered.important);
        }
      });

      // Handle close
      state.process.on('close', (code: number | null) => {
        timers.cleanupTimeout();
        timers.cleanupIdle();
        const executionTimeMs = Date.now() - startTime;

        let resourceStats: { cpuTimeMs: number | null; peakRssKb: number | null } = {
          cpuTimeMs: null,
          peakRssKb: null,
        };
        if (state.process?.pid) {
          const closedPid = state.process.pid;
          unregisterProcess(closedPid);
          resourceStats = stopResourceSampling(closedPid);
          // On Windows, 'close' (stdio closed) does NOT guarantee the process
          // exited — mirrors claude-execution-runner.ts's same reap-after-grace.
          // killProcessTreeSafely refuses to touch a port-3001 (backend) process.
          // Capture descendants NOW, while the parent links are still live — a
          // command the agent launched can outlive both the agent and the shell
          // that started it, and is then unreachable from the root.
          const known = captureDescendants(closedPid);
          const reap = setTimeout(
            () => killProcessTreeSafely(closedPid, { knownTargets: known }),
            3000,
          );
          (reap as { unref?: () => void }).unref?.();
        }

        // Process any remaining buffered line
        if (state.lineBuffer.trim()) {
          handleStdoutLine(state.lineBuffer);
        }

        logger.info(`${logPrefix} Closed with code: ${code}, time: ${executionTimeMs}ms`);

        // Log diagnostic for non-zero exit
        if (code !== null && code !== 0) {
          const stderrSample =
            state.errorBuffer?.length > 0 ? state.errorBuffer.slice(-4096) : '(stderr was empty)';
          logger.error(
            {
              exitCode: code,
              executionTimeMs,
              stderrTail: stderrSample,
              outputBufferLen: state.outputBuffer.length,
              argsForLog,
            },
            `${logPrefix} Codex CLI exited non-zero — full diagnostic`,
          );
          callbacks.emitOutput(
            `\n[Codex 終了コード ${code}] stderr (末尾4KB):\n${stderrSample}\n`,
            true,
          );
        }
        // Handle cancelled state
        if (state.status === 'cancelled') {
          resolve({
            success: false,
            output: state.outputBuffer,
            errorMessage: 'Execution cancelled',
            executionTimeMs,
            failureType: 'cancelled',
          });
          return;
        }
        if (state.status === 'failed') return;

        // Build and return result
        const result = buildCloseResult(
          code,
          state,
          config,
          startTime,
          parseArtifacts,
          parseCommits,
          resourceStats,
        );

        if (result.waitingForInput) {
          state.status = 'waiting_for_input';
          callbacks.onStatusChange('waiting_for_input');
          callbacks.emitOutput(`\n${logPrefix} 回答を待っています...\n`);
        } else {
          const newStatus = code === 0 ? 'completed' : 'failed';
          state.status = newStatus;
          callbacks.onStatusChange(newStatus);
        }

        resolve(result);
      });

      // Handle error
      state.process.on('error', (error: Error) => {
        timers.cleanupTimeout();
        timers.cleanupIdle();
        state.status = 'failed';
        callbacks.onStatusChange('failed');
        logger.error({ err: error }, `${logPrefix} Process error`);
        callbacks.emitOutput(`${logPrefix} Error: ${error.message}\n`, true);

        const parts = [`プロセス起動エラー: ${error.message}`];
        if (state.errorBuffer.trim())
          parts.push(`\n\n【標準エラー出力】\n${state.errorBuffer.trim()}`);

        resolve({
          success: false,
          output: state.outputBuffer,
          errorMessage: parts.join(''),
          executionTimeMs: Date.now() - startTime,
        });
      });
    } catch (error) {
      state.status = 'failed';
      callbacks.onStatusChange('failed');
      logger.error({ err: error }, `${logPrefix} Spawn error`);
      resolve({
        success: false,
        output: '',
        errorMessage: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      });
    }
  });
}

export function normalizeCodexModel(model: string, hasApiKey: boolean): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;

  // Legacy GPT-4-era API models are not reliable with Codex CLI ChatGPT
  // account mode. Prefer the current Codex-capable default family so the CLI
  // does not silently ignore the request and then report a different model.
  if (!hasApiKey && /^(gpt-4|gpt-3\.5)/i.test(trimmed)) {
    return 'gpt-5.5';
  }
  return trimmed;
}
