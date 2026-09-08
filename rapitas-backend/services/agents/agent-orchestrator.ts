/**
 * AgentOrchestrator (Facade)
 *
 * Thin wrapper that delegates to sub-modules by responsibility:
 * - orchestrator/types.ts: Shared type definitions
 * - orchestrator/lifecycle-manager.ts: Shutdown and state persistence
 * - orchestrator/task-executor.ts: Task execution
 * - orchestrator/continuation-executor.ts: Continuation execution and timeout handling
 * - orchestrator/recovery-manager.ts: Interruption recovery and resume
 * - orchestrator/git-operations.ts: Git operations
 * - orchestrator/question-timeout-manager.ts: Question timeout and lock management
 * - orchestrator/execution-helpers.ts: Shared output/question-detection handlers
 */
import { PrismaClient } from '../../generated/prisma-postgres';
type PrismaClientInstance = InstanceType<typeof PrismaClient>;

import type { AgentTask, AgentExecutionResult } from './base-agent';
import type { AgentConfigInput } from './agent-factory';
import { narrowAgentType } from './agent-factory';
import { resolveStoredSecret } from '../../utils/common/secret-store';
import type { QuestionKey } from './question-detection';
import { agentFactory } from './agent-factory';
import { createLogger } from '../../config/logger';
import { GitOperations } from './orchestrator/git-operations';
import { QuestionTimeoutManager } from './orchestrator/question-timeout-manager';
import type {
  ExecutionOptions,
  ExecutionState,
  OrchestratorEvent,
  EventListener,
  ActiveAgentInfo,
  OrchestratorContext,
} from './orchestrator/types';
import {
  setupSignalHandlers,
  gracefulShutdown as doGracefulShutdown,
  saveAllAgentStates,
} from './orchestrator/lifecycle-manager';
import { executeTask as doExecuteTask } from './orchestrator/task-executor';
import {
  executeContinuation as doExecuteContinuation,
  executeContinuationWithLock as doExecuteContinuationWithLock,
  handleQuestionTimeout as doHandleQuestionTimeout,
} from './orchestrator/continuation-executor';
import {
  getInterruptedExecutions as doGetInterruptedExecutions,
  recoverStaleExecutions as doRecoverStaleExecutions,
  resumeInterruptedExecution as doResumeInterruptedExecution,
  startExecutionLeaseSweep,
} from './orchestrator/recovery-manager';
import { EventManager } from './orchestrator/event-manager';

// Re-export types for backward compatibility
export type { ExecutionOptions, ExecutionState, OrchestratorEvent, EventListener };

const logger = createLogger('agent-orchestrator');

/**
 * AgentOrchestrator
 *
 * Singleton that coordinates agent execution, lifecycle, and recovery.
 */
export class AgentOrchestrator {
  private static instance: AgentOrchestrator;
  private prisma: PrismaClientInstance;
  private activeExecutions: Map<number, ExecutionState> = new Map();
  private activeAgents: Map<number, ActiveAgentInfo> = new Map();
  private eventManager: EventManager = new EventManager();
  private _isShuttingDown: boolean = false;
  /** When the shutdown latch was last set true, for stale-wedge detection. / ラッチを立てた時刻 */
  private _shuttingDownSince: number | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private serverStartedAt: Date = new Date();
  private serverStopCallback: (() => Promise<void> | void) | null = null;
  private gitOps: GitOperations = new GitOperations();
  private questionTimeoutManager: QuestionTimeoutManager = new QuestionTimeoutManager();

  private constructor(prisma: PrismaClientInstance) {
    this.prisma = prisma;
    setupSignalHandlers(
      () => this.gracefulShutdown(),
      () => saveAllAgentStates(this.prisma, this.activeAgents),
    );
    this.questionTimeoutManager.setTimeoutHandler((executionId, taskId) =>
      this.handleQuestionTimeout(executionId, taskId),
    );
    this.questionTimeoutManager.setEventEmitter((event) => this.eventManager.emitEvent(event));
  }

  static getInstance(prisma: PrismaClientInstance): AgentOrchestrator {
    if (!AgentOrchestrator.instance) {
      AgentOrchestrator.instance = new AgentOrchestrator(prisma);
    }
    return AgentOrchestrator.instance;
  }

