/**
 * ClaudeCodeStream
 *
 * Low-level process spawning, stdin chunked writing, and stream-json event parsing
 * for the Claude Code CLI. Does NOT manage agent lifecycle or provider configuration.
 */
import { spawnLowPriority } from '../process-priority';
import type { AgentExecutionContext, AgentExecutionResult } from '../abstraction/types';
import { resolveCliPath } from './cli-utils';
import { processStreamEvent } from './stream-event-parser';
import { buildSanitizedSpawnEnv } from '../../../utils/agent';

export { processStreamEvent } from './stream-event-parser';

/** Mutable output state threaded through stream handlers. */
export interface StreamState {
  outputBuffer: string;
  errorBuffer: string;
  lineBuffer: string;
  claudeSessionId: string | null;
}

/** Configuration slice consumed by runClaudeCode. */
export interface RunConfig {
  cliPath?: string;
  resumeSessionId?: string;
  continueConversation?: boolean;
  dangerouslySkipPermissions?: boolean;
  model?: string;
  maxTokens?: number;
  timeout?: number;
}

/**
 * Processes a batch of newline-delimited stream-json lines, updating streamState in place.
 * Returns whether a question was detected and the detected question text.
 *
 * @param lines - Array of raw text lines (not including trailing incomplete line) / 末尾の不完全行を除いたテキスト行配列
 * @param streamState - Mutable buffer state / 可変バッファ状態
 * @param proc - Spawned process (killed on question detection) / 質問検出時にkillするスポーンプロセス
 * @param emitOutput - Output emit callback / 出力エミットコールバック
 * @returns Detection result / 検出結果
 */
async function processLines(
  lines: string[],
  streamState: StreamState,
  proc: import('child_process').ChildProcess,
  emitOutput: (output: string, isError: boolean) => Promise<void>,
): Promise<{ isQuestion: boolean; questionText: string }> {
  let isQuestion = false;
  let questionText = '';

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const json = JSON.parse(line);
      const result = processStreamEvent(json);

      if (result.output) {
        streamState.outputBuffer += result.output;
        await emitOutput(result.output, false);
      }

      if (result.sessionId) {
        streamState.claudeSessionId = result.sessionId;
      }

      if (result.isQuestion) {
        isQuestion = true;
        questionText = result.questionText || '';

        // Stop process on question detection to hand control back to user
        if (proc && !proc.killed) {
          proc.kill('SIGTERM');
        }
      }
    } catch {
      // Filter out non-JSON lines (e.g. Windows chcp output)
      const trimmedLine = line.trim();
      if (
        !trimmedLine ||
        /^Active code page:/i.test(trimmedLine) ||
        /^現在のコード ページ:/i.test(trimmedLine) ||
        /^chcp\s/i.test(trimmedLine)
      ) {
        continue;
      }
      streamState.outputBuffer += line + '\n';
      await emitOutput(line + '\n', false);
    }
  }

  return { isQuestion, questionText };
}

/**
 * Spawns a Claude Code CLI process, pipes the prompt via stdin, and resolves when done.
 *
 * @param prompt - Prompt text to send to Claude Code / Claude Codeに送るプロンプトテキスト
 * @param workDir - Working directory for the spawned process / スポーンするプロセスの作業ディレクトリ
 * @param context - Agent execution context / エージェント実行コンテキスト
 * @param config - Runtime configuration for CLI flags / CLIフラグのランタイム設定
 * @param streamState - Mutable buffer state shared with the caller / 呼び出し元と共有する可変バッファ状態
 * @param emitOutput - Callback invoked for each output chunk / 各出力チャンクで呼ばれるコールバック
 * @returns Agent execution result / エージェント実行結果
 */
