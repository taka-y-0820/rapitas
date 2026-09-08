/**
 * PrePrBaseSync
 *
 * Merges the up-to-date base branch (origin/<base>) into the task's own
 * worktree branch RIGHT BEFORE the auto-PR is created, so drift against base is
 * caught while the task's context is still at hand instead of surfacing later
 * as a post-merge conflict task (task 573: PRs #338/#358/#363 all conflicted
 * because each branched from a stale develop). Real conflicts are resolved
 * in-place by a single bounded aux-AI call; unresolvable ones abort the merge
 * and the caller withholds PR creation.
 * Not responsible for commit/push/PR execution — see workflow-auto-commit.ts.
 */
import { createLogger } from '../../config/logger';
import type { VerificationVerdict } from '../agents/verification/automated-verifier';

const log = createLogger('workflow:pre-pr-base-sync');

/** Terminal classification of one base-sync attempt. */
export type BaseSyncStatus =
  | 'skipped' // infra failure (fetch/merge setup, or conflict-resolver CLI unavailable) — fail-open, PR proceeds
  | 'clean' // base merged cleanly (or already up to date); re-verify OK when needed
  | 'resolved' // real conflicts resolved by the injected resolver; re-verify OK
  | 'conflict_unresolved' // conflicts remain — merge aborted, PR must be withheld
  | 'reverify_failed'; // merge landed but lint/typecheck re-verification failed

export interface BaseSyncResult {
  status: BaseSyncStatus;
  /** Files the merge changed on the branch (0 = already up to date). */
  changedFiles: number;
  /** Conflicting files when the merge stopped on content conflicts. */
  conflicts: string[];
  /** Human-readable detail (kept OUT of completion-classification error blobs). */
  detail: string;
  /** Re-verification verdict, set only when a re-verify actually ran. */
  verdict?: VerificationVerdict;
}

/** Injected side-effect boundary — production defaults live in this module. */
export interface BaseSyncDeps {
  /** Run a git command in a cwd and return trimmed stdout (throws on non-zero). */
  runGit: (args: string[], cwd: string, opts?: { skipLog?: boolean }) => Promise<string>;
  /** Resolve the listed conflicted files in-place; true = resolved & committed. */
  resolveConflicts: (p: {
    gitCwd: string;
    taskId: number;
    baseBranch: string;
    conflicts: string[];
  }) => Promise<boolean>;
  /** Lightweight lint/typecheck re-verification; ok = gate open, verdict = three-way result. */
  runVerify: (
    taskId: number,
    gitCwd: string,
    sessionId?: number,
  ) => Promise<{ ok: boolean; verdict: VerificationVerdict }>;
}

/** Build the production deps (lazy imports keep the test module graph light). */
async function defaultDeps(): Promise<BaseSyncDeps> {
  const { runGitCommand } = await import('../github/git-exec');
  return {
    runGit: (args, cwd, opts) => runGitCommand(args, cwd, opts),
    resolveConflicts: resolveConflictsWithAuxCli,
    runVerify: async (taskId, gitCwd, sessionId) => {
      const { runVerificationGate } = await import('../agents/verification/verification-gate');
      const gate = await runVerificationGate(taskId, gitCwd, sessionId);
      return { ok: gate.ok, verdict: gate.verdict };
    },
  };
}

// Bounded prompt size for the aux-CLI conflict resolution. Beyond this the
// one-shot text model cannot reliably reproduce full files — fail over to the
// unresolved path (conflict task / manual) instead of risking a mangled merge.
const MAX_CONFLICT_PROMPT_CHARS = 160_000;

/** Delimiters the aux CLI must echo around each resolved file. */
const FILE_BLOCK_RE = /<<<RAPITAS_FILE:\s*(.+?)\s*>>>\r?\n([\s\S]*?)<<<RAPITAS_FILE_END>>>/g;

