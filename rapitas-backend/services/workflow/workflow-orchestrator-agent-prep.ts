/**
 * Workflow Orchestrator — Agent Preparation
 *
 * Second stage of runAdvanceWorkflow: role config lookup, agent resolution
 * fallback chain, system prompt resolution and plan-mode directive injection.
 * Artifact reuse is decided by preflight, before this stage.
 * Not responsible for plan validation, context building or execution.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { resolveWorkflowDir, readWorkflowFile } from './workflow-file-utils';
import { applyPlanModeDirective } from './workflow-context-builder';
import type { WorkflowAdvanceResult } from './workflow-agent-executor';
import type { RoleTransition, WorkflowStatus } from './workflow-types';
// NOTE: imported from the prompt sub-module, never from './workflow-orchestrator'
// (that would form a circular import with the orchestrator that calls us).
import { resolveSystemPromptContent } from './workflow-orchestrator-prompt';

const log = createLogger('workflow-orchestrator');

/**
 * Resolves role config, agent config and system prompt for the transition, or
 * returns an early result (role disabled / no agent / path failure).
 *
 * @param taskId - The task whose workflow should advance. / ワークフローを進めるタスクID
 * @param transition - Transition selected by preflight. / プリフライトで決まった遷移
 * @param currentStatus - Current workflow status. / 現在のワークフローステータス
 * @returns `{ done: true, result }` for an early return, otherwise role/agent/prompt state. / 早期終了結果または次段階の状態
 */
export async function prepareAgentAndPrompt(
  taskId: number,
  transition: RoleTransition,
  currentStatus: WorkflowStatus,
) {
  // Get role configuration
  const roleConfig = await prisma.workflowRoleConfig.findUnique({
    where: { role: transition.role },
    include: { agentConfig: true },
  });
  // An explicitly DISABLED role is a deliberate stop — respect it.
  if (roleConfig && !roleConfig.isEnabled) {
    const result: WorkflowAdvanceResult = {
      success: false,
      role: transition.role,
      status: currentStatus,
      error: `ロール "${transition.role}" は無効化されています`,
    };
    return { done: true as const, result };
  }
  // Resolve the agent for this role. When WorkflowRoleConfig has no agent
  // assigned, fall back to the capability-based recommender — the SAME path
  // execute-route uses. Without this fallback, queue-driven tasks (e.g. split
  // subtasks) hard-failed at the very first phase whenever the user had not
  // manually wired every role in the agent-management page, exhausting all
  // retries in ~30ms with no agent ever spawned.
  let agentConfig: {
    id: number;
    agentType: string;
    name: string;
    modelId: string | null;
    apiKeyEncrypted: string | null;
    endpoint: string | null;
  } | null = roleConfig?.agentConfig ?? null;
  if (!agentConfig) {
    const { recommendAgentForRole } = await import('./role-recommender');
    const recommended = await recommendAgentForRole(transition.role).catch(() => null);
    if (recommended?.agentConfigId) {
      agentConfig = await prisma.aIAgentConfig
        .findUnique({ where: { id: recommended.agentConfigId } })
        .catch(() => null);
    }
    if (agentConfig) {
      log.info(
        { taskId, role: transition.role, agentId: agentConfig.id, agentName: agentConfig.name },
        '[WorkflowOrchestrator] No agent assigned to role — using capability-recommended agent',
      );
    }
  }
  if (!agentConfig) {
    // Last resort: the built-in Claude Code agent (id: -1). This is the SAME
    // default execute-route uses, so a workflow can run even when the DB has
    // zero AIAgentConfig rows and every role is unassigned. The execution
    // layer (task-executor) maps the unknown id back to the built-in and
    // nulls the agentConfig FK so AgentExecution creation does not fail.
    const { getDefaultAgent } = await import('../agent-config/defaults');
    const builtIn = await getDefaultAgent().catch(() => null);
    if (builtIn) {
      agentConfig = {
        id: builtIn.id,
        agentType: builtIn.agentType,
        name: builtIn.name,
        modelId: builtIn.modelId ?? null,
        apiKeyEncrypted: builtIn.apiKeyEncrypted ?? null,
        endpoint: builtIn.endpoint ?? null,
      };
      log.info(
        { taskId, role: transition.role, agentName: agentConfig.name },
        '[WorkflowOrchestrator] No assigned/recommended agent — using built-in default agent',
      );
    }
  }
  if (!agentConfig) {
    const result: WorkflowAdvanceResult = {
      success: false,
      role: transition.role,
      status: currentStatus as WorkflowStatus,
      error: `ロール "${transition.role}" にエージェントが割り当てられていません。エージェント管理ページで設定してください。`,
    };
    return { done: true as const, result };
  }

  // Get system prompt — DB-stored content takes priority.
  // NOTE: If the seed has not been run yet, fall back to the compiled DEFAULT_SYSTEM_PROMPTS
  // so the researcher receives the correct template even on a fresh install.
  let systemPromptContent = '';
  if (roleConfig?.systemPromptKey) {
    systemPromptContent = await resolveSystemPromptContent(roleConfig.systemPromptKey);
  }

  // Resolve workflow directory
  const workflowInfo = await resolveWorkflowDir(taskId);
  if (!workflowInfo) {
    const result: WorkflowAdvanceResult = {
      success: false,
      role: transition.role,
      status: currentStatus as WorkflowStatus,
      error: 'パス解決に失敗しました',
    };
    return { done: true as const, result };
  }

  // Plan-optional framing: the role prompts assume plan.md, but the lightweight
  // (research→implement→verify) workflow produces none. Prepend an authoritative
  // mode directive so the implementer/verifier work from research.md + task
  // requirements instead of a non-existent plan/checklist/planner. Applies to
  // implementer/verifier only; no-op for other roles.
  // Apply the AUTHORITATIVE plan-mode directive ALWAYS — even when the role has
  // no configured system prompt. This was gated behind `if (systemPromptContent)`,
  // but the implementer role's system prompt is EMPTY by default, so the
  // no-plan directive was never prepended: a lightweight implementer then
  // followed CLAUDE.md's generic plan step and created a plan.md (task 229).
  // applyPlanModeDirective handles an empty base prompt (returns just the directive).
  {
    const planContent = await readWorkflowFile(taskId, 'plan');
    systemPromptContent = applyPlanModeDirective(
      transition.role,
      systemPromptContent || '',
      !!planContent?.trim(),
    );
  }

  // Artifact reuse belongs to preflight. Rechecking here would override its
  // decision to regenerate a rejected plan or a pending human revision.
  return { done: false as const, roleConfig, agentConfig, systemPromptContent };
}
