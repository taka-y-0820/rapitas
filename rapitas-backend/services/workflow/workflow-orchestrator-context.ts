/**
 * Workflow Orchestrator — Execution Context
 *
 * Fourth stage of runAdvanceWorkflow: role context assembly (with approved and
 * experimental prompt addenda), effective model resolution via Smart Router,
 * and task-status reconciliation right before the run. Moved verbatim from
 * workflow-orchestrator.ts (file-size ratchet, task 627); behavior is unchanged.
 */
import { prisma } from '../../config';
import { getDbProvider } from '../../config/db-provider';
import { createLogger } from '../../config/logger';
import { buildRoleContext } from './workflow-context-builder';
import type { RoleTransition, WorkflowMode, WorkflowStatus } from './workflow-types';
import type { ResolvedTask } from './workflow-orchestrator-preflight';
import { routeModelForRole, shouldAutoSelectModel } from './role-route-inputs';

const log = createLogger('workflow-orchestrator');

/**
 * Builds the role context and appends the approved / experimental addenda.
 *
 * @param taskId - The task whose workflow should advance. / ワークフローを進めるタスクID
 * @param transition - Transition about to execute. / 実行予定の遷移
 * @param task - Resolved task row. / 解決済みタスク行
 * @param language - Language for generated content. / 生成コンテンツの言語
 * @param workflowMode - Effective workflow mode. / 有効なワークフローモード
 * @returns Assembled context string. / 組み立てたコンテキスト
 */
export async function buildExecutionContext(
  taskId: number,
  transition: RoleTransition,
  task: ResolvedTask,
  language: 'ja' | 'en',
  workflowMode: WorkflowMode,
): Promise<string> {
  let context = await buildRoleContext(taskId, transition.role, task, language, workflowMode);
  const provider = getDbProvider();
  context +=
    language === 'ja'
      ? `\n\n## 実行環境\n稼働中のRapitasバックエンドのDBプロバイダー: ${provider}\nRapitas自体を変更する場合、この実環境への互換性も検証してください。別の対象プロジェクトのDBはそのプロジェクトの設定から確認してください。`
      : `\n\n## Runtime environment\nActive Rapitas backend database provider: ${provider}\nWhen changing Rapitas itself, verify compatibility with this running environment. For a different target project, determine its database from that project's configuration.`;

  // Human-approved prompt-evolution addendum for this role (proposed by the
  // weekly evolution pipeline, approved on /system-prompts). Appended at the
  // single orchestration call site so every workflow role gets it without
  // touching each buildRoleContext case. Best-effort.
  try {
    const { getApprovedRoleAddendum } = await import('../self-learning/prompt-evolution-worker');
    const addendum = await getApprovedRoleAddendum(transition.role, taskId);
    if (addendum) {
      context += `\n\n## 承認済みの改善ガイダンス(プロンプト進化)\n\n${addendum}`;
      // Observability: role-evidence success rates before/after this line
      // starts appearing are the evolution's measured effect.
      log.info(
        { taskId, role: transition.role },
        '[prompt-evolution] Approved addendum injected into role context',
      );
    }
  } catch {
    // Addendum injection must never block the run.
  }

  // Active-experiment intervention (hypothesis-driven self-experiment loop).
  // Deliberately a SEPARATE path from the approved addendum above: the text
  // is unapproved and under measurement, so it carries its own heading and
  // never touches getApprovedRoleAddendum's status='approved' semantics.
  // Best-effort.
  try {
    const { getActiveExperimentAddendum } =
      await import('../self-learning/experiment-loop/experiment-store');
    const experimentAddendum = await getActiveExperimentAddendum(transition.role);
    if (experimentAddendum) {
      context += `\n\n## 実験中の改善ガイダンス(未承認・効果測定中)\n\n${experimentAddendum}`;
      log.info(
        { taskId, role: transition.role },
        '[experiment] Active-experiment addendum injected into role context',
      );
    }
  } catch {
    // Experiment injection must never block the run.
  }

  return context;
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
