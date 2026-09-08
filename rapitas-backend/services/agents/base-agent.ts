/**
 * BaseAgent
 *
 * Abstract base class for AI agents. Designed for extensibility
 * with additional agent types (Codex, Gemini, etc.).
 */

export type AgentCapability = {
  codeGeneration: boolean;
  codeReview: boolean;
  taskAnalysis: boolean;
  fileOperations: boolean;
  terminalAccess: boolean;
  gitOperations?: boolean;
  webSearch?: boolean;
};

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_for_input'
  // NOTE: investigationMode で codex が exit 0 した直後、research.md の slice 保存を待つ過渡状態
  | 'post_processing';

/**
 * AI task analysis result for structured prompt generation.
 */
export type TaskAnalysisInfo = {
  summary: string;
  complexity: 'simple' | 'medium' | 'complex';
  estimatedTotalHours: number;
  subtasks: Array<{
    title: string;
    description: string;
    estimatedHours: number;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    order: number;
    dependencies?: number[];
  }>;
  reasoning: string;
  tips?: string[];
};

export type AgentTask = {
  id: number;
  title: string;
  description?: string | null;
  context?: string;
  workingDirectory?: string;
  repositoryUrl?: string;
  /** Theme ID this task belongs to. */
  themeId?: number | null;
  /** AI task analysis result (when analysis is enabled). */
  analysisInfo?: TaskAnalysisInfo;
  /** Optimized prompt (structured and optimized by AI). */
  optimizedPrompt?: string;
  /** Claude Code CLI session ID (used with --resume to continue conversation). */
  resumeSessionId?: string;
  /** Model ID override for this task (e.g., "claude-sonnet-4-5-20250514"). */
  modelId?: string;
  /** Whether plan.md should be auto-approved (skips waiting for user approval). */
  autoApprovePlan?: boolean;
  /**
   * Investigation mode: agent runs as read-only researcher/planner.
   * For codex this triggers `--sandbox=read-only --ask-for-approval=never`
   * so code modifications are physically impossible.
   */
  investigationMode?: boolean;
  /**
   * Investigation phase output type. Codex uses this to decide which
   * heading the final markdown must start with (`# 調査レポート` /
   * `# 実装計画` / `# レビュー指摘` / `# 検証結果`). The orchestrator
   * passes the role's output file label so each phase produces an
   * artifact with the right shape.
   */
  investigationOutputType?: 'research' | 'plan' | 'review' | 'verify';
  /**
   * Path to which the agent should write its final assistant message.
   * For codex, mapped to the `-o / --output-last-message` flag.
   */
  outputLastMessageFile?: string;
};

/**
 * Question type discriminator.
 * - 'tool_call': Question via Claude Code's AskUserQuestion tool call
 * - 'none': No question
 *
 * @deprecated Use QuestionDetectionMethod in new implementations.
 * Question detection now relies solely on AskUserQuestion tool calls.
 * SSOT is now types/agent-execution-types.ts — this re-export exists for backward compatibility.
 */
import type { QuestionType } from '../../types/agent-execution-types';
export type { QuestionType };

// QuestionDetails is re-exported from question-detection.ts for backward compatibility

