/**
 * GeminiCliAgent — Agent
 *
 * Spawns Google Gemini CLI as a child process to execute tasks.
 * Orchestrates process management, stream handling, question detection, and prompt building.
 *
 * Gemini CLI: @google/gemini-cli (npm install -g @google/gemini-cli)
 * https://github.com/google-gemini/gemini-cli
 */

import { ChildProcess } from 'child_process';
import { BaseAgent } from '../base-agent';
import type { AgentCapability, AgentTask, AgentExecutionResult } from '../base-agent';
import { createInitialWaitingState, tolegacyQuestionType } from '../question-detection';
import type { QuestionWaitingState } from '../question-detection';
import { createLogger } from '../../../config/logger';
import { getProjectRoot } from '../../../config';
import type { GeminiCliAgentConfig } from './types';
import {
  resolveCliPath,
  buildCliArgs,
  buildProcessEnv,
  spawnGeminiProcess,
  stopGeminiProcess,
  checkGeminiAvailability,
} from './process-manager';
import { stopResourceSampling } from '../process-resource-sampler';
import { parseArtifacts, parseCommits } from './output-parser';
import { buildStructuredPrompt } from './prompt-builder';
import { attachStreamHandlers } from './stream-handler';
import { validateAgentConfig } from './config-validator';

export { GeminiCliAgentConfig };

const logger = createLogger('gemini-cli-agent');

export class GeminiCliAgent extends BaseAgent {
  private process: ChildProcess | null = null;
  private config: GeminiCliAgentConfig;
  private outputBuffer: string = '';
  private errorBuffer: string = '';
  private detectedQuestion: QuestionWaitingState = createInitialWaitingState();
  private activeTools: Map<string, { name: string; startTime: number; info: string }> = new Map();
  private geminiSessionId: string | null = null;
  /** Checkpoint ID for session continuation. */
  private checkpointId: string | null = null;

