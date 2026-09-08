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
import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { createCommit } from '../../../../services/agents/orchestrator/git-operations/core/core-ops';
import {
  createPullRequest,
  type CreatePullRequestResult,
} from '../../../../services/agents/orchestrator/git-operations/pr/branch-pr-ops';
import { notify } from '../../../../services/workflow/auto-merge-notify';
import { runAutomatedVerification } from '../../../../services/agents/verification/automated-verifier';
import { retryOrBlock } from '../../../../services/agents/verification/verification-retry';
import { verificationCrashResult } from '../../../../services/agents/verification/verification-gate';
import { linkAutoCreatedPr } from '../../../../services/github/pr-link';
import {
  findOpenPrForTask,
  claimPrCreationLock,
  releasePrCreationLock,
} from '../../../../services/github/pr-duplicate-guard';
import { resolvePreferredBaseBranch } from '../../../../services/task/task-resolver';
import { isAwaitingRequiredMerge } from '../../../../services/workflow/verify-settle-artifact-recovery';
import { publicationAborted } from '../../../../services/workflow/publication-cancellation-guard';
import { holdForRequiredMerge } from '../../../../services/workflow/required-merge-hold';
import {
  cleanupWorktree,
  execAsync,
  getDiff,
  markTaskDone,
  resolveBaseBranch,
  runAIReview,
} from './post-execution-review-helpers';

const log = createLogger('routes:post-execution-review');

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

  // Boundary 1/5 — a stop recorded before this pipeline started must not
  // produce a commit, a PR, or a worktree removal (task 895). This path has its
  // OWN commit/PR code, so it does not inherit performAutoCommitAndPR's guards.
  if (await publicationAborted(taskId, 'post_execution_review_entry')) return;

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
    .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
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
  const verification = await runAutomatedVerification(executionDir, {
    planContent: planContentForScope,
    preferredBaseBranch: preferredBaseBranchForVerify,
    taskId,
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

  // Boundary 2/5 — the verification gate above runs lint/type/tests and can
  // take minutes; a stop during it must not fall through into git.
  if (await publicationAborted(taskId, 'after_verification_gate')) return;

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

  // Boundary 3/5 — the last point before this run writes to git (the AI review
  // call above is another multi-minute await).
  if (await publicationAborted(taskId, 'before_commit')) return;

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
  // Boundary 4/5 — nothing is published to GitHub after a stop.
  if (await publicationAborted(taskId, 'before_pr')) return;

  const lockClaimed = await claimPrCreationLock(prisma, taskId);
  if (!lockClaimed) {
    log.info(
      { taskId },
      'Another PR-creation attempt is already in flight — preserving worktree, skipping',
    );
    return;
  }

  let prResult: CreatePullRequestResult;
  // Captured OUTSIDE the try so the completion gate below can read it: TS treats
  // an assignment inside try/finally as possibly-unexecuted.
  let publishedPrNumber: number | undefined;
  try {
    const existingOpenPr = await findOpenPrForTask(prisma, taskId);
    if (existingOpenPr) {
      log.info(
        { taskId, prNumber: existingOpenPr.prNumber },
        'Task already has an open PR — reusing instead of creating a new one',
      );
      prResult = { success: true, prUrl: existingOpenPr.url, prNumber: existingOpenPr.prNumber };
      publishedPrNumber = existingOpenPr.prNumber;
    } else {
      prResult = await createPullRequest(executionDir, prTitle, prBody, baseBranch);
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
      publishedPrNumber = prResult.prNumber ?? undefined;

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
      }
    }
  } finally {
    await releasePrCreationLock(prisma, taskId);
  }

  // Boundary 5/5 — worktree removal is irreversible and destroys the evidence a
  // stopped run must keep for inspection, so it is withheld too.
  if (await publicationAborted(taskId, 'before_worktree_cleanup')) return;

  // 5. Cleanup worktree only after PR is confirmed
  await cleanupWorktree(workDir, executionDir, sessionId);

  // 6. Completion point. When autoMergePR was requested, creating the PR is NOT
  // completion — hold the task at verify_done so the AutoMergeWatcher completes
  // it only after GitHub confirms the merge (task 895). This path is otherwise
  // the one completion route that never consulted the automation policy at all.
  if (await isAwaitingRequiredMerge(taskId).catch(() => true)) {
    // holdForRequiredMerge compare-and-swaps on the workflowStatus we OBSERVED,
    // so read it here rather than assuming: a non-workflow single run carries
    // whatever status its own path last wrote (often null).
    const observed = await prisma.task
      .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
      .catch(() => null);
    await holdForRequiredMerge({
      taskId,
      fromStatus: observed?.workflowStatus ?? null,
      source: 'post-execution-review',
      metadata: { prNumber: publishedPrNumber ?? null },
    });
    log.info(
      { taskId, prNumber: publishedPrNumber },
      'Post-execution review pipeline finished — completion deferred to the auto-merge watcher',
    );
    return;
  }
  await markTaskDone(taskId);

  log.info({ taskId }, 'Post-execution review pipeline completed');
}
