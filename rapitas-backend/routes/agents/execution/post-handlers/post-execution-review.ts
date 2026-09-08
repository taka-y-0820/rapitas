/**
 * Post-Execution Review Pipeline
 *
 * After agent execution completes successfully in a worktree:
 * 1. AI reviews the diff for quality (Ollama free → Haiku fallback)
 * 2. If approved, commits changes and creates a PR
 * 3. Cleans up the worktree only after PR is confirmed created
 *
 * If review finds issues, the worktree is preserved for manual inspection.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { sendAIMessage } from '../../../../utils/ai-client';
import { getLocalLLMStatus } from '../../../../services/local-llm';
import { AgentWorkerManager } from '../../../../services/agents/agent-worker-manager';
import { createCommit } from '../../../../services/agents/orchestrator/git-operations/core/core-ops';
import {
  createPullRequest,
  type CreatePullRequestResult,
} from '../../../../services/agents/orchestrator/git-operations/pr/branch-pr-ops';
import { notify } from '../../../../services/workflow/auto-merge-notify';
import {
  runAutomatedVerification,
  computeVerdict,
} from '../../../../services/agents/verification/automated-verifier';
import { retryOrBlock } from '../../../../services/agents/verification/verification-retry';
import {
  verificationCrashResult,
  recordUnknownVerdictMarker,
} from '../../../../services/agents/verification/verification-gate';
import { parseSpecArray } from '../../../../utils/common/spec-array';
import { linkAutoCreatedPr } from '../../../../services/github/pr-link';
import {
  findOpenPrForTask,
  claimPrCreationLock,
  releasePrCreationLock,
} from '../../../../services/github/pr-duplicate-guard';
import { resolvePreferredBaseBranch } from '../../../../services/task/task-resolver';

const log = createLogger('routes:post-execution-review');
const agentWorkerManager = AgentWorkerManager.getInstance();
// Async git so worktree revert/diff here never blocks the single-threaded
// event loop. Synchronous execSync('git ...') would freeze ALL HTTP requests
// (e.g. the UI's GET /tasks/:id) for up to the given timeout when a git op is
// slow/locked — the "Request timeout after 30001ms" this bug class produces
// (already fixed for execute-post-handler.ts's own copy of this logic; this
// file's copy was missed at the time).
const execAsync = promisify(exec);

const REVIEW_PROMPT = `あなたはシニアコードレビュアーです。以下のgit diffをレビューしてください。

## タスク: {title}

## 変更差分
{diff}

以下のJSON形式で返してください（他のテキスト不要）:
{
  "approved": true/false,
  "summary": "変更内容の要約（1-2文）",
  "issues": ["問題点があれば記載"],
  "commitMessage": "適切なコミットメッセージ（conventional commits形式: feat/fix/refactor等）"
}

承認基準:
- コードが動作しそうか（明らかな構文エラーがないか）
- 意図しないファイルの削除や破壊的変更がないか
- 明確なバグの混入がないか
軽微なスタイル問題は承認してください。`;

interface ReviewParams {
  taskId: number;
  taskTitle: string;
  sessionId: number;
  workDir: string;
  executionDir: string;
  branchName?: string;
  executionOutput?: string;
}

/**
 * AI review → commit → PR → cleanup pipeline.
 * Called as fire-and-forget from execute-post-handler.
 *
 * @param params - Execution context / 実行コンテキスト
 */