/**
 * Default conflict resolver: one bounded aux-AI call (subscription CLI via
 * sendAIMessage — never a raw paid-API hit) that receives every conflicted
 * file's markered content plus the task title, and must return each file's
 * fully resolved content in delimited blocks. On success the files are written
 * back, staged, and the merge is concluded non-interactively. Re-throws when
 * the aux CLI itself is unavailable (`ClaudeCliUnavailableError` — timeout,
 * spawn failure, or a CLI-reported error) so the caller can fail open instead
 * of treating an infra outage as an unresolvable content conflict. All other
 * failures (missing/markered file, git operation failure) return false.
 *
 * @param p - Worktree cwd, task id, base branch and conflicted files / 対象情報
 * @returns True when every conflict was resolved and the merge was committed / 解消成否
 */
export async function resolveConflictsWithAuxCli(p: {
  gitCwd: string;
  taskId: number;
  baseBranch: string;
  conflicts: string[];
}): Promise<boolean> {
  try {
    const { getAuxAiMode, sendAIMessage } = await import('../../utils/ai-client');
    if (getAuxAiMode() === 'off') {
      log.warn({ taskId: p.taskId }, '[base-sync] aux AI disabled — cannot auto-resolve conflicts');
      return false;
    }

    const { readFile, writeFile } = await import('fs/promises');
    const { join } = await import('path');

    const sections: string[] = [];
    for (const file of p.conflicts) {
      const content = await readFile(join(p.gitCwd, file), 'utf8');
      sections.push(`<<<RAPITAS_FILE: ${file}>>>\n${content}\n<<<RAPITAS_FILE_END>>>`);
    }
    const filesBlock = sections.join('\n\n');
    if (filesBlock.length > MAX_CONFLICT_PROMPT_CHARS) {
      log.warn(
        { taskId: p.taskId, chars: filesBlock.length },
        '[base-sync] conflicted content too large for bounded aux resolution',
      );
      return false;
    }

    // Task context so the resolver keeps THIS task's intent when merging.
    let taskTitle = '';
    try {
      const { prisma } = await import('../../config');
      const task = await prisma.task.findUnique({
        where: { id: p.taskId },
        select: { title: true },
      });
      taskTitle = task?.title ?? '';
    } catch {
      // Context is best-effort — resolution can proceed without the title.
    }

    const systemPrompt = [
      'You are resolving git merge conflicts inside a feature branch worktree.',
      `The branch implements task #${p.taskId}${taskTitle ? ` (${taskTitle})` : ''}; the base branch "${p.baseBranch}" was just merged in and left conflict markers.`,
      "Resolve EVERY file below by integrating BOTH sides: keep the base branch changes AND this task's changes (both are additive features unless they are true alternatives).",
      'Return each file COMPLETE (full content, not a diff), wrapped EXACTLY as:',
      '<<<RAPITAS_FILE: relative/path>>>',
      '...full resolved file content...',
      '<<<RAPITAS_FILE_END>>>',
      'No conflict markers (<<<<<<<, =======, >>>>>>>) may remain. Output ONLY the file blocks.',
    ].join('\n');

    const response = await sendAIMessage({
      // Sonnet only on the CLI path — the paid-API path needs a full model id,
      // so leave it to its default there.
      model: getAuxAiMode() === 'cli' ? 'sonnet' : undefined,
      messages: [{ role: 'user', content: filesBlock }],
      systemPrompt,
      maxTokens: 32_000,
    });

    const resolved = new Map<string, string>();
    for (const m of response.content.matchAll(FILE_BLOCK_RE)) {
      resolved.set(m[1].replace(/\\/g, '/'), m[2]);
    }
    for (const file of p.conflicts) {
      const content = resolved.get(file.replace(/\\/g, '/'));
      if (content === undefined || /^(<{7}|={7}|>{7})/m.test(content)) {
        log.warn({ taskId: p.taskId, file }, '[base-sync] aux resolution missing/markered file');
        return false;
      }
      await writeFile(join(p.gitCwd, file), content, 'utf8');
    }

    const { runGitCommand } = await import('../github/git-exec');
    await runGitCommand(['add', '-A'], p.gitCwd);
    // core.editor=true keeps `merge --continue` non-interactive (it otherwise
    // opens an editor for the merge commit message). skipLog suppresses the
    // generic runGitCommand ERROR log — a failure here is fully handled by
    // the catch below (log.warn at line ~176), same rationale as the
    // merge --abort calls in syncBaseIntoBranch (task 689).
    await runGitCommand(['-c', 'core.editor=true', 'merge', '--continue'], p.gitCwd, {
      skipLog: true,
    });
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ClaudeCliUnavailableError') {
      log.warn(
        { err, taskId: p.taskId },
        '[base-sync] aux CLI unavailable — propagating for fail-open classification',
      );
      throw err;
    }
    log.warn({ err, taskId: p.taskId }, '[base-sync] aux conflict resolution failed');
    return false;
  }
}

