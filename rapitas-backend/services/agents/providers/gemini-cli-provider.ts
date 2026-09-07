/**
 * Gemini CLI Provider
 *
 * IAgentProvider implementation that creates GeminiCliAgentV2 instances.
 * Re-exports types and the agent class for backward compatibility.
 */

import { spawn } from 'child_process';
import type {
  AgentCapabilities,
  AgentProviderConfig,
  AgentHealthStatus,
} from '../abstraction/types';
import type { IAgentProvider, IAgent } from '../abstraction/interfaces';
import { GeminiCliAgentV2, resolveCliPath } from './gemini-cli-agent';
import type { GeminiCliConfig } from './gemini-cli-types';

// Re-export for backward compatibility
export type { GeminiCliConfig } from './gemini-cli-types';
export type { GeminiStreamEvent, StreamEventResult } from './gemini-cli-types';
export { GeminiCliAgentV2, resolveCliPath } from './gemini-cli-agent';

/**
 * GeminiCliProvider — creates and validates Gemini CLI agent instances.
 */
export class GeminiCliProvider implements IAgentProvider {
  readonly providerId = 'google-gemini' as const;
  readonly providerName = 'Gemini CLI';
  readonly version = '1.0.0';

  private defaultConfig: GeminiCliConfig;

  constructor(config?: Partial<GeminiCliConfig>) {
    this.defaultConfig = {
      providerId: 'google-gemini',
      enabled: true,
      model: 'gemini-2.0-flash',
      ...config,
    };
  }

  getCapabilities(): AgentCapabilities {
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
   * Checks whether the Gemini CLI binary is reachable.
   *
   * @returns true if the binary exits with code 0 / バイナリが正常に起動できれば true
   */
  async isAvailable(): Promise<boolean> {
    const isWindows = process.platform === 'win32';
    const geminiPath = await resolveCliPath(
      this.defaultConfig.cliPath ||
        process.env.GEMINI_CLI_PATH ||
        (isWindows ? 'gemini.cmd' : 'gemini'),
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
   * Validates a provider config against the google-gemini provider contract.
   *
   * @param config - Provider config to validate / バリデート対象の設定
   * @returns Validation result / バリデーション結果
   */
  async validateConfig(config: AgentProviderConfig): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (config.providerId !== 'google-gemini') {
      errors.push(`Invalid provider ID: ${config.providerId}`);
    }

    const available = await this.isAvailable();
    if (!available) {
      errors.push(
        'Gemini CLI is not installed or not available. Install with: npm install -g @google/gemini-cli',
      );
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Runs a health check by verifying CLI availability.
   *
   * @returns Current health status / 現在のヘルス状態
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
   * Creates a new agent instance merging the provider defaults with the given config.
   *
   * @param config - Per-agent override config / エージェント固有の設定
   * @returns A new GeminiCliAgentV2 instance / 新しいエージェントインスタンス
   */
  createAgent(config: AgentProviderConfig): IAgent {
    const mergedConfig: GeminiCliConfig = {
      ...this.defaultConfig,
      ...config,
    } as GeminiCliConfig;

    return new GeminiCliAgentV2(mergedConfig);
  }
}

/**
 * Default Gemini CLI provider instance
 */
export const geminiCliProvider = new GeminiCliProvider();
