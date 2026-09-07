/**
 * Workflow Orchestrator — Agent Execution
 *
 * Final stage of runAdvanceWorkflow: applies the resolved model to the agent
 * config, dispatches to the CLI or API executor and wraps the run in the
 * single-retry provider fallback. Moved verbatim from workflow-orchestrator.ts
 * (file-size ratchet, task 627); behavior is unchanged.
 */
import { createLogger } from '../../config/logger';
import {
  executeCLIAgent,
  executeAPIAgent,
  type WorkflowAdvanceResult,
} from './workflow-agent-executor';
import { isShutdownError } from '../agents/orchestrator/shutdown-error';
import { tryProviderFallback, hasProviderErrorInOutput } from './workflow-provider-fallback';
import type { RoleTransition, WorkflowStatus } from './workflow-types';
import type { ComparisonAssignment } from '../self-learning/comparison/prompt-comparison-types';
import { resolveExecutableAgentConfig } from './workflow-orchestrator-agent-config';
import type { ResolvedTask } from './workflow-orchestrator-preflight';

const log = createLogger('workflow-orchestrator');

const CLI_AGENT_TYPES = new Set(['claude-code', 'codex', 'gemini']);

/**
 * Executes the phase agent with provider fallback.
 *
 * @param params - Execution inputs assembled by the preceding stages. / 先行段階で組み立てた実行入力
 * @returns Phase execution result. / フェーズ実行結果
 * @throws Re-throws shutdown errors so the runner can requeue without consuming retries. / シャットダウンエラーは再throw
 */
export async function executeAgentWithFallback(params: {
  taskId: number;
  task: ResolvedTask;
  transition: RoleTransition;
  systemPromptContent: string;
  context: string;
  /** Prompt-comparison arm this phase was assigned to, carried to the run recorder. */
  comparisonAssignment: ComparisonAssignment | null;
  language: 'ja' | 'en';
  agentConfig: {
    id: number;
    agentType: string;
    name: string;
    modelId: string | null;
    apiKeyEncrypted: string | null;
    endpoint: string | null;
  };
  effectiveModelId: string | null;
  currentStatus: WorkflowStatus;
  advanceFn: (taskId: number, language: 'ja' | 'en') => Promise<WorkflowAdvanceResult>;
  devConfigFn: (taskId: number) => Promise<{ id: number }>;
}): Promise<WorkflowAdvanceResult> {
  const {
    taskId,
    task,
    transition,
    systemPromptContent,
    context,
    comparisonAssignment,
    language,
    agentConfig,
    effectiveModelId,
    currentStatus,
    advanceFn,
    devConfigFn,
  } = params;

  // Apply the resolved effectiveModelId uniformly across both execution
  // paths. Previously CLI agents received the raw agentConfig, causing
  // role-specific overrides and Smart Router decisions to be silently
  // dropped — and breaking the cross-provider review safeguard which
  // reads modelName from upstream executions.
  const resolvedAgentConfig = await resolveExecutableAgentConfig(agentConfig, effectiveModelId);

  const runAgent = async (cfg: typeof agentConfig): Promise<WorkflowAdvanceResult> => {
    if (CLI_AGENT_TYPES.has(cfg.agentType)) {
      return await executeCLIAgent(
        taskId,
        task,
        cfg,
        systemPromptContent,
        context,
        transition,
        language,
        advanceFn,
        devConfigFn,
        comparisonAssignment,
      );
    }
    return await executeAPIAgent(
      taskId,
      task,
      cfg,
      systemPromptContent,
      context,
      transition,
      language,
      advanceFn,
      devConfigFn,
    );
  };

  // Wrap the call in a single-retry fallback: if the chosen provider hits
  // a quota / rate-limit / auth error, mark it cooled-down and re-route
  // through Smart Router (which now skips cooling providers).
  //
  // Note we also treat "success but output contains a provider error" as a
  // failure for fallback purposes — Codex CLI prints "ERROR: You've hit
  // your usage limit..." but exits with code 0, so the success flag alone
  // is unreliable.
  try {
    const first = await runAgent(resolvedAgentConfig);
    const firstHasImplicitError = await hasProviderErrorInOutput(
      `${first.error ?? ''}\n${typeof first.output === 'string' ? first.output : ''}`,
    );
    if (first.success && !firstHasImplicitError) return first;

    const fallback = await tryProviderFallback({
      taskId,
      role: transition.role,
      currentConfig: resolvedAgentConfig,
      firstResult: first,
      runAgent,
    });
    if (fallback) return fallback;
    // Only override to failure when the original run itself failed.
    // If first.success=true but the output contained a provider-error
    // pattern, trust the clean exit rather than forcing failure — the
    // pattern check can false-positive when agents write code that handles
    // Anthropic rate limit errors (e.g. `error.type === 'rate_limit_error'`).
    if (firstHasImplicitError && !first.success) {
      return {
        ...first,
        error: first.error || 'Provider failure detected and no fallback completed successfully',
      };
    }
    return first;
  } catch (error: unknown) {
    // NOTE: Shutdown errors are not agent failures — skip fallback and re-throw so the runner
    // can requeue the item without consuming retry budget.
    if (isShutdownError(error)) {
      log.warn(
        `[WorkflowOrchestrator] ${transition.role} interrupted by shutdown — skipping fallback`,
      );
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`[WorkflowOrchestrator] Error in ${transition.role}: ${errorMessage}`);

    // Thrown error path: also try fallback once.
    const fallback = await tryProviderFallback({
      taskId,
      role: transition.role,
      currentConfig: resolvedAgentConfig,
      firstResult: {
        success: false,
        role: transition.role,
        status: currentStatus as WorkflowStatus,
        error: errorMessage,
      },
      runAgent,
    });
    if (fallback?.success) return fallback;

    return {
      success: false,
      role: transition.role,
      status: currentStatus as WorkflowStatus,
      error: `実行エラー: ${errorMessage}`,
    };
  }
}
