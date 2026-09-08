/**
 * Workflow Auto Commit — Classification helpers
 *
 * Pure/near-pure predicates the auto-commit pipeline and the verify-completion
 * gates share: how far a branch is ahead of its base, and whether a failed
 * commit/PR outcome means "there was nothing to land".
 * Not responsible for performing any commit, PR, merge, or cleanup — see
 * workflow-auto-commit.ts.
 */

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

/**
 * Classify whether a failed commit/PR outcome means "no change was needed"
 * (already implemented — safe to complete WITHOUT a PR) as opposed to a real
 * PR failure that must block. Shared by both verify-completion paths (HTTP
 * file-save handler and the CLI executor epilogue). Pure and unit-testable.
 *
 * Task 485 incident: `gh pr create` against a base branch that does not exist
 * in the repo also says "No commits between <base> and <head>" — a naive regex
 * match then completed a 261-line change with NO PR. Two guards close that:
 * a base-branch error is never no-change, and a commit that actually changed
 * files proves there WAS work to land.
 *
 * @param p.errorBlob - Concatenated commit/PR/step error messages. / エラー文字列連結
 * @param p.filesChanged - Files changed by the auto-commit (undefined = no commit made). / コミットの変更ファイル数
 * @returns True when completion-without-PR is justified. / PRなし完了が正当か
 */
export function isNoChangeCompletion(p: {
  errorBlob: string;
  filesChanged: number | undefined;
}): boolean {
  // A missing/invalid base produces "No commits between ..." too — that is a
  // PR-creation failure, not an already-implemented no-op.
  if (/base (?:sha|ref)|sha can't be blank|must be a branch/i.test(p.errorBlob)) return false;
  // The commit itself changed files: there IS work that failed to reach a PR.
  if (typeof p.filesChanged === 'number' && p.filesChanged > 0) return false;
  return (
    p.filesChanged === 0 ||
    /no commits between|nothing to commit|no changes added|変更がありません|差分がありません/i.test(
      p.errorBlob,
    )
  );
}
