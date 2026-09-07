/**
 * Workflow Orchestrator — Execution Context
 *
 * Fourth stage of runAdvanceWorkflow: role context assembly (with approved,
 * limited-trial and experimental prompt addenda), effective model resolution
 * via Smart Router, and task-status reconciliation right before the run.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { buildRoleContext } from './workflow-context-builder';
import type { RoleTransition, WorkflowMode, WorkflowStatus } from './workflow-types';
import type { ResolvedTask } from './workflow-orchestrator-preflight';
import { routeModelForRole, shouldAutoSelectModel } from './role-route-inputs';
import type { ComparisonAssignment } from '../self-learning/comparison/prompt-comparison-types';

const log = createLogger('workflow-orchestrator');

/**
 * Builds the role context and appends the approved / trial / experimental
 * addenda.
 *
 * At most ONE prompt-evolution addendum is appended: an approved rollout wins,
 * and only when there is none does a `staged` candidate get its limited-trial
 * assignment. Stacking both would make the resulting run unattributable to
 * either.
 *
 * @param taskId - The task whose workflow should advance. / ワークフローを進めるタスクID
 * @param transition - Transition about to execute. / 実行予定の遷移
 * @param task - Resolved task row. / 解決済みタスク行
 * @param language - Language for generated content. / 生成コンテンツの言語
 * @param workflowMode - Effective workflow mode. / 有効なワークフローモード
 * @returns Context string plus the comparison arm this phase was assigned to. / コンテキストと比較アーム割当
 */
export async function buildExecutionContext(
  taskId: number,
  transition: RoleTransition,
  task: ResolvedTask,
  language: 'ja' | 'en',
  workflowMode: WorkflowMode,
): Promise<{ context: string; comparisonAssignment: ComparisonAssignment | null }> {
  let context = await buildRoleContext(taskId, transition.role, task, language, workflowMode);
  let comparisonAssignment: ComparisonAssignment | null = null;

  // Human-approved (or trial-adopted) prompt-evolution addendum for this role.
  // Appended at the single orchestration call site so every workflow role gets
  // it without touching each buildRoleContext case. Best-effort.
  let approved: { promptEvolutionId: number; text: string } | null = null;
  try {
    const { getApprovedRoleAddendumDetail } =
      await import('../self-learning/prompt-evolution-worker');
    approved = await getApprovedRoleAddendumDetail(transition.role, taskId);
    if (approved) {
      context += `\n\n## 承認済みの改善ガイダンス(プロンプト進化)\n\n${approved.text}`;
      // Observability: the candidate id and text checksum make the injection
      // attributable to an exact version — logging taskId/role alone left no
      // way to tell WHICH addendum a run actually saw.
      const { addendumVersionHash } =
        await import('../self-learning/comparison/prompt-comparison-store');
      log.info(
        {
          taskId,
          role: transition.role,
          promptEvolutionId: approved.promptEvolutionId,
          version: addendumVersionHash(approved.text),
          arm: 'approved',
        },
        '[prompt-evolution] Approved addendum injected into role context',
      );
    }
  } catch {
    // Addendum injection must never block the run.
  }

  // Limited trial for a `staged` candidate — only when no approved addendum
  // occupies this role. The arm is decided here, but `injected` is only set
  // after the text is actually appended: an assignment alone is not evidence
  // that the intervention reached the prompt.
  if (!approved) {
    try {
      const { getStagedRoleAddendumForTrial } =
        await import('../self-learning/prompt-evolution-staged-trial');
      const trial = await getStagedRoleAddendumForTrial(transition.role, taskId);
      if (trial) {
        comparisonAssignment = trial.assignment;
        if (trial.addendum) {
          context += `\n\n## 限定試行中の改善ガイダンス(効果測定中)\n\n${trial.addendum}`;
          comparisonAssignment.injected = true;
          comparisonAssignment.injectedVersion = trial.version;
        }
        log.info(
          {
            taskId,
            role: transition.role,
            promptEvolutionId: comparisonAssignment.promptEvolutionId,
            arm: comparisonAssignment.arm,
            injected: comparisonAssignment.injected,
            version: comparisonAssignment.injectedVersion,
          },
          '[prompt-evolution] Limited-trial arm resolved for this phase',
        );
      }
    } catch {
      // A failed trial assignment costs one sample, never the run.
    }
  }

  // Active-experiment intervention (hypothesis-driven self-experiment loop).
  // Deliberately a SEPARATE path from the addenda above: the text is
  // unapproved and under a different measurement, so it carries its own
  // heading and never touches getApprovedRoleAddendum's status semantics.
  // Best-effort.
  try {
    const { getActiveExperimentInjection } =
      await import('../self-learning/experiment-loop/experiment-store');
    const experiment = await getActiveExperimentInjection(transition.role);
    if (experiment) {
      context += `\n\n## 実験中の改善ガイダンス(未承認・効果測定中)\n\n${experiment.addendum}`;
      // Same audit fields as the two paths above, so one log query answers
      // "which text did task X's role Y actually run under" for every path.
      const { addendumVersionHash } =
        await import('../self-learning/comparison/prompt-comparison-store');
      log.info(
        {
          taskId,
          role: transition.role,
          experimentId: experiment.experimentId,
          hypothesisId: experiment.hypothesisId,
          version: addendumVersionHash(experiment.addendum),
          arm: 'experiment',
        },
        '[experiment] Active-experiment addendum injected into role context',
      );
    }
  } catch {
    // Experiment injection must never block the run.
  }

  return { context, comparisonAssignment };
}

