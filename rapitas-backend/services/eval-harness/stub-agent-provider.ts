/**
 * StubAgentProvider
 *
 * An `IAgentProvider` that spawns `stub-agent-cli.ts` instead of a real coding
 * CLI, so fault-injection runs exercise the production orchestrator end to end
 * without a model call. Registering it through the existing
 * `AgentRegistry.registerProvider()` is the whole integration surface — no
 * production file gains an eval-only branch.
 *
 * Measures nothing itself; `eval-runner.ts` interprets the results.
 */
import { spawn, type ChildProcess } from 'child_process';
import { join, resolve } from 'path';
import { AgentEventEmitter } from '../agents/abstraction/event-emitter';
import type { IAgent, IAgentProvider } from '../agents/abstraction/interfaces';
import type {
  AgentCapabilities,
  AgentExecutionContext,
  AgentExecutionResult,
  AgentHealthStatus,
  AgentLifecycleHooks,
  AgentMetadata,
  AgentProviderConfig,
  AgentProviderId,
  AgentState,
  AgentTaskDefinition,
  ContinuationContext,
} from '../agents/abstraction/types';
import { EXIT_CODE_EARLY_DEATH, STUB_MARKER_FILE, type FaultScenario } from './stub-agent-cli';

/**
 * Provider id the stub registers under.
 *
 * NOTE: `AgentProviderId` is a closed union in
 * `services/agents/abstraction/types/agent-identification.ts`, and `custom` is
 * the slot it reserves for exactly this. Widening the union to add a literal
 * `eval-stub` would mean editing production type definitions purely for test
 * infrastructure — the opposite of this subsystem's "no production changes"
 * constraint. The human-readable name below stays `eval-stub`.
 */
export const EVAL_STUB_PROVIDER_ID: AgentProviderId = 'custom';

/** Display name used in logs and provider listings. */
export const EVAL_STUB_PROVIDER_NAME = 'eval-stub';

/** Path to the stub CLI entry point. */
const STUB_CLI_PATH = resolve(import.meta.dir, 'stub-agent-cli.ts');

/** Capabilities the stub claims. Deliberately narrow: it writes one file. */
const STUB_CAPABILITIES: AgentCapabilities = {
  codeGeneration: true,
  codeReview: false,
  codeExecution: false,
  fileRead: true,
  fileWrite: true,
  fileEdit: false,
  terminalAccess: false,
  gitOperations: false,
  webSearch: false,
  webFetch: false,
  taskAnalysis: false,
  taskPlanning: false,
  parallelExecution: false,
  questionAsking: false,
  conversationMemory: false,
  sessionContinuation: false,
};

/** Extra settings the runner passes through `AgentProviderConfig.customConfig`. */
export interface StubAgentSettings {
  /** Scenario the spawned CLI reproduces. */
  fault: FaultScenario;
  /** How long the stub stays alive after producing output, in ms. */
  holdMs: number;
}

/**
 * Reads stub settings out of a provider config, applying defaults.
 *
 * @param config - Provider configuration / プロバイダ設定
 * @returns Normalized stub settings / 正規化されたスタブ設定
 */
export function readStubSettings(config: AgentProviderConfig): StubAgentSettings {
  const custom = (config.customConfig ?? {}) as Partial<StubAgentSettings>;
  return {
    fault: custom.fault ?? 'baseline',
    holdMs: typeof custom.holdMs === 'number' ? custom.holdMs : 0,
  };
}

/** An agent instance backed by one stub child process. */
class StubAgent implements IAgent {
  readonly metadata: AgentMetadata;
  readonly capabilities: AgentCapabilities = STUB_CAPABILITIES;
  readonly events: AgentEventEmitter;

  private currentState: AgentState = 'idle';
  private child: ChildProcess | null = null;
  private hooks: AgentLifecycleHooks = {};

  constructor(
    agentId: string,
    private readonly settings: StubAgentSettings,
  ) {
    this.metadata = {
      id: agentId,
      providerId: EVAL_STUB_PROVIDER_ID,
      name: EVAL_STUB_PROVIDER_NAME,
      version: '1.0.0',
      description: 'Deterministic fault-injection stub for the private eval harness',
      createdAt: new Date(),
    };
    this.events = new AgentEventEmitter(agentId);
  }

  get state(): AgentState {
    return this.currentState;
  }

