/**
 * worktree-rebuild-recovery
 *
 * Recovers a task whose diff-review scope violation stems from BRANCH HISTORY
 * (the worktree was cut on top of another task's unmerged branch — task 539):
 * snapshots the session's work, rebuilds the worktree from the theme's default
 * branch on a fresh uniquely-named branch, re-applies the session diff minus
 * the contaminated files, and updates the session pointers. Editing the
 * working tree can never remove ancestor-commit content, so bouncing to the
 * implementer is futile for this failure class. Capped at ONE rebuild per task
 * (WorkflowTransition cause count — no schema change). Never commits/pushes to
 * the old branch and never deletes it (snapshot stays reachable via a tag).
 * Not responsible for deciding blocked/bounce policy — callers branch on the
 * returned reason.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { diffBaseRef, getAllChangedFiles } from '../agents/verification/automated-verifier';
import { evaluateScopeCheck, parsePlanFiles } from '../agents/verification/scope-check';
import {
  classifyScopeContamination,
  type FileTouchingCommit,
} from '../agents/verification/scope-contamination';
import {
  createWorktree,
  removeWorktree,
} from '../agents/orchestrator/git-operations/worktree/worktree-ops';
import { assertSafeGitRef, sanitizeBranchName } from '../../utils/common/branch-name-generator';
import { recordTransition } from './transition-recorder';
import { readWorkflowFile } from './workflow-file-utils';

const log = createLogger('workflow:worktree-rebuild-recovery');

/** WorkflowTransition.cause recorded on a successful rebuild (also the 1-per-task cap counter). */
export const WORKTREE_REBUILD_CAUSE = 'worktree_rebuilt';

/** Mirrors scope-check's offending-file cap — bounds the per-file `git log` fan-out. */
const MAX_OFFENDING_FILES = 40;

/** Diffs between distant bases can be large; default 1 MB maxBuffer is not enough. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

export interface RecoveryOutcome {
  recovered: boolean;
  /**
   * recovered=false の理由。呼び出し元の分岐に使う:
   * - `recovery_already_used` — cap reached → caller blocks + notifies (受入基準3)
   * - `patch_apply_conflict` — old worktree is GONE, implementer bounce is
   *   impossible → caller blocks + notifies (受入基準2c)
   * - everything else — recovery never started destroying state → caller
   *   falls through to the ordinary implementer bounce
   */
  reason?:
    | 'no_offending_files'
    | 'not_history_contaminated'
    | 'recovery_already_used'
    | 'session_not_found'
    | 'git_operation_failed'
    | 'patch_apply_conflict';
  newWorktreePath?: string;
  newBranchName?: string;
}

/**
 * Run a git command with array args (no shell) in a directory.
 *
 * @param cwd - Directory to run in / 実行ディレクトリ
 * @param args - git argv / git引数
 * @returns stdout / 標準出力
 * @throws {Error} On non-zero exit / 非ゼロ終了時
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

/**
 * Collect the commits touching each offending file within mergeBase..HEAD.
 *
 * @param worktreePath - Worktree to inspect / 対象worktree
 * @param mergeBase - Fork-point ref / マージベース
 * @param files - Offending files (already capped) / 対象ファイル
 * @returns Touching commits / 該当コミット一覧
 */
async function collectTouchingCommits(
  worktreePath: string,
  mergeBase: string,
  files: string[],
): Promise<FileTouchingCommit[]> {
  const out: FileTouchingCommit[] = [];
  for (const file of files) {
    const stdout = await runGit(worktreePath, [
      'log',
      `${mergeBase}..HEAD`,
      '--format=%H|%cI',
      '--',
      file,
    ]);
    for (const line of stdout.split('\n')) {
      const [sha, committedAt] = line.trim().split('|');
      if (sha && committedAt) out.push({ file, sha, committedAt });
    }
  }
  return out;
}