  /** Build the shared context object for sub-modules. */
  private getContext(): OrchestratorContext {
    return {
      prisma: this.prisma,
      activeExecutions: this.activeExecutions,
      activeAgents: this.activeAgents,
      isShuttingDown: this.isEffectivelyShuttingDown(),
      serverStartedAt: this.serverStartedAt,
      emitEvent: (event) => this.eventManager.emitEvent(event),
      startQuestionTimeout: (eid, tid, qk) => this.startQuestionTimeout(eid, tid, qk),
      cancelQuestionTimeout: (eid) => this.cancelQuestionTimeout(eid),
      getQuestionTimeoutInfo: (eid) => this.getQuestionTimeoutInfo(eid),
      tryAcquireContinuationLock: (eid, src) => this.tryAcquireContinuationLock(eid, src),
      releaseContinuationLock: (eid) => this.releaseContinuationLock(eid),
      buildAgentConfigFromDb: (dbConfig, options) => this.buildAgentConfigFromDb(dbConfig, options),
    };
  }

  // ==================== Lifecycle ====================

  async gracefulShutdown(options?: { skipServerStop?: boolean }): Promise<void> {
    if (this._isShuttingDown) {
      logger.info('[Orchestrator] Shutdown already in progress, waiting...');
      return this.shutdownPromise || Promise.resolve();
    }

    this.shutdownPromise = doGracefulShutdown(
      {
        prisma: this.prisma,
        activeAgents: this.activeAgents,
        activeExecutions: this.activeExecutions,
        questionTimeoutManager: this.questionTimeoutManager,
        serverStopCallback: this.serverStopCallback,
        getIsShuttingDown: () => this._isShuttingDown,
        setIsShuttingDown: (v) => {
          this._isShuttingDown = v;
          this._shuttingDownSince = v ? Date.now() : null;
        },
      },
      options,
    );

    return this.shutdownPromise;
  }

  isInShutdown(): boolean {
    return this._isShuttingDown;
  }

  /**
   * Effective shutdown state, with self-healing for a wedged latch.
   *
   * `_isShuttingDown` is a one-way latch set by gracefulShutdown and normally
   * cleared only by the process exiting. If a shutdown is initiated but the
   * process never exits (an aborted/partial restart, or a shutdown call on a path
   * that stays alive), the latch sticks true and EVERY new execution is rejected
   * with "Server is shutting down, cannot start new execution" — an endless spin.
   * A real shutdown always exits within the 30s grace budget, so a latch still set
   * far past that is definitively stale: clear it and resume serving. Read on every
   * getContext(), so a spinning execution attempt self-heals the orchestrator.
   *
   * @returns Whether the orchestrator is genuinely shutting down right now. / 本当にシャットダウン中か
   */
  private isEffectivelyShuttingDown(): boolean {
    if (!this._isShuttingDown) return false;
    // » the 30s shutdown budget + restart backstop; only a true wedge lasts this long.
    const STALE_SHUTDOWN_MS = 90_000;
    if (
      this._shuttingDownSince !== null &&
      Date.now() - this._shuttingDownSince > STALE_SHUTDOWN_MS
    ) {
      logger.warn(
        { stuckForMs: Date.now() - this._shuttingDownSince },
        '[Orchestrator] Shutdown latch stuck past the grace budget without a process exit — clearing stale latch to resume executions',
      );
      this._isShuttingDown = false;
      this._shuttingDownSince = null;
      this.shutdownPromise = null;
      return false;
    }
    return true;
  }

  setServerStopCallback(callback: () => Promise<void> | void): void {
    this.serverStopCallback = callback;
  }

  async stopServer(): Promise<void> {
    if (this.serverStopCallback) {
      try {
        logger.info('[Orchestrator] Stopping server listener...');
        await this.serverStopCallback();
        logger.info('[Orchestrator] Server listener stopped');
      } catch (error) {
        logger.error({ err: error }, '[Orchestrator] Failed to stop server listener');
      }
    }
  }

  // ==================== Execution State Queries ====================

  getActiveExecutionCount(): number {
    return this.activeAgents.size;
  }

