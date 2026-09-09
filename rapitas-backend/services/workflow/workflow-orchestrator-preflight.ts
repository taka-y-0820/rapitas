import { reviewedReplanTransition } from './requirement-replan-dispatch';
/**
 * Workflow Orchestrator — Preflight
 *
 * First stage of runAdvanceWorkflow: task lookup, blocked / workflow-disabled
 * guards, transition-table construction, intake gate, pre-research provisional
 * mode selection and artifact-reuse reconciliation. Moved verbatim from
 * workflow-orchestrator.ts (file-size ratchet, task 627); behavior is unchanged.
 * Not responsible for agent resolution or execution.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { resolveTaskWithThemeAndCategory } from '../task/task-resolver';
import type { WorkflowAdvanceResult } from './workflow-agent-executor';
import { reconcileStatusFromExistingArtifacts } from './artifact-reuse-reconciler';
import { narrowWorkflowStatus, narrowWorkflowMode } from './workflow-types.guards.generated';
import type { WorkflowStatus } from './workflow-types';
import { TASK_NOT_FOUND } from '../../utils/common/error-messages';
import { resolveEffectiveWorkflowDisabled } from './workflow-disabled';
import { computeMetadataComplexity } from './workflow-orchestrator-metadata-complexity';

const log = createLogger('workflow-orchestrator');

/** Task row as loaded by resolveTaskWithThemeAndCategory (non-null). / 解決済みタスク行 */
export type ResolvedTask = NonNullable<Awaited<ReturnType<typeof resolveTaskWithThemeAndCategory>>>;

/**
 * Runs the preflight stage and returns either an early result or the state the
 * next stage (agent preparation) needs.
 *
 * @param taskId - The task whose workflow should advance. / ワークフローを進めるタスクID
 * @returns `{ done: true, result }` for an early return, otherwise the resolved state. / 早期終了結果または次段階の状態
 */
