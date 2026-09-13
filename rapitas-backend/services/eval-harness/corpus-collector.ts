/**
 * CorpusCollector
 *
 * Turns completed app-database tasks into frozen corpus candidates by
 * resolving, from git history alone, the commit that actually fixed each task
 * and the commit the agent should start from.
 *
 * Ambiguity is always resolved by EXCLUDING the candidate: a corpus entry
 * pointing at an unrelated diff would silently corrupt every accuracy metric
 * downstream, which is far worse than a smaller corpus.
 *
 * Takes its git access as an injected port so it holds no connection of its
 * own — scripts/eval-corpus-seed.ts wires the real one.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { classifyTask, type Classification } from './corpus-classifier';

const execFileAsync = promisify(execFile);

/** A completed task as read from the app database. */
export interface CompletedTaskRecord {
  id: number;
  title: string;
  description: string | null;
  /** `Task.workflowStatus` at collection time. */
  workflowStatus: string | null;
  /** Linked PR number, when one is known. */
  prNumber: number | null;
  /** True when a `blocked` to `in_progress` transition exists for this task. */
  hasBlockedRecovery: boolean;
}

/** Git operations the collector needs. Injected so tests stay hermetic. */
export interface GitPort {
  /** Returns every commit SHA whose message contains `pattern` (fixed string). */
  findCommitsByMessage(pattern: string): Promise<string[]>;
  /** Returns the subject line of a commit. */
  getSubject(sha: string): Promise<string>;
  /** Returns the first parent of a commit. */
  getFirstParent(sha: string): Promise<string>;
  /** Returns file paths changed between two commits. */
  getChangedFiles(baseSha: string, headSha: string): Promise<string[]>;
  /** True when `sha` is an ancestor of `ref` (i.e. actually landed). */
  isAncestorOf(sha: string, ref: string): Promise<boolean>;
}

/** A candidate that survived resolution and classification. */
export interface CorpusCandidate {
  sourceTaskId: number;
  title: string;
  problemStatement: string;
  classification: Classification;
  baseCommitSha: string;
  fixCommitSha: string;
  protectedTestFiles: string[];
}

/** A candidate that was dropped, with the machine-readable reason. */
export interface CorpusExclusion {
  sourceTaskId: number;
  /** no_fix_commit | ambiguous_fix_commit | not_merged | no_parent | unclassified */
  reason: string;
  detail: string;
}

/** Result of a collection pass. */
export interface CollectionResult {
  accepted: CorpusCandidate[];
  excluded: CorpusExclusion[];
}

/** Ref the fix commit must be an ancestor of to count as landed. */
export const DEFAULT_LANDED_REF = 'origin/develop';

/**
 * Returns true for paths the implementing agent must not touch during eval.
 *
 * @param path - Repository-relative path / リポジトリ相対パス
 * @returns Whether the path is a test file / テストファイルかどうか
 */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|cjs|mjs)$/.test(path);
}

/**
 * Extracts the distinct top-level directory of each changed path.
 *
 * @param paths - Changed file paths / 変更されたファイルパス
 * @returns Distinct top-level directory names / 重複を除いたトップレベルディレクトリ名
 */
export function topLevelDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const head = path.split('/')[0];
    if (head && head !== path) dirs.add(head);
  }
  return [...dirs];
}

/** Successful commit resolution for one task. */
interface ResolvedCommits {
  ok: true;
  fixCommitSha: string;
  baseCommitSha: string;
  changedFiles: string[];
}

/**
 * Resolves the fix and base commits for one task.
 *
 * @param task - The completed task / 対象の完了タスク
 * @param git - Git port / gitポート
 * @param landedRef - Ref the fix must have landed on / 取り込み先ref
 * @returns Resolved SHAs and changed files, or an exclusion / 解決結果、または除外理由
 */
