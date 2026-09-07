/**
 * Claude Code CLI Provider (subscription-backed, no per-token billing)
 *
 * Runs one-shot text generation through the Claude Code CLI (`claude --print`)
 * so auxiliary AI features (naming, spec derivation, memory upkeep, reviews, …)
 * are covered by the Claude subscription instead of the paid Anthropic Messages
 * API. It is NOT responsible for agent/workflow execution — that path lives under
 * services/agents/claude-code and manages its own process lifecycle.
 */
import { spawn, type ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import { createLogger } from '../../config/logger';
// NOTE: Deliberate utils→services exception (concern #1284): aux CLI children
// must be visible to the shared process tracker so the task-boundary restart
// can require "0 live aux CLI children" and post-crash cleanup can reap them.
import { registerProcess, unregisterProcess } from '../../services/agents/agent-process-tracker';
import { getClaudePathAsync } from '../common/cli-path-resolver';
import { type AIMessage, type AIResponse } from './types';
import { describeCliFailure, extractLastJsonObject } from './cli-failure-reason';

const log = createLogger('ai-client:claude-cli');

/** Build the platform-specific spawn command/args (UTF-8 code page on Windows). */
function buildSpawnCommand(claudePath: string, args: string[]): [string, string[]] {
  if (process.platform !== 'win32') return [claudePath, args];
  const argsString = args
    .map((arg) => (arg.includes(' ') || arg.includes('&') || arg.includes('|') ? `"${arg}"` : arg))
    .join(' ');
  const quotedPath = claudePath.includes(' ') ? `"${claudePath}"` : claudePath;
  return [`chcp 65001 >NUL 2>&1 && ${quotedPath} ${argsString}`, []];
}

/** Whether the CLI responds to `--version` within 10s. */
async function checkClaudeAvailable(): Promise<boolean> {
  const claudePath = await getClaudePathAsync();
  return new Promise((resolve) => {
    const proc = spawn(claudePath, ['--version'], { shell: true, windowsHide: true });
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 10000);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Thrown when the CLI path cannot serve a request (binary missing, not logged
 * in, non-zero exit, timeout). Lets the router / callers degrade gracefully
 * instead of silently falling back to the paid API.
 */
export class ClaudeCliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCliUnavailableError';
  }
}

// Per-call wall-clock cap. One-shot helper prompts are small; a stuck CLI must
// not hang a background job forever.
const CLI_TIMEOUT_MS = Number(process.env.RAPITAS_AUX_AI_CLI_TIMEOUT_MS) || 120_000;

// Concurrency cap: the auto-run loop + 30s memory queue can fire many aux calls
// at once. Spawning an unbounded number of CLI processes stampedes both the
// subscription rate limit and local CPU, so serialize to a small pool.
const MAX_CONCURRENT = Number(process.env.RAPITAS_AUX_AI_CLI_CONCURRENCY) || 2;
let activeCount = 0;
const queue: Array<() => void> = [];

/** Acquire a concurrency slot; resolves once one is free. */
function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

/** Release a concurrency slot and hand it to the next waiter. */
function releaseSlot(): void {
  const next = queue.shift();
  if (next) {
    next();
  } else {
    activeCount = Math.max(0, activeCount - 1);
  }
}

// Availability probe result, memoized for the process lifetime (the CLI binary
// does not appear/disappear during a run). A restart re-probes.
let availabilityCache: boolean | null = null;

/**
 * Whether the Claude Code CLI binary responds to `--version`.
 *
 * @returns true if the CLI is invokable / CLIが起動可能ならtrue
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache;
  availabilityCache = await checkClaudeAvailable();
  return availabilityCache;
}

/**
 * Map a full model id (or undefined) to a Claude Code `--model` alias.
 * Unspecified defaults to Haiku — aux calls should stay light on the shared
 * subscription rate limit.
 *
 * @param model - Requested model id, if any / 要求モデルID（任意）
 * @returns CLI model alias / CLIのモデルエイリアス
 */
function toCliModel(model?: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  return 'haiku';
}

/**
 * Build the spawn environment. Strips Anthropic API credentials so the CLI is
 * FORCED to use its subscription login — guaranteeing these calls never bill as
 * paid API. Adds UTF-8 / non-interactive flags mirroring the agent runner.
 */
function buildCliEnv(): NodeJS.ProcessEnv {
  const isWindows = process.platform === 'win32';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CI: '1',
    TERM: 'dumb',
    NODE_OPTIONS: '--no-warnings',
    ...(isWindows && { LANG: 'en_US.UTF-8', CHCP: '65001' }),
  };
  // NOTE: Force subscription auth — an API key in the env would make the CLI
  // bill as paid API, defeating the entire purpose of this provider.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Tools disabled for pure text generation — no repo/file/shell/network access. */
const DISALLOWED_TOOLS =
  'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite,MultiEdit';

/**
 * Fold system prompt + conversation into a single stdin prompt. Passing text via
 * stdin (not CLI args) avoids all cross-platform shell-quoting hazards.
 */
function combinePrompt(messages: AIMessage[], systemPrompt?: string): string {
  const system = systemPrompt || messages.find((m) => m.role === 'system')?.content || '';
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
    .join('\n\n');
  return system ? `${system}\n\n${convo}` : convo;
}

/**
 * Track an aux CLI child in the shared process tracker (concern #1284) and
 * return an idempotent untrack callback. With `shell: true` the tracked PID is
 * the shell wrapper (cmd.exe on Windows) which lives as long as the CLI call —
 * a correct liveness proxy for the "0 aux children" restart gate; killing the
 * real CLI grandchild by PID is out of scope here.
 */
function trackAuxCliChild(child: ChildProcess): () => void {
  const pid = child.pid;
  if (typeof pid !== 'number') return () => {};
  registerProcess({
    pid,
    role: 'cli-agent',
    startedAt: new Date().toISOString(),
    parentPid: process.pid,
  });
  let untracked = false;
  return () => {
    if (untracked) return;
    untracked = true;
    unregisterProcess(pid);
  };
}

/** Spawn the CLI with the given args, feed `prompt` on stdin, resolve stdout. */
async function spawnCli(args: string[], prompt: string): Promise<string> {
  const claudePath = await getClaudePathAsync();
  return new Promise((resolve, reject) => {
    const [command, spawnArgs] = buildSpawnCommand(claudePath, args);
    const child: ChildProcess = spawn(command, spawnArgs, {
      cwd: tmpdir(), // isolate from the repo even if a tool slipped through
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCliEnv(),
    });
    const untrack = trackAuxCliChild(child);

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (stdout += d));
    child.stderr?.on('data', (d: string) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
      // Untrack promptly — on Windows the shell wrapper may linger after
      // kill(); the tracker's liveness check self-heals if it survives.
      untrack();
      reject(new ClaudeCliUnavailableError(`Claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      untrack();
      reject(new ClaudeCliUnavailableError(`Claude CLI spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      untrack();
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new ClaudeCliUnavailableError(
            `Claude CLI exited ${code}: ${describeCliFailure(stderr || stdout)}`,
          ),
        );
      }
    });

    const buf = Buffer.from(prompt, 'utf8');
    child.stdin?.on('error', (err) =>
      log.warn({ err }, 'Claude CLI stdin error while writing prompt'),
    );
    child.stdin?.end(buf);
  });
}