export async function reviewAndCommitWorktree(params: ReviewParams): Promise<void> {
  const { taskId, taskTitle, sessionId, workDir, executionDir } = params;

  log.info({ taskId, executionDir }, 'Starting post-execution review pipeline');

  // 1. Get the diff from the worktree
  const diff = await getDiff(executionDir);
  if (!diff.trim()) {
    // NOTE: Workflow files (research.md / plan.md / verify.md) are stored
    // OUTSIDE the worktree at `~/.rapitas/workflows/...` so their creation does
    // NOT show up in `git diff`. If the agent followed the workflow correctly
    // (saved research/plan via the workflow API and then exited without code
    // changes), `task.workflowStatus` will have transitioned to a planning
    // state. Treat that as a successful planning phase — NOT a blocked failure.
    const taskState = await prisma.task
      .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
      .catch(() => null);
    const planningStatuses = new Set(['research_done', 'plan_created', 'plan_approved']);
    if (taskState?.workflowStatus && planningStatuses.has(taskState.workflowStatus)) {
      log.info(
        { taskId, sessionId, workflowStatus: taskState.workflowStatus },
        'Agent completed planning phase (research/plan saved). Awaiting user approval before implementation.',
      );
      await prisma.task
        // Canonical task.status is hyphenated 'in-progress' (see StatusConfig);
        // the underscore form is the separate workflowStatus value.
        .update({ where: { id: taskId }, data: { status: 'in-progress' } })
        .catch((err) => log.warn({ err, taskId }, 'Failed to update task status'));
      // Worktree is preserved so the next execution (after user approves the
      // plan in the UI) can pick up where this one left off.
      return;
    }

    // NOTE: Empty diff with no planning artifacts almost always means the agent
    // gave up mid-task without making any change (CLI crashed, vitest EPERM,
    // agent hallucinated completion, ignored the workflow instruction, etc.).
    // DO NOT silently mark the task as done — surface it to the user as
    // `blocked` so they can inspect the worktree and re-run.
    log.warn(
      { taskId, sessionId, workflowStatus: taskState?.workflowStatus ?? null },
      'Agent reported success but produced no diff and no planning artifacts — marking task as blocked',
    );
    await prisma.task
      .update({ where: { id: taskId }, data: { status: 'blocked' } })
      .catch((err) => log.warn({ err, taskId }, 'Failed to update task to blocked'));
    await prisma.agentSession
      .update({
        where: { id: sessionId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage:
            'Agent finished but produced no file changes and no workflow artifacts (research.md/plan.md). Possible causes: verification command crashed, agent ignored the workflow instruction, or hallucinated completion. Worktree preserved for inspection.',
        },
      })
      .catch((err) => log.warn({ err, sessionId }, 'Failed to update session to failed'));
    // NOTE: Worktree intentionally preserved (not cleaned up) so the user can
    // inspect what the agent did/did not do. The worktree-cleanup-scheduler
    // will eventually remove it after the configured retention window.
    return;
  }

  // NOTE: If the agent produced code changes but did NOT save a plan.md via
  // the workflow API, the agent ignored the workflow instructions entirely
  // (codex CLI is known to do this — it's optimized for "implement now" and
  // does not respect "save plan and stop" instructions). Revert the worktree
  // to discard the unauthorized changes and block the task so the user is
  // forced to re-run the planning phase.
  // EXCEPTION: codex agents run without workflow enforcement, so missing
  // plan.md is expected for them. Skip the revert for codex sessions.
  const taskWithStatus = await prisma.task
    .findUnique({
      where: { id: taskId },
      select: {
        workflowStatus: true,
        description: true,
        goals: true,
        constraints: true,
        acceptanceCriteria: true,
      },
    })
    .catch(() => null);
  const status = taskWithStatus?.workflowStatus;
  const planFile = await prisma.workflowFile
    .findFirst({ where: { taskId, fileType: 'plan' }, select: { id: true } })
    .catch(() => null);
  const planExists = !!planFile;

  // Look up the agent type via session → execution → agentConfig chain.
  const execution = await prisma.agentExecution
    .findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      select: { agentConfig: { select: { agentType: true } } },
    })
    .catch(() => null);
  const reviewIsCodexAgent = execution?.agentConfig?.agentType === 'codex';

  if (!planExists && !reviewIsCodexAgent) {
    log.error(
      { taskId, sessionId, workflowStatus: status, diffSize: diff.length },
      'Agent produced code changes WITHOUT saving plan.md — workflow violated. Reverting worktree and blocking task.',
    );
    // Discard the agent's unauthorized changes so the user has a clean slate
    // to retry from. The branch + worktree are preserved (just the working
    // tree is reset to HEAD).
    try {
      await execAsync('git reset --hard HEAD', { cwd: executionDir, timeout: 30000 });
      await execAsync('git clean -fd', { cwd: executionDir, timeout: 30000 });
      log.info({ taskId, executionDir }, 'Reverted unauthorized agent changes');
    } catch (revertErr) {
      log.warn(
        { err: revertErr, taskId },
        'Failed to revert worktree (proceeding to mark blocked)',
      );
    }
    await prisma.task
      .update({ where: { id: taskId }, data: { status: 'blocked' } })
      .catch((err) => log.warn({ err, taskId }, 'Failed to update task to blocked'));
    await prisma.agentSession
      .update({
        where: { id: sessionId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage:
            'ワークフロー違反: エージェントが plan.md を保存せずに直接コードを変更しました (codex CLI は「計画して停止」指示を無視する傾向があります)。worktree の未承認変更は破棄しました。タスクを再実行すれば調査・計画フェーズからやり直します。',
        },
      })
      .catch((err) => log.warn({ err, sessionId }, 'Failed to update session to failed'));
    return;
  }

  // NOTE: plan.md exists but isn't approved yet — agent jumped ahead from
  // planning to implementation in a single run. Preserve the diff (it might
  // be salvageable) but block the commit/PR until user approves the plan.
  if (status === 'plan_created') {
    log.warn(
      { taskId, sessionId, workflowStatus: status },
      'Agent produced code changes but plan.md is not yet approved — blocking commit/PR until user approves the plan',
    );
    await prisma.task
      .update({ where: { id: taskId }, data: { status: 'blocked' } })
      .catch((err) => log.warn({ err, taskId }, 'Failed to update task to blocked'));
    await prisma.agentSession
      .update({
        where: { id: sessionId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage:
            'Agent implemented before the user approved plan.md. Worktree changes preserved for review. Approve the plan in the UI and re-run, or discard the worktree.',
        },
      })
      .catch((err) => log.warn({ err, sessionId }, 'Failed to update session to failed'));
    return;
  }

  // 1.5 Automated verification gate — run REAL lint + typecheck + scoped tests
  // (+ plan-scope when a plan exists) on the agent's changes (not the agent's
  // prose claims). Blocks commit/PR (task=blocked, session=failed with
  // evidence) on new failures. Verifier crashes block as unverifiable.
  // Shared with the verify.md auto-PR path. See verification-gate.ts.
  const planContentForScope = await (async () => {
    try {
      const { readWorkflowFile } =
        await import('../../../../services/workflow/workflow-file-utils');
      return (await readWorkflowFile(taskId, 'plan')) || null;
    } catch {
      return null;
    }
  })();
  // The worktree's ACTUAL fork point, not a guess — see automated-verifier.ts's
  // diffBaseRef doc comment (task 506: a guess-only base can misread unrelated
  // pre-existing commits as this task's own out-of-scope/tampering changes).
  // NOTE: theme.defaultBranch, not AgentExecutionConfig.targetBranch alone
  // (task 511: that table is empty for the autonomous pipeline) — this file
  // already resolves theme.defaultBranch separately below for the PR base
  // branch; resolvePreferredBaseBranch centralizes the same lookup here too.
  const preferredBaseBranchForVerify = await resolvePreferredBaseBranch(taskId);
  // acceptanceCriteria/taskText mirror verification-gate.ts's own lookup (this path
  // calls runAutomatedVerification directly, bypassing the shared gate — intentional).
  // Reuses taskWithStatus fetched above instead of a second round-trip.
  const acceptanceCriteria = parseSpecArray(taskWithStatus?.acceptanceCriteria);
  const specText = [
    taskTitle,
    taskWithStatus?.description ?? '',
    ...parseSpecArray(taskWithStatus?.goals),
    ...parseSpecArray(taskWithStatus?.constraints),
    ...acceptanceCriteria,
  ].join('\n');
  const verification = await runAutomatedVerification(executionDir, {
    planContent: planContentForScope,
    preferredBaseBranch: preferredBaseBranchForVerify,
    taskId,
    acceptanceCriteria,
    taskText: specText,
  }).catch((err) => {
    log.error({ err, taskId }, 'Automated verification crashed — blocking gate');
    return verificationCrashResult();
  });
  if (!verification.ok) {
    // Self-repair: feed the lint/type errors back to the implementer and re-run
    // on the same worktree; block only after retries are exhausted. After the
    // fix attempt we re-enter this pipeline (onReverify) to re-verify.
    await retryOrBlock({
      taskId,
      sessionId,
      taskTitle,
      executionDir,
      result: verification,
      onReverify: () => reviewAndCommitWorktree(params),
    });
    return;
  }
  const verdict = computeVerdict(verification.checks); // ok:true guaranteed above

  // 2. AI Review
  const review = await runAIReview(taskTitle, diff);
  if (!review) {
    log.warn({ taskId }, 'AI review returned no result, preserving worktree for manual inspection');
    return;
  }

  if (!review.approved) {
    log.info({ taskId, issues: review.issues }, 'AI review rejected changes, preserving worktree');
    return;
  }

  log.info({ taskId, summary: review.summary }, 'AI review approved');

  // 3. Commit
  const commitMsg = review.commitMessage || `feat(task-${taskId}): ${taskTitle}`;
  let commitHash: string;
  try {
    const commitResult = await createCommit(executionDir, commitMsg);
    commitHash = commitResult.hash;
  } catch (commitErr) {
    log.warn({ taskId, err: commitErr }, 'Commit failed, preserving worktree');
    return;
  }

  log.info({ taskId, hash: commitHash }, 'Changes committed');

  // 4. Create PR
  const prBody = [
    `## ${review.summary}`,
    '',
    `Task: #${taskId}`,
    '',
    `自動検証: ${verification ? verification.summary.replace(/^自動検証:\s*/, '') : 'スキップ'}`,
    '',
    '---',
    '🤖 AI-reviewed and auto-committed by Rapitas',
  ].join('\n');

  const prTitle = `[Task-${taskId}] ${taskTitle}`;
  // Base = the task's theme defaultBranch (mirrors the workflow / approval paths).
  // `branchName` is the worktree's HEAD branch, NOT the base — passing it here was
  // the bug that left base unset, so createPullRequest auto-detected and (when
  // origin/develop was not resolvable in the worktree) fell back to main, opening
  // every auto-PR against main and making them conflict with develop.
  const baseBranch = await resolveBaseBranch(taskId);

  // One-open-PR-per-task guard: createPullRequest's own reuse check is
  // branch-scoped (gh pr list --head <branch>) and misses a task's real open
  // PR whenever this run lands on a DIFFERENT branch (recreated worktree,
  // diverged push renamed to <branch>-<sha>). Claim the lock first so two
  // concurrent auto-PR attempts for this task can't both pass the check and
  // each create one.
  const lockClaimed = await claimPrCreationLock(prisma, taskId);
  if (!lockClaimed) {
    log.info(
      { taskId },
      'Another PR-creation attempt is already in flight — preserving worktree, skipping',
    );
    return;
  }

  let prResult: CreatePullRequestResult;
  try {
    const existingOpenPr = await findOpenPrForTask(prisma, taskId);
    if (existingOpenPr) {
      log.info(
        { taskId, prNumber: existingOpenPr.prNumber },
        'Task already has an open PR — reusing instead of creating a new one',
      );
      prResult = { success: true, prUrl: existingOpenPr.url, prNumber: existingOpenPr.prNumber };
    } else {
      prResult = await createPullRequest(
        executionDir,
        prTitle,
        prBody,
        baseBranch,
        undefined,
        verdict === 'unknown',
      );
      if (!prResult.success) {
        // Task-identity mismatch (task 541): the branch's open PR belongs to
        // another task — notify instead of failing silently so the user can
        // resolve the stale branch/PR collision.
        if (prResult.foreignPrDetected) {
          await notify({
            taskId,
            type: 'auto_pr_identity_mismatch',
            title: '自動PR作成を中止しました',
            message: `タスク ${taskId} のブランチには他タスクの PR #${prResult.foreignPrDetected.prNumber} が開いたまま残っているため、誤リンクを避けてPR作成を中止しました。${prResult.foreignPrDetected.prUrl}`,
          });
        }
        log.warn({ taskId, error: prResult.error }, 'PR creation failed, worktree preserved');
        return;
      }

      log.info({ taskId, prUrl: prResult.prUrl, prNumber: prResult.prNumber }, 'PR created');

      // Persist + link the PR locally so the task's "PRを開く" button can resolve
      // task → local PR id (otherwise the by-task lookup 404s and nothing happens).
      // The worktree's current branch is the PR head; baseBranch (resolved above) is
      // the theme's default branch the PR targets.
      if (prResult.prNumber != null && prResult.prUrl) {
        let headBranch = 'unknown';
        try {
          const { stdout } = await execAsync('git branch --show-current', {
            cwd: executionDir,
            encoding: 'utf-8',
          });
          headBranch = stdout.trim() || headBranch;
        } catch {
          /* display-only field — a later sync corrects it */
        }
        await linkAutoCreatedPr(prisma, {
          taskId,
          prNumber: prResult.prNumber,
          prUrl: prResult.prUrl,
          title: prTitle,
          headBranch,
          baseBranch,
          workingDirectory: executionDir,
        });
        if (verdict === 'unknown') {
          await recordUnknownVerdictMarker(taskId, executionDir, 'post-execution-review');
          await notify({
            taskId,
            type: 'auto_pr_draft_unknown',
            title: '検証結果 unknown のため draft PR を作成',
            message: `タスク ${taskId}: 検証結果が判定不能(unknown)のため PR #${prResult.prNumber} を draft として作成しました。内容を確認し、問題なければ "gh pr ready" で通常のPRに切り替えてください。`,
          });
        }
      }
    }
  } finally {
    await releasePrCreationLock(prisma, taskId);
  }

  // 5. Cleanup worktree only after PR is confirmed
  await cleanupWorktree(workDir, executionDir, sessionId);

  // 6. Mark task as done — UNLESS the verdict is 'unknown': the draft PR still
  // needs independent CI or human approval before completion (task 874).
  if (verdict !== 'unknown') await markTaskDone(taskId);

  log.info({ taskId, verdict }, 'Post-execution review pipeline completed');
}

