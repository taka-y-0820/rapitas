/**
 * ClaudeCodeProvider
 *
 * IAgentProvider implementation that creates ClaudeCodeAgentV2 instances.
 * Health checking, config validation, and capability declaration for the Claude Code CLI.
 */
import { spawn } from 'child_process';
import type {
  AgentCapabilities,
  AgentProviderConfig,
  AgentHealthStatus,
} from '../abstraction/types';
import type { IAgentProvider, IAgent } from '../abstraction/interfaces';
import type { ClaudeCodeConfig } from './claude-code-provider';
import { ClaudeCodeAgentV2, CLAUDE_CODE_CAPABILITIES } from './claude-code-provider';
import { resolveCliPath } from './cli-utils';

/**
 * Claude Code Provider
 */
export class ClaudeCodeProvider implements IAgentProvider {
  readonly providerId = 'claude-code' as const;
  readonly providerName = 'Claude Code';
  readonly version = '2.0.0';

  private defaultConfig: ClaudeCodeConfig;

  constructor(config?: Partial<ClaudeCodeConfig>) {
    this.defaultConfig = {
      providerId: 'claude-code',
      enabled: true,
      ...config,
    };
  }

  getCapabilities(): AgentCapabilities {
    return CLAUDE_CODE_CAPABILITIES;
  }

  /**
   * Checks if the Claude Code CLI is reachable from this provider's configured path.
   *
   * @returns true if CLI exits with code 0 / CLIがコード0で終了する場合true
   */
  async isAvailable(): Promise<boolean> {
    const isWindows = process.platform === 'win32';
    const baseClaudePath =
      this.defaultConfig.cliPath ||
      process.env.CLAUDE_CODE_PATH ||
      (isWindows ? 'claude.cmd' : 'claude');
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
   * Validates a provider config object.
   *
   * @param config - Config to validate / 検証する設定
   * @returns Validation result with error list / エラーリスト付きの検証結果
   */
  async validateConfig(config: AgentProviderConfig): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (config.providerId !== 'claude-code') {
      errors.push(`Invalid provider ID: ${config.providerId}`);
    }

    const available = await this.isAvailable();
    if (!available) {
      errors.push('Claude Code CLI is not installed or not available');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Performs a health check by testing CLI availability.
   *
   * @returns Health status with latency measurement / レイテンシ計測付きのヘルスステータス
   */
  async healthCheck(): Promise<AgentHealthStatus> {
    const startTime = Date.now();

    try {
      const available = await this.isAvailable();
      const latency = Date.now() - startTime;

      return {
        healthy: available,
        available,
        latency,
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        healthy: false,
        available: false,
        errors: [error instanceof Error ? error.message : String(error)],
        lastCheck: new Date(),
      };
    }
  }

  /**
   * Creates a new ClaudeCodeAgentV2 with merged default + per-call config.
   *
   * @param config - Per-call agent config / 呼び出しごとのエージェント設定
   * @returns New agent instance / 新しいエージェントインスタンス
   */
  createAgent(config: AgentProviderConfig): IAgent {
    const mergedConfig: ClaudeCodeConfig = {
      ...this.defaultConfig,
      ...config,
    } as ClaudeCodeConfig;

    return new ClaudeCodeAgentV2(mergedConfig);
  }
}