/**
 * One-shot text generation via the Claude Code CLI (non-streaming).
 *
 * @param model - Requested model id (mapped to a CLI alias) / モデルID
 * @param messages - Conversation messages / 会話メッセージ
 * @param systemPrompt - Optional system instructions / システム指示（任意）
 * @param _maxTokens - Accepted for signature parity; the CLI manages output length / 署名互換のため受理
 * @returns The generated text and token usage / 生成テキストとトークン使用量
 * @throws {ClaudeCliUnavailableError} When the CLI cannot serve the request / CLIが応答できない場合
 */
export async function callClaudeCli(
  model: string | undefined,
  messages: AIMessage[],
  systemPrompt: string | undefined,
  _maxTokens: number,
): Promise<AIResponse> {
  await acquireSlot();
  try {
    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      toCliModel(model),
      '--disallowedTools',
      DISALLOWED_TOOLS,
    ];
    const stdout = await spawnCli(args, combinePrompt(messages, systemPrompt));
    const jsonText = extractLastJsonObject(stdout.trim()) ?? stdout.trim();
    let parsed: {
      result?: string;
      is_error?: boolean;
      subtype?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new ClaudeCliUnavailableError(
        `Claude CLI returned unparseable output: ${stdout.slice(0, 300)}`,
      );
    }
    if (parsed.is_error || parsed.subtype === 'error' || typeof parsed.result !== 'string') {
      throw new ClaudeCliUnavailableError(
        `Claude CLI reported an error: ${describeCliFailure(jsonText)}`,
      );
    }
    const tokensUsed = (parsed.usage?.input_tokens || 0) + (parsed.usage?.output_tokens || 0);
    return { content: parsed.result, tokensUsed };
  } finally {
    releaseSlot();
  }
}

