/**
 * FakeGitRemote
 *
 * Creates the throwaway `origin` an eval run pushes to: a bare repository on
 * the local filesystem. Nothing here ever touches GitHub, so a run cannot leak
 * evaluation branches into a real repository, burn API rate limit, or depend
 * on `gh` credentials.
 *
 * Owns creation, seeding, merging and teardown of that remote only — it makes
 * no judgement about whether a run passed.
 */
import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** A live throwaway remote plus the clone that pushes to it. */
export interface FakeGitRemote {
  /** Filesystem path of the bare repository acting as `origin`. */
  remotePath: string;
  /** Working clone the agent runs in. */
  workdirPath: string;
  /** Branch treated as the default/base branch. */
  defaultBranch: string;
}

/** Default branch name used by throwaway remotes. */
export const FAKE_REMOTE_DEFAULT_BRANCH = 'main';

/**
 * Runs a git command, returning trimmed stdout.
 *
 * @param cwd - Working directory / 実行ディレクトリ
 * @param args - Git arguments / gitの引数
 * @returns Trimmed stdout / 前後の空白を除いた標準出力
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Creates a bare remote and a working clone seeded with one commit.
 *
 * @param label - Short label folded into the temp directory name / 一時ディレクトリ名に使う短いラベル
 * @returns The created remote / 作成された使い捨てリモート
 */
export async function createFakeRemote(label = 'eval'): Promise<FakeGitRemote> {
  const root = mkdtempSync(join(tmpdir(), `rapitas-${label}-`));
  const remotePath = join(root, 'origin.git');
  const workdirPath = join(root, 'work');

  await execFileAsync('git', [
    'init',
    '--bare',
    '--initial-branch',
    FAKE_REMOTE_DEFAULT_BRANCH,
    remotePath,
  ]);
  await execFileAsync('git', ['init', '--initial-branch', FAKE_REMOTE_DEFAULT_BRANCH, workdirPath]);

  // Identity is set per-repository: the harness must never depend on, or
  // write to, the developer's global git config.
  await git(workdirPath, ['config', 'user.email', 'eval-harness@rapitas.local']);
  await git(workdirPath, ['config', 'user.name', 'Rapitas Eval Harness']);
  await git(workdirPath, ['commit', '--allow-empty', '-m', 'chore(eval): seed throwaway remote']);
  await git(workdirPath, ['remote', 'add', 'origin', remotePath]);
  await git(workdirPath, ['push', '-u', 'origin', FAKE_REMOTE_DEFAULT_BRANCH]);

  return { remotePath, workdirPath, defaultBranch: FAKE_REMOTE_DEFAULT_BRANCH };
}

/**
 * Commits every change in the working clone and pushes it to a branch.
 *
 * @param remote - Remote to push to / プッシュ先のリモート
 * @param branch - Branch name / ブランチ名
 * @param message - Commit message / コミットメッセージ
 * @returns The pushed commit SHA, or null when there was nothing to commit / コミットSHA（変更なしならnull）
 */
export async function commitAndPush(
  remote: FakeGitRemote,
  branch: string,
  message: string,
): Promise<string | null> {
  await git(remote.workdirPath, ['checkout', '-B', branch]);
  await git(remote.workdirPath, ['add', '-A']);

  const staged = await git(remote.workdirPath, ['diff', '--cached', '--name-only']);
  if (staged.length === 0) return null;

  await git(remote.workdirPath, ['commit', '-m', message]);
  await git(remote.workdirPath, ['push', '-f', 'origin', branch]);
  return git(remote.workdirPath, ['rev-parse', 'HEAD']);
}

/**
 * Fast-forward-merges a branch into the default branch, locally and on the
 * throwaway remote. Used to measure post-merge regression.
 *
 * @param remote - Remote to merge in / 対象のリモート
 * @param branch - Branch to merge / マージ元ブランチ
 * @returns Whether the merge succeeded / マージが成功したか
 */
export async function mergeIntoDefault(remote: FakeGitRemote, branch: string): Promise<boolean> {
  try {
    await git(remote.workdirPath, ['checkout', remote.defaultBranch]);
    await git(remote.workdirPath, ['merge', '--no-edit', branch]);
    await git(remote.workdirPath, ['push', 'origin', remote.defaultBranch]);
    return true;
  } catch {
    // A conflict is a legitimate observation, not a harness error: the run is
    // recorded as merge-attempted-and-failed rather than aborting the batch.
    return false;
  }
}

/**
 * Deletes the throwaway remote and its working clone.
 *
 * @param remote - Remote to destroy / 破棄するリモート
 */
export function destroyFakeRemote(remote: FakeGitRemote): void {
  // The temp root is the parent of both paths; removing it drops the whole
  // remote in one call.
  const root = join(remote.remotePath, '..');
  rmSync(root, { recursive: true, force: true });
}
