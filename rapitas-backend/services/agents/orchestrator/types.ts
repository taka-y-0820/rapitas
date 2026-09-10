/**
 * Orchestrator Shared Type Definitions
 *
 * All types used across orchestrator modules are centralized here
 * to prevent circular dependencies.
 */
import { PrismaClient } from '../../../generated/prisma-postgres';
export type PrismaClientInstance = InstanceType<typeof PrismaClient>;

import type { AgentOutputHandler, AgentStatus, TaskAnalysisInfo, BaseAgent } from '../base-agent';
import type { QuestionKey } from '../question-detection';
import type { ExecutionFileLogger } from '../execution-file-logger';
import type { AgentConfigInput } from '../agent-factory';

export type ExecutionOptions = {
  /** Main-process admission check, repeated after async setup before launching an agent. */
  assertExecutionAllowed?: () => void;
  taskId: number;
  sessionId: number;
  agentConfigId?: number;
  workingDirectory?: string;
  timeout?: number;
  requireApproval?: boolean;
  onOutput?: AgentOutputHandler;
  /** AI task analysis result (passed when analysis is enabled). */
  analysisInfo?: TaskAnalysisInfo;
  /** Flag indicating continuation from a previous execution. */
  continueFromPrevious?: boolean;
  branchName?: string;
  /** Override the DB-configured model for this execution only. */
  modelIdOverride?: string;
  /**
   * Claude CLI session id to continue via `--resume` instead of cold-starting.
   * Set by the workflow when the same role re-runs on the same task in the same
   * worktree (a repair bounce), so the agent keeps the context it just built
   * rather than re-reading ~105k tokens. Falls back to a fresh session
   * automatically when the CLI rejects the id.
   */
  resumeSessionId?: string;
  /** When false, successful execution does not mark Task.status as done. */
  autoCompleteTask?: boolean;
  /**
   * Internal: when set, the executor will not retry on provider failure.
   * Used by the fallback path itself to prevent recursion.
   */
  disableFallback?: boolean;
  /**
   * Investigation mode: agent runs as read-only researcher/planner.
   * For codex specifically this means `--sandbox=read-only
   * --ask-for-approval=never -o <file>` so the agent CANNOT modify code at
   * the OS level — perfect for the safe research → plan → review chain.
   * The orchestrator wires this through to the CLI args.
   */
  investigationMode?: boolean;
  /**
   * Output artifact type for investigation mode. Drives codex's
   * positional headline (`# 調査レポート` / `# 実装計画` / …) so the
   * planner phase produces documents with the correct shape
   * instead of being force-shaped as research reports.
   */
  investigationOutputType?: 'research' | 'plan' | 'review' | 'verify';
  /**
   * Optional path to which the agent should write its final assistant
   * message. Used together with investigationMode for codex's `-o` flag.
   * Caller resolves this to the workflow file path (research.md / plan.md).
   */
  outputLastMessageFile?: string;
};

export type ExecutionState = {
  executionId: number;
  sessionId: number;
  agentId: string;
  taskId: number;
  status: AgentStatus;
  startedAt: Date;
  output: string;
};

export type OrchestratorEvent = {
  type:
    | 'execution_started'
    | 'execution_output'
    | 'execution_completed'
    | 'execution_failed'
    | 'execution_cancelled';
  executionId: number;
  sessionId: number;
  taskId: number;
  data?: unknown;
  timestamp: Date;
};

export type EventListener = (event: OrchestratorEvent) => void;

/**
 * Tracking info for an active agent.
 */
export type ActiveAgentInfo = {
  agent: BaseAgent;
  executionId: number;
  sessionId: number;
  taskId: number;
  state: ExecutionState;
  lastOutput: string;
  lastSavedAt: Date;
  fileLogger?: ExecutionFileLogger;
};

/**
 * Orchestrator shared context.
 * Provides access to shared state and methods needed by each module.
 */
export type OrchestratorContext = {
  prisma: PrismaClientInstance;
  activeExecutions: Map<number, ExecutionState>;
  activeAgents: Map<number, ActiveAgentInfo>;
  isShuttingDown: boolean;
  serverStartedAt: Date;
  emitEvent: (event: OrchestratorEvent) => void;
  startQuestionTimeout: (executionId: number, taskId: number, questionKey?: QuestionKey) => void;
  cancelQuestionTimeout: (executionId: number) => void;
  getQuestionTimeoutInfo: (executionId: number) => {
    remainingSeconds: number;
    deadline: Date;
    questionKey?: QuestionKey;
  } | null;
  tryAcquireContinuationLock: (
    executionId: number,
    source: 'user_response' | 'auto_timeout',
  ) => boolean;
  releaseContinuationLock: (executionId: number) => void;
  buildAgentConfigFromDb: (
    dbConfig: {
      id: number;
      agentType: string;
      name: string;
      apiKeyEncrypted: string | null;
      endpoint: string | null;
      modelId: string | null;
    },
    options: { workingDirectory?: string; timeout?: number },
  ) => Promise<AgentConfigInput>;
};