  getActiveAgentInfos(): Array<{
    executionId: number;
    sessionId: number;
    taskId: number;
    startedAt: Date;
    lastOutput: string;
  }> {
    return Array.from(this.activeAgents.values()).map((info) => ({
      executionId: info.executionId,
      sessionId: info.sessionId,
      taskId: info.taskId,
      startedAt: info.state.startedAt,
      lastOutput: info.lastOutput,
    }));
  }

  getActiveExecutions(): ExecutionState[] {
    return Array.from(this.activeExecutions.values());
  }

  getSessionExecutions(sessionId: number): ExecutionState[] {
    return Array.from(this.activeExecutions.values()).filter(
      (state) => state.sessionId === sessionId,
    );
  }

  getExecutionState(executionId: number): ExecutionState | undefined {
    return this.activeExecutions.get(executionId);
  }

  // ==================== Event Management ====================

  addEventListener(listener: EventListener): void {
    this.eventManager.addEventListener(listener);
  }

  removeEventListener(listener: EventListener): void {
    this.eventManager.removeEventListener(listener);
  }

  // ==================== Question Timeout Management ====================

  startQuestionTimeout(executionId: number, taskId: number, questionKey?: QuestionKey): void {
    this.questionTimeoutManager.startQuestionTimeout(executionId, taskId, questionKey);
  }

  cancelQuestionTimeout(executionId: number): void {
    this.questionTimeoutManager.cancelQuestionTimeout(executionId);
  }

  tryAcquireContinuationLock(
    executionId: number,
    source: 'user_response' | 'auto_timeout',
  ): boolean {
    return this.questionTimeoutManager.tryAcquireContinuationLock(executionId, source);
  }

  releaseContinuationLock(executionId: number): void {
    this.questionTimeoutManager.releaseContinuationLock(executionId);
  }

  hasContinuationLock(executionId: number): boolean {
    return this.questionTimeoutManager.hasContinuationLock(executionId);
  }

  getQuestionTimeoutInfo(executionId: number): {
    remainingSeconds: number;
    deadline: Date;
    questionKey?: QuestionKey;
  } | null {
    return this.questionTimeoutManager.getQuestionTimeoutInfo(executionId);
  }

  private async handleQuestionTimeout(executionId: number, taskId: number): Promise<void> {
    return doHandleQuestionTimeout(this.getContext(), executionId, taskId, (qk, qt, qd) =>
      this.questionTimeoutManager.generateDefaultResponse(qk as QuestionKey | undefined, qt, qd),
    );
  }

  // ==================== Task Execution ====================

  async executeTask(task: AgentTask, options: ExecutionOptions): Promise<AgentExecutionResult> {
    return doExecuteTask(this.getContext(), task, options);
  }

  // ==================== Continuation Execution ====================

  async executeContinuation(
    executionId: number,
    response: string,
    options: Partial<ExecutionOptions> = {},
  ): Promise<AgentExecutionResult> {
    return doExecuteContinuation(this.getContext(), executionId, response, options);
  }

  async executeContinuationWithLock(
    executionId: number,
    response: string,
    options: Partial<ExecutionOptions> = {},
  ): Promise<AgentExecutionResult> {
    return doExecuteContinuationWithLock(this.getContext(), executionId, response, options);
  }

  // ==================== Execution Stop ====================

