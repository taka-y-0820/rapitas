/**
 * claude-execution-runner
 *
 * The body of the Promise inside `ClaudeCodeAgent.execute()`. Spawns the
 * Claude Code CLI as a child process, wires up the output-parser Worker,
 * registers stdout/stderr/close/error handlers, and resolves the agent's
 * execute() promise.
 *
 * Extracted from agent-core.ts purely to keep that file under the
 * 500-line per-file limit. The function reads and writes the agent's
 * `/** @internal *\/` public state directly.
 */
import { spawnLowPriority } from '../process-priority';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentTask, AgentExecutionResult } from '../base-agent';
import type { WorkerOutputMessage, WorkerInputMessage } from '../../../workers/output-parser-types';
import { createLogger } from '../../../config/logger';
import {
  registerProcess,
  unregisterProcess,
  killProcessTreeSafely,
  captureDescendants,
} from '../agent-process-tracker';
import { startResourceSampling, stopResourceSampling } from '../process-resource-sampler';
import { getClaudePath, buildSpawnCommand } from './cli-utils';
import { buildSanitizedSpawnEnv } from '../../../utils/agent';
import { buildStructuredPrompt } from './prompt-builder';
import { startIdleMonitor } from './idle-monitor';
import type { ClaudeCodeAgent } from './agent-core';
import { formatPromptPreview } from '../../../utils/agent/prompt-preview';

const logger = createLogger('claude-code-agent');

/**
 * Build the Claude Code CLI argument list from agent config. Pure function.
 *
 * @param agent - Host agent providing `.config` and `.logPrefix` only — safe to
 *   call with any object shape that has those two fields (see unit tests). / `.config`と`.logPrefix`のみ使用
 * @returns CLI args plus any log lines the caller should emit / CLI引数と呼び出し元が出力すべきログ行
 */