/**
 * One-shot text generation via the Claude Code CLI (streaming).
 * Emits the same SSE byte contract as the paid-API stream provider:
 * `data: {"content":"..."}\n\n` per chunk, then `data: [DONE]\n\n`.
 *
 * @param model - Requested model id / モデルID
 * @param messages - Conversation messages / 会話メッセージ
 * @param systemPrompt - Optional system instructions / システム指示（任意）
 * @param _maxTokens - Accepted for signature parity / 署名互換のため受理
 * @returns A ReadableStream of SSE bytes / SSEバイトのReadableStream
 */
export async function callClaudeCliStream(
  model: string | undefined,
  messages: AIMessage[],
  systemPrompt: string | undefined,
  _maxTokens: number,
): Promise<ReadableStream> {
  const prompt = combinePrompt(messages, systemPrompt);
  const args = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--model',
    toCliModel(model),
    '--disallowedTools',
    DISALLOWED_TOOLS,
  ];

  await acquireSlot();
  const claudePath = await getClaudePathAsync();
  const [command, spawnArgs] = buildSpawnCommand(claudePath, args);
  const child = spawn(command, spawnArgs, {
    cwd: tmpdir(),
    shell: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildCliEnv(),
  });
  const untrack = trackAuxCliChild(child);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  const encoder = new TextEncoder();
  const emit = (controller: ReadableStreamDefaultController, payload: object) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

  return new ReadableStream({
    start(controller) {
      let lineBuffer = '';
      let emittedAny = false;
      let fallbackResult = '';
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        untrack();
        if (!emittedAny && fallbackResult) emit(controller, { content: fallbackResult });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        releaseSlot();
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        emit(controller, { error: message });
        controller.close();
        releaseSlot();
        child.kill();
        // Untrack after kill — the tracker's liveness check self-heals if the
        // shell wrapper lingers past the kill on Windows.
        untrack();
      };

      const timer = setTimeout(
        () => fail(`Claude CLI timed out after ${CLI_TIMEOUT_MS}ms`),
        CLI_TIMEOUT_MS,
      );

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: {
          type?: string;
          result?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        try {
          evt = JSON.parse(trimmed);
        } catch {
          return; // ignore non-JSON noise
        }
        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          for (const block of evt.message!.content!) {
            if (block.type === 'text' && block.text) {
              emittedAny = true;
              emit(controller, { content: block.text });
            }
          }
        } else if (evt.type === 'result' && typeof evt.result === 'string') {
          fallbackResult = evt.result;
        }
      };

      child.stdout?.on('data', (chunk: string) => {
        lineBuffer += chunk;
        let idx: number;
        while ((idx = lineBuffer.indexOf('\n')) !== -1) {
          handleLine(lineBuffer.slice(0, idx));
          lineBuffer = lineBuffer.slice(idx + 1);
        }
      });
      let stderr = '';
      child.stderr?.on('data', (d: string) => (stderr += d));
      child.on('error', (err) => fail(`Claude CLI spawn failed: ${err.message}`));
      child.on('close', (code) => {
        if (lineBuffer.trim()) handleLine(lineBuffer);
        if (code === 0) finish();
        else fail(`Claude CLI exited ${code}: ${stderr.slice(0, 300)}`);
      });

      // Feed the prompt now that stdout handlers are attached, then close stdin
      // so the CLI produces output.
      child.stdin?.on('error', (err) =>
        log.warn({ err }, 'Claude CLI stdin error while writing prompt'),
      );
      child.stdin?.end(Buffer.from(prompt, 'utf8'));
    },
  });
}