/**
 * Resolves the effective model id: role override → agent default → Smart Router.
 *
 * @param taskId - The task whose workflow should advance. / ワークフローを進めるタスクID
 * @param transition - Transition about to execute. / 実行予定の遷移
 * @param task - Resolved task row. / 解決済みタスク行
 * @param roleConfig - Role config row (may be null). / ロール設定行
 * @param agentConfig - Agent config resolved for the role. / ロールに解決されたエージェント設定
 * @returns Effective model id, or null when none is configured. / 有効なモデルID
 */
export async function resolveEffectiveModel(
  taskId: number,
  transition: RoleTransition,
  task: ResolvedTask,
  roleConfig: { modelId?: string | null } | null,
  agentConfig: { modelId: string | null },
): Promise<string | null> {
  // NOTE: The routing itself lives in role-route-inputs.ts, shared with the
  // manual /agents/execute route. Keeping a second copy here is what let the
  // two surfaces drift: the manual path used to skip the risk/retry floors
  // entirely, so the same phase of the same task resolved to a different model
  // depending on which button started it.
  //
  // `agentConfig` is intentionally unused now. An unset role model means "let
  // the router decide", NOT "fall back to the agent's default" — reading it as
  // the latter pinned planner and verifier to a premium model and bypassed the
  // router for 15% of measured spend (see shouldAutoSelectModel).
  void agentConfig;

  const roleModelId = roleConfig?.modelId ?? null;
  if (!shouldAutoSelectModel(roleModelId)) return roleModelId;

  const routed = await routeModelForRole({ taskId, role: transition.role, task });
  log.info(routed.details, 'Auto-selected model via Smart Router');
  return routed.modelId;
}

/**
 * Reconciles task.workflowStatus / task.status right before the agent starts.
 *
 * @param taskId - The task whose workflow should advance. / ワークフローを進めるタスクID
 * @param currentStatus - Current workflow status. / 現在のワークフローステータス
 */
export async function reconcileTaskStatusBeforeRun(
  taskId: number,
  currentStatus: WorkflowStatus,
): Promise<void> {
  if (currentStatus === 'draft') {
    // Reconcile the status from EXISTING artifacts before starting. A
    // re-dispatched task whose research.md / plan.md already exist must not
    // restart at `draft` — draft only accepts research/question saves, so the
    // agent would have to RE-SAVE research.md just to escape draft before it can
    // save verify.md (the "verify.md already written but won't advance without a
    // re-save" the user observed on task 267). Mirror resolveImplementEntryStatus:
    // plan.md present → plan_created, else research.md present → research_done.
    //
    // NOTE: stops at `plan_created` (never `plan_approved`) even when plan.md
    // is present — reusing an existing plan must go through the SAME
    // approval gate a freshly-produced plan.md would (manual approval or the
    // auto-approve setting), never silently skip it just because a
    // WorkflowFile row happens to exist. This is a DB-existence-only
    // backstop; reconcileStatusFromExistingArtifacts (called earlier in
    // runAdvanceWorkflow, before role/model resolution) already handles the
    // common case with actual content-quality validation and in time to
    // affect which role THIS dispatch runs — this block only still fires
    // when that earlier check found nothing usable but a WorkflowFile row
    // exists anyway (e.g. a stale row pointing at deleted/invalid content).
    const [hasPlan, hasResearch] = await Promise.all([
      prisma.workflowFile
        .findFirst({ where: { taskId, fileType: 'plan' }, select: { id: true } })
        .catch(() => null),
      prisma.workflowFile
        .findFirst({ where: { taskId, fileType: 'research' }, select: { id: true } })
        .catch(() => null),
    ]);
    const reconciled = hasPlan ? 'plan_created' : hasResearch ? 'research_done' : 'draft';
    await prisma.task.update({
      where: { id: taskId },
      data: { workflowStatus: reconciled, status: 'in-progress' },
    });
  } else {
    // A task that resumes at a non-draft phase (valid research/plan artifacts
    // reused, or a multi-phase / re-run continuation) skips the draft branch
    // above, so its status was never flipped off 'todo' while the workflow
    // advances — leaving it stuck looking like 'todo' (進行中にならない) in the UI.
    //
    // The `where` clause carries the 'todo' test rather than a status this
    // function was told. It used to trust runPreflight's snapshot, but the row
    // can change under that snapshot while the dispatch resolves its role,
    // context and model — which is why the parameter is gone. That is not
    // hypothetical — after a restart the startup reaper reverts interrupted
    // agents' tasks to 'todo' (lifecycle-manager), and task 658 landed exactly
    // in that window: the reaper wrote 'todo' two seconds before the agent
    // spawned, the stale snapshot still said 'in-progress', so nothing flipped
    // and the task ran while displaying 'todo'. A conditional update also keeps
    // the original guarantee — only 'todo' advances, so 'done'/'blocked' are
    // never clobbered — without re-reading first.
    await prisma.task.updateMany({
      where: { id: taskId, status: 'todo' },
      data: { status: 'in-progress' },
    });
  }
}
