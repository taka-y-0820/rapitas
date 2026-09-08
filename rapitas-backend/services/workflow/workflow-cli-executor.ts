/**
 * Workflow CLI Executor
 *
 * Executes CLI-type workflow agents (claude-code, codex, gemini) via
 * AgentOrchestrator. Resolves the working directory, builds the agent
 * prompt, delegates execution, and hands the result off to the epilogue /
 * post-processing modules. Not responsible for prompt text, worktree
 * resolution, or phase-status gating — see the sibling
 * workflow-cli-executor-* modules.
 */
import { prisma } from '../../config';
import { AgentOrchestrator } from '../agents/agent-orchestrator';
import { resolveTaskWithTheme } from '../task/task-resolver';
import { getAgentTimeoutMs } from '../agents/execution-timeouts';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';
import { resolveExecutionWorkdir } from './workflow-cli-executor-worktree';
import { buildCliAgentPrompt } from './workflow-cli-executor-prompt';
import { readAgentsMdConstraints } from './workflow-agents-md-context';
import { harvestInvestigationOutput, runPhaseEpilogue } from './workflow-cli-executor-epilogue';
import { runPostProcessing } from './workflow-cli-executor-postprocess';
import { resumeSessionIdFor } from './phase-session-resume';

// Disk-existence guard for reusing a recorded worktree. Re-exported here so the
// existing worktree-reuse.test.ts import path keeps working; the single source
// of truth now lives in git-operations/worktree/worktree-usable so every execution entry
// point (orchestrator, continue-execution route) shares the same check.
export { canReuseWorktree } from '../agents/orchestrator/git-operations/worktree/worktree-usable';

/**
 * Drive the AgentSession this phase created to a terminal status.
 *
 * NOTE: the session was created 'active' and nothing ever updated it, so every
 * CLI-driven role left its session 'active' until the orphan sweep relabelled
 * it 'interrupted'. That erased the population every outcome measurement reads
 * (prompt-evolution, role evidence) — task 893. Best-effort by design: a
 * bookkeeping write must never change the phase's own result.
 *
 * @param sessionId - Session opened for this phase. / このフェーズのセッションID
 * @param success - Whether the phase succeeded. / フェーズが成功したか
 */
async function finalizeAgentSession(sessionId: number, success: boolean): Promise<void> {
  try {
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: { status: success ? 'completed' : 'failed', lastActivityAt: new Date() },
    });
  } catch {
    /* session bookkeeping is never worth failing (or delaying) the phase for */
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
  // Target repository's OWN AGENTS.md — never rapitas' own (task 892 premise
  // #4: fixing rapitas-specific rules onto other themes previously caused a
  // false-investigation incident, task580 in workflow-cli-executor-worktree.ts).
  const agentsMd = readAgentsMdConstraints(effectiveWorkDir);

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

  const fullPrompt = buildCliAgentPrompt({
    taskId,
    language,
    systemPrompt,
    context,
    transition,
    agentsMd,
  });

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

    const { effectiveSuccess, phaseStatus, phaseError, superseded } = await runPhaseEpilogue({
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
      ...(superseded ? { superseded: true } : {}),
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
    await finalizeAgentSession(session.id, sessionSucceeded);
  }
}
