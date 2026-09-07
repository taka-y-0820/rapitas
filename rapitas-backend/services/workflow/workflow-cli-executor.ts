/**
 * Workflow CLI Executor
 *
 * Executes CLI-type workflow agents (claude-code, codex, gemini) via
 * AgentOrchestrator. Resolves the working directory, builds the agent
 * prompt, delegates execution, and hands the result off to the epilogue /
 * post-processing modules. Not responsible for prompt text, worktree
 * resolution, or phase-status gating — see the sibling
 * workflow-cli-executor-* modules.
 *
 * Session finalization is delegated to workflow-phase-session (conditional
 * write — a stopped session is never overwritten); this module only decides
 * WHEN the phase is over.
 */
import { prisma } from '../../config';
import { AgentOrchestrator } from '../agents/agent-orchestrator';
import { resolveTaskWithTheme } from '../task/task-resolver';
import { getAgentTimeoutMs } from '../agents/execution-timeouts';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';
import { resolveExecutionWorkdir } from './workflow-cli-executor-worktree';
import { buildCliAgentPrompt } from './workflow-cli-executor-prompt';
import { harvestInvestigationOutput, runPhaseEpilogue } from './workflow-cli-executor-epilogue';
import { runPostProcessing } from './workflow-cli-executor-postprocess';
import { resumeSessionIdFor } from './phase-session-resume';
import { finalizePhaseSession } from './workflow-phase-session';
import type { ComparisonAssignment } from '../self-learning/comparison/prompt-comparison-types';

// Disk-existence guard for reusing a recorded worktree. Re-exported here so the
// existing worktree-reuse.test.ts import path keeps working; the single source
// of truth now lives in git-operations/worktree/worktree-usable so every execution entry
// point (orchestrator, continue-execution route) shares the same check.
export { canReuseWorktree } from '../agents/orchestrator/git-operations/worktree/worktree-usable';

/**
 * Append this phase's outcome to the comparison record of the candidate under
 * limited trial, so the trial is judged on REAL executions (id, cost, duration,
 * failure cause) rather than on the arm assignment alone.
 *
 * Best-effort: a missing record, an unreadable execution row or a write failure
 * costs one sample and never the phase.
 *
 * @param assignment - Arm this phase ran under, or null when nothing is staged. / 実行したアーム
 * @param taskId - Task the phase belongs to. / 対象タスクID
 * @param sessionId - Session opened for this phase. / このフェーズのセッションID
 * @param success - Whether the phase succeeded. / フェーズが成功したか
 * @param phaseStartedAt - When the phase began, for the duration fallback. / フェーズ開始時刻
 */
async function recordTrialRun(
  assignment: ComparisonAssignment | null,
  taskId: number,
  sessionId: number,
  success: boolean,
  phaseStartedAt: Date,
): Promise<void> {
  if (!assignment) return;
  try {
    const execution = await prisma.agentExecution.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        errorMessage: true,
        costUsd: true,
        executionTimeMs: true,
      },
    });
    if (!execution) return;
    const { classifyFailureCause } =
      await import('../self-learning/comparison/prompt-comparison-metrics');
    const { recordComparisonRun } =
      await import('../self-learning/comparison/prompt-comparison-store');
    recordComparisonRun(assignment.promptEvolutionId, assignment.arm, {
      taskId,
      executionId: execution.id,
      success,
      // costUsd is a Prisma Decimal — Number() is the documented conversion.
      costUsd: Number(execution.costUsd ?? 0),
      durationMs: execution.executionTimeMs ?? Date.now() - phaseStartedAt.getTime(),
      failureCause: success
        ? null
        : classifyFailureCause({ status: execution.status, errorMessage: execution.errorMessage }),
      role: assignment.role,
      injected: assignment.injected,
      injectedVersion: assignment.injectedVersion,
    });
  } catch {
    /* a lost comparison sample is never worth failing (or delaying) the phase for */
  }
}

/**
 * Execute a CLI agent (claude-code, codex, gemini) via AgentOrchestrator.
 *
 * The agent is given a prompt that includes language instructions and a curl
 * command to save its output via the workflow API. When the agent's own final
 * message is a clean report instead, extractMarkdownFromOutput recovers it as
 * a fallback (still saved via writeWorkflowFile, not a direct filesystem write).
 *
 * @param taskId - Task being processed; also the key for reading/writing its workflow artifacts. / 処理中のタスクID（成果物の読み書きキーも兼ねる）
 * @param task - Task title and description. / タスクのタイトルと説明
 * @param agentConfig - Agent configuration record. / エージェント設定レコード
 * @param systemPrompt - System prompt content. / システムプロンプト内容
 * @param context - Role context assembled by buildRoleContext. / buildRoleContextで組み立てられたロールコンテキスト
 * @param transition - Current role transition definition. / 現在のロール遷移定義
 * @param language - Output language. / 出力言語
 * @param advanceWorkflow - Callback to start the next phase (for auto-advance). / 次フェーズを開始するコールバック
 * @param getOrCreateDevConfig - Callback to resolve the dev config record. / devConfigレコードを解決するコールバック
 * @param comparisonAssignment - Prompt-comparison arm this phase runs under, if any. / このフェーズの比較アーム割当
 * @returns Phase execution result. / フェーズ実行結果
 */