export function buildClaudeArgs(agent: ClaudeCodeAgent): { args: string[]; logExtras: string[] } {
  const cfg = agent.config;
  const args: string[] = ['--print', '--verbose', '--output-format', 'stream-json'];
  const logExtras: string[] = [];

  if (cfg.resumeSessionId) {
    args.push('--resume', cfg.resumeSessionId);
    logExtras.push(
      `${agent.logPrefix} Resuming specific session with --resume ${cfg.resumeSessionId}`,
    );
  } else if (cfg.continueConversation) {
    args.push('--continue');
    logExtras.push(`${agent.logPrefix} Continuing most recent conversation with --continue`);
  }

  if (cfg.dangerouslySkipPermissions) {
    // NOTE(security): This agent runs fully headless (spawned with stdio
    // pipes, no TTY — see runClaudeExecution below) for up to the phase
    // timeout (tens of minutes) with nobody available to answer a permission
    // prompt. `--permission-mode acceptEdits` was evaluated as a narrower
    // alternative but does NOT auto-approve arbitrary Bash (only a handful of
    // filesystem commands like mkdir/rm/mv) — every test/build/git/lint
    // command this workflow needs to run would still prompt and, with no TTY
    // to answer it, the run aborts instead of hanging. `--permission-mode
    // dontAsk` avoids the abort but requires enumerating exact allowed Bash
    // command patterns up front, which is incompatible with a general-purpose
    // coding agent that decides its own test/build tooling per task. Bypass
    // therefore stays, compensated by: (1) worktree isolation — the agent
    // only ever touches its own disposable worktree, never the primary
    // checkout; (2) a sanitized spawn env (buildSpawnEnv below) that strips
    // ENCRYPTION_KEY/DATABASE_URL/*_TOKEN/etc. before the process starts, so
    // there is nothing sensitive in-process for a prompt-steered command to
    // read; (3) the `--disallowedTools` denylist below, which removes
    // network-egress and meta/recursion tools this workflow never needs.
    args.push('--dangerously-skip-permissions');
    // Also set permission-mode to ensure all file edits (including .claude/) are allowed
    args.push('--permission-mode', 'bypassPermissions');
  }
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.maxTokens) args.push('--max-tokens', String(cfg.maxTokens));

  // NOTE(security): No --mcp-config is ever passed to this spawn, so without
  // --strict-mcp-config the CLI would still ambiently load MCP servers from
  // the machine's global (~/.claude.json) or project (.mcp.json) config —
  // reachable tools this workflow's prompts never sanction and that an
  // implementer/verifier agent has no legitimate need for. --strict-mcp-config
  // restricts loading to --mcp-config sources only, and since none is passed
  // here that means zero MCP servers are loaded for spawned agents.
  args.push('--strict-mcp-config');

  // NOTE: Disable worktree tools to prevent the spawned CLI from creating nested worktrees
  // that conflict with rapitas-managed worktrees and could corrupt .git/ directory structure.
  // NOTE(security): WebFetch/WebSearch (network egress), ToolSearch/Skill (can
  // indirectly reach tools/skills outside this denylist, including network
  // ones), and Task (recursive sub-agent spawning — costs tokens/time and
  // isn't part of the sanctioned workflow, which registers subtasks via the
  // HTTP API instead) are blocked unconditionally: no implementer/verifier/
  // research prompt in this codebase instructs the agent to use them, so
  // they are pure attack surface with no functional cost to removing them.
  const disallowed = [
    'EnterWorktree',
    'ExitWorktree',
    'WebFetch',
    'WebSearch',
    'ToolSearch',
    'Skill',
    'Task',
    // NOTE(security): destructive git operations are denied even in mutating
    // mode. The agent works in a disposable worktree, but its branch may back
    // an OPEN PR (force-push auto-closes/orphans it — observed with PR #253),
    // `git stash` on a shared branch has clobbered real work before, and
    // reset --hard / clean erase the agent's own uncommitted progress that the
    // repair loop may still need. Prefix rules — a determined prompt injection
    // can rephrase, so the worktree isolation guard remains the real boundary;
    // this denylist removes the ACCIDENTAL destruction class.
    'Bash(git push --force:*)',
    'Bash(git push -f:*)',
    'Bash(git reset --hard:*)',
    'Bash(git clean:*)',
    'Bash(git stash:*)',
    'Bash(git switch:*)',
    'PowerShell(git push --force:*)',
    'PowerShell(git push -f:*)',
    'PowerShell(git reset --hard:*)',
    'PowerShell(git clean:*)',
    'PowerShell(git stash:*)',
    'PowerShell(git switch:*)',
  ];
  if (cfg.investigationMode) {
    // Investigation mode (research / planner): additionally block
    // ALL mutating tools so the agent can't bypass the parent-only workflow
    // contract by writing files directly, running shell commands (curl /
    // git / pnpm), or invoking the workflow API itself. Read-only tools
    // (Read / Glob / Grep) remain available so the agent can still
    // investigate the codebase.
    const investigationExtras = [
      'Bash',
      'PowerShell',
      'Edit',
      'Write',
      // NOTE: 'MultiEdit' removed — current Claude Code CLI has no such tool and
      // logged "Permission deny rule MultiEdit matches no known tool" every run.
      // File mutation is already blocked via Edit/Write/NotebookEdit.
      'NotebookEdit',
    ];
    disallowed.push(...investigationExtras);
    logExtras.push(
      `${agent.logPrefix} Investigation mode: blocking write/shell tools (${investigationExtras.join(',')})`,
    );
  }
  args.push('--disallowedTools', disallowed.join(','));

  return { args, logExtras };
}

/**
 * Build the env passed to the Claude Code CLI subprocess.
 *
 * @returns Sanitized environment (see buildSanitizedSpawnEnv) plus CLI-friendly overrides / サニタイズ済み環境
 */
export function buildSpawnEnv(): NodeJS.ProcessEnv {
  const isWindows = process.platform === 'win32';
  // NOTE: Heap cap for EVERY node process in the agent's tree (NODE_OPTIONS is
  // inherited by child processes, so `next build` etc. get it too). Task 553:
  // an agent-run webpack build with splitChunks.maxSize grew to 48 GB RSS and
  // starved the host (1.9 GB free of 64 GB) — an explicit OOM failure the agent
  // can see and self-repair beats a silent host-wide stall. 8192 MB is generous:
  // CI runners build this frontend within ~7 GB total RAM.
  const heapMb = Math.max(
    1024,
    parseInt(process.env.RAPITAS_AGENT_NODE_HEAP_MB ?? '8192', 10) || 8192,
  );
  // NOTE: The spawned CLI is prompt-steerable (the task prompt itself can ask
  // it to print/exfiltrate its own env), so start from a sanitized base —
  // never the raw inherited env — to keep ENCRYPTION_KEY/DATABASE_URL/
  // GITHUB_TOKEN/etc out of its reach.
  return buildSanitizedSpawnEnv({
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CI: '1',
    TERM: 'dumb',
    PYTHONUNBUFFERED: '1',
    NODE_OPTIONS: `--no-warnings --max-old-space-size=${heapMb}`,
    ...(isWindows && {
      LANG: 'en_US.UTF-8',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      CHCP: '65001', // Enable UTF-8 mode on Windows 10+
    }),
  });
}