export async function resolveCommitsForTask(
  task: CompletedTaskRecord,
  git: GitPort,
  landedRef: string = DEFAULT_LANDED_REF,
): Promise<ResolvedCommits | { ok: false; exclusion: CorpusExclusion }> {
  const exclude = (reason: string, detail: string) => ({
    ok: false as const,
    exclusion: { sourceTaskId: task.id, reason, detail },
  });

  // Steps 1-3 of the resolution procedure: PR merge commit first, then the
  // task-id tag as a fallback.
  let matches: string[] = [];
  if (task.prNumber !== null) {
    matches = await git.findCommitsByMessage(`Merge pull request #${task.prNumber} from`);
  }
  if (matches.length !== 1) {
    matches = await git.findCommitsByMessage(`[#${task.id}]`);
  }
  if (matches.length === 0) {
    return exclude('no_fix_commit', `No commit references PR #${task.prNumber} or [#${task.id}]`);
  }
  if (matches.length > 1) {
    return exclude('ambiguous_fix_commit', `${matches.length} commits matched; refusing to guess`);
  }

  const fixCommitSha = matches[0] as string;

  // Step 5: only accept work that actually landed on the mainline.
  if (!(await git.isAncestorOf(fixCommitSha, landedRef))) {
    return exclude('not_merged', `${fixCommitSha.slice(0, 8)} is not an ancestor of ${landedRef}`);
  }

  // Step 4: the agent starts from the commit immediately before the fix.
  let baseCommitSha: string;
  try {
    baseCommitSha = await git.getFirstParent(fixCommitSha);
  } catch (error) {
    return exclude('no_parent', error instanceof Error ? error.message : String(error));
  }

  const changedFiles = await git.getChangedFiles(baseCommitSha, fixCommitSha);
  return { ok: true, fixCommitSha, baseCommitSha, changedFiles };
}

/**
 * Resolves and classifies every supplied task.
 *
 * @param tasks - Completed tasks to consider / 検討対象の完了タスク
 * @param git - Git port / gitポート
 * @param landedRef - Ref the fix must have landed on / 取り込み先ref
 * @returns Accepted candidates and the excluded ones with reasons / 採用候補と除外理由
 */
export async function collectCorpusCandidates(
  tasks: CompletedTaskRecord[],
  git: GitPort,
  landedRef: string = DEFAULT_LANDED_REF,
): Promise<CollectionResult> {
  const accepted: CorpusCandidate[] = [];
  const excluded: CorpusExclusion[] = [];

  for (const task of tasks) {
    const resolved = await resolveCommitsForTask(task, git, landedRef);
    if (!resolved.ok) {
      excluded.push(resolved.exclusion);
      continue;
    }

    const subject = await git.getSubject(resolved.fixCommitSha).catch(() => '');
    const classification = classifyTask({
      taskId: task.id,
      title: task.title,
      workflowStatus: task.workflowStatus,
      fixCommitSubject: subject.length > 0 ? subject : null,
      changedTopLevelDirs: topLevelDirs(resolved.changedFiles),
      changedFileCount: resolved.changedFiles.length,
      hasBlockedRecovery: task.hasBlockedRecovery,
    });

    if (!classification) {
      excluded.push({
        sourceTaskId: task.id,
        reason: 'unclassified',
        detail: `No category rule fired for "${task.title.slice(0, 60)}"`,
      });
      continue;
    }

    accepted.push({
      sourceTaskId: task.id,
      title: task.title,
      // NOTE: title + description ONLY. Including research/plan/verify content
      // would hand the agent the recorded solution and make fail-to-pass
      // meaningless.
      problemStatement: [task.title, task.description ?? ''].join('\n\n').trim(),
      classification,
      baseCommitSha: resolved.baseCommitSha,
      fixCommitSha: resolved.fixCommitSha,
      protectedTestFiles: resolved.changedFiles.filter(isTestFile),
    });
  }

  return { accepted, excluded };
}

/**
 * Builds the real git port, backed by `git` in `repoDir`.
 *
 * @param repoDir - Repository working directory / リポジトリの作業ディレクトリ
 * @returns A GitPort bound to that repository / そのリポジトリに束縛されたGitPort
 */
export function createGitPort(repoDir: string): GitPort {
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoDir,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  };

  return {
    async findCommitsByMessage(pattern) {
      // --fixed-strings: PR subjects and task titles routinely contain regex
      // metacharacters ([ # ( ) .) that would otherwise silently change the
      // match set.
      const out = await run([
        'log',
        '--all',
        '--fixed-strings',
        `--grep=${pattern}`,
        '--format=%H',
      ]);
      return out.length > 0 ? out.split('\n') : [];
    },
    async getSubject(sha) {
      return run(['log', '-1', '--format=%s', sha]);
    },
    async getFirstParent(sha) {
      return run(['rev-parse', `${sha}^`]);
    },
    async getChangedFiles(baseSha, headSha) {
      const out = await run(['diff', '--name-only', `${baseSha}..${headSha}`]);
      return out.length > 0 ? out.split('\n').filter((line) => line.length > 0) : [];
    },
    async isAncestorOf(sha, ref) {
      try {
        await run(['merge-base', '--is-ancestor', sha, ref]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
