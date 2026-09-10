/**
 * Workflow CLI Executor Worktree Resolution
 *
 * Resolves the working directory for a CLI phase run: reuses or creates the
 * per-task git worktree for mutating roles (implementer / verifier), refuses
 * to run them in a primary checkout, and falls back to the theme directory
 * for investigation roles. Not responsible for prompt building or execution.
 */
import { resolveTaskTitle, resolveTaskWithTheme } from '../task/task-resolver';
import { resolveLatestSessionWorktree } from '../agents/agent-session-resolver';
import { createLogger } from '../../config/logger';
import type { AgentOrchestrator } from '../agents/agent-orchestrator';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';
import { canReuseWorktree } from '../agents/orchestrator/git-operations/worktree/worktree-usable';
import { isPrimaryWorkTree } from '../agents/orchestrator/git-operations/worktree/worktree-guard';
import { resolveGitRoot } from './workflow-cli-executor-helpers';

// NOTE: Same logger name as the executor body — keeps the observed log `name`
// field identical after the file split.
const log = createLogger('workflow-cli-executor');

/**
 * Resolve the effective working directory (and worktree/branch) for a phase.
 *
 * When `abort` is set the caller must return it as the phase result without
 * executing any agent (worktree creation failed, or a mutating role would run
 * in a primary checkout); the remaining fields are placeholders in that case.
 *
 * @param params - taskId, role transition, orchestrator (createWorktree), resolved task+theme / タスクID・ロール遷移・オーケストレータ・テーマ付きタスク
 * @returns Worktree path / branch / effective workdir, or an abort result / 解決済み作業ディレクトリ情報または中止結果
 */