  async stopExecution(executionId: number): Promise<boolean> {
    this.cancelQuestionTimeout(executionId);
    this.releaseContinuationLock(executionId);

    const state = this.activeExecutions.get(executionId);
    if (!state) {
      logger.info(`[Orchestrator] stopExecution: No active execution found for ${executionId}`);
      return false;
    }

    const agent = agentFactory.getAgent(state.agentId);
    if (!agent) {
      logger.info(`[Orchestrator] stopExecution: No agent found for ${state.agentId}`);
      this.activeExecutions.delete(executionId);
      this.activeAgents.delete(executionId);
      return false;
    }

    try {
      await agent.stop();
    } catch (error) {
      logger.error({ err: error }, `[Orchestrator] Error stopping agent`);
    }

    try {
      await this.prisma.agentExecution.update({
        where: { id: executionId },
        data: {
          status: 'cancelled',
          output: state.output,
          completedAt: new Date(),
          errorMessage: 'Cancelled by user',
        },
      });
    } catch (error) {
      // NOTE: The agent process is already stopped above; a DB write failure
      // here must not abort the rest of this method, or the in-memory
      // activeExecutions/activeAgents maps are left with a permanently
      // stale entry for an execution whose agent no longer exists — the
      // caller (e.g. stopAllForTasks) already treats stopExecution as
      // best-effort via `.catch(() => {})`, so this mirrors that contract.
      logger.error({ err: error }, `[Orchestrator] Failed to persist cancellation for execution`);
    }

    this.activeExecutions.delete(executionId);
    this.activeAgents.delete(executionId);
    await agentFactory.removeAgent(state.agentId);

    this.eventManager.emitEvent({
      type: 'execution_cancelled',
      executionId,
      sessionId: state.sessionId,
      taskId: state.taskId,
      timestamp: new Date(),
    });

    logger.info(`[Orchestrator] Execution ${executionId} stopped and cleaned up`);
    return true;
  }

  /**
   * Stop ALL in-memory executions whose taskId is in the given set.
   *
   * Uses activeAgents directly, bypassing the DB query — catches agents that
   * are alive but have a stale or missing DB status row (race condition during
   * spawn, partial prior stop, orphaned in-progress row).
   *
   * @param taskIds - Set of task IDs to sweep. / 停止対象タスクID集合
   * @returns Execution IDs that were stopped. / 停止した実行ID一覧
   */
  async stopAllForTasks(taskIds: Set<number>): Promise<number[]> {
    const stopped: number[] = [];
    // Snapshot before iterating — stopExecution mutates activeAgents.
    const entries = [...this.activeAgents.entries()];
    for (const [executionId, info] of entries) {
      if (taskIds.has(info.taskId)) {
        await this.stopExecution(executionId).catch(() => {});
        stopped.push(executionId);
      }
    }
    if (stopped.length > 0) {
      logger.info(
        { stopped, taskCount: taskIds.size },
        '[Orchestrator] stopAllForTasks: swept in-memory agents',
      );
    }
    return stopped;
  }

  // ==================== Recovery ====================

  async getInterruptedExecutions() {
    return doGetInterruptedExecutions(this.prisma);
  }

  async recoverStaleExecutions() {
    const result = await doRecoverStaleExecutions(this.getContext());
    // After the one-shot startup pass, keep a periodic dead-lease sweep
    // running — it catches deaths the startup pass structurally cannot see
    // (in-process worker restarts leave rows newer than serverStartedAt).
    startExecutionLeaseSweep(this.getContext());
    return result;
  }

  async resumeInterruptedExecution(
    executionId: number,
    options: Partial<ExecutionOptions> = {},
  ): Promise<AgentExecutionResult> {
    return doResumeInterruptedExecution(this.getContext(), executionId, options);
  }

  // ==================== Git Operations ====================

  async getGitDiff(workingDirectory: string): Promise<string> {
    return this.gitOps.getGitDiff(workingDirectory);
  }

  async getFullGitDiff(workingDirectory: string): Promise<string> {
    return this.gitOps.getFullGitDiff(workingDirectory);
  }

  async commitChanges(
    workingDirectory: string,
    message: string,
    taskTitle?: string,
  ): Promise<{ success: boolean; commitHash?: string; error?: string }> {
    return this.gitOps.commitChanges(workingDirectory, message, taskTitle);
  }