export type AgentExecutionResult = {
  success: boolean;
  output: string;
  artifacts?: AgentArtifact[];
  tokensUsed?: number;
  executionTimeMs?: number;
  errorMessage?: string;
  commits?: GitCommitInfo[];
  waitingForInput?: boolean;
  question?: string;
  /** Question detection method (tool_call: AskUserQuestion tool, none: no question). */
  questionType?: QuestionType;
  /** Question details (options, etc.). */
  questionDetails?: import('./question-detection').QuestionDetails;
  /** Structured question key (new format). */
  questionKey?: import('./question-detection').QuestionKey;
  /** Claude Code CLI session ID (used with --resume to continue conversation). */
  claudeSessionId?: string;
  /** Number of retry attempts before this result. */
  retryCount?: number;
  /** Classified failure reason (for retry decisions). */
  failureType?:
    | 'test_failed'
    | 'lint_error'
    | 'type_error'
    | 'timeout'
    | 'wall_clock_timeout'
    | 'cancelled'
    | 'prompt_too_long'
    | 'unknown';
  /** Real cost (USD) reported by Claude Code's stream-json `result` event. */
  costUsd?: number;
  /** Standard input tokens reported by `result.usage.input_tokens`. */
  inputTokens?: number;
  /** Output tokens reported by `result.usage.output_tokens`. */
  outputTokens?: number;
  /** Cache-read input tokens reported by `result.usage.cache_read_input_tokens`. */
  cacheReadInputTokens?: number;
  /** Cache-creation input tokens reported by `result.usage.cache_creation_input_tokens`. */
  cacheCreationInputTokens?: number;
  /** Primary model used for this execution (largest token share in `modelUsage`). */
  modelName?: string;
  /** LLM API call count for this execution. CLI: from stream-json num_turns. API: 1 per callApi. */
  llmCallCount?: number;
  /** Measured child-process CPU time in ms, sampled by process-resource-sampler. null when unmeasured. */
  cpuTimeMs?: number | null;
  /** Measured child-process peak RSS in KB, sampled by process-resource-sampler. null when unmeasured. */
  peakRssKb?: number | null;
  /**
   * The agent's FINAL assistant message only (Claude Code stream-json `result`
   * event). Unlike `output` — which concatenates every streamed assistant
   * delta, tool-result display, and status line — this is the clean final
   * answer. Investigation phases save THIS as research.md / plan.md to avoid
   * the mid-run narration noise that polluted those files.
   */
  finalMessage?: string;
};

export type AgentArtifact = {
  type: 'file' | 'code' | 'diff' | 'log';
  name: string;
  content: string;
  path?: string;
};

export type GitCommitInfo = {
  hash: string;
  message: string;
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
};

export type AgentOutputHandler = (output: string, isError?: boolean) => void;

/**
 * Callback handler invoked immediately when a question is detected during streaming.
 */
export type QuestionDetectedHandler = (info: {
  question: string;
  questionType: QuestionType;
  questionDetails?: import('./question-detection').QuestionDetails;
  questionKey?: import('./question-detection').QuestionKey;
  /** Claude Code CLI session ID (used for resuming). */
  claudeSessionId?: string;
}) => void;

export abstract class BaseAgent {
  protected status: AgentStatus = 'idle';
  protected outputHandler?: AgentOutputHandler;
  protected questionDetectedHandler?: QuestionDetectedHandler;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly type: string,
  ) {}

  /**
   * Log prefix in [AgentName] format. Subclasses may override per-execution
   * (e.g. CodexCliAgent in investigation mode renames itself to
   * "Research Agent" so logs make the role obvious).
   */
  get logPrefix(): string {
    return `[${this.name}]`;
  }

  /**
   * Return the agent's capabilities.
   */
  abstract getCapabilities(): AgentCapability;

  /**
   * Execute a task.
   */
  abstract execute(
    task: AgentTask,
    options?: Record<string, unknown>,
  ): Promise<AgentExecutionResult>;

  /**
   * Stop execution.
   */
  abstract stop(): Promise<void>;

  /**
   * Pause execution (if supported).
   */
  async pause(): Promise<boolean> {
    return false;
  }

  /**
   * Resume execution (if supported).
   */
  async resume(): Promise<boolean> {
    return false;
  }

  /**
   * Get current status.
   */
  getStatus(): AgentStatus {
    return this.status;
  }

  /**
   * Set the output handler.
   */
  setOutputHandler(handler: AgentOutputHandler): void {
    this.outputHandler = handler;
  }

  /**
   * Set the question detection handler.
   * Called immediately when a question is detected during streaming.
   */
  setQuestionDetectedHandler(handler: QuestionDetectedHandler): void {
    this.questionDetectedHandler = handler;
  }

  /**
   * Emit a question detection event.
   */
  protected emitQuestionDetected(info: Parameters<QuestionDetectedHandler>[0]): void {
    if (this.questionDetectedHandler) {
      this.questionDetectedHandler(info);
    }
  }

  /**
   * Emit output.
   */
  protected emitOutput(output: string, isError: boolean = false): void {
    if (this.outputHandler && output != null && output !== 'null' && output !== 'undefined') {
      this.outputHandler(output, isError);
    }
  }

  /**
   * Check whether the agent is available.
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Validate the agent configuration.
   */
  abstract validateConfig(): Promise<{ valid: boolean; errors: string[] }>;
}
