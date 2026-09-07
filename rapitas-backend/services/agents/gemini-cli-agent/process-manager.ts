/**
 * GeminiCliAgent — ProcessManager
 *
 * Handles spawning, stopping, pausing, and resuming the Gemini CLI child process.
 * Not responsible for parsing CLI output or building prompts.
 */

import { spawn, ChildProcess } from 'child_process';
import { spawnLowPriority } from '../process-priority';
import type { GeminiCliAgentConfig } from './types';
import { createLogger } from '../../../config/logger';
import { buildSanitizedSpawnEnv } from '../../../utils/agent';
import { registerProcess } from '../agent-process-tracker';
import { startResourceSampling } from '../process-resource-sampler';
import { resolveCliPathAsync } from '../../../utils/common/cli-path-resolver';

const logger = createLogger('gemini-cli-agent:process-manager');

export { resolveCliPathAsync as resolveCliPath } from '../../../utils/common/cli-path-resolver';

/**
 * Build the spawn arguments array for the Gemini CLI.
 *
 * IMPORTANT: The prompt itself is not passed in `args` any more — long
 * multi-line workflow prompts get truncated when serialised through
 * `shell: true` on Windows, which is why Gemini was responding to only
 * the first line ("use Japanese") and idling. The prompt is instead
 * piped via stdin in `spawnGeminiProcess`. The Gemini CLI auto-detects
 * piped stdin and consumes the body as the user prompt without entering
 * interactive mode.
 *
 * @param config - Agent configuration / エージェント設定
 * @param resumeId - Optional checkpoint/session ID to resume from / 再開用チェックポイントID
 * @returns Array of CLI argument strings
 */
export function buildCliArgs(config: GeminiCliAgentConfig, resumeId?: string | null): string[] {
  const args: string[] = [];

  // Pass -p with an empty trailing prompt: this triggers Gemini's
  // non-interactive (headless) mode while still letting us feed the actual
  // prompt body via stdin. The CLI documents `-p <prompt>` as
  // "Appended to input on stdin (if any)", so the empty -p value is
  // benign and stdin content becomes the effective prompt.
  // Without -p the CLI starts an interactive REPL which on Windows tries
  // to load node-pty and fails with `AttachConsole failed`.
  args.push('-p', '');
  args.push('--output-format', 'stream-json');
  // Skip the workspace-trust prompt; the working directory was already
  // opted into by the user via theme settings.
  args.push('--skip-trust');

  if (config.sandboxMode) {
    args.push('--sandbox');
  }

  if (config.yolo) {
    args.push('--yolo');
  }

  if (config.model) {
    args.push('-m', config.model);
  }

  if (resumeId) {
    args.push('--checkpoint', resumeId);
    logger.info(`[ProcessManager] Resuming from checkpoint: ${resumeId}`);
  }

  if (config.allowedTools && config.allowedTools.length > 0) {
    args.push('--allowlist', config.allowedTools.join(','));
  }

  // NOTE(security): Gemini CLI supports `--allowed-mcp-server-names` to
  // restrict which MCP servers may connect (mirroring Claude Code's
  // `--strict-mcp-config`, see claude-execution-runner.ts), but its
  // empty-list semantics (does an empty/omitted value mean "allow none" or
  // "no restriction"?) could not be confirmed — the Gemini CLI is not
  // installed in this environment to test against, and passing the flag with
  // unverified semantics risks silently allowing everything (worse than
  // today) rather than blocking it. Left as a follow-up: verify the flag's
  // empty-list behavior against a real Gemini CLI install before wiring it in.
  if (config.disallowedTools && config.disallowedTools.length > 0) {
    args.push('--denylist', config.disallowedTools.join(','));
  }

  return args;
}

/**
 * Build the environment variables for the Gemini CLI process.
 *
 * NOTE: The spawned CLI is prompt-steerable (the task prompt can ask it to
 * print/exfiltrate its own env), so start from a sanitized base — never the
 * raw inherited process.env — to keep ENCRYPTION_KEY/DATABASE_URL/tokens out
 * of its reach. GEMINI_ and GOOGLE_-prefixed vars are kept because the Gemini CLI
 * authenticates and configures itself with them.
 *
 * @param config - Agent configuration / エージェント設定
 * @returns Merged environment object
 */
export function buildProcessEnv(config: GeminiCliAgentConfig): NodeJS.ProcessEnv {
  const isWindows = process.platform === 'win32';

  const env: NodeJS.ProcessEnv = buildSanitizedSpawnEnv(
    {
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      CI: '1',
      TERM: 'dumb',
      // Gemini CLI refuses to run in directories it doesn't recognise as
      // "trusted" with exit code 55. Workflows operate against external
      // working directories the user has already opted into via theme
      // configuration, so flag the workspace as trusted unconditionally.
      // The user can override by setting GEMINI_CLI_TRUST_WORKSPACE=false
      // at the parent-process level if they want stricter behaviour.
      GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true',
    },
    ['GEMINI_', 'GOOGLE_'],
  );

  if (config.apiKey) {
    env.GEMINI_API_KEY = config.apiKey;
    env.GOOGLE_API_KEY = config.apiKey;
  }

  if (config.projectId) {
    env.GOOGLE_CLOUD_PROJECT = config.projectId;
  }

  if (config.location) {
    env.GOOGLE_CLOUD_LOCATION = config.location;
  }

  if (isWindows) {
    env.LANG = 'en_US.UTF-8';
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.CHCP = '65001';
  }

  return env;
}

