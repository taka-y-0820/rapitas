/**
 * Workflow Orchestrator
 *
 * Manages automatic progression of workflow phases and executes AI agents assigned to each phase.
 * CLI agents (claude-code, gemini, codex) run via AgentOrchestrator.
 * API agents (anthropic-api, openai, etc.) call APIs directly and save output files on their behalf.
 */
import { observeWorkflowStage } from './workflow-stage-timing';
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { ExecutionCancelledError } from '../agents/execution-cancelled-error';
import { type WorkflowAdvanceResult } from './workflow-agent-executor';
import {
  acquireTaskExecutionLock,
  getTaskExecutionLockOwner,
  releaseTaskExecutionLock,
  getTaskExecutionCancellationVersion,
  WORKFLOW_LOCK_TTL_MS,
} from '../agents/task-execution-lock';
import { narrowWorkflowStatus } from './workflow-types.guards.generated';
import { runPreflight } from './workflow-orchestrator-preflight';
import { guardImplementOverlap } from './workflow-orchestrator-overlap-guard';
import { prepareAgentAndPrompt } from './workflow-orchestrator-agent-prep';
import { runPreflightProbe } from './workflow-orchestrator-preflight-probe';
import { guardPlanValidity } from './workflow-orchestrator-plan-guard';
import {
  buildExecutionContext,
  resolveEffectiveModel,
  reconcileTaskStatusBeforeRun,
} from './workflow-orchestrator-context';
import { executeAgentWithFallback } from './workflow-orchestrator-execute';
import { readPromptLanguage } from '../system/prompt-language-store';

// Re-export sub-module helpers so existing imports from this path keep working.
export { resolveWorkflowDir, readWorkflowFile, writeWorkflowFile } from './workflow-file-utils';
export type { WorkflowFileType } from './workflow-file-utils';
export { buildRoleContext } from './workflow-context-builder';
export { callAnthropicAPI, callOpenAIAPI, decryptApiKey } from './workflow-api-callers';
export type { WorkflowAdvanceResult } from './workflow-agent-executor';
export { resolveSystemPromptContent } from './workflow-orchestrator-prompt';

const log = createLogger('workflow-orchestrator');

// NOTE: The per-mode transition tables were moved to workflow-mode-config.ts,
// which builds them from DB-backed, UI-editable settings (single source of
// truth, shared with role-resolver and the frontend). Research is mandatory in
// every mode; the tiers diverge by ceremony (plan / review / auto-verify).

export class WorkflowOrchestrator {
  private static instance: WorkflowOrchestrator;

  static getInstance(): WorkflowOrchestrator {
    if (!WorkflowOrchestrator.instance) {
      WorkflowOrchestrator.instance = new WorkflowOrchestrator();
    }
    return WorkflowOrchestrator.instance;
  }

  /**
   * Get or create the DeveloperModeConfig required for AgentSession creation.
   *
   * @param taskId - The task ID. / タスクID
   * @returns The DeveloperModeConfig record. / DeveloperModeConfigレコード
   */
  private async getOrCreateDevConfig(taskId: number) {
    let devConfig = await prisma.developerModeConfig.findUnique({ where: { taskId } });
    if (!devConfig) {
      devConfig = await prisma.developerModeConfig.create({
        data: { taskId, isEnabled: true },
      });
    }
    return devConfig;
  }

  /**
   * Execute the next phase of the workflow.
   *
   * Acquires the process-wide per-task execution mutex BEFORE doing any work,
   * guaranteeing at most one agent runs per task at a time. The many triggers
   * that call this (queue runner, post-phase auto-advance setTimeouts, HTTP
   * approve/advance handlers, plan auto-approve) would otherwise spawn
   * duplicate agents for the same task. When the lock is already held, this
   * returns `skipped: true` WITHOUT spawning — the holder will advance the
   * workflow, so the duplicate trigger is a safe no-op.
   *
   * @param taskId - The task whose workflow should advance. / ワークフローを進めるタスクID
   * @param language - Language for generated content. / 生成コンテンツの言語
   * @returns Result of the phase execution. / フェーズ実行の結果
   */
  async advanceWorkflow(
    taskId: number,
    // Follows the UI locale unless a caller pins it (route bodies may).
    language: 'ja' | 'en' = readPromptLanguage(),
  ): Promise<WorkflowAdvanceResult> {
    // WORKFLOW_LOCK_TTL_MS intentionally exceeds the WorkflowRunner's per-phase
    // timeout (both derive from execution-timeouts) so a long phase cannot have
    // its lock stolen mid-run.
    if (!acquireTaskExecutionLock(taskId, WORKFLOW_LOCK_TTL_MS)) {
      const current = await prisma.task
        .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
        .catch(() => null);
      log.info(
        `[WorkflowOrchestrator] Task ${taskId} already has a phase running — skipping duplicate advance`,
      );
      return {
        success: true,
        skipped: true,
        role: 'researcher',
        status: narrowWorkflowStatus(current?.workflowStatus),
        output: 'skipped: another phase is already executing for this task',
      };
    }

    const owner = getTaskExecutionLockOwner(taskId);
    const cancellationVersion = getTaskExecutionCancellationVersion(taskId);
    const guardedAdvance = async (nextTaskId: number, nextLanguage: 'ja' | 'en') => {
      if (getTaskExecutionCancellationVersion(taskId) !== cancellationVersion) {
        throw new ExecutionCancelledError('Workflow continuation cancelled by stop request');
      }
      return this.advanceWorkflow(nextTaskId, nextLanguage);
    };
    const assertOwnership = () => {
      if (!owner || getTaskExecutionLockOwner(taskId) !== owner) {
        throw new ExecutionCancelledError(
          'Workflow preparation cancelled: execution lock ownership was revoked',
        );
      }
    };
    try {
      // A phase-critic verdict may still be in flight for the artifact that
      // triggered this advance (the save handler fails open past 90s while
      // the critique keeps running). Wait for it so we read the POST-verdict
      // workflowStatus — otherwise a late rejection rolls the workflow back
      // AFTER the next phase already dispatched against the rejected artifact
      // (task 536), which is what made critic bounces never regenerate.
      const { awaitCriticSettled } = await import('./phase-critic');
      await observeWorkflowStage(taskId, 'critic-settle', () => awaitCriticSettled(taskId));
      assertOwnership();
      return await this.runAdvanceWorkflow(taskId, language, assertOwnership, guardedAdvance);
    } finally {
      if (owner) releaseTaskExecutionLock(taskId, owner);
    }
  }

