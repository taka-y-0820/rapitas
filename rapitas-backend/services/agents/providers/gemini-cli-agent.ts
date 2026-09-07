/**
 * Gemini CLI Agent
 *
 * AbstractAgent implementation that drives the @google/gemini-cli binary.
 * Process spawn and stream parsing logic lives in gemini-cli-runner.ts.
 */

import { spawn } from 'child_process';
import { getProjectRoot } from '../../../config';
import type {
  AgentCapabilities,
  AgentExecutionContext,
  AgentTaskDefinition,
  AgentExecutionResult,
  ContinuationContext,
} from '../abstraction/types';
import { AbstractAgent } from '../abstraction/abstract-agent';
import { generateAgentId } from '../abstraction';
import type { GeminiCliConfig } from './gemini-cli-types';
import { runGeminiCli, type RunState } from './gemini-cli-runner';

export { resolveCliPathAsync as resolveCliPath } from '../../../utils/common/cli-path-resolver';
import { resolveCliPathAsync } from '../../../utils/common/cli-path-resolver';

/**
 * GeminiCliAgentV2 — abstraction-layer-compatible Gemini CLI agent.
 */
export class GeminiCliAgentV2 extends AbstractAgent {
  private config: GeminiCliConfig;
  private runState: RunState = {
    outputBuffer: '',
    errorBuffer: '',
    lineBuffer: '',
    geminiSessionId: null,
    checkpointId: null,
    process: null,
  };

  constructor(config: GeminiCliConfig) {
    super(generateAgentId('gemini-cli'), config.model || 'Gemini CLI Agent', 'google-gemini', {
      version: '1.0.0',
      description: 'Google Gemini CLI を使用したコード生成・編集エージェント',
      modelId: config.model,
    });
    this.config = config;
  }

  // NOTE: All capability flags are true except parallelExecution — Gemini CLI is single-threaded.
  get capabilities(): AgentCapabilities {
    return {
      codeGeneration: true,
      codeReview: true,
      codeExecution: true,
      fileRead: true,
      fileWrite: true,
      fileEdit: true,
      terminalAccess: true,
      gitOperations: true,
      webSearch: true,
      webFetch: true,
      taskAnalysis: true,
      taskPlanning: true,
      parallelExecution: false,
      questionAsking: true,
      conversationMemory: true,
      sessionContinuation: true,
    };
  }

  /**
   * Checks whether the Gemini CLI binary is available in PATH.
   *
   * @returns true when the binary responds with exit code 0 / バイナリが利用可能なら true
   */
  async isAvailable(): Promise<boolean> {
    const isWindows = process.platform === 'win32';
    const geminiPath = await resolveCliPathAsync(
      this.config.cliPath || process.env.GEMINI_CLI_PATH || (isWindows ? 'gemini.cmd' : 'gemini'),
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

  /**
   * Validates the current agent configuration.
   *
   * @returns Validation result with a list of errors / バリデーション結果とエラーリスト
   */
  async validateConfig(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    const available = await this.isAvailable();
    if (!available) {
      errors.push(
        'Gemini CLI is not installed or not available in PATH. Install with: npm install -g @google/gemini-cli',
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

    return { valid: errors.length === 0, errors };
  }

  protected async doExecute(
    task: AgentTaskDefinition,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult> {
    this.runState = {
      outputBuffer: '',
      errorBuffer: '',
      lineBuffer: '',
      geminiSessionId: null,
      checkpointId: null,
      process: null,
    };

    const prompt = this.buildPrompt(task);
    const workDir = context.workingDirectory || this.config.workingDirectory || getProjectRoot();

    return runGeminiCli(
      prompt,
      workDir,
      context,
      this.config,
      this.runState,
      this.emitOutput.bind(this),
      this.log.bind(this) as (level: string, message: string, data?: unknown) => void,
    );
  }

  protected async doContinue(
    continuation: ContinuationContext,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult> {
    this.runState = {
      outputBuffer: '',
      errorBuffer: '',
      lineBuffer: '',
      geminiSessionId: this.runState.geminiSessionId,
      checkpointId: this.runState.checkpointId,
      process: null,
    };

    const prompt = continuation.userResponse || '';
    const workDir = context.workingDirectory || this.config.workingDirectory || getProjectRoot();

    // Temporarily set checkpoint ID for continuation
    const originalCheckpoint = this.config.checkpointId;
    this.config.checkpointId = continuation.sessionId;

    try {
      return await runGeminiCli(
        prompt,
        workDir,
        context,
        this.config,
        this.runState,
        this.emitOutput.bind(this),
        this.log.bind(this) as (level: string, message: string, data?: unknown) => void,
      );
    } finally {
      this.config.checkpointId = originalCheckpoint;
    }
  }

  protected async doStop(): Promise<void> {
    if (this.runState.process) {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        try {
          const pid = this.runState.process.pid;
          if (pid) {
            const { execSync } = require('child_process');
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          }
        } catch {
          try {
            this.runState.process.kill();
          } catch {
            // Final fallback kill failed - process may already be terminated
          }
        }
      } else {
        this.runState.process.kill('SIGTERM');
      }

      this.runState.process = null;
    }
  }

  private buildPrompt(task: AgentTaskDefinition): string {
    if (task.optimizedPrompt) return task.optimizedPrompt;
    if (task.analysis) return this.buildStructuredPrompt(task);
    return task.prompt || task.description || task.title;
  }

  private buildStructuredPrompt(task: AgentTaskDefinition): string {
    const analysis = task.analysis!;
    const sections: string[] = [];

    sections.push('# タスク実装指示', '', '## 概要');
    sections.push(`**タスク名:** ${task.title}`);
    sections.push(`**分析サマリー:** ${analysis.summary}`);
    sections.push(`**複雑度:** ${analysis.complexity}`);
    if (analysis.estimatedDuration) {
      sections.push(`**推定時間:** ${analysis.estimatedDuration}分`);
    }
    sections.push('');

    if (task.description) {
      sections.push('## タスク詳細', task.description, '');
    }

    if (analysis.subtasks && analysis.subtasks.length > 0) {
      sections.push('## 実装手順');
      for (const subtask of analysis.subtasks) {
        sections.push(`### ${subtask.order}. ${subtask.title}`);
        sections.push(`- **説明:** ${subtask.description}`);
        if (subtask.estimatedDuration) {
          sections.push(`- **推定時間:** ${subtask.estimatedDuration}分`);
        }
        sections.push(`- **優先度:** ${subtask.priority}`, '');
      }
    }

    if (analysis.tips && analysis.tips.length > 0) {
      sections.push('## 実装のヒント');
      for (const tip of analysis.tips) sections.push(`- ${tip}`);
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * Returns the checkpoint ID for session continuation.
   *
   * @returns The checkpoint ID or null / チェックポイントIDまたはnull
   */
  getCheckpointId(): string | null {
    return this.runState.checkpointId;
  }

  /**
   * Returns the Gemini session ID.
   *
   * @returns The session ID or null / セッションIDまたはnull
   */
  getSessionId(): string | null {
    return this.runState.geminiSessionId;
  }
}
