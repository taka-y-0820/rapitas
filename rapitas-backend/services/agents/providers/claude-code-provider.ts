/**
 * Claude Code Provider
 *
 * Claude Code agent provider compatible with the abstraction layer.
 * Prompt building lives in cli-utils.ts; process spawning and stream parsing in claude-code-stream.ts.
 * The IAgentProvider class lives in claude-code-provider-class.ts.
 */

import { spawn } from 'child_process';
import { getProjectRoot } from '../../../config';
import type {
  AgentCapabilities,
  ClaudeCodeProviderConfig,
  AgentExecutionContext,
  AgentTaskDefinition,
  AgentExecutionResult,
  ContinuationContext,
} from '../abstraction/types';
import { AbstractAgent } from '../abstraction/abstract-agent';
import { generateAgentId } from '../abstraction';
import { resolveCliPath, buildPrompt } from './cli-utils';
import { runClaudeCode, type StreamState } from './claude-code-stream';

/**
 * Claude Code provider configuration
 */
export interface ClaudeCodeConfig extends ClaudeCodeProviderConfig {
  workingDirectory?: string;
  model?: string;
  timeout?: number;
  maxTokens?: number;
  continueConversation?: boolean;
  resumeSessionId?: string;
}

/**
 * Shared capabilities object returned by both the agent and the provider.
 *
 * NOTE: Exported so ClaudeCodeProvider (in the class file) can re-use without duplication.
 */
export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = {
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

/**
 * Claude Code Agent (v2 - abstraction layer compatible)
 */
export class ClaudeCodeAgentV2 extends AbstractAgent {
  private config: ClaudeCodeConfig;
  private process: import('child_process').ChildProcess | null = null;
  private streamState: StreamState = {
    outputBuffer: '',
    errorBuffer: '',
    lineBuffer: '',
    claudeSessionId: null,
  };

  constructor(config: ClaudeCodeConfig) {
    super(
      generateAgentId('claude-code'),
      config.defaultModel || 'Claude Code Agent',
      'claude-code',
      {
        version: '2.0.0',
        description: 'Claude Code CLI を使用したコード生成・編集エージェント',
        modelId: config.defaultModel,
      },
    );
    this.config = config;
  }

  get capabilities(): AgentCapabilities {
    return CLAUDE_CODE_CAPABILITIES;
  }

  /**
   * Checks if the Claude Code CLI is installed and reachable.
   *
   * @returns true if CLI exits with code 0 / CLIがコード0で終了する場合true
   */
  async isAvailable(): Promise<boolean> {
    const isWindows = process.platform === 'win32';
    const baseClaudePath =
      this.config.cliPath || process.env.CLAUDE_CODE_PATH || (isWindows ? 'claude.cmd' : 'claude');
    const claudePath = await resolveCliPath(baseClaudePath);

    return new Promise((resolve) => {
      const proc = spawn(claudePath, ['--version'], { shell: true });

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
   * Validates agent configuration, checking CLI availability and working directory.
   *
   * @returns Validation result with error list / エラーリスト付きの検証結果
   */
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

    return { valid: errors.length === 0, errors };
  }

  protected async doExecute(
    task: AgentTaskDefinition,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult> {
    this.streamState = { outputBuffer: '', errorBuffer: '', lineBuffer: '', claudeSessionId: null };

    const prompt = buildPrompt(task);
    const workDir = context.workingDirectory || this.config.workingDirectory || getProjectRoot();

    const result = await runClaudeCode(
      prompt,
      workDir,
      context,
      this.config,
      this.streamState,
      (output, isError) => this.emitOutput(output, isError, true),
    );

    // NOTE: Propagate claudeSessionId captured during streaming back to the agent result
    if (this.streamState.claudeSessionId) {
      (result as AgentExecutionResult & { sessionId?: string }).sessionId =
        this.streamState.claudeSessionId;
    }

    return result;
  }

  protected async doContinue(
    continuation: ContinuationContext,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult> {
    this.streamState = { outputBuffer: '', errorBuffer: '', lineBuffer: '', claudeSessionId: null };

    const prompt = continuation.userResponse || '';
    const workDir = context.workingDirectory || this.config.workingDirectory || getProjectRoot();

    // Temporarily set continuation flags for this execution
    const originalContinue = this.config.continueConversation;
    this.config.continueConversation = true;
    this.config.resumeSessionId = continuation.sessionId;

    try {
      return await runClaudeCode(
        prompt,
        workDir,
        context,
        this.config,
        this.streamState,
        (output, isError) => this.emitOutput(output, isError, true),
      );
    } finally {
      this.config.continueConversation = originalContinue;
    }
  }

  protected async doStop(): Promise<void> {
    if (this.process) {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        try {
          const pid = this.process.pid;
          if (pid) {
            const { execSync } = require('child_process');
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          }
        } catch {
          try {
            this.process.kill();
          } catch {
            // Final fallback kill failed - process may already be terminated
          }
        }
      } else {
        this.process.kill('SIGTERM');
      }

      this.process = null;
    }
  }
}

// Re-export provider class for backward compatibility
export { ClaudeCodeProvider } from './claude-code-provider-class';

// NOTE: claudeCodeProvider is instantiated here so all consumers that import from this
// module get the same singleton without importing from claude-code-provider-class directly.
import { ClaudeCodeProvider as _Provider } from './claude-code-provider-class';
export const claudeCodeProvider = new _Provider();
