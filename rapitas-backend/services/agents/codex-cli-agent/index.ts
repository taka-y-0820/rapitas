/**
 * CodexCliAgent
 *
 * Spawns OpenAI Codex CLI as a child process to execute tasks.
 * Delegates prompt building, output parsing, and process management to sub-modules.
 *
 * Codex CLI: @openai/codex (npm install -g @openai/codex)
 * https://github.com/openai/codex
 */

import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { BaseAgent } from '../base-agent';
import type { AgentCapability, AgentTask, AgentExecutionResult } from '../base-agent';
import { createInitialWaitingState } from '../question-detection';
import type { QuestionWaitingState } from '../question-detection';
import { createLogger } from '../../../config/logger';
import { getProjectRoot } from '../../../config';
import type { CodexCliAgentConfig } from './types';
import { resolveCliPath } from './types';
import { buildStructuredPrompt } from './prompt-builder';
import { parseArtifacts, parseCommits } from './output-parser';
import { spawnCodexProcess } from './process-runner';
import type { ProcessRunnerState } from './process-runner';

export type { CodexCliAgentConfig } from './types';

const logger = createLogger('codex-cli-agent');

/** @internal Re-export for convenience */
export { resolveCliPath };

export class CodexCliAgent extends BaseAgent {
  private process: ChildProcess | null = null;
  private config: CodexCliAgentConfig;
  private outputBuffer: string = '';
  private errorBuffer: string = '';
  private lineBuffer: string = '';
  private detectedQuestion: QuestionWaitingState = createInitialWaitingState();
  private activeTools: Map<string, { name: string; startTime: number; info: string }> = new Map();
  private codexSessionId: string | null = null;

  constructor(id: string, name: string, config: CodexCliAgentConfig = {}) {
    super(id, name, 'codex');
    this.config = {
      timeout: 900000, // 15 minutes default
      ...config,
    };
  }

  /**
   * Override the log prefix so investigation-mode runs are clearly marked
   * as "Research Agent (codex)" in logs / UI streams. The Development Agent
   * label was misleading users and the agent itself, since codex inferred
   * "implementation task" from the tag and then ignored read-only
   * instructions.
   */
  override get logPrefix(): string {
    if (this.config.investigationMode) {
      return `[Research Agent (codex)]`;
    }
    return `[${this.name}]`;
  }

  getCapabilities(): AgentCapability {
    return {
      codeGeneration: true,
      codeReview: true,
      taskAnalysis: true,
      fileOperations: true,
      terminalAccess: true,
      gitOperations: true,
      webSearch: true,
    };
  }