export async function runClaudeCode(
  prompt: string,
  workDir: string,
  context: AgentExecutionContext,
  config: RunConfig,
  streamState: StreamState,
  emitOutput: (output: string, isError: boolean) => Promise<void>,
): Promise<AgentExecutionResult> {
  const startTime = Date.now();
  const isWindows = process.platform === 'win32';
  const baseClaudePath =
    config.cliPath || process.env.CLAUDE_CODE_PATH || (isWindows ? 'claude.cmd' : 'claude');
  const claudePath = await resolveCliPath(baseClaudePath);

  return new Promise((resolve) => {
    const timeout = context.timeout || config.timeout || 900000;

    const args: string[] = ['--print', '--verbose', '--output-format', 'stream-json'];

    if (config.resumeSessionId) {
      // --resume resumes a specific session by ID
      args.push('--resume', config.resumeSessionId);
    } else if (config.continueConversation) {
      // --continue resumes the most recent conversation when no session ID is available
      args.push('--continue');
    }

    if (config.dangerouslySkipPermissions || context.dangerouslySkipPermissions) {
      // NOTE(security): Same headless-no-TTY constraint as
      // claude-execution-runner.ts's buildClaudeArgs — this process is spawned
      // with piped stdio and no TTY, so any permission mode that can still
      // prompt (acceptEdits auto-approves only a handful of filesystem Bash
      // commands; everything else, including test/build/git, still prompts)
      // would abort the run with nobody able to answer. `dontAsk` avoids that
      // but requires enumerating exact Bash command patterns up front, which
      // this general-purpose coding agent can't know ahead of time. Bypass
      // stays, compensated by worktree isolation, the sanitized spawn env
      // below (strips ENCRYPTION_KEY/DATABASE_URL/*_TOKEN/etc.), and the
      // `--disallowedTools` denylist.
      args.push('--dangerously-skip-permissions');
      args.push('--permission-mode', 'bypassPermissions');
    }

    if (config.model) args.push('--model', config.model);
    if (config.maxTokens) args.push('--max-tokens', String(config.maxTokens));

    // NOTE(security): No --mcp-config is passed to this spawn either, so
    // --strict-mcp-config prevents the CLI from ambiently loading MCP servers
    // from the machine's global/project config (see claude-execution-runner.ts's
    // buildClaudeArgs for the full rationale — this is the same fix mirrored
    // for the streaming provider's spawn path).
    args.push('--strict-mcp-config');

    // NOTE: Disable worktree tools to prevent the spawned CLI from creating nested worktrees
    // that conflict with rapitas-managed worktrees and could corrupt .git/ directory structure.
    // NOTE(security): Also block network-egress (WebFetch/WebSearch) and
    // meta/recursion tools (ToolSearch/Skill/Task) — no prompt built for this
    // agent instructs it to use them, so they are pure attack surface. Mirrors
    // the denylist in claude-execution-runner.ts's buildClaudeArgs.
    args.push(
      '--disallowedTools',
      'EnterWorktree,ExitWorktree,WebFetch,WebSearch,ToolSearch,Skill,Task',
    );

    let finalCommand: string;
    let finalArgs: string[];

    if (isWindows) {
      const quotedPath = claudePath.includes(' ') ? `"${claudePath}"` : claudePath;
      finalCommand = `chcp 65001 >NUL 2>&1 && ${quotedPath} ${args.join(' ')}`;
      finalArgs = [];
    } else {
      finalCommand = claudePath;
      finalArgs = args;
    }

    try {
      const proc = spawnLowPriority(finalCommand, finalArgs, {
        cwd: workDir,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // NOTE: The spawned CLI is prompt-steerable (the task prompt can ask it
        // to print/exfiltrate its own env), so start from a sanitized base —
        // never the raw inherited env — to keep ENCRYPTION_KEY/DATABASE_URL/
        // GITHUB_TOKEN/etc out of its reach.
        env: buildSanitizedSpawnEnv({ FORCE_COLOR: '0', NO_COLOR: '1', CI: '1', TERM: 'dumb' }),
      });

      if (proc.stdout) proc.stdout.setEncoding('utf8');
      if (proc.stderr) proc.stderr.setEncoding('utf8');

      writePromptToStdin(proc, prompt);

      let lastOutputTime = Date.now();
      let hasDetectedQuestion = false;
      let detectedQuestionText = '';

      const timeoutCheck = setInterval(() => {
        if (Date.now() - lastOutputTime >= timeout) {
          clearInterval(timeoutCheck);
          if (proc && !proc.killed) proc.kill('SIGTERM');
          resolve({
            success: false,
            state: 'timeout',
            output: streamState.outputBuffer,
            errorMessage: `Execution timed out (no output for ${timeout / 1000}s)`,
            metrics: {
              startTime: new Date(startTime),
              endTime: new Date(),
              durationMs: Date.now() - startTime,
            },
          });
        }
      }, 10000);

      proc.stdout?.on('data', async (data: Buffer) => {
        streamState.lineBuffer += data.toString();
        lastOutputTime = Date.now();

        const lines = streamState.lineBuffer.split('\n');
        streamState.lineBuffer = lines.pop() || '';

        const detection = await processLines(lines, streamState, proc, emitOutput);
        if (detection.isQuestion) {
          hasDetectedQuestion = true;
          detectedQuestionText = detection.questionText;
        }
      });

      proc.stderr?.on('data', async (data: Buffer) => {
        const output = data.toString();
        streamState.errorBuffer += output;
        lastOutputTime = Date.now();
        await emitOutput(output, true);
      });

      proc.on('close', (code: number | null) => {
        clearInterval(timeoutCheck);
        const executionTimeMs = Date.now() - startTime;
        const metrics = {
          startTime: new Date(startTime),
          endTime: new Date(),
          durationMs: executionTimeMs,
        };

        if (streamState.lineBuffer.trim()) {
          streamState.outputBuffer += streamState.lineBuffer + '\n';
        }

        if (hasDetectedQuestion) {
          resolve({
            success: true,
            state: 'waiting_for_input',
            output: streamState.outputBuffer,
            pendingQuestion: {
              questionId: `q-${Date.now()}`,
              text: detectedQuestionText,
              category: 'clarification',
            },
            sessionId: streamState.claudeSessionId || undefined,
            metrics,
          });
          return;
        }

        resolve({
          success: code === 0,
          state: code === 0 ? 'completed' : 'failed',
          output: streamState.outputBuffer,
          errorMessage: code !== 0 ? `Process exited with code ${code}` : undefined,
          sessionId: streamState.claudeSessionId || undefined,
          metrics,
        });
      });

      proc.on('error', (error: Error) => {
        clearInterval(timeoutCheck);
        resolve({
          success: false,
          state: 'failed',
          output: streamState.outputBuffer,
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

/**
 * Writes a prompt string to the process stdin in 16 KB chunks, respecting backpressure.
 *
 * @param proc - Child process with an open stdin / stdinが開いているChildProcess
 * @param prompt - Prompt text to write / 書き込むプロンプトテキスト
 */
export async function writePromptToStdin(
  proc: import('child_process').ChildProcess,
  prompt: string,
): Promise<void> {
  if (!proc?.stdin) return;

  const stdin = proc.stdin;
  const CHUNK_SIZE = 16384;
  const promptBuffer = Buffer.from(prompt, 'utf8');

  stdin.on('error', () => {
    // stdin errors are intentionally suppressed; the process close/error events handle failures
  });

  for (let i = 0; i < promptBuffer.length; i += CHUNK_SIZE) {
    const chunk = promptBuffer.subarray(i, Math.min(i + CHUNK_SIZE, promptBuffer.length));
    const canContinue = stdin.write(chunk);

    if (!canContinue) {
      await new Promise<void>((resolve) => {
        stdin.once('drain', resolve);
      });
    }
  }

  stdin.end();
}