export async function runPreflight(taskId: number) {
  const task = await resolveTaskWithThemeAndCategory(taskId);
  if (!task) {
    const result: WorkflowAdvanceResult = {
      success: false,
      role: 'researcher',
      status: 'draft',
      error: TASK_NOT_FOUND,
    };
    return { done: true as const, result };
  }

  // A blocked task awaits user inspection and must NOT be auto-advanced. Without
  // this guard a task blocked by the replan-exhausted path (status='blocked' but
  // workflowStatus still 'plan_approved') gets re-dispatched and re-runs the same
  // block path, re-recording plan_invalid_replan_exhausted every few seconds
  // (observed: 80+ transitions on stale invalid-plan tasks). / ブロック中タスクは
  // 自動実行せずスキップし、exhausted ループの再記録を止める。
  if (task.status === 'blocked') {
    const result: WorkflowAdvanceResult = {
      success: false,
      role: 'researcher',
      status: narrowWorkflowStatus(task.workflowStatus),
      error: 'タスクはブロック中のため自動実行をスキップしました',
    };
    return { done: true as const, result };
  }

  // Workflow-disabled tasks (see workflow-disabled.ts — task-level or global
  // off-switch) run as a single direct-implementation pass via the manual
  // "実行" execute-route path, not this per-phase orchestrator dispatch —
  // there is no transition-table entry for a "disabled" pseudo-mode here.
  // Skip rather than mis-dispatch a researcher/planner role.
  if (await resolveEffectiveWorkflowDisabled(taskId)) {
    const result: WorkflowAdvanceResult = {
      success: false,
      role: 'researcher',
      status: narrowWorkflowStatus(task.workflowStatus),
      error:
        'このタスクはワークフロー無効モードのため自動実行(フェーズ進行)の対象外です。手動実行してください。',
    };
    return { done: true as const, result };
  }

  // Build the transition table from the (DB-backed, UI-editable) mode config.
  // Single source of truth — see workflow-mode-config.ts.
  let workflowMode = narrowWorkflowMode(task.workflowMode);
  const { getModeSettings, buildTransitions } = await import('./workflow-mode-config');
  const modeSettings = await getModeSettings(workflowMode);
  const modeTransitions = buildTransitions(modeSettings);

  let currentStatus = narrowWorkflowStatus(task.workflowStatus);
  const reviewedTransition = await reviewedReplanTransition(prisma, taskId, currentStatus);
  if (reviewedTransition) {
    return {
      done: false as const,
      task,
      workflowMode,
      currentStatus,
      transition: reviewedTransition,
    };
  }

  let transition = modeTransitions[currentStatus];
  if (!transition) {
    const result: WorkflowAdvanceResult = {
      success: false,
      role: 'researcher',
      status: currentStatus,
      error: `ステータス "${currentStatus}" では次のフェーズを実行できません`,
    };
    return { done: true as const, result };
  }

  // Intake quality gate — runs once, just before the first (research) phase.
  // Enriches a thin spec and, per policy, pauses for a single clarifying
  // question (returns early to awaiting_question) or proceeds on best-guess.
  // Fail-open: any error here must NOT block the workflow — fall through to
  // research. Idempotent, so re-entry after a question is answered is safe.
  if (currentStatus === 'draft' && transition.role === 'researcher') {
    try {
      const { ensureIntakeReady } = await import('../intake');
      const intake = await ensureIntakeReady(taskId);
      if (intake.status === 'awaiting_question') {
        const result: WorkflowAdvanceResult = {
          success: true,
          role: transition.role,
          status: 'awaiting_question' as WorkflowStatus,
          output:
            intake.message ?? '仕様が不十分なため確認の質問を作成しました（回答後に再開します）',
        };
        return { done: true as const, result };
      }
    } catch (err) {
      log.warn(
        { err, taskId },
        '[WorkflowOrchestrator] intake gate failed — proceeding to research (fail-open)',
      );
    }
    // Intake can persist new criteria. Refresh the execution input too, including
    // when the user pinned the mode and provisional mode selection is skipped.
    const freshSpec = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        title: true,
        description: true,
        goals: true,
        constraints: true,
        acceptanceCriteria: true,
        complexityScore: true,
      },
    });
    if (!freshSpec) throw new Error('Task specification unavailable after intake');
    Object.assign(task, freshSpec);
  }

  // Pre-research mode selection: pick the workflow mode from a cheap metadata
  // complexity estimate BEFORE the researcher runs, so the phase chain (does a
  // plan phase exist?) and the researcher's prompt are mode-aware from the
  // start. Without this, every task ran research in the default 'comprehensive'
  // framing and the mode was corrected only AFTER research — producing
  // plan-assuming research.md (and a plan) even for trivial tasks. The
  // research-assessed code-grounded complexity refines (UPGRADES) this later.
  // Respects a user-pinned mode (workflowModeOverride). Fail-open.
  if (currentStatus === 'draft' && transition.role === 'researcher' && !task.workflowModeOverride) {
    try {
      // The post-intake refresh above is also the input for mode selection.
      const fresh = task;
      // The metadata heuristic is computed IN-MEMORY for this provisional
      // mode pick only — it is not persisted. task.complexityScore holds
      // exclusively the research agent's code-grounded assessment
      // (applyResearchAssessedComplexity); the UI shows 複雑度"-" until then.
      let score = fresh?.complexityScore ?? null;
      if (score == null) {
        score = await computeMetadataComplexity({
          ...task,
          goals: fresh?.goals ?? task.goals,
          constraints: fresh?.constraints ?? task.constraints,
          acceptanceCriteria: fresh?.acceptanceCriteria ?? task.acceptanceCriteria,
        }).catch(() => null);
      }
      if (score != null) {
        const { selectProvisionalMode } = await import('./workflow-mode-config');
        const provisional = await selectProvisionalMode(score);
        if (provisional !== workflowMode) {
          await prisma.task.update({
            where: { id: taskId },
            data: { workflowMode: provisional },
          });
          log.info(
            { taskId, score, from: workflowMode, to: provisional },
            '[WorkflowOrchestrator] Pre-research provisional mode selected',
          );
          workflowMode = provisional;
        }
      }
    } catch (err) {
      log.warn(
        { err, taskId },
        '[WorkflowOrchestrator] Pre-research mode selection failed — keeping current mode',
      );
    }
  }

  // Artifact-reuse fast-forward: a re-run (or a workflowStatus reset) can
  // leave the task at `draft`/`research_done` while research.md and/or
  // plan.md ALREADY exist on disk and are good enough quality to reuse —
  // dispatching the researcher/planner again would just redo work the
  // agent would otherwise notice and skip on its own (observed: task 491's
  // researcher explicitly reasoning "research.md already matches this task,
  // reusing it" instead of the status already reflecting that). Re-fetch
  // mode settings first: the pre-research mode-selection step above may
  // have just changed workflowMode, and `includePlan` must match the FINAL
  // mode for this reconciliation to target the right status.
  {
    const finalModeSettings = await getModeSettings(workflowMode);
    const finalModeTransitions = buildTransitions(finalModeSettings);
    const reconciled = await reconcileStatusFromExistingArtifacts(
      taskId,
      currentStatus,
      finalModeSettings.includePlan,
    ).catch((err) => {
      log.warn({ err, taskId }, '[WorkflowOrchestrator] Artifact-reuse reconciliation failed');
      return { status: currentStatus, advanced: false };
    });
    if (reconciled.advanced) {
      currentStatus = reconciled.status;
      const advancedTransition = finalModeTransitions[currentStatus];
      if (!advancedTransition) {
        const result: WorkflowAdvanceResult = {
          success: false,
          role: transition.role,
          status: currentStatus,
          error: `ステータス "${currentStatus}" では次のフェーズを実行できません`,
        };
        return { done: true as const, result };
      }
      transition = advancedTransition;
    }
  }

  log.info(
    { taskId, currentStatus, role: transition.role },
    '[WorkflowOrchestrator] Preflight done — dispatching role',
  );
  return { done: false as const, task, workflowMode, currentStatus, transition };
}