/** Stream the prompt to stdin in 16 KB chunks (avoids buffering issues). */
async function writePromptToStdin(agent: ClaudeCodeAgent, prompt: string): Promise<void> {
  if (!agent.process?.stdin) {
    logger.info(`${agent.logPrefix} stdin is not available`);
    return;
  }
  const stdin = agent.process.stdin;
  const CHUNK_SIZE = 16384; // 16KB chunks

  stdin.on('error', (err) => {
    logger.error({ err }, `${agent.logPrefix} stdin error`);
  });

  // Convert prompt to UTF-8 Buffer to prevent encoding issues
  const promptBuffer = Buffer.from(prompt, 'utf8');
  logger.info(`${agent.logPrefix} Prompt buffer size: ${promptBuffer.length} bytes`);

  for (let i = 0; i < promptBuffer.length; i += CHUNK_SIZE) {
    const chunk = promptBuffer.subarray(i, Math.min(i + CHUNK_SIZE, promptBuffer.length));
    const canContinue = stdin.write(chunk);
    if (!canContinue) {
      await new Promise<void>((r) => stdin.once('drain', r));
    }
  }

  stdin.end();
  logger.info(
    `${agent.logPrefix} Prompt written to stdin (${promptBuffer.length} bytes) in chunks`,
  );
}

/**
 * Run the spawn-and-wait body for ClaudeCodeAgent.execute().
 *
 * @param agent - Host agent providing state, config, and emitters.
 * @param task - Task to execute.
 * @param workDir - Verified working directory.
 * @param startTime - Promise start timestamp.
 * @param timeout - Idle/total timeout in ms.
 * @param resolve - Promise resolver from execute().
 * @param buildResolveAfterParse - Bound `agent.buildResolveAfterParse`.
 */
