/**
 * GitOperations — Module Index
 *
 * Re-assembles the GitOperations class from sub-modules.
 * Delegates all method implementations to standalone functions in:
 *   - core/core-ops.ts          (getGitDiff, getFullGitDiff, commitChanges, createCommit)
 *   - core/diff-structured.ts   (getDiff — structured per-file diff)
 *   - pr/branch-pr-ops.ts       (createBranch, createPullRequest, mergePullRequest, revertChanges)
 *   - worktree/repository-setup.ts (ensureGitRepository, validateAndSetupRemote)
 *   - worktree/worktree-ops.ts  (createWorktree, removeWorktree, cleanupStaleWorktrees)
 */

import { getGitDiff, getFullGitDiff, commitChanges, getDiff, createCommit } from './core/core-ops';
import {
  createBranch,
  createPullRequest,
  mergePullRequest,
  revertChanges,
} from './pr/branch-pr-ops';
import {
  ensureGitRepository,
  validateAndSetupRemote,
  createWorktree,
  removeWorktree,
  cleanupStaleWorktrees,
} from './worktree/worktree-ops';
import {
  awaitWorktreeDependencies,
  startWorktreeDependenciesInstall,
  taskNeedsDependencies,
  clearWorktreeDependenciesTracking,
} from './worktree/dependency-installer';
import { execGitReadonly, clearGitCache, clearAllGitCache } from './core/git-exec';

export {
  getGitDiff,
  getFullGitDiff,
  commitChanges,
  getDiff,
  createCommit,
  createBranch,
  createPullRequest,
  mergePullRequest,
  revertChanges,
  ensureGitRepository,
  validateAndSetupRemote,
  createWorktree,
  removeWorktree,
  cleanupStaleWorktrees,
  awaitWorktreeDependencies,
  startWorktreeDependenciesInstall,
  taskNeedsDependencies,
  clearWorktreeDependenciesTracking,
  execGitReadonly,
  clearGitCache,
  clearAllGitCache,
};

/**
 * Provides Git operations (diff, commit, branch, PR, merge, revert, worktrees).
 * All methods delegate to standalone functions in the sub-modules.
 */
export class GitOperations {
  /** @see getGitDiff */
  async getGitDiff(workingDirectory: string): Promise<string> {
    return getGitDiff(workingDirectory);
  }

  /** @see getFullGitDiff */
  async getFullGitDiff(workingDirectory: string): Promise<string> {
    return getFullGitDiff(workingDirectory);
  }

  /** @see commitChanges */
  async commitChanges(
    workingDirectory: string,
    message: string,
    taskTitle?: string,
  ): Promise<{ success: boolean; commitHash?: string; error?: string }> {
    return commitChanges(workingDirectory, message, taskTitle);
  }

  /** @see createPullRequest */
  async createPullRequest(
    workingDirectory: string,
    title: string,
    body: string,
    baseBranch?: string,
    headBranch?: string,
    draft?: boolean,
  ): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
    return createPullRequest(workingDirectory, title, body, baseBranch, headBranch, draft);
  }

  /** @see mergePullRequest */
  async mergePullRequest(
    workingDirectory: string,
    prNumber: number,
    commitThreshold: number = 5,
    baseBranch: string = 'master',
  ): Promise<{ success: boolean; mergeStrategy?: 'squash' | 'merge'; error?: string }> {
    return mergePullRequest(workingDirectory, prNumber, commitThreshold, baseBranch);
  }

  /** @see revertChanges */
  async revertChanges(workingDirectory: string): Promise<boolean> {
    return revertChanges(workingDirectory);
  }

  /** @see createBranch */
  async createBranch(workingDirectory: string, branchName: string): Promise<boolean> {
    return createBranch(workingDirectory, branchName);
  }

  /** @see createCommit */
  async createCommit(
    workingDirectory: string,
    message: string,
    preferredBaseBranch?: string | null,
  ): Promise<{
    hash: string;
    branch: string;
    filesChanged: number;
    additions: number;
    deletions: number;
    alreadyCommitted: boolean;
  }> {
    return createCommit(workingDirectory, message, preferredBaseBranch);
  }

  /** @see getDiff */
  async getDiff(workingDirectory: string): Promise<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>
  > {
    return getDiff(workingDirectory);
  }

  /** @see ensureGitRepository */
  async ensureGitRepository(directory: string, repositoryUrl?: string | null): Promise<boolean> {
    return ensureGitRepository(directory, repositoryUrl);
  }

  /** @see validateAndSetupRemote */
  async validateAndSetupRemote(directory: string, repositoryUrl?: string | null): Promise<boolean> {
    return validateAndSetupRemote(directory, repositoryUrl);
  }

  /** @see createWorktree */
  async createWorktree(
    baseDir: string,
    branchName: string,
    taskId?: number,
    repositoryUrl?: string | null,
    baseBranch?: string | null,
  ): Promise<string> {
    return createWorktree(baseDir, branchName, taskId, repositoryUrl, baseBranch);
  }

  /** @see removeWorktree */
  async removeWorktree(
    baseDir: string,
    worktreePath: string,
    deleteBranch: boolean = true,
  ): Promise<boolean> {
    return removeWorktree(baseDir, worktreePath, deleteBranch);
  }

  /** @see cleanupStaleWorktrees */
  async cleanupStaleWorktrees(baseDir: string, keepPaths: string[] = []): Promise<number> {
    return cleanupStaleWorktrees(baseDir, keepPaths);
  }
}