/**
 * Resolve the PR base branch for a task: the task's theme defaultBranch, else
 * 'develop'. Mirrors the workflow-auto-commit / approval paths so auto-PRs target
 * the theme's intended branch instead of an auto-detected main.
 *
 * @param taskId - Task id / タスクID
 * @returns Base branch name / ベースブランチ名
 */
async function resolveBaseBranch(taskId: number): Promise<string> {
  const task = await prisma.task
    .findUnique({ where: { id: taskId }, select: { theme: { select: { defaultBranch: true } } } })
    .catch(() => null);
  return task?.theme?.defaultBranch || 'develop';
}

/** Get git diff from worktree. */
async function getDiff(dir: string): Promise<string> {
  try {
    // Staged + unstaged changes
    const { stdout: staged } = await execAsync('git diff --cached --stat', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
    });
    const { stdout: unstaged } = await execAsync('git diff --stat', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
    });
    const { stdout: untracked } = await execAsync('git ls-files --others --exclude-standard', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
    });

    // Get actual diff content (limited to prevent token overflow)
    const { stdout: diffContent } = await execAsync('git diff HEAD --no-color -U3', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });

    const parts = [staged, unstaged, untracked].filter(Boolean).join('\n');
    if (!parts.trim() && !diffContent.trim()) return '';

    // Truncate large diffs for AI review
    return diffContent.slice(0, 8000);
  } catch {
    return '';
  }
}