export async function resolveExecutionWorkdir(params: {
  taskId: number;
  transition: RoleTransition;
  orchestrator: AgentOrchestrator;
  taskWithTheme: Awaited<ReturnType<typeof resolveTaskWithTheme>>;
}): Promise<{
  resolvedWorktreePath: string | null;
  resolvedBranchName: string | null;
  effectiveWorkDir: string;
  abort?: WorkflowAdvanceResult;
}> {
  const { taskId, transition, orchestrator, taskWithTheme } = params;
  const themeWorkDir = taskWithTheme?.theme?.workingDirectory || null;
  const isImplementationRole = transition.role === 'implementer';
  const isVerifierRole = transition.role === 'verifier' || transition.role === 'auto_verifier';
  // CRITICAL: implementer / verifier must run inside the per-task git worktree
  // that the original execute-route call created via executeSetup. Without
  // this, code edits land directly on the dev project root, no branch is
  // produced, and the auto-commit/PR pipeline can't fire (no diff to compare,
  // no branch to push). Earlier code defaulted to `themeWorkDir` which is the
  // dev project ROOT — the user reported "worktree が作成されない / コミット
  // も PR も作られない" exactly because of this regression.
  // Look up the most recent session for THIS task that already has a
  // worktreePath. The execute-route's research mode setup or a prior
  // implementer run is the usual source. We resolve this BEFORE creating
  // the new session so the new session can inherit the worktree path
  // immediately (and the agent runs inside it).
  let resolvedWorktreePath: string | null = null;
  let resolvedBranchName: string | null = null;
  // A revised plan must inspect the implementation that was actually verified,
  // including uncommitted files. Reuse only; planning must not recreate it.
  if (transition.role === 'planner') {
    const prior = await resolveLatestSessionWorktree(taskId);
    if (prior?.worktreePath && canReuseWorktree(prior.worktreePath)) {
      resolvedWorktreePath = prior.worktreePath;
      resolvedBranchName = prior.branchName;
    }
  }
  if (isImplementationRole || isVerifierRole) {
    const sessionWithWorktree = await resolveLatestSessionWorktree(taskId);
    // Only REUSE a recorded worktree if it still exists ON DISK. A prior
    // session may record a worktreePath that was later removed (a stop/cleanup,
    // or a worktree that never finished creating). Reusing a phantom path makes
    // every implementer/verifier re-launch fail with "Working directory does not
    // exist" and retry forever (task 30: .worktrees/task-30-… was gone). When the
    // recorded path is missing, fall through to recreate a fresh worktree.
    const recordedPath = sessionWithWorktree?.worktreePath ?? null;
    if (canReuseWorktree(recordedPath)) {
      resolvedWorktreePath = recordedPath;
      resolvedBranchName = sessionWithWorktree?.branchName ?? null;
      log.info(
        { taskId, role: transition.role, worktreePath: resolvedWorktreePath },
        '[WorkflowCLIExecutor] Reusing existing worktree from prior session',
      );
    } else {
      if (recordedPath) {
        log.warn(
          { taskId, role: transition.role, recordedPath },
          '[WorkflowCLIExecutor] Recorded worktree no longer exists on disk — recreating instead of reusing a phantom path',
        );
      }
      // No prior worktree — create one so implementer/verifier always runs in
      // isolation and produces a branch the auto-PR pipeline can push. Host it
      // in the theme's project dir, or — when unset (e.g. rapitas
      // self-development) — the git root of the backend's cwd, so we still get
      // an isolated worktree instead of editing the live checkout directly
      // (which previously flipped the main checkout's branch mid-run).
      let worktreeBase = themeWorkDir;
      if (!worktreeBase) {
        worktreeBase = await resolveGitRoot(process.cwd());
        if (worktreeBase) {
          log.info(
            { taskId, role: transition.role, worktreeBase },
            '[WorkflowCLIExecutor] No themeWorkDir; isolating in a worktree of the cwd git root',
          );
        }
      }
      if (worktreeBase) {
        try {
          const { generateBranchName } = await import('../../utils/common/branch-name-generator');
          const taskInfo = await resolveTaskTitle(taskId);
          const taskTitle = taskInfo?.title ?? `task-${taskId}`;
          const taskDescription = taskInfo?.description ?? undefined;
          // Reuse the EXISTING feature branch (it holds the prior implementation
          // and the commits already pushed to the PR) when a prior session
          // recorded one — e.g. a ci_repair re-run after the worktree was cleaned
          // up. Recreating on a FRESH branch loses the PR's work and re-implements
          // from scratch, so the CI fix never lands on the PR branch (observed:
          // task 227 re-implement loop). createWorktree checks out an existing
          // branch as-is, keeping its commits.
          const priorBranch = sessionWithWorktree?.branchName?.trim();
          // A NEW branch MUST be unique per task — unrelated tasks used to
          // collide on generic title-derived names (observed: 10 PRs sharing
          // ONE branch; PR #253 / task 305 closed unmerged by a force-push).
          // generateBranchName embeds the `t<taskId>-` marker internally
          // (exactly once — no manual suffixing here, which previously caused
          // the `...-t319-task-319` double-embed) and falls back to the
          // deterministic generator, still taskId-tagged, when AI is
          // unavailable. A reused priorBranch keeps its EXACT name (it already
          // maps 1:1 to an open PR).
          const branchName =
            priorBranch ||
            (await generateBranchName(taskTitle, taskDescription, taskId)) ||
            `feature/task-${taskId}-auto`;
          const wt = await orchestrator.createWorktree(worktreeBase, branchName, taskId, null);
          resolvedWorktreePath = wt;
          resolvedBranchName = branchName;
          log.info(
            { taskId, role: transition.role, worktreePath: wt, branchName },
            '[WorkflowCLIExecutor] Created new worktree (no prior session had one)',
          );
        } catch (wtErr) {
          // NOTE(safety): worktree creation failure is FATAL for mutating
          // roles. The old behavior fell through to themeWorkDir — usually a
          // real project's PRIMARY checkout — and spawned a bypass-permissions
          // agent directly in it (the main-checkout clobber class of incident).
          // Failing the phase is recoverable (retry after fixing the worktree
          // problem); a clobbered checkout is not.
          log.error(
            { err: wtErr, taskId, role: transition.role, worktreeBase },
            '[WorkflowCLIExecutor] Failed to create worktree — refusing to run a mutating role without isolation',
          );
          return {
            resolvedWorktreePath: null,
            resolvedBranchName: null,
            effectiveWorkDir: process.cwd(),
            abort: {
              success: false,
              role: transition.role,
              status: (taskWithTheme?.workflowStatus as WorkflowAdvanceResult['status']) || 'draft',
              error:
                'worktree の作成に失敗したため実行を中止しました（隔離なしでの変更系エージェント実行を防止）。worktree の問題を解消して再実行してください。',
            },
          };
        }
      } else {
        log.warn(
          {
            taskId,
            themeId: taskWithTheme?.themeId ?? null,
            role: transition.role,
            themeWorkDir: null,
            cwd: process.cwd(),
          },
          '[WorkflowCLIExecutor] No themeWorkDir and no git root; running at cwd (no isolation). Fix: set theme workingDirectory in the theme settings.',
        );
      }
    }
  }
  // CRITICAL: implementer / verifier must run inside the per-task git
  // worktree. Earlier code defaulted to `themeWorkDir` which is the dev
  // project ROOT — the user reported "worktree が作成されない / コミット
  // も PR も作られない" exactly because of this regression.
  //
  // Investigation roles (researcher / planner) get themeWorkDir, NOT the
  // backend's own cwd. They previously always ran in C:\...\rapitas-backend,
  // so every non-rapitas theme had its codebase investigated against RAPITAS:
  // task 580 (theme コンバーター, C:\Projects\ime-live-converter) produced a
  // research report concluding "viterbi.rs / scoring.rs do not exist and the
  // premises are invalid" — because it grepped the wrong repository. Only
  // rapitas self-development was unaffected, which is why it went unnoticed.
  // Safe without a worktree: these phases run with investigationMode, whose
  // denylist removes Bash/PowerShell/Edit/Write/NotebookEdit, so they can only
  // read the checkout.
  const isInvestigationRole = transition.role === 'researcher' || transition.role === 'planner';
  const effectiveWorkDir: string =
    resolvedWorktreePath ??
    (isImplementationRole || isVerifierRole || isInvestigationRole
      ? (themeWorkDir ?? process.cwd())
      : process.cwd());

  // SAFETY (②): a mutating role must run inside a LINKED worktree — never any
  // repo's PRIMARY checkout. This is repo-agnostic on purpose: the earlier
  // isBackendPrimaryCheckout guard protected only the rapitas self-checkout,
  // so when worktree isolation failed for a normal theme the agent (spawned
  // with --dangerously-skip-permissions) still ran directly in THAT project's
  // primary checkout, where its own git commands could commit/switch/reset the
  // developer's tree (the main-checkout clobber class of incident). Refusing
  // fails safe — the task errors with a clear cause and is retryable.
  // isPrimaryWorkTree also returns true for non-git directories (fail safe):
  // mutating roles produce commits/PRs, which are meaningless without git.
  // Escape hatch: RAPITAS_ALLOW_PRIMARY_EXEC=1 restores the old behavior.
  if (
    (isImplementationRole || isVerifierRole) &&
    process.env.RAPITAS_ALLOW_PRIMARY_EXEC !== '1' &&
    (await isPrimaryWorkTree(effectiveWorkDir))
  ) {
    log.error(
      { taskId, role: transition.role, effectiveWorkDir },
      '[WorkflowCLIExecutor] Refusing to run a mutating role in a primary checkout — worktree isolation required',
    );
    return {
      resolvedWorktreePath,
      resolvedBranchName,
      effectiveWorkDir,
      abort: {
        success: false,
        role: transition.role,
        status: (taskWithTheme?.workflowStatus as WorkflowAdvanceResult['status']) || 'draft',
        error:
          'worktree 隔離に失敗したため primary チェックアウトでの実行を中止しました（開発チェックアウトの破壊を防止）。worktree を再生成して再実行してください。',
      },
    };
  }

  return { resolvedWorktreePath, resolvedBranchName, effectiveWorkDir };
}