  constructor(id: string, name: string, config: GeminiCliAgentConfig = {}) {
    super(id, name, 'gemini');
    this.config = {
      timeout: 900000, // 15 minutes default
      ...config,
    };
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
    this.detectedQuestion = createInitialWaitingState();
    this.activeTools.clear();
    this.geminiSessionId = null;
    this.checkpointId = null;
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

    if (!(await this.isAvailable())) {
      this.status = 'failed';
      return {
        success: false,
        output: '',
        errorMessage: `Gemini CLI not found. Please install it with: npm install -g @google/gemini-cli`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    const isWindows = process.platform === 'win32';
    const geminiPath = await resolveCliPath(
      process.env.GEMINI_CLI_PATH || (isWindows ? 'gemini.cmd' : 'gemini'),
    );

    return new Promise((resolve) => {
      const prompt = buildStructuredPrompt(task, this.logPrefix);

      logger.info(`${this.logPrefix} Using ${task.analysisInfo ? 'structured' : 'simple'} prompt`);

      const resumeId = this.config.checkpointId || task.resumeSessionId;
      // NOTE: Prompt is now piped via stdin in spawnGeminiProcess to avoid
      // Windows shell truncation of long multi-line prompts.
      const args = buildCliArgs(this.config, resumeId);

      logger.info(
        `${this.logPrefix} Platform: ${process.platform}, Path: ${geminiPath}, Dir: ${workDir}`,
      );
      logger.info(
        `${this.logPrefix} Timeout: ${this.config.timeout}ms, Prompt: ${prompt.length} chars`,
      );

      this.emitOutput(`${this.logPrefix} Starting execution...\n`);
      // Persist the model into the stored log stream (parity with claude runner).
      this.emitOutput(`${this.logPrefix} Model: ${this.config.model ?? 'default'}\n`);
      this.emitOutput(`${this.logPrefix} Working directory: ${workDir}\n`);

      try {
        const env = buildProcessEnv(this.config);
        this.process = spawnGeminiProcess(geminiPath, args, workDir, env, prompt);

        logger.info(`${this.logPrefix} Process spawned with PID: ${this.process.pid}`);
        this.emitOutput(`${this.logPrefix} Process PID: ${this.process.pid}\n`);

        const sessionState = { sessionId: this.geminiSessionId, checkpointId: this.checkpointId };
        const detectedQuestionRef = { value: this.detectedQuestion };

        attachStreamHandlers(
          this.process,
          this.config,
          startTime,
          this.logPrefix,
          this.activeTools,
          sessionState,
          detectedQuestionRef,
          {
            onOutput: (text, isError) => this.emitOutput(text, isError),
            onOutputBufferAppend: (text) => {
              this.outputBuffer += text;
            },
            onErrorBufferAppend: (text) => {
              this.errorBuffer += text;
            },
            onSessionIdUpdate: (id) => {
              this.geminiSessionId = id;
              sessionState.sessionId = id;
            },
            onCheckpointIdUpdate: (id) => {
              this.checkpointId = id;
              sessionState.checkpointId = id;
            },
            onQuestionDetected: (state) => {
              this.detectedQuestion = state;
              detectedQuestionRef.value = state;
              this.status = 'waiting_for_input';
            },
            onQuestionEmit: (data) =>
              this.emitQuestionDetected(data as Parameters<typeof this.emitQuestionDetected>[0]),
            onKillProcess: () => {
              if (this.process && !this.process.killed) {
                this.process.kill('SIGTERM');
              }
            },
          },
          // onClose
          (code) => {
            this.detectedQuestion = detectedQuestionRef.value;
            const resourceStats = this.process?.pid
              ? stopResourceSampling(this.process.pid)
              : { cpuTimeMs: null, peakRssKb: null };

            if (this.status === 'cancelled') {
              resolve({
                success: false,
                output: this.outputBuffer,
                errorMessage: 'Execution cancelled',
                executionTimeMs: Date.now() - startTime,
                failureType: 'cancelled',
                ...resourceStats,
              });
              return;
            }

            if (this.status === 'failed') return;

            const artifacts = parseArtifacts(this.outputBuffer);
            const commits = parseCommits(this.outputBuffer);
            const { hasQuestion, question, questionKey, questionDetails } = this.detectedQuestion;
            const questionType = tolegacyQuestionType(this.detectedQuestion.questionType);

            if (hasQuestion) {
              this.status = 'waiting_for_input';
              this.emitOutput(`\n${this.logPrefix} 回答を待っています...\n`);
              resolve({
                success: true,
                output: this.outputBuffer,
                artifacts,
                commits,
                executionTimeMs: Date.now() - startTime,
                waitingForInput: true,
                question,
                questionType,
                questionDetails,
                questionKey,
                // NOTE: Re-using claudeSessionId field for session continuation (checkpoint ID takes priority)
                claudeSessionId: this.checkpointId || this.geminiSessionId || undefined,
                modelName: this.config.model,
                ...resourceStats,
              });
              return;
            }

            this.status = code === 0 ? 'completed' : 'failed';

            let errorMessage: string | undefined;
            if (code !== 0) {
              const parts: string[] = [`プロセスがコード ${code} で終了しました`];
              if (this.errorBuffer.trim())
                parts.push(`\n\n【標準エラー出力】\n${this.errorBuffer.trim()}`);
              if (this.outputBuffer.trim())
                parts.push(`\n${this.outputBuffer.trim().slice(-1000)}`);
              errorMessage = parts.join('');
            }

            resolve({
              success: code === 0,
              output: this.outputBuffer,
              artifacts,
              commits,
              executionTimeMs: Date.now() - startTime,
              waitingForInput: false,
              claudeSessionId: this.checkpointId || this.geminiSessionId || undefined,
              modelName: this.config.model,
              errorMessage,
              ...resourceStats,
            });
          },
          // onStatusFailed
          () => {
            this.status = 'failed';
            const parts: string[] = ['プロセス起動エラー'];
            if (this.errorBuffer.trim())
              parts.push(`\n\n【標準エラー出力】\n${this.errorBuffer.trim()}`);
            resolve({
              success: false,
              output: this.outputBuffer,
              errorMessage: parts.join(''),
              executionTimeMs: Date.now() - startTime,
            });
          },
        );
      } catch (error) {
        this.status = 'failed';
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, `${this.logPrefix} Spawn error`);
        resolve({
          success: false,
          output: '',
          errorMessage,
          executionTimeMs: Date.now() - startTime,
        });
      }
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.status = 'cancelled';
      this.emitOutput(`\n${this.logPrefix} Stopping execution...\n`);
      await stopGeminiProcess(this.process, this.logPrefix);
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
    return checkGeminiAvailability();
  }

  async validateConfig(): Promise<{ valid: boolean; errors: string[] }> {
    return validateAgentConfig(this.config, this.logPrefix);
  }

  /**
   * Get the checkpoint ID (for session continuation).
   *
   * @returns Checkpoint ID or null / チェックポイントIDまたはnull
   */
  getCheckpointId(): string | null {
    return this.checkpointId;
  }

  /**
   * Get the session ID.
   *
   * @returns Session ID or null / セッションIDまたはnull
   */
  getSessionId(): string | null {
    return this.geminiSessionId;
  }
}