interface ReviewResult {
  approved: boolean;
  summary: string;
  issues: string[];
  commitMessage: string;
}

/** Run AI review on the diff. */
async function runAIReview(title: string, diff: string): Promise<ReviewResult | null> {
  try {
    const localStatus = await getLocalLLMStatus().catch(() => ({ available: false }));
    const useLocal = (localStatus as { available: boolean }).available;

    const prompt = REVIEW_PROMPT.replace('{title}', title).replace('{diff}', diff);

    const response = await sendAIMessage({
      provider: useLocal ? 'ollama' : 'claude',
      model: useLocal ? 'llama3.2' : 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as ReviewResult;
  } catch (err) {
    log.warn({ err }, 'AI review call failed');
    return null;
  }
}

/** Clean up worktree and update DB. */
async function cleanupWorktree(
  workDir: string,
  executionDir: string,
  sessionId: number,
): Promise<void> {
  try {
    const removed = await agentWorkerManager.removeWorktree(workDir, executionDir);
    if (removed) {
      await prisma.agentSession.update({ where: { id: sessionId }, data: { worktreePath: null } });
      log.info({ sessionId }, 'Worktree cleaned up');
    } else {
      log.warn({ sessionId }, 'removeWorktree refused or failed');
    }
  } catch (err) {
    log.warn({ err, sessionId }, 'Worktree cleanup failed');
  }
}

/** Mark task as done with completedAt timestamp. */
async function markTaskDone(taskId: number): Promise<void> {
  try {
    await prisma.task.update({
      where: { id: taskId },
      data: { status: 'done', completedAt: new Date() },
    });
    log.info({ taskId }, 'Task marked as done');
  } catch (err) {
    log.warn({ err, taskId }, 'Failed to mark task as done');
  }
}
