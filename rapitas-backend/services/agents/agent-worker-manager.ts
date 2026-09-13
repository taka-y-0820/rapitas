/**
 * Agent Worker Manager
 *
 * Manages agent worker processes, IPC communication, health checks,
 * and real-time event bridging.
 *
 * Provides the same interface as AgentOrchestrator,
 * transparently delegating calls from agent-execution-router to the worker.
 * Implementation details are split across agent-worker/*.ts sub-modules.
 */

import { createLogger } from '../../config/logger';
import { isApiRecoveryMode } from '../system/api-recovery-mode';
import type { AgentTask, AgentExecutionResult } from './base-agent';
import type { ExecutionOptions, ExecutionState } from './orchestrator/types';
import type { QuestionKey } from './question-detection';
import { getProjectRoot } from '../../config';
import { sendIPCRequest, type PendingRequest } from './agent-worker/ipc';
import { type WorkerState } from './agent-worker/lifecycle';
import { initializeWorker, gracefulShutdown } from './agent-worker/worker-shutdown';
import * as api from './agent-worker/public-api';
import * as git from './agent-worker/git-api';

const logger = createLogger('agent-worker-manager');

export class AgentWorkerManager {
  private static instance: AgentWorkerManager;

  // NOTE: state is a single mutable object so sub-modules can mutate it by reference
  private state: WorkerState = {
    workerProcess: null,
    pendingRequests: new Map<string, PendingRequest>(),
    isWorkerReady: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    restartPromise: null,
    requestIdCounter: 0,
    readyResolve: null,
    cachedActiveCount: 0,
  };

  private constructor() {}