/**
 * Spawn the Gemini CLI process and pipe the prompt via stdin.
 *
 * The prompt is delivered through stdin rather than the `-p` flag because
 * long workflow prompts (system header + role context + file-save curl
 * snippets) get truncated when serialised through `shell: true` on
 * Windows, making Gemini reply only to the first line. Piping through
 * stdin has no length / quoting limits.
 *
 * @param geminiPath - Resolved path to the Gemini CLI executable
 * @param args - CLI argument array (must NOT contain the prompt)
 * @param workDir - Working directory for the process
 * @param env - Environment variables
 * @param prompt - User prompt to feed via stdin
 * @returns Spawned ChildProcess instance
 */
export function spawnGeminiProcess(
  geminiPath: string,
  args: string[],
  workDir: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
): ChildProcess {
  const isWindows = process.platform === 'win32';

  let finalCommand: string;
  let finalArgs: string[];

  if (isWindows) {
    const argsString = args
      .map((arg) => {
        // Quote empty strings explicitly — without "" the empty value
        // collapses in cmd.exe and the next flag is consumed as the
        // missing value (`-p` followed by `--output-format` would
        // produce `Not enough arguments following: p`).
        if (arg === '') return '""';
        if (arg.includes(' ') || arg.includes('&') || arg.includes('|')) {
          return `"${arg}"`;
        }
        return arg;
      })
      .join(' ');
    const quotedPath = geminiPath.includes(' ') ? `"${geminiPath}"` : geminiPath;
    finalCommand = `chcp 65001 >NUL 2>&1 && ${quotedPath} ${argsString}`;
    finalArgs = [];
  } else {
    finalCommand = geminiPath;
    finalArgs = args;
  }

  logger.info(
    { promptChars: prompt.length },
    `[ProcessManager] Spawning Gemini (prompt via stdin)`,
  );

  const proc = spawnLowPriority(finalCommand, finalArgs, {
    cwd: workDir,
    shell: true,
    windowsHide: true, // NOTE: Prevents TCP handle inheritance — stops CLI process from inheriting port 3001 socket
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  if (proc.stdout) {
    proc.stdout.setEncoding('utf8');
  }
  if (proc.stderr) {
    proc.stderr.setEncoding('utf8');
  }

  // Track the PID so a crash of the parent backend (or a hung gemini process
  // outliving its own timeout) can still be found and reaped by dev.js's
  // startup cleanup / cleanupZombieProcesses — previously ONLY
  // claude-execution-runner.ts's spawn registered here, so gemini CLI
  // processes were invisible to the zombie sweep (and not `bun.exe`, so
  // killStrayBunProcesses' name-based scan misses them too). Unregistered in
  // stream-handler.ts's 'close' handler, where this process's lifecycle ends.
  if (proc.pid) {
    registerProcess({
      pid: proc.pid,
      role: 'cli-agent',
      startedAt: new Date().toISOString(),
      parentPid: process.pid,
    });
    startResourceSampling(proc.pid);
  }

  // Feed the prompt via stdin then close it so Gemini knows the prompt
  // is complete and can begin processing instead of waiting interactively.
  if (proc.stdin) {
    proc.stdin.setDefaultEncoding('utf8');
    proc.stdin.write(prompt);
    if (!prompt.endsWith('\n')) proc.stdin.write('\n');
    proc.stdin.end();
  }

  return proc;
}

/**
 * Stop a running Gemini CLI process.
 *
 * @param proc - The child process to stop / 停止するプロセス
 * @param logPrefix - Log prefix for identification / ログ識別プレフィックス
 */
export async function stopGeminiProcess(proc: ChildProcess, logPrefix: string): Promise<void> {
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    try {
      const pid = proc.pid;
      if (pid) {
        const { execSync } = require('child_process');
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        logger.info(`${logPrefix} Process ${pid} killed via taskkill`);
      }
    } catch (e) {
      // Same benign race as agent-core.ts's stop() — the process usually
      // already exited between the null-check and the call; the fallback
      // below recovers it.
      logger.warn({ err: e }, `${logPrefix} taskkill failed`);
      try {
        proc.kill();
      } catch (killErr) {
        logger.warn({ err: killErr }, `${logPrefix} process.kill() also failed`);
      }
    }
  } else {
    proc.kill('SIGINT');

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!proc || proc.killed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        if (proc && !proc.killed) {
          proc.kill('SIGTERM');
        }
        clearInterval(checkInterval);
        resolve();
      }, 5000);
    });
  }
}

/**
 * Check whether the Gemini CLI is available in PATH.
 *
 * @returns true if `gemini --version` exits with code 0 / 利用可能な場合はtrue
 */
export async function checkGeminiAvailability(): Promise<boolean> {
  const isWindows = process.platform === 'win32';
  const geminiPath = await resolveCliPathAsync(
    process.env.GEMINI_CLI_PATH || (isWindows ? 'gemini.cmd' : 'gemini'),
  );

  return new Promise((resolve) => {
    const proc = spawn(geminiPath, ['--version'], { shell: true });

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
