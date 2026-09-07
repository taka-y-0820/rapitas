/**
 * Gemini CLI Runner
 *
 * Encapsulates the process spawn loop, stdout/stderr streaming, and timeout
 * logic for a single Gemini CLI invocation.
 * Separated from the agent class to keep each file under 300 lines.
 */

import { spawn } from 'child_process';
import type { AgentExecutionContext, AgentExecutionResult } from '../abstraction/types';
import type { GeminiCliConfig, GeminiStreamEvent } from './gemini-cli-types';
import { processStreamEvent } from './gemini-cli-types';
import { resolveCliPath } from './gemini-cli-agent';

/** Callback used by the runner to emit output lines back to the agent. */
export type EmitOutputFn = (output: string, isError: boolean, streaming: boolean) => Promise<void>;

/** Callback used by the runner to write structured log entries. */
export type LogFn = (level: string, message: string, meta?: Record<string, unknown>) => void;

// Re-export so existing imports from this module continue to work
export { processStreamEvent } from './gemini-cli-types';

/** Mutable state accumulated during a single CLI run. Passed by reference. */
export interface RunState {
  outputBuffer: string;
  errorBuffer: string;
  lineBuffer: string;
  geminiSessionId: string | null;
  checkpointId: string | null;
  /** Set to the spawned process so doStop() can kill it. */
  process: import('child_process').ChildProcess | null;
}

/** Builds the argv array for the Gemini CLI invocation. */
function buildArgs(
  prompt: string,
  config: GeminiCliConfig,
  context: AgentExecutionContext,
): string[] {
  const args: string[] = ['-p', prompt, '--output-format', 'stream-json'];
  if (config.sandboxMode) args.push('--sandbox');
  if (config.yolo || context.dangerouslySkipPermissions) args.push('--yolo');
  if (config.model) {
    const modelMapping: Record<string, string> = {
      'gemini-2.0-flash': 'gemini-2.0-flash-exp-0111',
      'gemini-1.5-flash': 'gemini-1.5-flash',
      'gemini-1.5-pro': 'gemini-1.5-pro',
      'gemini-2.0-flash-thinking': 'gemini-2.0-flash-thinking-exp-01-21',
    };
    let modelName = modelMapping[config.model] || config.model;
    if (!modelName.startsWith('models/')) modelName = `models/${modelName}`; // Gemini CLI requires models/ prefix
    args.push('-m', modelName);
  }
  if (config.checkpointId) args.push('--checkpoint', config.checkpointId);
  if (config.allowedTools?.length) args.push('--allowlist', config.allowedTools.join(','));
  if (config.disallowedTools?.length) args.push('--denylist', config.disallowedTools.join(','));
  // NOTE(security): See gemini-cli-agent/process-manager.ts's buildCliArgs for
  // why --allowed-mcp-server-names isn't wired in here either (unverified
  // empty-list semantics — Gemini CLI not installed in this environment).
  return args;
}

/** Builds the process environment, injecting API credentials. */
function buildEnv(config: GeminiCliConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CI: '1',
    TERM: 'dumb',
  };
  if (config.apiKey) {
    env.GEMINI_API_KEY = config.apiKey;
    env.GOOGLE_API_KEY = config.apiKey; // Gemini CLI may also use GOOGLE_API_KEY
  }
  if (config.projectId) env.GOOGLE_CLOUD_PROJECT = config.projectId;
  if (config.location) env.GOOGLE_CLOUD_LOCATION = config.location;
  return env;
}

/**
 * Spawns the Gemini CLI binary, pipes stdout/stderr through the stream-json parser,
 * and resolves with an AgentExecutionResult when the process exits or times out.
 *
 * @param prompt - Prompt text passed via the -p flag / -pフラグで渡すプロンプト
 * @param workDir - Working directory for the subprocess / サブプロセスの作業ディレクトリ
 * @param context - Execution context from the abstraction layer / 抽象化レイヤーの実行コンテキスト
 * @param config - Gemini CLI provider configuration / Gemini CLIプロバイダー設定
 * @param state - Mutable run state object / 変更可能な実行状態オブジェクト
 * @param emitOutput - Callback to forward output to the agent / 出力をエージェントに転送するコールバック
 * @param log - Structured logger callback / 構造化ロガーコールバック
 * @returns Resolved execution result / 解決された実行結果
 */
