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
import { auxCliCleanup } from './aux-cli-cleanup';
import { prepareAuxCli } from './aux-cli-launch';
import { createClaudeCliStream } from './claude-cli-stream';
import { ClaudeCliUnavailableError } from './cli-errors';

export { ClaudeCliUnavailableError } from './cli-errors';

const log = createLogger('ai-client:claude-cli');

/** Build the platform-specific spawn command/args (UTF-8 code page on Windows). */
function buildSpawnCommand(claudePath: string, args: string[]): [string, string[]] {
  if (process.platform !== 'win32') return [claudePath, args];
  const argsString = args
    .map((arg) =>
      !arg || arg.includes(' ') || arg.includes('&') || arg.includes('|') ? `"${arg}"` : arg,
    )
    .join(' ');
  const quotedPath = claudePath.includes(' ') ? `"${claudePath}"` : claudePath;
  return [`chcp 65001 >NUL 2>&1 && ${quotedPath} ${argsString}`, []];
}

/** Whether the CLI responds to `--version` within 10s. */
async function checkClaudeAvailable(): Promise<boolean> {
  await acquireSlot();
  try {
    await spawnCli(['--version'], '', 10000);
    return true;
  } catch {
    return false;
  } finally {
    releaseSlot();
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
let availabilityPending: Promise<boolean> | null = null;

/**
 * Whether the Claude Code CLI binary responds to `--version`.
 *
 * @returns true if the CLI is invokable / CLIが起動可能ならtrue
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache;
  availabilityPending ??= checkClaudeAvailable()
    .then((result) => {
      availabilityCache = result;
      return result;
    })
    .finally(() => {
      availabilityPending = null;
    });
  return availabilityPending;
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

/** Auxiliary calls generate text; they do not need the default coding-agent prompt or tools. */
const TEXT_ONLY_ARGS = [
  '--effort',
  'low',
  '--tools',
  '',
  '--system-prompt',
  'You are a text processing assistant. Follow the supplied instructions and return only the requested text. Do not use tools.',
];

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
async function spawnCli(
  args: string[],
  prompt: string,
  timeoutMs = CLI_TIMEOUT_MS,
): Promise<string> {
  const claudePath = await getClaudePathAsync();
  auxCliCleanup.assertReady();
  const [command, spawnArgs] = buildSpawnCommand(claudePath, args);
  const launch = await prepareAuxCli(command, tmpdir(), buildCliEnv(), spawnArgs);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        launch?.command ?? command,
        launch?.args ?? spawnArgs,
        launch?.options ?? {
          cwd: tmpdir(), // isolate from the repo even if a tool slipped through
          shell: true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildCliEnv(),
        },
      );
    } catch (error) {
      // A synchronous spawn failure must release local ownership while preserving its durable hold.
      void (launch ? launch.stop() : Promise.resolve())
        .catch((cleanupError) => {
          log.error({ cleanupError }, 'Auxiliary launch cleanup unresolved');
        })
        .finally(() => reject(error));
      return;
    }
    const untrack = trackAuxCliChild(child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const confirmed = launch?.attach(child) ?? Promise.resolve();
    const cleanup = async (stop: boolean) => {
      if (launch) {
        if (stop) await launch.stop();
        else await launch.finish();
        untrack();
      } else if (stop) auxCliCleanup.stop(child);
      else untrack();
    };
    const fail = async (message: string, stop: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await cleanup(stop);
      } catch (error) {
        log.error({ error, pid: child.pid }, 'Auxiliary CLI cleanup unresolved');
        message += `; cleanup unresolved: ${error instanceof Error ? error.message : String(error)}`;
      }
      reject(new ClaudeCliUnavailableError(message));
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (!settled) stdout += d;
    });
    child.stderr?.on('data', (d: string) => {
      if (!settled) stderr += d;
    });

    const timer = setTimeout(() => {
      void fail(`Claude CLI timed out after ${timeoutMs}ms`, true);
    }, timeoutMs);

    child.on('error', (err) => {
      void fail(`Claude CLI spawn failed: ${err.message}`, Boolean(launch));
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        await cleanup(false);
      } catch (error) {
        reject(
          new ClaudeCliUnavailableError(
            `Claude CLI cleanup unresolved: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
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
    void confirmed.then(
      () => {
        if (!settled) child.stdin?.end(buf);
      },
      (error) =>
        fail(
          `Claude CLI ownership failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        ),
    );
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
      ...TEXT_ONLY_ARGS,
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
    ...TEXT_ONLY_ARGS,
  ];

  await acquireSlot();
  let claudePath: string;
  try {
    claudePath = await getClaudePathAsync();
    auxCliCleanup.assertReady();
  } catch (error) {
    releaseSlot();
    throw error;
  }
  const [command, spawnArgs] = buildSpawnCommand(claudePath, args);
  let launch: Awaited<ReturnType<typeof prepareAuxCli>>;
  let child: ChildProcess;
  try {
    launch = await prepareAuxCli(command, tmpdir(), buildCliEnv(), spawnArgs);
    child = spawn(
      launch?.command ?? command,
      launch?.args ?? spawnArgs,
      launch?.options ?? {
        cwd: tmpdir(),
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildCliEnv(),
      },
    );
  } catch (error) {
    if (launch!)
      await launch
        .stop()
        .catch((cleanupError) =>
          log.error({ cleanupError }, 'Auxiliary launch cleanup unresolved'),
        );
    releaseSlot();
    throw error;
  }
  const untrack = trackAuxCliChild(child);
  const confirmed = launch?.attach(child) ?? Promise.resolve();
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  return createClaudeCliStream(
    child,
    prompt,
    launch,
    confirmed,
    untrack,
    releaseSlot,
    CLI_TIMEOUT_MS,
  );
}