  async execute(
    task: AgentTaskDefinition,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult> {
    this.currentState = 'running';
    this.events.setExecutionId(context.executionId);
    if ((await this.hooks.beforeExecute?.(context, task)) === false) {
      this.currentState = 'cancelled';
      return {
        success: false,
        state: 'cancelled',
        output: '',
        errorMessage: 'Cancelled by beforeExecute hook',
      };
    }

    const startTime = new Date();
    const spawned = await this.spawnStub(context.workingDirectory);
    const endTime = new Date();

    // A signalled stub was stopped on purpose by the runner; treat it as
    // cancelled rather than failed so the runner can tell the two apart.
    const cancelled = spawned.signal !== null;
    const success = !cancelled && spawned.exitCode === 0;
    this.currentState = cancelled ? 'cancelled' : success ? 'completed' : 'failed';

    const result: AgentExecutionResult = {
      success,
      state: this.currentState,
      output: spawned.stdout,
      errorMessage: success
        ? undefined
        : cancelled
          ? `Stub terminated by signal ${spawned.signal}`
          : `Stub exited with code ${spawned.exitCode}`,
      artifacts: success
        ? [
            {
              type: 'file',
              name: STUB_MARKER_FILE,
              content: spawned.stdout,
              path: join(context.workingDirectory, STUB_MARKER_FILE),
            },
          ]
        : [],
      metrics: {
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
        // Zero by construction: the stub never calls a model. Recording 0
        // rather than undefined keeps cost-per-success arithmetic total.
        costUsd: 0,
        tokensUsed: 0,
      },
      debugInfo: {
        logs: [],
        processInfo: {
          exitCode: spawned.exitCode ?? undefined,
          signal: spawned.signal ?? undefined,
        },
      },
    };

    await this.hooks.afterExecute?.(context, result);
    return result;
  }

  async continue(
    _continuation: ContinuationContext,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult> {
    // The stub has no conversation state, so continuing is a fresh run.
    return this.execute({ id: context.executionId, title: 'stub-continue' }, context);
  }

  async stop(): Promise<void> {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
    }
    this.currentState = 'cancelled';
  }

  async pause(): Promise<boolean> {
    // Not supported: the stub is a short-lived one-shot process.
    return false;
  }

  async resume(): Promise<boolean> {
    return false;
  }

  setLifecycleHooks(hooks: AgentLifecycleHooks): void {
    this.hooks = hooks;
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.child = null;
  }

  /** Spawns the stub CLI and collects its termination shape. */
  private spawnStub(workingDirectory: string): Promise<{
    stdout: string;
    exitCode: number | null;
    signal: string | null;
  }> {
    return new Promise((resolvePromise) => {
      const child = spawn(
        process.execPath,
        [
          STUB_CLI_PATH,
          '--fault',
          this.settings.fault,
          '--cwd',
          workingDirectory,
          '--hold-ms',
          String(this.settings.holdMs),
        ],
        { cwd: workingDirectory, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.child = child;

      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.on('error', () => {
        resolvePromise({ stdout, exitCode: EXIT_CODE_EARLY_DEATH, signal: null });
      });
      child.on('close', (code, signal) => {
        resolvePromise({ stdout, exitCode: code, signal: signal ?? null });
      });
    });
  }
}

/** Provider that hands out {@link StubAgent} instances. */
export class StubAgentProvider implements IAgentProvider {
  readonly providerId: AgentProviderId = EVAL_STUB_PROVIDER_ID;
  readonly providerName = EVAL_STUB_PROVIDER_NAME;
  readonly version = '1.0.0';

  private agentCounter = 0;

  getCapabilities(): AgentCapabilities {
    return STUB_CAPABILITIES;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async validateConfig(config: AgentProviderConfig): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    if (config.providerId !== EVAL_STUB_PROVIDER_ID) {
      errors.push(`providerId must be "${EVAL_STUB_PROVIDER_ID}"`);
    }
    return { valid: errors.length === 0, errors };
  }

  async healthCheck(): Promise<AgentHealthStatus> {
    return { healthy: true, available: true, lastCheck: new Date() };
  }

  createAgent(config: AgentProviderConfig): IAgent {
    this.agentCounter += 1;
    return new StubAgent(`eval-stub-${this.agentCounter}`, readStubSettings(config));
  }
}