  /**
   * Inner implementation of {@link advanceWorkflow}. MUST only be called while
   * the task execution lock is held (advanceWorkflow guarantees this).
   *
   * NOTE: The stages below were extracted verbatim into sibling
   * workflow-orchestrator-*.ts modules (file-size ratchet, task 627). Each
   * stage returns `{ done: true, result }` to reproduce the original early
   * returns; the order of stages and their side effects are unchanged.
   *
   * @param taskId - The task whose workflow should advance. / ワークフローを進めるタスクID
   * @param language - Language for generated content. / 生成コンテンツの言語
   * @returns Result of the phase execution. / フェーズ実行の結果
   */
  private async runAdvanceWorkflow(
    taskId: number,
    language: 'ja' | 'en' = 'ja',
    assertOwnership: () => void = () => {},
    advanceFn = this.advanceWorkflow.bind(this),
  ): Promise<WorkflowAdvanceResult> {
    const preflight = await observeWorkflowStage(taskId, 'preflight', () => runPreflight(taskId));
    if (preflight.done) return preflight.result;
    const { task, workflowMode, currentStatus, transition } = preflight;

    // Cheap DB-only check first: an invalid plan.md must be caught before the
    // implementer overlap hold (which can wait up to 30 min) rather than after
    // it — otherwise detection is delayed by however long the hold lasts
    // (task 800: 45.1 min plan_approved stay before plan_invalid_replan fired).
    const guard = await observeWorkflowStage(taskId, 'plan-guard', () =>
      guardPlanValidity(taskId, transition, workflowMode, language),
    );
    if (guard.done) return guard.result;

    // Before any agent/prompt work: hold the implementer while its files are
    // still changing in another open auto-PR (skipped → the runner re-queues).
    const overlap = await observeWorkflowStage(taskId, 'overlap-guard', () =>
      guardImplementOverlap(taskId, transition, task, currentStatus),
    );
    if (overlap.done) return overlap.result;

    const prep = await observeWorkflowStage(taskId, 'agent-prep', () =>
      prepareAgentAndPrompt(taskId, transition, currentStatus),
    );
    if (prep.done) return prep.result;
    const { roleConfig, agentConfig, systemPromptContent } = prep;

    const probe = await observeWorkflowStage(taskId, 'preflight-probe', () =>
      runPreflightProbe(taskId, transition.role, agentConfig, currentStatus),
    );
    if (probe.done) return probe.result;

    const context = await observeWorkflowStage(taskId, 'context', () =>
      buildExecutionContext(taskId, transition, task, language, workflowMode),
    );
    const effectiveModelId = await resolveEffectiveModel(
      taskId,
      transition,
      task,
      roleConfig,
      agentConfig,
    );
    assertOwnership();
    await observeWorkflowStage(taskId, 'status-reconcile', () =>
      reconcileTaskStatusBeforeRun(taskId, currentStatus),
    );

    assertOwnership();
    return await executeAgentWithFallback({
      assertOwnership,
      taskId,
      task,
      transition,
      systemPromptContent,
      context,
      language,
      agentConfig,
      effectiveModelId,
      currentStatus,
      advanceFn,
      devConfigFn: this.getOrCreateDevConfig.bind(this),
    });
  }
}

// NOTE: tryProviderFallback / hasProviderErrorInOutput moved verbatim to
// workflow-provider-fallback.ts (file-size ratchet) and instrumented there
// with recovery-metrics recording (task 641). Behavior is unchanged.