  async createPullRequest(
    workingDirectory: string,
    title: string,
    body: string,
    baseBranch?: string,
    headBranch?: string,
    draft?: boolean,
  ): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
    return this.gitOps.createPullRequest(
      workingDirectory,
      title,
      body,
      baseBranch,
      headBranch,
      draft,
    );
  }

  async mergePullRequest(
    workingDirectory: string,
    prNumber: number,
    commitThreshold: number = 5,
    baseBranch: string = 'master',
  ): Promise<{
    success: boolean;
    mergeStrategy?: 'squash' | 'merge';
    error?: string;
  }> {
    return this.gitOps.mergePullRequest(workingDirectory, prNumber, commitThreshold, baseBranch);
  }

  async revertChanges(workingDirectory: string): Promise<boolean> {
    return this.gitOps.revertChanges(workingDirectory);
  }

  async createBranch(workingDirectory: string, branchName: string): Promise<boolean> {
    return this.gitOps.createBranch(workingDirectory, branchName);
  }

  /**
   * Create a git worktree for isolated task execution.
   *
   * @param baseDir - Main repository root / メインリポジトリルート
   * @param branchName - Branch to create / 作成するブランチ名
   * @param taskId - Task ID for directory naming / ディレクトリ名用タスクID
   * @param repositoryUrl - Expected remote URL for validation / 検証用リモートURL
   * @returns Absolute path to the worktree / worktreeの絶対パス
   */
  async createWorktree(
    baseDir: string,
    branchName: string,
    taskId?: number,
    repositoryUrl?: string | null,
    baseBranch?: string | null,
  ): Promise<string> {
    return this.gitOps.createWorktree(baseDir, branchName, taskId, repositoryUrl, baseBranch);
  }

  /**
   * Remove a git worktree.
   *
   * @param baseDir - Main repository root / メインリポジトリルート
   * @param worktreePath - Worktree path to remove / 削除するworktreeパス
   */
  async removeWorktree(baseDir: string, worktreePath: string): Promise<boolean> {
    return this.gitOps.removeWorktree(baseDir, worktreePath);
  }

  /**
   * Clean up stale worktrees from previous crashes.
   *
   * @param baseDir - Main repository root / メインリポジトリルート
   * @param keepPaths - Live worktrees that must NOT be removed / 保護対象worktree
   * @returns Count of cleaned worktrees / クリーンアップ数
   */
  async cleanupStaleWorktrees(baseDir: string, keepPaths: string[] = []): Promise<number> {
    return this.gitOps.cleanupStaleWorktrees(baseDir, keepPaths);
  }

  async createCommit(
    workingDirectory: string,
    message: string,
    preferredBaseBranch?: string | null,
  ): Promise<{
    hash: string;
    branch: string;
    filesChanged: number;
    additions: number;
    deletions: number;
    alreadyCommitted: boolean;
  }> {
    return this.gitOps.createCommit(workingDirectory, message, preferredBaseBranch);
  }

  async getDiff(workingDirectory: string): Promise<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>
  > {
    return this.gitOps.getDiff(workingDirectory);
  }

  // ==================== Helpers ====================

  private async buildAgentConfigFromDb(
    dbConfig: {
      id: number;
      agentType: string;
      name: string;
      apiKeyEncrypted: string | null;
      endpoint: string | null;
      modelId: string | null;
    },
    options: { workingDirectory?: string; timeout?: number },
  ): Promise<AgentConfigInput> {
    let decryptedApiKey: string | undefined;
    if (dbConfig.apiKeyEncrypted) {
      try {
        decryptedApiKey = resolveStoredSecret(dbConfig.apiKeyEncrypted) ?? undefined;
      } catch (e) {
        logger.error(
          { err: e, agentId: dbConfig.id },
          `[Orchestrator] Failed to decrypt API key for agent`,
        );
      }
    }

    // Read the user's permission-skip preference. Defaults to true when the
    // setting row is missing so historical behaviour is preserved on first
    // boot. When this is false the CLI agent's native approval prompts are
    // surfaced to the user via stdin.
    const settings = await this.prisma.userSettings.findFirst({
      select: { skipAgentPermissionPrompts: true } as Record<string, true>,
    });
    const skipPrompts =
      ((settings as Record<string, unknown> | null)?.skipAgentPermissionPrompts as
        | boolean
        | undefined) ?? true;

    return {
      type: narrowAgentType(dbConfig.agentType),
      name: dbConfig.name,
      endpoint: dbConfig.endpoint || undefined,
      apiKey: decryptedApiKey,
      modelId: dbConfig.modelId || undefined,
      workingDirectory: options.workingDirectory,
      timeout: options.timeout,
      dangerouslySkipPermissions: skipPrompts,
      yoloMode: skipPrompts,
    };
  }
}

export function createOrchestrator(prisma: PrismaClientInstance): AgentOrchestrator {
  return AgentOrchestrator.getInstance(prisma);
}