export async function runGeminiCli(
  prompt: string,
  workDir: string,
  context: AgentExecutionContext,
  config: GeminiCliConfig,
  state: RunState,
  emitOutput: EmitOutputFn,
  log: LogFn,
): Promise<AgentExecutionResult> {
  const startTime = Date.now();
  const isWindows = process.platform === 'win32';
  const geminiPath = await resolveCliPath(
    config.cliPath || process.env.GEMINI_CLI_PATH || (isWindows ? 'gemini.cmd' : 'gemini'),
  );

  return new Promise((resolve) => {
    const timeout = context.timeout || config.timeout || 900000;

    const args = buildArgs(prompt, config, context);
    const env = buildEnv(config);

    let finalCommand: string;
    let finalArgs: string[];

    if (isWindows) {
      const argsString = args
        .map((arg) =>
          arg.includes(' ') || arg.includes('&') || arg.includes('|')
            ? `"${arg.replace(/"/g, '\\"')}"`
            : arg,
        )
        .join(' ');
      const quotedPath = geminiPath.includes(' ') ? `"${geminiPath}"` : geminiPath;
      finalCommand = `chcp 65001 >NUL 2>&1 && ${quotedPath} ${argsString}`;
      finalArgs = [];
    } else {
      finalCommand = geminiPath;
      finalArgs = args;
    }

    log('info', 'Starting Gemini CLI execution', {
      workDir,
      promptLength: prompt.length,
      command: isWindows ? finalCommand : `${finalCommand} ${args.join(' ')}`,
      model: config.model,
    });

    try {
      // Log API key presence (only prefix for security)
      const hasApiKey =
        !!env.GEMINI_API_KEY || !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
      const apiKeyPrefix = (
        env.GEMINI_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        ''
      ).substring(0, 8);
      log('info', 'Gemini API configuration', {
        hasApiKey,
        apiKeyPrefix: apiKeyPrefix ? `${apiKeyPrefix}...` : 'NOT SET',
        hasProjectId: !!env.GOOGLE_CLOUD_PROJECT,
        hasLocation: !!env.GOOGLE_CLOUD_LOCATION,
      });

      state.process = spawn(finalCommand, finalArgs, {
        cwd: workDir,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      if (state.process.stdout) state.process.stdout.setEncoding('utf8');
      if (state.process.stderr) state.process.stderr.setEncoding('utf8');

      // stdin must be closed since prompt is passed via -p flag
      if (state.process.stdin) state.process.stdin.end();

      let lastOutputTime = Date.now();
      let hasDetectedQuestion = false;
      let detectedQuestionText = '';

      const timeoutCheck = setInterval(() => {
        if (Date.now() - lastOutputTime >= timeout) {
          clearInterval(timeoutCheck);
          if (state.process && !state.process.killed) state.process.kill('SIGTERM');
          resolve({
            success: false,
            state: 'timeout',
            output: state.outputBuffer,
            errorMessage: `Execution timed out (no output for ${timeout / 1000}s)`,
            metrics: {
              startTime: new Date(startTime),
              endTime: new Date(),
              durationMs: Date.now() - startTime,
            },
          });
        }
      }, 10000);

      state.process.stdout?.on('data', async (data: Buffer) => {
        state.lineBuffer += data.toString();
        lastOutputTime = Date.now();
        const lines = state.lineBuffer.split('\n');
        state.lineBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as GeminiStreamEvent;
            const result = processStreamEvent(json);
            if (result.output) {
              state.outputBuffer += result.output;
              await emitOutput(result.output, false, true);
            }
            if (result.sessionId) state.geminiSessionId = result.sessionId;
            if (result.checkpointId) state.checkpointId = result.checkpointId;
            if (result.isQuestion) {
              hasDetectedQuestion = true;
              detectedQuestionText = result.questionText || '';
              // Stop process on question detection to hand control back to user
              if (state.process && !state.process.killed) state.process.kill('SIGTERM');
            }
          } catch {
            // Filter out non-JSON lines (e.g. Windows chcp output)
            const t = line.trim();
            if (
              !t ||
              /^Active code page:/i.test(t) ||
              /^現在のコード ページ:/i.test(t) ||
              /^chcp\s/i.test(t)
            )
              continue;
            state.outputBuffer += line + '\n';
            await emitOutput(line + '\n', false, true);
          }
        }
      });

      state.process.stderr?.on('data', async (data: Buffer) => {
        const output = data.toString();
        state.errorBuffer += output;
        lastOutputTime = Date.now();
        log('error', 'Gemini CLI stderr output', { error: output, model: config.model, workDir });
        await emitOutput(output, true, true);
      });

      state.process.on('close', (code: number | null) => {
        clearInterval(timeoutCheck);
        const executionTimeMs = Date.now() - startTime;

        if (state.lineBuffer.trim()) state.outputBuffer += state.lineBuffer + '\n';

        if (hasDetectedQuestion) {
          resolve({
            success: true,
            state: 'waiting_for_input',
            output: state.outputBuffer,
            pendingQuestion: {
              questionId: `q-${Date.now()}`,
              text: detectedQuestionText,
              category: 'clarification',
            },
            sessionId: state.checkpointId || state.geminiSessionId || undefined,
            metrics: {
              startTime: new Date(startTime),
              endTime: new Date(),
              durationMs: executionTimeMs,
            },
          });
          return;
        }

        let errorMessage: string | undefined;
        if (code !== 0) {
          errorMessage = `Process exited with code ${code}`;
          if (state.errorBuffer.trim()) {
            errorMessage += `\nError output: ${state.errorBuffer.trim()}`;
          }
          if (
            state.errorBuffer.includes('ModelNotFoundError') ||
            state.errorBuffer.includes('Requested entity was not found')
          ) {
            errorMessage +=
              '\nNote: The specified model may not be available. Try using a different model or check your API access.';
          }
        }

        resolve({
          success: code === 0,
          state: code === 0 ? 'completed' : 'failed',
          output: state.outputBuffer,
          errorMessage,
          sessionId: state.checkpointId || state.geminiSessionId || undefined,
          metrics: {
            startTime: new Date(startTime),
            endTime: new Date(),
            durationMs: executionTimeMs,
          },
        });
      });

      state.process.on('error', (error: Error) => {
        clearInterval(timeoutCheck);
        resolve({
          success: false,
          state: 'failed',
          output: state.outputBuffer,
          errorMessage: error.message,
          metrics: {
            startTime: new Date(startTime),
            endTime: new Date(),
            durationMs: Date.now() - startTime,
          },
        });
      });
    } catch (error) {
      resolve({
        success: false,
        state: 'failed',
        output: '',
        errorMessage: error instanceof Error ? error.message : String(error),
        metrics: {
          startTime: new Date(startTime),
          endTime: new Date(),
          durationMs: Date.now() - startTime,
        },
      });
    }
  });
}
