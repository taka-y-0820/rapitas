/**
 * ClaudeCodeAgent Core
 *
 * Spawns Claude Code CLI as a child process to execute tasks.
 * Delegates prompt building, CLI resolution, git diffing, question parsing, and idle monitoring
 * to sub-modules in this directory.
 */

import { execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { BaseAgent } from '../base-agent';
import type {
  AgentCapability,
  AgentTask,
  AgentExecutionResult,
  AgentArtifact,
  AgentStatus,
  GitCommitInfo,
} from '../base-agent';
import { createInitialWaitingState } from '../question-detection';
import type { QuestionWaitingState } from '../question-detection';
import type { WorkerOutputMessage } from '../../../workers/output-parser-types';
import { createLogger } from '../../../config/logger';
import { getProjectRoot } from '../../../config';
import { prisma } from '../../../config/database';
import { checkClaudeAvailable } from './cli-utils';
import { getAgentTimeoutMs } from '../execution-timeouts';
import { handleWorkerMessage } from './worker-message-handler';
import type { WorkerResultUsageSnapshot } from './worker-message-handler';
import { buildResolveAfterParse } from './execution-resolver';
import { runClaudeExecution } from './claude-execution-runner';

const logger = createLogger('claude-code-agent');

export type ClaudeCodeAgentConfig = {
  workingDirectory?: string;
  model?: string;
  dangerouslySkipPermissions?: boolean;
  timeout?: number; // milliseconds
  maxTokens?: number;
  continueConversation?: boolean; // Whether to continue the previous conversation
  resumeSessionId?: string; // Session ID used with --resume
  /**
   * When true, run as a read-only investigation agent: file edits, shell
   * execution and any tool that could mutate the workspace or call the
   * workflow API are added to `--disallowedTools`. Mirrors the codex
   * investigation contract so the parent process is the sole writer for
   * research.md / plan.md / verify.md.
   */
  investigationMode?: boolean;
  /**
   * Phase output type. Verifier evidence may succeed without a code diff,
   * independently of investigationMode's read-only tool restrictions.
   */
  investigationOutputType?: 'research' | 'plan' | 'review' | 'verify';
};

export class ClaudeCodeAgent extends BaseAgent {
  // NOTE: The fields below are marked `/** @internal */` and exposed as
  // public so the helpers in worker-message-handler.ts and
  // execution-resolver.ts can mutate them. They are NOT part of the
  // public API of ClaudeCodeAgent — do not access them from outside the
  // claude-code/ directory.

  /** @internal */
  public process: ChildProcess | null = null;
  /** @internal */
  public config: ClaudeCodeAgentConfig;
  /** @internal */
  public outputBuffer: string = '';
  /**
   * @internal The clean FINAL assistant message from the stream-json `result`
   * event (no narration / tool output). Used by investigation phases.
   */
  public finalResultText: string = '';
  /** @internal */
  public errorBuffer: string = '';
  /** @internal Buffer for parsing stream-json format */
  public lineBuffer: string = '';
  /** @internal Question waiting state (key-based detection system) */
  public detectedQuestion: QuestionWaitingState = createInitialWaitingState();
  /** @internal */
  public activeTools: Map<string, { name: string; startTime: number; info: string }> = new Map();
  /** @internal Claude Code session ID (for resuming conversations via --resume) */
  public claudeSessionId: string | null = null;
  /** @internal Whether file-modifying tools (Write, Edit, NotebookEdit, Bash) were used successfully */
  public hasFileModifyingToolCalls: boolean = false;
  /** @internal Flag indicating forced termination due to idle hang */
  public idleTimeoutForceKilled: boolean = false;
  /** @internal Flag indicating forced termination due to the wall-clock cap (task 546) */
  public wallClockTimeoutForceKilled: boolean = false;
  /** @internal Worker thread for output parsing */
  public parserWorker: Worker | null = null;
  /** @internal Artifacts parsed by the Worker */
  public workerArtifacts: AgentArtifact[] = [];
  /** @internal Commits parsed by the Worker */
  public workerCommits: GitCommitInfo[] = [];
  /** @internal Usage figures captured from the stream-json `result` event. */
  public workerResultUsage: WorkerResultUsageSnapshot | null = null;
  /** @internal Callback invoked when parse-complete finishes */
  public onParseComplete: (() => void) | null = null;

  constructor(id: string, name: string, config: ClaudeCodeAgentConfig = {}) {
    super(id, name, 'claude-code');
    this.config = {
      // Default derived from the shared timeout config so the agent self-
      // terminates just BEFORE the WorkflowRunner's phase backstop (see
      // execution-timeouts). A caller-supplied config.timeout still wins.
      timeout: getAgentTimeoutMs(),
      ...config,
    };
  }

  /** @internal Top-level alias of `config.resumeSessionId` for helper context. */
  public get resumeSessionId(): string | undefined {
    return this.config.resumeSessionId;
  }

  /** @internal Top-level alias of `config.continueConversation` for helper context. */
  public get continueConversation(): boolean | undefined {
    return this.config.continueConversation;
  }

  /** @internal Top-level alias of `config.model` for helper context. */
  public get instructedModel(): string | undefined {
    return this.config.model;
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

  /**
   * Handle all messages received from the output-parser Worker thread.
   * Delegates to the free function in worker-message-handler.ts for the
   * actual switch logic — this is a 1-line wrapper that adapts the agent
   * to the helper's `WorkerMessageContext` shape.
   *
   * @param msg - Typed message from the Worker / Workerからの型付きメッセージ
   */
  private handleWorkerMessage(msg: WorkerOutputMessage): void {
    handleWorkerMessage(this as unknown as Parameters<typeof handleWorkerMessage>[0], msg);
  }

  /** @internal Public alias for handleWorkerMessage so the execution runner can wire onmessage. */
  public handleWorkerMessageInternal(msg: WorkerOutputMessage): void {
    this.handleWorkerMessage(msg);
  }

  /** @internal Proxy for BaseAgent's protected emitOutput, used by helpers. */
  public emitOutputInternal(output: string, isError: boolean = false): void {
    this.emitOutput(output, isError);
  }

  /** @internal Proxy for BaseAgent's protected emitQuestionDetected, used by helpers. */
  public emitQuestionDetectedInternal(
    info: Parameters<ClaudeCodeAgent['emitQuestionDetected']>[0],
  ): void {
    this.emitQuestionDetected(info);
  }

  /** @internal Proxy for the private killProcessForQuestion, used by helpers. */
  public killProcessForQuestionInternal(): void {
    this.killProcessForQuestion();
  }

  /** @internal Public setter for the protected `status` field, used by helpers. */
  public setStatusInternal(status: AgentStatus): void {
    this.status = status;
  }

  /**
   * Build the resolution callback used after the Worker finishes parsing.
   * Thin wrapper that constructs a `ResolverContext` view of `this` and
   * delegates to the free function in execution-resolver.ts.
   */
  private buildResolveAfterParse(
    code: number | null,
    workDir: string,
    startTime: number,
    resolve: (result: AgentExecutionResult) => void,
    taskId?: number,
    resourceStats?: { cpuTimeMs: number | null; peakRssKb: number | null },
  ): () => void {
    return buildResolveAfterParse(
      this as unknown as Parameters<typeof buildResolveAfterParse>[0],
      code,
      workDir,
      startTime,
      resolve,
      () => this.workerArtifacts,
      () => this.workerCommits,
      // A plan saved via the workflow API flips workflowStatus to plan_created;
      // treat that as "awaiting approval" rather than a do-nothing failure.
      async () => {
        if (!taskId) return false;
        try {
          const t = await prisma.task.findUnique({
            where: { id: taskId },
            select: { workflowStatus: true },
          });
          if (
            t?.workflowStatus === 'plan_created' ||
            t?.workflowStatus === 'plan_approved' ||
            // A research phase saved research.md and produced no code on purpose —
            // a valid pause, not a "planned but didn't implement" failure. The
            // workflow auto-advances to the next phase (lightweight: implement;
            // standard: plan). Without this a lightweight research run failed with
            // "Agent output a plan but no actual code changes were made".
            t?.workflowStatus === 'research_done'
          ) {
            return true;
          }
          // A plan that was split into subtasks delegates all implementation
          // to those subtasks, so the parent's own run legitimately produces
          // no code — and by then it has already auto-advanced to in_progress.
          // Without this, a split parent was reported as a "no code changes"
          // failure even though splitting was the correct outcome.
          const subtaskCount = await prisma.task.count({ where: { parentId: taskId } });
          return subtaskCount > 0;
        } catch {
          return false;
        }
      },
      this.config.investigationMode || this.config.investigationOutputType === 'verify',
      resourceStats,
    );
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
    this.claudeSessionId = null;
    this.hasFileModifyingToolCalls = false;
    this.idleTimeoutForceKilled = false;
    this.wallClockTimeoutForceKilled = false;
    this.workerArtifacts = [];
    this.workerCommits = [];
    this.workerResultUsage = null;
    this.onParseComplete = null;
    const startTime = Date.now();

    const timeout = this.config.timeout ?? getAgentTimeoutMs();

    const fs = await import('fs/promises');
    const workDir = task.workingDirectory || this.config.workingDirectory || getProjectRoot();

    // Verify working directory exists before spawning
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

    // Verify Claude CLI is available before execution
    const isClaudeAvailable = await checkClaudeAvailable();
    if (!isClaudeAvailable) {
      this.status = 'failed';
      return {
        success: false,
        output: '',
        errorMessage: `Claude Code CLI not found.`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    return new Promise((resolve) => {
      runClaudeExecution(
        this,
        task,
        workDir,
        startTime,
        timeout,
        resolve,
        (code, wd, st, res, resourceStats) =>
          this.buildResolveAfterParse(code, wd, st, res, task.id, resourceStats),
      );
    });
  }

  /**
   * Gracefully stops the process when a question is detected.
   * Uses taskkill on Windows, SIGTERM on Unix.
   * Unlike stop(), does not set status to cancelled (preserves waiting_for_input).
   */
  private killProcessForQuestion(): void {
    if (!this.process || this.process.killed) return;

    if (process.platform === 'win32') {
      try {
        const pid = this.process.pid;
        if (pid) {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          logger.info(`${this.logPrefix} Process ${pid} killed via taskkill (question detected)`);
        }
      } catch (e) {
        // taskkill fails most often because the target PID already exited between
        // the null-check and the call (idle-monitor.ts:129 treats the identical
        // failure the same way) — the process.kill() fallback below recovers it.
        logger.warn({ err: e }, `${this.logPrefix} taskkill failed (question detected)`);
        try {
          this.process.kill();
        } catch (killErr) {
          logger.warn(
            { err: killErr },
            `${this.logPrefix} process.kill() also failed (question detected)`,
          );
        }
      }
    } else {
      this.process.kill('SIGTERM');
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.status = 'cancelled';
      this.emitOutput(`\n${this.logPrefix} Stopping execution...\n`);

      if (process.platform === 'win32') {
        try {
          const pid = this.process.pid;
          if (pid) {
            // /T terminates the entire process tree, /F forces termination
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
            logger.info(`${this.logPrefix} Process ${pid} killed via taskkill`);
          }
        } catch (e) {
          // Same benign race as killProcessForQuestion() above — the fallback
          // below recovers it, and idle-monitor.ts already logs the identical
          // failure at warn.
          logger.warn({ err: e }, `${this.logPrefix} taskkill failed`);
          try {
            this.process.kill();
          } catch (killErr) {
            logger.warn({ err: killErr }, `${this.logPrefix} process.kill() also failed`);
          }
        }
      } else {
        // On Unix, send SIGINT for graceful shutdown
        this.process.kill('SIGINT');

        // Send SIGTERM if still running after 5 seconds
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
    return checkClaudeAvailable();
  }

  async validateConfig(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    const available = await this.isAvailable();
    if (!available) {
      errors.push('Claude Code CLI is not installed or not available in PATH');
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
}