export async function executeCLIAgent(
  taskId: number,
  task: { title: string; description: string | null },
  agentConfig: { id: number; agentType: string; name: string; modelId: string | null },
  systemPrompt: string,
  context: string,
  transition: RoleTransition,
  language: 'ja' | 'en',
  advanceWorkflow: (taskId: number, language: 'ja' | 'en') => Promise<WorkflowAdvanceResult>,
  getOrCreateDevConfig: (taskId: number) => Promise<{ id: number }>,
  comparisonAssignment: ComparisonAssignment | null = null,
): Promise<WorkflowAdvanceResult> {
  const orchestrator = AgentOrchestrator.getInstance(prisma);

  // NOTE: Resolve workingDirectory from theme — implementation runs in the target project,
  // not in the rapitas project itself. Workflow files (plan.md, verify.md) are saved
  // separately via the workflow API regardless of cwd.
  const taskWithTheme = await resolveTaskWithTheme(taskId);

  const workdir = await resolveExecutionWorkdir({
    taskId,
    transition,
    orchestrator,
    taskWithTheme,
  });
  if (workdir.abort) return workdir.abort;
  const { resolvedWorktreePath, resolvedBranchName, effectiveWorkDir } = workdir;

  const devConfig = await getOrCreateDevConfig(taskId);
  const session = await prisma.agentSession.create({
    data: {
      configId: devConfig.id,
      mode: `workflow-${transition.role}`,
      status: 'active',
      // Persist the worktree path on the session so post-handlers
      // (auto-commit / PR) and the reset-route worktree cleanup can find it.
      worktreePath: resolvedWorktreePath ?? undefined,
      branchName: resolvedBranchName ?? undefined,
    },
  });

  // Investigation phases (research/plan) MUST run with read-only
  // sandbox so codex (and any other CLI agent) cannot modify code. The
  // agent's final message is captured via codex `-o <file>` (a temp file
  // we then upload to the workflow API server-side). This is the official
  // safe pattern: codex CANNOT save the md itself, the OS guarantees it.
  const isInvestigationPhase = transition.role === 'researcher' || transition.role === 'planner';

  const fullPrompt = buildCliAgentPrompt({ taskId, language, systemPrompt, context, transition });

  // For the harvest guard below: a critic rejection recorded AFTER this point
  // means the artifact this phase produced was already judged and bounced.
  const phaseStartedAt = new Date();

  // Everything past this point is wrapped so the session reaches a terminal
  // status on the success path, the failure path, AND when the epilogue /
  // post-processing throws. `finally` performs a side effect only — it never
  // returns or throws, so the original result/exception propagates unchanged.
  let sessionSucceeded = false;
  try {
    const result = await orchestrator.executeTask(
      {
        id: taskId,
        title: `[${transition.role}] ${task.title}`,
        description: fullPrompt,
        workingDirectory: effectiveWorkDir,
      },
      {
        taskId,
        sessionId: session.id,
        agentConfigId: agentConfig.id,
        workingDirectory: effectiveWorkDir,
        modelIdOverride: agentConfig.modelId || undefined,
        // Repair bounce: continue the CLI session this role already built.
        resumeSessionId: await resumeSessionIdFor(
          taskId,
          transition.role,
          effectiveWorkDir,
          agentConfig.agentType,
        ),
        // Role-aware wall-clock cap: implementer gets 2x the base (task 546).
        timeout: getAgentTimeoutMs(transition.role),
        autoCompleteTask: false,
        investigationMode: isInvestigationPhase,
        // Phase-specific output type. Drives codex's positional headline
        // (`# 調査レポート` vs `# 実装計画` vs `# レビュー指摘`) so each
        // role's CLI invocation produces an artifact in the correct shape.
        // Without this, planner phases were force-shaped as research reports
        // and the validator flagged plan.md for missing 設計判断の根拠 /
        // 実装チェックリスト sections.
        investigationOutputType:
          transition.outputFile === 'plan'
            ? 'plan'
            : transition.outputFile === 'verify'
              ? 'verify'
              : 'research',
        // For investigation phases, codex writes its final message to a TEMP
        // file via -o. We read that temp file after the run and upload it to
        // the workflow API ourselves — codex never gets to touch the
        // workflow file path directly. (outputLastMessageFile is currently
        // always unused — no CLI path sets a temp file — but the option is
        // kept wired for when one does.)
        outputLastMessageFile: undefined,
      },
    );

    await harvestInvestigationOutput({
      taskId,
      transition,
      result,
      isInvestigationPhase,
      phaseStartedAt,
    });

    const { effectiveSuccess, phaseStatus, phaseError } = await runPhaseEpilogue({
      taskId,
      transition,
      session,
      result,
      resolvedWorktreePath,
      language,
      phaseStartedAt,
    });

    sessionSucceeded = effectiveSuccess;
    const finalResult: WorkflowAdvanceResult = {
      success: effectiveSuccess,
      role: transition.role,
      status: phaseStatus,
      output: result.output,
      error: effectiveSuccess ? undefined : phaseError,
    };

    await runPostProcessing({
      taskId,
      transition,
      session,
      language,
      effectiveSuccess,
      phaseStatus,
      isInvestigationPhase,
      advanceWorkflow,
    });

    return finalResult;
  } finally {
    // The comparison sample is recorded BEFORE the session is finalized: the
    // run's own outcome is what the trial measures, and it must not be skipped
    // when the finalization write races another owner and no-ops.
    await recordTrialRun(
      comparisonAssignment,
      taskId,
      session.id,
      sessionSucceeded,
      phaseStartedAt,
    );
    await finalizePhaseSession(session.id, sessionSucceeded);
  }
}