  public static getInstance(): AgentWorkerManager {
    if (!AgentWorkerManager.instance) {
      AgentWorkerManager.instance = new AgentWorkerManager();
    }
    return AgentWorkerManager.instance;
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${++this.state.requestIdCounter}`;
  }

  private ipc(
    type: string,
    data: Record<string, unknown>,
    timeoutMs: number = 60000,
  ): Promise<unknown> {
    return sendIPCRequest(
      this.state.workerProcess,
      this.state.isWorkerReady,
      this.state.pendingRequests,
      this.generateRequestId.bind(this),
      type,
      data,
      timeoutMs,
    );
  }

  /**
   * Starts the worker process and waits until it reaches the ready state.
   * Called during server startup in index.ts.
   */
  public async initialize(): Promise<void> {
    if (isApiRecoveryMode()) throw new Error('Agent workers are held during API recovery');
    await initializeWorker(
      this.state,
      (baseDir) => this.cleanupStaleWorktrees(baseDir),
      getProjectRoot(),
    );
  }

  // ==================== Public API (Orchestrator-compatible) ====================

  async executeTask(task: AgentTask, options: ExecutionOptions): Promise<AgentExecutionResult> {
    return api.executeTask(this.ipc.bind(this), task, options);
  }

  async executeContinuation(
    executionId: number,
    response: string,
    options: Partial<ExecutionOptions> = {},
  ): Promise<AgentExecutionResult> {
    return api.executeContinuation(this.ipc.bind(this), executionId, response, options);
  }

  async executeContinuationWithLock(
    executionId: number,
    response: string,
    options: Partial<ExecutionOptions> = {},
  ): Promise<AgentExecutionResult> {
    return api.executeContinuationWithLock(this.ipc.bind(this), executionId, response, options);
  }

  async stopExecution(executionId: number): Promise<boolean> {
    return this.ipc('stop-execution', { executionId }, 10000) as Promise<boolean>;
  }

  /** Retrieves active executions within a session (async). */
  async getSessionExecutionsAsync(sessionId: number): Promise<ExecutionState[]> {
    return api.getSessionExecutionsAsync(this.ipc.bind(this), sessionId);
  }

  /** Retrieves the active execution count (async). */
  async getActiveExecutionCountAsync(): Promise<number> {
    const count = (await this.ipc('get-active-count', {}, 5000)) as number;
    this.state.cachedActiveCount = count;
    return count;
  }

  /** Retrieves the active execution count synchronously (cached value). */
  getActiveExecutionCount(): number {
    return this.state.cachedActiveCount;
  }

  /** Async version of lock acquisition. */
  async tryAcquireContinuationLockAsync(
    executionId: number,
    source: 'user_response' | 'auto_timeout',
  ): Promise<boolean> {
    return this.ipc('try-acquire-lock', { executionId, source }, 5000) as Promise<boolean>;
  }

  cancelQuestionTimeout(executionId: number): void {
    this.ipc('cancel-timeout', { executionId }, 5000).catch((err) => {
      logger.error({ err }, '[AgentWorkerManager] Failed to cancel timeout');
    });
  }

  /** Async retrieval of question timeout info. */
  async getQuestionTimeoutInfoAsync(
    executionId: number,
  ): Promise<{ remainingSeconds: number; deadline: Date; questionKey?: QuestionKey } | null> {
    return api.getQuestionTimeoutInfoAsync(this.ipc.bind(this), executionId);
  }

  async resumeInterruptedExecution(
    executionId: number,
    options: Partial<ExecutionOptions> = {},
  ): Promise<AgentExecutionResult> {
    return api.resumeInterruptedExecution(this.ipc.bind(this), executionId, options);
  }

  async recoverStaleExecutions(): Promise<{
    recoveredExecutions: number;
    updatedTasks: number;
    updatedSessions: number;
    interruptedExecutionIds: number[];
    reconciledBlockedSessions: number;
    prunedWorktreePointers: number;
  }> {
    return this.ipc('recover-stale', {}, 30000) as Promise<{
      recoveredExecutions: number;
      updatedTasks: number;
      updatedSessions: number;
      interruptedExecutionIds: number[];
      reconciledBlockedSessions: number;
      prunedWorktreePointers: number;
    }>;
  }

  // ==================== Git Operations ====================

  async createBranch(workingDirectory: string, branchName: string): Promise<boolean> {
    return git.createBranch(this.ipc.bind(this), workingDirectory, branchName);
  }

  /**
   * Create a git worktree for isolated task execution.
   *
   * @param baseDir - Main repository root / メインリポジトリルート
   * @param branchName - Branch to create / 作成するブランチ名
   * @param taskId - Task ID for directory naming / ディレクトリ名用タスクID
   * @param repositoryUrl - Expected remote URL for validation / 検証用リモートURL
   * @returns Absolute path to the created worktree / worktreeの絶対パス
   */
  async createWorktree(
    baseDir: string,
    branchName: string,
    taskId?: number,
    repositoryUrl?: string | null,
    baseBranch?: string | null,
  ): Promise<string> {
    return git.createWorktree(
      this.ipc.bind(this),
      baseDir,
      branchName,
      taskId,
      repositoryUrl,
      baseBranch,
    );
  }

  /**
   * Remove a git worktree.
   *
   * @param baseDir - Main repository root / メインリポジトリルート
   * @param worktreePath - Worktree to remove / 削除するworktreeパス
   */
  async removeWorktree(baseDir: string, worktreePath: string): Promise<boolean> {
    return git.removeWorktree(this.ipc.bind(this), baseDir, worktreePath);
  }

  /**
   * Clean up stale worktrees from previous crashes.
   *
   * @param baseDir - Main repository root / メインリポジトリルート
   * @returns Count of cleaned worktrees / クリーンアップ数
   */
  async cleanupStaleWorktrees(baseDir: string): Promise<number> {
    // Liveness filter: worktrees of non-terminal tasks must survive worker
    // (re)initialization — see worktree-keep-list.ts for the incident behind this.
    let keepPaths: string[];
    try {
      const { computeWorktreeKeepPaths } = await import('./worktree-keep-list');
      keepPaths = await computeWorktreeKeepPaths(baseDir);
    } catch {
      // Fail-safe: with no liveness verdict, DELETING is the dangerous action —
      // skip this cleanup cycle entirely rather than wipe live work.
      return 0;
    }
    return git.cleanupStaleWorktrees(this.ipc.bind(this), baseDir, keepPaths);
  }

  async commitChanges(
    workingDirectory: string,
    message: string,
    taskTitle?: string,
  ): Promise<{ success: boolean; commitHash?: string; error?: string }> {
    return git.commitChanges(this.ipc.bind(this), workingDirectory, message, taskTitle);
  }

  async createCommit(
    workingDirectory: string,
    message: string,
  ): Promise<{
    hash: string;
    branch: string;
    filesChanged: number;
    additions: number;
    deletions: number;
  }> {
    return git.createCommit(this.ipc.bind(this), workingDirectory, message);
  }

  async createPullRequest(
    workingDirectory: string,
    title: string,
    body: string,
    baseBranch: string = 'main',
  ): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
    return git.createPullRequest(this.ipc.bind(this), workingDirectory, title, body, baseBranch);
  }

  async mergePullRequest(
    workingDirectory: string,
    prNumber: number,
    commitThreshold: number = 5,
    baseBranch: string = 'master',
  ): Promise<{ success: boolean; mergeStrategy?: 'squash' | 'merge'; error?: string }> {
    return git.mergePullRequest(
      this.ipc.bind(this),
      workingDirectory,
      prNumber,
      commitThreshold,
      baseBranch,
    );
  }

  async getGitDiff(workingDirectory: string): Promise<string> {
    return git.getGitDiff(this.ipc.bind(this), workingDirectory);
  }

  async getFullGitDiff(workingDirectory: string): Promise<string> {
    return git.getFullGitDiff(this.ipc.bind(this), workingDirectory);
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
    return git.getDiff(this.ipc.bind(this), workingDirectory);
  }

  async revertChanges(workingDirectory: string): Promise<boolean> {
    return git.revertChanges(this.ipc.bind(this), workingDirectory);
  }

  // ==================== Sync Compatibility Methods ====================

  /**
   * Sync version of getSessionExecutions (for compatibility).
   * Worker communication is async, so this always returns an empty array.
   * Use getSessionExecutionsAsync() when accurate values are needed.
   */
  getSessionExecutions(_sessionId: number): ExecutionState[] {
    return [];
  }

  getActiveAgentInfos(): Array<{
    executionId: number;
    sessionId: number;
    taskId: number;
    startedAt: Date;
    lastOutput: string;
  }> {
    return [];
  }

  getActiveExecutions(): ExecutionState[] {
    return [];
  }

  /**
   * Asynchronously retrieves the list of active execution IDs from the worker process.
   * Used by the resumable-executions API for accurate active execution detection.
   * Returns an empty array immediately when the worker is not ready or shutting down,
   * matching the early-return pattern in lifecycle.ts:198.
   *
   * @returns Array of active execution IDs / アクティブ実行IDリスト（未準備時は空配列）
   */
  async getActiveExecutionIdsAsync(): Promise<number[]> {
    // Guard matches lifecycle.ts:198 — skip IPC when worker is not ready or shutting down.
    if (!this.state.isWorkerReady || this.state.isShuttingDown) {
      return [];
    }
    return api.getActiveExecutionIdsAsync(this.ipc.bind(this));
  }

  getExecutionState(_executionId: number): ExecutionState | undefined {
    return undefined;
  }

  // ==================== Stub Methods (Orchestrator-compatible) ====================

  addEventListener(_listener: (event: unknown) => void): void {
    // Events are already bridged to SSE via handleOrchestratorEvent
  }

  removeEventListener(_listener: (event: unknown) => void): void {}

  isInShutdown(): boolean {
    return this.state.isShuttingDown;
  }

  setServerStopCallback(_callback: () => Promise<void> | void): void {
    // Worker does not stop the server
  }

  async stopServer(): Promise<void> {
    // Handled directly in the main process index.ts
  }

  // ==================== Lifecycle ====================

  public getIsWorkerReady(): boolean {
    return this.state.isWorkerReady;
  }

  public async gracefulShutdown(_options?: { skipServerStop?: boolean }): Promise<void> {
    await gracefulShutdown(this.state);
  }
}