  async execute(
    task: AgentTask,
    _options?: Record<string, unknown>,
  ): Promise<AgentExecutionResult> {
    this.status = 'running';
    this.outputBuffer = '';
    this.errorBuffer = '';
    this.lineBuffer = '';
    this.detectedQuestion = createInitialWaitingState();
    this.activeTools.clear();
    this.codexSessionId = null;
    const startTime = Date.now();

    const fs = await import('fs/promises');
    const workDir = task.workingDirectory || this.config.workingDirectory || getProjectRoot();

    try {
      const stats = await fs.stat(workDir);
      if (!stats.isDirectory()) {
        this.status = 'failed';
        return {
          success: false,
          output: '',
          errorMessage: `Working directory is not a directory: ${workDir}`,
          executionTimeMs: Date.now() - startTime,
        };
      }
    } catch {
      this.status = 'failed';
      return {
        success: false,
        output: '',
        errorMessage: `Working directory does not exist: ${workDir}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    const availabilityError = await this.getAvailabilityError();
    if (availabilityError) {
      this.status = 'failed';
      return {
        success: false,
        output: '',
        errorMessage: availabilityError,
        executionTimeMs: Date.now() - startTime,
      };
    }

    const prompt = this.buildPrompt(task);

    logger.info(`${this.logPrefix} Using ${task.analysisInfo ? 'structured' : 'simple'} prompt`);
    if (task.analysisInfo) {
      logger.info(`${this.logPrefix} Analysis complexity: ${task.analysisInfo.complexity}`);
      logger.info(`${this.logPrefix} Subtasks count: ${task.analysisInfo.subtasks?.length || 0}`);
    }

    // Build a shared state object so process-runner can mutate it
    const runnerState: ProcessRunnerState = {
      process: null,
      outputBuffer: this.outputBuffer,
      errorBuffer: this.errorBuffer,
      lineBuffer: this.lineBuffer,
      detectedQuestion: this.detectedQuestion,
      activeTools: this.activeTools,
      codexSessionId: this.codexSessionId,
      actualModel: null,
      status: this.status,
    };

    // Extend config with task-level overrides (resume session, investigation
    // mode forwarded from ExecutionOptions). Investigation mode is the safe
    // pattern for research/plan/review phases — read-only sandbox + `-o file`
    // capture so codex cannot modify the workspace.
    const effectiveConfig: CodexCliAgentConfig = {
      ...this.config,
      resumeSessionId: this.config.resumeSessionId ?? task.resumeSessionId,
      investigationMode: this.config.investigationMode ?? task.investigationMode,
      investigationOutputType: this.config.investigationOutputType ?? task.investigationOutputType,
      outputLastMessageFile: this.config.outputLastMessageFile ?? task.outputLastMessageFile,
    };

    const result = await spawnCodexProcess(
      effectiveConfig,
      workDir,
      prompt,
      runnerState,
      {
        emitOutput: (text, isError) => this.emitOutput(text, isError),
        emitQuestionDetected: (payload) =>
          this.emitQuestionDetected({
            question: payload.question,
            questionType: payload.questionType,
            questionDetails: payload.questionDetails,
            questionKey: payload.questionKey,
          }),
        onSessionId: (id) => {
          this.codexSessionId = id;
        },
        onQuestionDetected: (state) => {
          this.detectedQuestion = state;
        },
        onStatusChange: (status) => {
          this.status = status as typeof this.status;
        },
        logPrefix: this.logPrefix,
      },
      startTime,
      parseArtifacts,
      parseCommits,
    );

    // Sync back mutable state from runner
    this.process = runnerState.process;
    this.outputBuffer = runnerState.outputBuffer;
    this.errorBuffer = runnerState.errorBuffer;
    this.lineBuffer = runnerState.lineBuffer;
    this.detectedQuestion = runnerState.detectedQuestion;
    this.codexSessionId = runnerState.codexSessionId;

    return result;
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.status = 'cancelled';
      this.emitOutput(`\n${this.logPrefix} Stopping execution...\n`);

      const isWindows = process.platform === 'win32';

      if (isWindows) {
        try {
          const pid = this.process.pid;
          if (pid) {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
            logger.info(`${this.logPrefix} Process ${pid} killed via taskkill`);
          }
        } catch (e) {
          // Same benign race as agent-core.ts's stop() — the process usually
          // already exited between the null-check and the call; the fallback
          // below recovers it.
          logger.warn({ err: e }, `${this.logPrefix} taskkill failed`);
          try {
            this.process.kill();
          } catch (killErr) {
            logger.warn({ err: killErr }, `${this.logPrefix} process.kill() also failed`);
          }
        }
        // Windows holds file handles for a brief window after taskkill /T /F
        // before the kernel releases them. Without this delay, the immediate
        // worktree removal after stop() returns hits EBUSY / Permission
        // denied because rg / pnpm / node spawned by codex are still draining.
        // 1.5s is enough in practice; the caller still retries with backoff.
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } else {
        this.process.kill('SIGINT');

        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (!this.process || this.process.killed) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);

          setTimeout(() => {
            if (this.process && !this.process.killed) {
              this.process.kill('SIGTERM');
            }
            clearInterval(checkInterval);
            resolve();
          }, 5000);
        });
      }

      this.process = null;
    }
  }

  override async pause(): Promise<boolean> {
    if (this.process && this.status === 'running') {
      this.process.kill('SIGSTOP');
      this.status = 'paused';
      this.emitOutput(`\n${this.logPrefix} Execution paused\n`);
      return true;
    }
    return false;
  }

  override async resume(): Promise<boolean> {
    if (this.process && this.status === 'paused') {
      this.process.kill('SIGCONT');
      this.status = 'running';
      this.emitOutput(`\n${this.logPrefix} Execution resumed\n`);
      return true;
    }
    return false;
  }

  async isAvailable(): Promise<boolean> {
    const availabilityError = await this.getAvailabilityError();
    if (availabilityError) logger.warn(`${this.logPrefix} ${availabilityError}`);
    return !availabilityError;
  }

  async validateConfig(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    const availabilityError = await this.getAvailabilityError();
    if (availabilityError) errors.push(availabilityError);

    if (this.config.apiKey) {
      logger.info(`${this.logPrefix} Using provided API key`);
    } else if (process.env.OPENAI_API_KEY) {
      logger.info(`${this.logPrefix} Using OPENAI_API_KEY from environment`);
    } else {
      logger.info(
        `${this.logPrefix} No API key provided - will use ChatGPT account authentication`,
      );
    }

    if (this.config.workingDirectory) {
      try {
        const fs = await import('fs/promises');
        const stats = await fs.stat(this.config.workingDirectory);
        if (!stats.isDirectory()) {
          errors.push(`Working directory is not a directory: ${this.config.workingDirectory}`);
        }
      } catch {
        errors.push(`Working directory does not exist: ${this.config.workingDirectory}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get the Codex session ID from the most recent execution.
   *
   * @returns Session ID string, or null if no session has been started / セッションIDまたはnull
   */
  getSessionId(): string | null {
    return this.codexSessionId;
  }

  /** Delegate to standalone buildStructuredPrompt with agent's log prefix. */
  private buildPrompt(task: AgentTask): string {
    return buildStructuredPrompt(task, this.logPrefix);
  }

  private async runCodexCommand(
    args: string[],
    timeoutMs: number = 10000,
  ): Promise<{ ok: boolean; stderr: string }> {
    const isWindows = process.platform === 'win32';
    const codexPath = await resolveCliPath(
      process.env.CODEX_CLI_PATH || (isWindows ? 'codex.cmd' : 'codex'),
    );

    return new Promise((resolve) => {
      // NOTE: With `shell: true`, Node.js does NOT auto-quote arguments
      // containing spaces. e.g. ['debug', 'prompt-input', 'health check']
      // becomes the literal command line `codex debug prompt-input health
      // check`, and Codex parses `check` as an extra positional argument
      // ("unexpected argument 'check' found"). Build the command line
      // ourselves with proper quoting to avoid this.
      const quotedCodex = codexPath.includes(' ') ? `"${codexPath}"` : codexPath;
      const quotedArgs = args
        .map((arg) =>
          /[\s"]/.test(arg) ? `"${arg.replace(/"/g, isWindows ? '""' : '\\"')}"` : arg,
        )
        .join(' ');
      const command = `${quotedCodex} ${quotedArgs}`;

      const proc = spawn(command, [], {
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';

      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ ok: false, stderr: `Timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ ok: code === 0, stderr });
      });
      proc.on('error', (error) => {
        clearTimeout(timeout);
        resolve({ ok: false, stderr: error.message });
      });
    });
  }

  private async getAvailabilityError(): Promise<string | null> {
    const runtimeAccessError = await this.getRuntimeAccessError();
    if (runtimeAccessError) return runtimeAccessError;

    const versionCheck = await this.runCodexCommand(['--version']);
    if (!versionCheck.ok) {
      return 'Codex CLI is not installed or not available in PATH. Install with: npm install -g @openai/codex';
    }

    // `codex --version` can succeed even when the CLI cannot open its session
    // store. `debug prompt-input` exercises the same session-file path without
    // making a model/network request, so it is a cheap runtime readiness probe.
    const sessionCheck = await this.runCodexCommand(['debug', 'prompt-input', 'health check']);
    if (!sessionCheck.ok) {
      return `Codex CLI cannot start a session. ${sessionCheck.stderr.trim() || 'Session probe failed.'}`;
    }

    return null;
  }

  /**
   * Codex can print a version even when it cannot start a session. On Windows
   * this commonly happens when ~/.codex/sessions is owned/locked by another
   * process. Treat that as unavailable so routing does not pick a broken agent.
   */
  private async getRuntimeAccessError(): Promise<string | null> {
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    const sessionsDir = join(codexHome, 'sessions');

    const checkWritableIfExists = async (path: string, label: string): Promise<string | null> => {
      try {
        await stat(path);
      } catch (error) {
        const code = (error as { code?: string }).code;
        return code === 'ENOENT' ? null : `${label} を確認できません: ${path}`;
      }

      try {
        await access(path, fsConstants.R_OK | fsConstants.W_OK);
        return null;
      } catch {
        return `${label} に読み書きできません: ${path}`;
      }
    };

    return (
      (await checkWritableIfExists(sessionsDir, 'Codex セッションディレクトリ')) ||
      (await checkWritableIfExists(codexHome, 'Codex ホームディレクトリ'))
    );
  }
}