/**
 * Attempt the worktree-rebuild recovery for history-contaminated scope
 * violations. See the module header for the overall contract; every git
 * failure BEFORE any destructive step returns a fall-through reason, while a
 * failure AFTER the old worktree was removed returns `patch_apply_conflict`
 * so the caller blocks instead of bouncing into a destroyed worktree.
 *
 * @param params.taskId - Task under verification / 対象タスク
 * @param params.worktreePath - Current (suspect) worktree / 現worktree
 * @param params.offendingFiles - Out-of-plan files from the scope check / 計画外ファイル
 * @param params.preferredBaseBranch - The branch the worktree should be based on / 基準ブランチ
 * @returns Outcome with new worktree/branch when recovered / リカバリ結果
 */
export async function attemptWorktreeRebuildRecovery(params: {
  taskId: number;
  worktreePath: string;
  offendingFiles: string[];
  preferredBaseBranch: string | null;
}): Promise<RecoveryOutcome> {
  const { taskId, worktreePath, offendingFiles, preferredBaseBranch } = params;

  // 1 rebuild per task (受入基準3). Count errors fail CLOSED (treated as
  // already-used) — mirroring verify-self-repair's countPriorRepairs: an
  // unverifiable budget must not enable another destructive rebuild.
  const priorRebuilds = await prisma.workflowTransition
    .count({ where: { taskId, cause: WORKTREE_REBUILD_CAUSE } })
    .catch(() => Number.MAX_SAFE_INTEGER);
  if (priorRebuilds >= 1) {
    log.warn({ taskId, priorRebuilds }, '[worktree-rebuild] Recovery already used — refusing');
    return { recovered: false, reason: 'recovery_already_used' };
  }

  if (offendingFiles.length === 0) return { recovered: false, reason: 'no_offending_files' };
  if (!worktreePath || !existsSync(worktreePath)) {
    return { recovered: false, reason: 'session_not_found' };
  }

  const task = await prisma.task
    .findUnique({
      where: { id: taskId },
      select: {
        workingDirectory: true,
        theme: {
          select: { repositoryUrl: true, workingDirectory: true, defaultBranch: true },
        },
      },
    })
    .catch(() => null);
  const baseDir = task?.workingDirectory ?? task?.theme?.workingDirectory ?? null;

  // Session-start proxy: the FIRST session that held a worktree for this task
  // (see plan.md 設計判断 — no positive per-session commit record exists).
  const firstSession = await prisma.agentSession
    .findFirst({
      where: { config: { taskId }, worktreePath: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })
    .catch(() => null);
  const latestSession = await prisma.agentSession
    .findFirst({
      where: { config: { taskId }, worktreePath: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, branchName: true },
    })
    .catch(() => null);
  if (!baseDir || !firstSession || !latestSession) {
    return { recovered: false, reason: 'session_not_found' };
  }

  // ---- Classification (read-only git) -------------------------------------
  let mergeBase: string;
  let touchingCommits: FileTouchingCommit[];
  const cappedOffending = offendingFiles.slice(0, MAX_OFFENDING_FILES);
  try {
    mergeBase = await diffBaseRef(worktreePath, preferredBaseBranch);
    touchingCommits = await collectTouchingCommits(worktreePath, mergeBase, cappedOffending);
  } catch (err) {
    log.warn(
      { err, taskId },
      '[worktree-rebuild] git inspection failed — aborting (no changes made)',
    );
    return { recovered: false, reason: 'git_operation_failed' };
  }

  const classification = classifyScopeContamination({
    offendingFiles: cappedOffending,
    touchingCommits,
    sessionStartedAt: firstSession.createdAt.toISOString(),
    // No positive record source for session-made commits exists yet — empty
    // disables the sha check inside the classifier (plan.md 設計判断).
    sessionCommitShas: [],
  });
  if (!classification.historyContaminated) {
    return { recovered: false, reason: 'not_history_contaminated' };
  }

  log.warn(
    { taskId, contaminatedFiles: classification.contaminatedFiles, mergeBase },
    '[worktree-rebuild] History contamination confirmed — rebuilding worktree',
  );

  // ---- Snapshot (non-destructive) -----------------------------------------
  const oldBranchName = latestSession.branchName;
  const snapshotTag = `recovery/task-${taskId}-${Date.now()}`;
  let snapshotSha: string;
  try {
    assertSafeGitRef(snapshotTag, 'snapshotTag');
    // Stage everything first: `git stash create` only captures TRACKED files,
    // so an implementer's brand-new (untracked) files would silently vanish
    // with the worktree. Staging is index-only — nothing is committed to the
    // branch (制約4), and the worktree is about to be removed anyway.
    await runGit(worktreePath, ['add', '-A']);
    snapshotSha = (await runGit(worktreePath, ['stash', 'create'])).trim();
    if (!snapshotSha) {
      // Clean tree — the session's work is fully committed; snapshot = HEAD.
      snapshotSha = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).trim();
    }
    // Tag in baseDir (shared object DB) BEFORE removal so the snapshot commit
    // can never be GC'd. The tag is intentionally never deleted (受入基準2a).
    await runGit(baseDir, ['tag', snapshotTag, snapshotSha]);
  } catch (err) {
    log.warn(
      { err, taskId },
      '[worktree-rebuild] Snapshot/tag failed — aborting (no changes made)',
    );
    return { recovered: false, reason: 'git_operation_failed' };
  }

  // ---- Remove old worktree BEFORE creating the new one --------------------
  // createWorktree's ground-truth reuse returns any live `task-<id>-*` dir, so
  // the contaminated worktree MUST be gone first (plan.md 設計判断).
  // deleteBranch=false is the load-bearing argument: the default (true) would
  // delete the other task's branch (制約4).
  try {
    await removeWorktree(baseDir, worktreePath, false, snapshotTag);
  } catch (err) {
    log.warn({ err, taskId }, '[worktree-rebuild] removeWorktree threw — aborting');
    return { recovered: false, reason: 'git_operation_failed' };
  }
  if (existsSync(worktreePath)) {
    // removeWorktree does not throw on refusal/EBUSY exhaustion — verify on disk.
    log.warn({ taskId, worktreePath }, '[worktree-rebuild] Old worktree still present — aborting');
    return { recovered: false, reason: 'git_operation_failed' };
  }

  // ---- Create the replacement worktree ------------------------------------
  const desiredBranch = sanitizeBranchName(
    `${oldBranchName ?? `feature/task-${taskId}`}-recovered`,
  );
  let newWorktreePath: string;
  let newBranchName: string;
  try {
    assertSafeGitRef(desiredBranch, 'newBranchName');
    // Collision-proofing (-task-<id> suffix) lives inside createWorktree.
    newWorktreePath = await createWorktree(
      baseDir,
      desiredBranch,
      taskId,
      task?.theme?.repositoryUrl ?? null,
      task?.theme?.defaultBranch ?? null,
    );
    // createWorktree may have uniquified the branch — record the REAL name.
    newBranchName =
      (await runGit(newWorktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() ||
      desiredBranch;
  } catch (err) {
    // Old worktree is already gone — an implementer bounce would land nowhere.
    log.error({ err, taskId }, '[worktree-rebuild] Failed to create replacement worktree');
    return { recovered: false, reason: 'patch_apply_conflict' };
  }

  // ---- Re-apply the session diff minus contaminated files -----------------
  try {
    // Pathspec order matters: `.` first, then excludes — excludes alone would
    // exclude EVERYTHING (git pathspec semantics; plan.md 申し送り).
    const excludeSpecs = classification.contaminatedFiles.map((f) => `:(exclude)${f}`);
    const patch = await runGit(baseDir, [
      'diff',
      mergeBase,
      snapshotSha,
      '--',
      '.',
      ...excludeSpecs,
    ]);
    if (patch.trim()) {
      const patchFile = join(tmpdir(), `rapitas-recovery-task-${taskId}-${Date.now()}.patch`);
      await fsPromises.writeFile(patchFile, patch, 'utf8');
      try {
        await runGit(newWorktreePath, ['apply', '--whitespace=nowarn', patchFile]);
      } finally {
        await fsPromises.rm(patchFile, { force: true }).catch(() => {});
      }
    }
  } catch (err) {
    // Conflict (or diff failure) after the old worktree was destroyed → caller
    // must block + notify. The new worktree is left in place for debugging;
    // the cleanup scheduler reclaims it later. Session still points at the old
    // path, so nothing downstream silently runs against the half-built tree.
    log.error(
      { err, taskId, snapshotTag },
      '[worktree-rebuild] Patch generation/application failed — recovery aborted (snapshot preserved in tag)',
    );
    return { recovered: false, reason: 'patch_apply_conflict' };
  }

  // ---- Commit the switch: session pointers + audit trail ------------------
  try {
    await prisma.agentSession.update({
      where: { id: latestSession.id },
      data: { branchName: newBranchName, worktreePath: newWorktreePath },
    });
  } catch (err) {
    log.error({ err, taskId }, '[worktree-rebuild] Session pointer update failed');
    return { recovered: false, reason: 'git_operation_failed' };
  }

  await recordTransition({
    taskId,
    fromStatus: 'verify_done',
    toStatus: 'verify_done',
    actor: 'system',
    cause: WORKTREE_REBUILD_CAUSE,
    phase: 'verify',
    metadata: {
      oldBranch: oldBranchName,
      newBranch: newBranchName,
      snapshotTag,
      oldWorktreePath: worktreePath,
      newWorktreePath,
      contaminatedFiles: classification.contaminatedFiles,
    },
  });

  log.info(
    { taskId, oldBranchName, newBranchName, newWorktreePath, snapshotTag },
    '[worktree-rebuild] Worktree rebuilt from base branch — session updated',
  );
  return { recovered: true, newWorktreePath, newBranchName };
}

/**
 * Recompute the scope check for a worktree and attempt the rebuild recovery
 * when out-of-plan files exist. Scope is ADVISORY in the automated gate
 * (excluded from result.ok since #298), so verify_repair entry never tells us
 * whether scope offended — this wrapper recomputes it independently on every
 * would-be repair bounce (plan.md 設計判断).
 *
 * @param taskId - Task under verification / 対象タスク
 * @param worktreePath - Current worktree (null-safe) / 現worktree
 * @param preferredBaseBranch - Base branch for diffing / 基準ブランチ
 * @returns Recovery outcome / リカバリ結果
 */
export async function tryRecoverFromHistoryContamination(
  taskId: number,
  worktreePath: string | null | undefined,
  preferredBaseBranch: string | null,
): Promise<RecoveryOutcome> {
  if (!worktreePath) return { recovered: false, reason: 'session_not_found' };

  // Lightweight tasks have no plan.md → scope check is not applicable → this
  // recovery is intentionally inert for them (research.md 既知の制限).
  const planContent = await readWorkflowFile(taskId, 'plan').catch(() => null);
  if (!planContent) return { recovered: false, reason: 'no_offending_files' };
  const planFiles = parsePlanFiles(planContent);
  if (planFiles.length === 0) return { recovered: false, reason: 'no_offending_files' };

  let allChanged: string[];
  try {
    allChanged = await getAllChangedFiles(worktreePath, preferredBaseBranch);
  } catch (err) {
    log.warn({ err, taskId }, '[worktree-rebuild] Changed-file listing failed');
    return { recovered: false, reason: 'git_operation_failed' };
  }

  const scopeCheck = evaluateScopeCheck(allChanged, planFiles);
  if (!scopeCheck?.offendingFiles?.length) {
    return { recovered: false, reason: 'no_offending_files' };
  }

  return attemptWorktreeRebuildRecovery({
    taskId,
    worktreePath,
    offendingFiles: scopeCheck.offendingFiles,
    preferredBaseBranch,
  });
}

/**
 * Best-effort user notification for the blocked fallbacks (受入基準2c/3).
 * Dynamic import avoids a routes/services import cycle (mirrors
 * durable-blocked-write.ts). Never throws.
 *
 * @param taskId - Blocked task / ブロックされたタスク
 * @param title - Notification title / 通知タイトル
 * @param message - Notification body / 通知本文
 */
export async function notifyRecoveryFallbackBlocked(
  taskId: number,
  title: string,
  message: string,
): Promise<void> {
  try {
    const { createNotification } = await import('../communication/notification-service');
    await createNotification({
      type: 'system',
      title,
      message,
      link: `/tasks?taskId=${taskId}`,
      metadata: { taskId, reason: 'worktree_rebuild_recovery' },
    });
  } catch (err) {
    log.warn({ err, taskId }, '[worktree-rebuild] Failed to create notification (non-fatal)');
  }
}