export async function runClaudeExecution(
  agent: ClaudeCodeAgent,
  task: AgentTask,
  workDir: string,
  startTime: number,
  timeout: number,
  resolve: (result: AgentExecutionResult) => void,
  buildResolveAfterParse: (
    code: number | null,
    workDir: string,
    startTime: number,
    resolve: (result: AgentExecutionResult) => void,
    resourceStats?: { cpuTimeMs: number | null; peakRssKb: number | null },
  ) => () => void,
): Promise<void> {
  // In --resume or --continue mode, use the prompt (user response) as-is
  // Adding extra text would break the session resumption context
  const isResumeMode = !!(agent.config.resumeSessionId || agent.config.continueConversation);
  const prompt = isResumeMode
    ? task.description || task.title
    : buildStructuredPrompt(task, workDir, agent.logPrefix);

  if (task.analysisInfo) {
    logger.info(`${agent.logPrefix} Using structured prompt with AI task analysis`);
    logger.info(`${agent.logPrefix} Analysis complexity: ${task.analysisInfo.complexity}`);
    logger.info(`${agent.logPrefix} Subtasks count: ${task.analysisInfo.subtasks?.length || 0}`);
  } else {
    logger.info(`${agent.logPrefix} Using simple prompt (no AI task analysis)`);
  }

  // Save prompt to temp file to bypass Windows command-line character limit
  const tempDir = join(tmpdir(), 'rapitas-prompts');
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  const promptFile = join(tempDir, `prompt-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt, 'utf-8');

  const { args, logExtras } = buildClaudeArgs(agent);
  for (const line of logExtras) logger.info(line);

  const claudePath = await getClaudePath();
  const [finalCommand, finalArgs] = buildSpawnCommand(claudePath, args);

  logger.info(`${agent.logPrefix} Platform: ${process.platform} / Claude path: ${claudePath}`);
  logger.info(`${agent.logPrefix} Work directory: ${workDir}`);
  logger.info(`${agent.logPrefix} Prompt length: ${prompt.length} chars / Timeout: ${timeout}ms`);
  logger.info(`${agent.logPrefix} Args: ${args.join(' ')}`);

  agent.emitOutputInternal(`${agent.logPrefix} Starting execution...\n`);
  agent.emitOutputInternal(`${agent.logPrefix} Model: ${agent.config.model ?? 'default'}\n`);
  agent.emitOutputInternal(`${agent.logPrefix} Working directory: ${workDir}\n`);
  agent.emitOutputInternal(`${agent.logPrefix} Timeout: ${timeout / 1000}s\n`);
  // One line only — untagged continuation lines render as agent narrative (formatPromptPreview).
  agent.emitOutputInternal(`${agent.logPrefix} Prompt: ${formatPromptPreview(prompt)}\n\n`);

  const cleanupPromptFile = () => {
    try {
      unlinkSync(promptFile);
    } catch {
      // Prompt file may already be deleted
    }
  };

  try {
    logger.info(`${agent.logPrefix} Final command: ${finalCommand}`);

    agent.process = spawnLowPriority(finalCommand, finalArgs, {
      cwd: workDir,
      shell: true,
      windowsHide: true, // NOTE: Prevents TCP handle inheritance — stops CLI process from inheriting port 3001 socket
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSpawnEnv(),
    });

    if (agent.process.stdout) agent.process.stdout.setEncoding('utf8');
    if (agent.process.stderr) agent.process.stderr.setEncoding('utf8');

    logger.info(`${agent.logPrefix} Process spawned with PID: ${agent.process.pid}`);
    agent.emitOutputInternal(`${agent.logPrefix} Process PID: ${agent.process.pid}\n`);

    if (agent.process.pid) {
      registerProcess({
        pid: agent.process.pid,
        role: 'cli-agent',
        taskId: task.id,
        startedAt: new Date().toISOString(),
        parentPid: process.pid,
      });
      startResourceSampling(agent.process.pid);
    }

    writePromptToStdin(agent, prompt).catch((err) => {
      logger.error({ err }, `${agent.logPrefix} Failed to write prompt to stdin`);
    });

    agent.lineBuffer = '';

    // Start idle and timeout monitors
    const monitor = startIdleMonitor(agent.logPrefix, timeout, startTime, {
      onFlushLineBuffer: (content) => {
        agent.outputBuffer += content;
        agent.emitOutputInternal(content);
        agent.lineBuffer = '';
      },
      onTimeout: (result) => {
        agent.setStatusInternal('failed');
        resolve(result);
      },
      getLineBuffer: () => agent.lineBuffer,
      getOutputBufferLength: () => agent.outputBuffer.length,
      getOutputBuffer: () => agent.outputBuffer,
      getErrorBuffer: () => agent.errorBuffer,
      getStatus: () => agent.getStatus(),
      getProcess: () => agent.process,
      setIdleTimeoutForceKilled: (v) => {
        agent.idleTimeoutForceKilled = v;
      },
      setWallClockTimeoutForceKilled: (v) => {
        agent.wallClockTimeoutForceKilled = v;
      },
    });

    // Spawn a Worker for output parsing
    agent.parserWorker = new Worker(
      new URL('../../../workers/output-parser-worker.ts', import.meta.url).href,
    );
    agent.parserWorker.postMessage({
      type: 'configure',
      config: {
        timeoutSeconds: agent.config.timeout ? Math.floor(agent.config.timeout / 1000) : undefined,
        logPrefix: agent.logPrefix,
      },
    } satisfies WorkerInputMessage);

    agent.parserWorker.onmessage = (event: MessageEvent<WorkerOutputMessage>) => {
      agent.handleWorkerMessageInternal(event.data);
    };

    agent.parserWorker.onerror = (error: ErrorEvent) => {
      logger.error({ errorMessage: error.message }, `${agent.logPrefix} Worker uncaught error`);
    };

    agent.process.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      monitor.recordOutput();
      monitor.markReceivedOutput();

      const elapsedMs = Date.now() - startTime;
      logger.info(
        `${agent.logPrefix} First stdout received after ${elapsedMs}ms (${chunk.length} chars)`,
      );

      // Delegate chunk to Worker (parsing runs on the Worker thread)
      try {
        agent.parserWorker?.postMessage({
          type: 'parse-chunk',
          data: chunk,
        } satisfies WorkerInputMessage);
      } catch (workerErr) {
        // Ignore if Worker is already terminated (InvalidStateError)
        logger.warn(
          { errorDetail: workerErr instanceof Error ? workerErr.message : workerErr },
          `${agent.logPrefix} Worker postMessage failed`,
        );
        agent.parserWorker = null;
      }
    });

    agent.process.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      agent.errorBuffer += output;
      monitor.recordOutput(); // Treat stderr as output to reset the timeout
      logger.info(
        `${agent.logPrefix} stderr (${output.length} chars): ${output.substring(0, 200)}`,
      );
      agent.emitOutputInternal(output, true);
    });

    let resourceStats: { cpuTimeMs: number | null; peakRssKb: number | null } = {
      cpuTimeMs: null,
      peakRssKb: null,
    };
    agent.process.on('close', (code: number | null) => {
      monitor.cleanup();
      cleanupPromptFile();
      if (agent.process?.pid) {
        const closedPid = agent.process.pid;
        unregisterProcess(closedPid);
        resourceStats = stopResourceSampling(closedPid);
        // On Windows, 'close' (stdio closed) does NOT guarantee the process
        // exited — a completed `claude --print` agent can stay resident and pile
        // up as a zombie. Reap its tree after a short grace if still alive.
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
      const executionTimeMs = Date.now() - startTime;

      if (agent.lineBuffer.trim()) {
        logger.info(
          `${agent.logPrefix} Processing remaining lineBuffer: ${agent.lineBuffer.substring(0, 200)}`,
        );
        agent.outputBuffer += agent.lineBuffer + '\n';
        agent.emitOutputInternal(agent.lineBuffer + '\n');
      }

      logger.info(
        `${agent.logPrefix} Process closed with code: ${code}, time: ${executionTimeMs}ms`,
      );
      logger.info(`${agent.logPrefix} Final output length: ${agent.outputBuffer.length}`);
      logger.info(`${agent.logPrefix} Last 500 chars of output: ${agent.outputBuffer.slice(-500)}`);
      if (agent.getStatus() === 'cancelled') {
        resolve({
          success: false,
          output: agent.outputBuffer,
          errorMessage: 'Execution cancelled',
          executionTimeMs,
          failureType: 'cancelled',
        });
        return;
      }

      // Skip if already resolved by timeout
      if (agent.getStatus() === 'failed') return;

      const resolveAfterParse = buildResolveAfterParse(
        code,
        workDir,
        startTime,
        resolve,
        resourceStats,
      );

      // If a Worker exists, send parse-complete and wait for results;
      // otherwise fall back to direct execution
      if (agent.parserWorker) {
        agent.workerArtifacts = [];
        agent.workerCommits = [];
        agent.onParseComplete = resolveAfterParse;

        try {
          agent.parserWorker.postMessage({
            type: 'parse-complete',
            outputBuffer: agent.outputBuffer,
          } satisfies WorkerInputMessage);
        } catch (workerErr) {
          logger.warn(
            { errorDetail: workerErr instanceof Error ? workerErr.message : workerErr },
            `${agent.logPrefix} Worker postMessage failed on parse-complete, falling back`,
          );
          agent.onParseComplete = null;
          resolveAfterParse();
        }
      } else {
        resolveAfterParse();
      }
    });

    agent.process.on('error', (error: Error) => {
      monitor.cleanup();
      cleanupPromptFile();
      if (agent.process?.pid) unregisterProcess(agent.process.pid);
      agent.setStatusInternal('failed');
      logger.error({ err: error }, `${agent.logPrefix} Process error`);
      agent.emitOutputInternal(`${agent.logPrefix} Error: ${error.message}\n`, true);

      const errorParts: string[] = [];
      errorParts.push(`Process startup error: ${error.message}`);
      if (agent.errorBuffer.trim()) {
        errorParts.push(`\n\n【Standard Error Output】\n${agent.errorBuffer.trim()}`);
      }
      if (agent.outputBuffer.trim()) {
        errorParts.push(`\n\n【Standard Output】\n${agent.outputBuffer.trim().slice(-500)}`);
      }

      resolve({
        success: false,
        output: agent.outputBuffer,
        errorMessage: errorParts.join(''),
        executionTimeMs: Date.now() - startTime,
      });
    });
  } catch (error) {
    // NOTE: This catch block handles errors before spawn, so monitor is not yet started
    cleanupPromptFile();
    agent.setStatusInternal('failed');
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, `${agent.logPrefix} Spawn error`);
    resolve({
      success: false,
      output: '',
      errorMessage,
      executionTimeMs: Date.now() - startTime,
    });
  }
}