/** Count the files the (now committed) merge changed on the branch. */
async function countMergeChangedFiles(
  runGit: BaseSyncDeps['runGit'],
  cwd: string,
): Promise<number> {
  try {
    const out = await runGit(['diff', '--name-only', 'ORIG_HEAD..HEAD'], cwd);
    return out.split('\n').filter((s) => s.trim().length > 0).length;
  } catch {
    // Unknown count — report 1 so the caller still re-verifies (conservative).
    return 1;
  }
}

/**
 * Fetch origin/<base> and merge it into the task worktree's current branch
 * before PR creation. Never throws — every outcome is a discriminated
 * {@link BaseSyncResult} so the shared auto-PR path can fail open on infra
 * errors and fail closed only on real conflicts / re-verification failures.
 *
 * @param p - gitCwd (task worktree), base branch, task id, optional session id and dep overrides / 入力一式
 * @returns Discriminated sync outcome / 取り込み結果
 */
export async function syncBaseIntoBranch(p: {
  gitCwd: string;
  baseBranch: string;
  taskId: number;
  sessionId?: number;
  deps?: Partial<BaseSyncDeps>;
}): Promise<BaseSyncResult> {
  // Skip building production defaults when every dep is injected (tests) so
  // the git/verification module graphs never load under bun test.
  const fullyInjected = p.deps?.runGit && p.deps?.resolveConflicts && p.deps?.runVerify;
  const deps: BaseSyncDeps = fullyInjected
    ? (p.deps as BaseSyncDeps)
    : { ...(await defaultDeps()), ...p.deps };

  // 1. Fetch the base. Infra failure (offline, missing remote/branch) must not
  //    block PR creation for every task — fail open.
  try {
    await deps.runGit(['fetch', 'origin', p.baseBranch], p.gitCwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ taskId: p.taskId, message }, '[base-sync] fetch failed — skipping base sync');
    return { status: 'skipped', changedFiles: 0, conflicts: [], detail: `fetch失敗: ${message}` };
  }

  // 2. Merge origin/<base> into the current (task) branch. skipLog suppresses
  //    the generic runGitCommand ERROR log — merge failures (conflict or
  //    otherwise) are fully handled below with our own warn/info logs, same
  //    rationale as the merge --abort calls further down (task 689).
  let mergeStdout: string;
  try {
    mergeStdout = await deps.runGit(['merge', `origin/${p.baseBranch}`, '--no-edit'], p.gitCwd, {
      skipLog: true,
    });
  } catch {
    // Merge stopped — collect the conflicting files.
    let conflicts: string[] = [];
    try {
      const out = await deps.runGit(['diff', '--name-only', '--diff-filter=U'], p.gitCwd);
      conflicts = out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // Conflict listing failed — treated as a non-content merge failure below.
    }

    if (conflicts.length === 0) {
      // Non-zero merge exit WITHOUT content conflicts (dirty tree, unrelated
      // histories, …) is an infra condition, not a resolvable competition —
      // abort best-effort and fail open like the fetch path. skipLog suppresses
      // the generic runGitCommand ERROR log (task 689: expected-failure noise);
      // a failed abort still leaves MERGE_HEAD stuck in the worktree (task 691)
      // and worktree-guard self-heals on the next git operation, so surface the
      // failure through our own warn log instead of the low-level one.
      await deps.runGit(['merge', '--abort'], p.gitCwd, { skipLog: true }).catch((err) => {
        log.warn({ taskId: p.taskId, err }, '[base-sync] merge --abort itself failed');
      });
      log.warn({ taskId: p.taskId }, '[base-sync] merge failed without conflicts — skipping');
      return {
        status: 'skipped',
        changedFiles: 0,
        conflicts: [],
        detail: 'マージが競合以外の理由で失敗したためスキップしました',
      };
    }

    log.info(
      { taskId: p.taskId, conflicts },
      '[base-sync] merge conflicts — attempting in-context resolution',
    );
    let resolvedOk = false;
    let infraUnavailableDetail: string | null = null;
    try {
      resolvedOk = await deps.resolveConflicts({
        gitCwd: p.gitCwd,
        taskId: p.taskId,
        baseBranch: p.baseBranch,
        conflicts,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'ClaudeCliUnavailableError') {
        infraUnavailableDetail = err.message;
      }
      resolvedOk = false;
    }

    if (!resolvedOk) {
      // See the "merge failed without conflicts" branch above for why skipLog
      // is combined with our own warn log on failure.
      await deps.runGit(['merge', '--abort'], p.gitCwd, { skipLog: true }).catch((err) => {
        log.warn({ taskId: p.taskId, err }, '[base-sync] merge --abort itself failed');
      });

      if (infraUnavailableDetail !== null) {
        log.warn(
          { taskId: p.taskId, conflicts, detail: infraUnavailableDetail },
          '[base-sync] conflict resolver infra unavailable — failing open',
        );
        return {
          status: 'skipped',
          changedFiles: 0,
          conflicts,
          detail: `補助AI CLIが一時的に利用できないため base 取り込みをスキップしました（${infraUnavailableDetail}）`,
        };
      }

      return {
        status: 'conflict_unresolved',
        changedFiles: 0,
        conflicts,
        detail: `origin/${p.baseBranch} とのマージ競合 ${conflicts.length} 件を自動解消できませんでした`,
      };
    }

    const changedFiles = await countMergeChangedFiles(deps.runGit, p.gitCwd);
    const { ok: verifyOk, verdict } = await deps
      .runVerify(p.taskId, p.gitCwd, p.sessionId)
      .catch(() => ({ ok: false, verdict: 'fail' as const }));
    if (!verifyOk) {
      return {
        status: 'reverify_failed',
        changedFiles,
        conflicts,
        detail: '競合解消後の lint/型 再検証に失敗しました',
        verdict,
      };
    }
    return {
      status: 'resolved',
      changedFiles,
      conflicts,
      detail: `競合 ${conflicts.length} 件を解消して origin/${p.baseBranch} を取り込みました`,
      verdict,
    };
  }

  // 3. Clean merge. "Already up to date" means no merge commit was made (and
  //    ORIG_HEAD was NOT updated) — nothing changed, no re-verification needed.
  if (/already up to date/i.test(mergeStdout)) {
    return {
      status: 'clean',
      changedFiles: 0,
      conflicts: [],
      detail: `origin/${p.baseBranch} は取り込み済みです`,
    };
  }

  const changedFiles = await countMergeChangedFiles(deps.runGit, p.gitCwd);
  if (changedFiles > 0) {
    // The base brought real file changes on top of this task's work — re-run
    // the lightweight gate so a bad interaction never reaches the PR.
    const { ok: verifyOk, verdict } = await deps
      .runVerify(p.taskId, p.gitCwd, p.sessionId)
      .catch(() => ({ ok: false, verdict: 'fail' as const }));
    if (!verifyOk) {
      return {
        status: 'reverify_failed',
        changedFiles,
        conflicts: [],
        detail: 'base取り込み後の lint/型 再検証に失敗しました',
        verdict,
      };
    }
    return {
      status: 'clean',
      changedFiles,
      conflicts: [],
      detail: `origin/${p.baseBranch} をクリーンに取り込みました（変更 ${changedFiles} ファイル）`,
      verdict,
    };
  }
  return {
    status: 'clean',
    changedFiles,
    conflicts: [],
    detail: `origin/${p.baseBranch} をクリーンに取り込みました（変更 ${changedFiles} ファイル）`,
  };
}
