/**
 * Claude Code Provider
 *
 * Agent provider that uses the Claude Code CLI.
 */

import type {
  AgentProviderId,
  AgentCapabilities,
  AgentProviderConfig,
  ClaudeCodeProviderConfig,
  AgentHealthStatus,
} from '../types';
import type { IAgentProvider, IAgent } from '../interfaces';
import { createDefaultCapabilities } from '../index';
import { ClaudeCodeAgentAdapter } from './claude-code-agent-adapter';
// NOTE: static import (not require()) so bun:test's mock.module() can
// intercept this path in tests — require() bypasses Bun's ESM module mock
// registry, which silently made resolveCliPathAsync's `where` resolution hit
// the real filesystem/CLI in any test that exercised isAvailable()/healthCheck().
import { resolveCliPathAsync } from '../../../../utils/common/cli-path-resolver';

/**
 * Claude Code Provider.
 * Provides agents backed by the Claude Code CLI.
 */
export class ClaudeCodeProvider implements IAgentProvider {
  readonly providerId: AgentProviderId = 'claude-code';
  readonly providerName = 'Claude Code';
  readonly version = '1.0.0';

  private capabilities: AgentCapabilities;
  private defaultConfig: Partial<ClaudeCodeProviderConfig>;

  constructor(config?: Partial<ClaudeCodeProviderConfig>) {
    this.defaultConfig = config || {};

    // Set Claude Code CLI capabilities
    this.capabilities = createDefaultCapabilities({
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
      parallelExecution: false, // single agent does not support parallel execution
      questionAsking: true,
      conversationMemory: true,
      sessionContinuation: true,
    });
  }

  /**
   * Returns provider capabilities.
   */
  getCapabilities(): AgentCapabilities {
    return { ...this.capabilities };
  }

  /**
   * Checks if the Claude Code CLI is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { spawn } = await import('child_process');
      const isWindows = process.platform === 'win32';
      const claudePath = await resolveCliPathAsync(
        process.env.CLAUDE_CODE_PATH || (isWindows ? 'claude.cmd' : 'claude'),
      );

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
    } catch {
      return false;
    }
  }

  /**
   * Validates the configuration.
   */
  async validateConfig(config: AgentProviderConfig): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Verify provider ID
    if (config.providerId !== 'claude-code') {
      errors.push(`Invalid provider ID: expected 'claude-code', got '${config.providerId}'`);
    }

    // Check if Claude CLI is available
    const available = await this.isAvailable();
    if (!available) {
      errors.push('Claude Code CLI is not installed or not available in PATH');
    }

    // Validate Claude Code specific settings
    const claudeConfig = config as ClaudeCodeProviderConfig;

    // Verify cliPath exists if specified
    if (claudeConfig.cliPath) {
      try {
        const fs = await import('fs/promises');
        await fs.access(claudeConfig.cliPath);
      } catch {
        errors.push(`Specified CLI path does not exist: ${claudeConfig.cliPath}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Performs a health check.
   */
  async healthCheck(): Promise<AgentHealthStatus> {
    const startTime = Date.now();
    const errors: string[] = [];

    try {
      const isAvailable = await this.isAvailable();
      const latency = Date.now() - startTime;

      if (!isAvailable) {
        errors.push('Claude Code CLI is not available');
      }

      return {
        healthy: isAvailable,
        available: isAvailable,
        latency,
        errors: errors.length > 0 ? errors : undefined,
        lastCheck: new Date(),
        details: {
          platform: process.platform,
          cliPath:
            process.env.CLAUDE_CODE_PATH ||
            (process.platform === 'win32' ? 'claude.cmd' : 'claude'),
        },
      };
    } catch (error) {
      return {
        healthy: false,
        available: false,
        latency: Date.now() - startTime,
        errors: [error instanceof Error ? error.message : String(error)],
        lastCheck: new Date(),
      };
    }
  }

  /**
   * Creates a new agent instance.
   */
  createAgent(config: AgentProviderConfig): IAgent {
    const claudeConfig = config as ClaudeCodeProviderConfig;

    // Merge with default config
    const mergedConfig: ClaudeCodeProviderConfig = {
      ...this.defaultConfig,
      ...claudeConfig,
    };

    return new ClaudeCodeAgentAdapter(mergedConfig);
  }
}

/**
 * Default Claude Code Provider singleton.
 */
export const claudeCodeProvider = new ClaudeCodeProvider();
