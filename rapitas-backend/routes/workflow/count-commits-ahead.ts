import { runGitCommand } from '../../services/github/git-exec';

/**
 * Commits on HEAD that the remote base does not have.
 *
 * Fails OPEN: when git cannot answer (no remote-tracking ref, not a repo) the
 * caller proceeds to the PR attempt, which decides for itself.
 *
 * @param cwd - Worktree or checkout to inspect. / 対象の作業ツリー
 * @param baseBranch - PR base branch name (remote-tracking `origin/<base>` is compared). / ベースブランチ
 * @returns Number of commits ahead, or null when unknown. / 先行コミット数（不明なら null）
 */
export async function countCommitsAhead(cwd: string, baseBranch: string): Promise<number | null> {
  try {
    const out = await runGitCommand(['rev-list', '--count', `origin/${baseBranch}..HEAD`], cwd);
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

