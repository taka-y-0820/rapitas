/**
 * GitOperations — Pull Request Creation
 *
 * Creates a PR against the best available base branch, tolerant of a
 * diverged remote branch and an already-open PR for the same head.
 * Not responsible for merging or branch checkout.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../../../../config/logger';
import { runGhCommandWithBody } from '../../../../github/gh-client';
import { titleMarkersAgree } from '../../../../github/pr-ownership';
import { ghPath } from './gh-cli-path';
import { ensurePrBase } from './pr-base-guard';

// NOTE: execFile (array-args, no shell) instead of exec (shell string) — branch
// names, base branches, and other caller-controlled values are passed as
// literal argv elements, so shell metacharacters in them can't be interpreted.
const execFileAsync = promisify(execFile);
const logger = createLogger('git-operations/pr-create-ops');

// Local git reads/writes normally finish in well under a second; 60s leaves
// generous headroom while still bounding a lock-contention or auth-prompt
// hang so the implementer phase can't sit blocked past its wall-clock budget.
const GIT_OP_TIMEOUT_MS = 60_000;
// `git push` and `gh` calls hit the network; 120s gives real requests
// headroom while still bounding a hang so the phase can't stall on it.
const GIT_SLOW_OP_TIMEOUT_MS = 120_000;

/** Matches git's various "remote is ahead / you must fetch first" push errors. */
function isNonFastForwardError(message: string): boolean {
  return /non-fast-forward|\[rejected\]|fetch first|tip of your current branch is behind|Updates were rejected/i.test(
    message,
  );
}

/**
 * Push the current branch for PR creation, tolerant of a DIVERGED remote branch.
 *
 * A plain `git push -u origin <branch>` fails non-fast-forward when origin already
 * has a branch of the same name from an earlier run (common because the branch
 * namer collapses many tasks to `feature/implement-task`). Rather than
 * force-pushing — which could rewrite a still-open PR or merged history — this
 * renames the local branch to a commit-unique name and pushes that, so a PR can
 * always be created without clobbering anything.
 *
 * @param cwd - Repository / worktree directory / リポジトリ・worktree ディレクトリ
 * @param branch - The branch the agent worked on / エージェントの作業ブランチ
 * @returns The branch name actually pushed (renamed on divergence) / 実際に push したブランチ名
 * @throws Re-throws non-divergence push failures (auth, network, etc.). / 分岐以外の push 失敗は再送出。
 */
async function pushBranchForPr(cwd: string, branch: string): Promise<string> {
  try {
    await execFileAsync('git', ['push', '-u', 'origin', branch], {
      cwd,
      timeout: GIT_SLOW_OP_TIMEOUT_MS,
    });
    return branch;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!isNonFastForwardError(msg)) throw error;

    const { stdout: sha } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      timeout: GIT_OP_TIMEOUT_MS,
    });
    const unique = `${branch}-${sha.trim()}`;
    logger.warn(
      `[createPullRequest] origin/${branch} has diverged; pushing unique branch ${unique} instead`,
    );
    // Rename the local branch so HEAD (and gh's inferred PR head) match the push.
    await execFileAsync('git', ['branch', '-M', unique], { cwd, timeout: GIT_OP_TIMEOUT_MS });
    try {
      await execFileAsync('git', ['push', '-u', 'origin', unique], {
        cwd,
        timeout: GIT_SLOW_OP_TIMEOUT_MS,
      });
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      if (!isNonFastForwardError(msg2)) throw err2;
      // The commit-unique branch also diverged — it is tied to THIS exact commit,
      // so a lease-guarded force can only restore identical work.
      await execFileAsync('git', ['push', '-u', '--force-with-lease', 'origin', unique], {
        cwd,
        timeout: GIT_SLOW_OP_TIMEOUT_MS,
      });
    }
    return unique;
  }
}

/**
 * Prefix of the `error` string returned when the branch's existing open PR fails
 * the task-identity check. Callers reached through re-declared narrow return
 * types (`git-operations/index.ts` / `agent-orchestrator.ts` expose only
 * `{success,prUrl,prNumber,error}`) detect the mismatch via
 * `error?.startsWith(FOREIGN_PR_ERROR_PREFIX)` — a deliberate string channel so
 * those type annotations need not widen.
 */
export const FOREIGN_PR_ERROR_PREFIX = 'PR_IDENTITY_MISMATCH:';

/** Result of {@link createPullRequest}. */
export interface CreatePullRequestResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  /**
   * Set when the head branch's existing open PR belongs to ANOTHER task
   * (task-identity marker mismatch) — the PR that was found but refused.
   * / ブランチ上の既存PRが他タスクのものだった場合の検出情報
   */
  foreignPrDetected?: { prNumber: number; prUrl: string };
}

/**
 * Create a pull request targeting the best available base branch.
 * Automatically determines base branch (prefer develop, fallback to main/master) if not specified.
 *
 * @param workingDirectory - Repository directory / リポジトリのディレクトリ
 * @param title - PR title / PRのタイトル
 * @param body - PR description / PRの説明
 * @param baseBranch - Override base branch; auto-detected if omitted / ベースブランチ（省略時は自動検出）
 * @param headBranch - Head branch for the PR; falls back to the checked-out branch if omitted / PRのheadブランチ（省略時はチェックアウト中のブランチ）
 * @param draft - Create as a draft PR (verification verdict 'unknown'); default false / draft PRとして作成するか
 * @returns Result with success flag, PR URL, and PR number / 成功フラグ・PR URL・PR番号を含む結果
 */
export async function createPullRequest(
  workingDirectory: string,
  title: string,
  body: string,
  baseBranch?: string,
  headBranch?: string,
  draft = false,
): Promise<CreatePullRequestResult> {
  try {
    // Check the REMOTE-tracking ref (origin/<b>) as well as a local branch:
    // `gh pr create --base` targets the remote, and in many checkouts `develop`
    // exists ONLY as `origin/develop` (no local branch). The old local-only
    // check then fell through to main — the recurring #170/#172 mistarget where
    // the PR diff shows main instead of develop until manually retargeted.
    const branchExists = async (b: string): Promise<boolean> => {
      const local = await execFileAsync('git', ['branch', '--list', b], {
        cwd: workingDirectory,
        encoding: 'utf8',
        timeout: GIT_OP_TIMEOUT_MS,
      })
        .then((r) => !!r.stdout.trim())
        .catch(() => false);
      if (local) return true;
      return await execFileAsync('git', ['branch', '-r', '--list', `origin/${b}`], {
        cwd: workingDirectory,
        encoding: 'utf8',
        timeout: GIT_OP_TIMEOUT_MS,
      })
        .then((r) => !!r.stdout.trim())
        .catch(() => false);
    };

    let targetBranch = baseBranch;
    // A caller-supplied base (typically theme.defaultBranch) may not exist in
    // THIS repo — themes default to 'develop' but external repos often only
    // have main/master. gh then fails with "Base sha can't be blank / No
    // commits between develop and X" (task 485). Validate and fall back to
    // auto-detection instead of passing a nonexistent base through.
    if (targetBranch && !(await branchExists(targetBranch))) {
      logger.warn(
        `[createPullRequest] Requested base branch "${targetBranch}" not found (local or origin) — falling back to auto-detection`,
      );
      targetBranch = undefined;
    }
    if (!targetBranch) {
      // Prefer develop, then main, then master.
      if (await branchExists('develop')) targetBranch = 'develop';
      else if (await branchExists('main')) targetBranch = 'main';
      else targetBranch = 'master';
      logger.info(`[createPullRequest] Auto-determined base branch: ${targetBranch}`);
    }

    // Resolve the PR head. The caller-supplied headBranch (the session's
    // branchName) takes priority: `git branch --show-current` reads the RAW
    // checkout state of gitCwd, which can be the base branch itself when the
    // worktree is gone and git ops fell back to a shared checkout (task 594:
    // head resolved to "develop" while the session branch was pushed fine).
    let resolvedHead = headBranch?.trim();
    if (!resolvedHead) {
      const { stdout: currentBranchRaw } = await execFileAsync(
        'git',
        ['branch', '--show-current'],
        {
          cwd: workingDirectory,
          encoding: 'utf8',
          timeout: GIT_OP_TIMEOUT_MS,
        },
      );
      resolvedHead = currentBranchRaw.trim();
    }

    // head==base can never form a valid PR — refuse BEFORE push/gh so the
    // failure is explicit and no remote call is wasted. NOTE: this message must
    // NOT match isNoChangeCompletion's patterns ("no commits between" etc.),
    // or a task WITH real changes would be wrongly completed without a PR.
    if (resolvedHead === targetBranch) {
      const error = `head branch and base branch are both "${targetBranch}" — refusing to create a PR (head resolution likely fell back to the base checkout)`;
      logger.error(`[createPullRequest] ${error}`);
      return { success: false, error };
    }

    // Push the work. If origin's branch has DIVERGED (a stale branch left by a
    // prior run — the AI/fallback namer collapses many Japanese-titled tasks to
    // the shared `feature/implement-task`, so collisions are common), this falls
    // back to a fresh uniquely-named branch instead of failing the whole PR step.
    const currentBranch = await pushBranchForPr(workingDirectory, resolvedHead);

    // Idempotent: a CI-repair re-run pushes a fix to the SAME branch. The push
    // above already updated any existing PR, so reuse it instead of letting
    // `gh pr create` fail with "a pull request already exists".
    try {
      const { stdout: existing } = await execFileAsync(
        ghPath(),
        [
          'pr',
          'list',
          '--head',
          currentBranch,
          '--state',
          'open',
          '--json',
          'number,url,baseRefName,title',
          '--jq',
          '.[0]',
        ],
        { cwd: workingDirectory, encoding: 'utf8', timeout: GIT_SLOW_OP_TIMEOUT_MS },
      );
      const trimmed = existing.trim();
      if (trimmed && trimmed !== 'null') {
        const pr = JSON.parse(trimmed) as {
          number?: number;
          url?: string;
          baseRefName?: string;
          title?: string;
        };
        if (pr.number && pr.url) {
          // Task-identity gate: a branch-name match alone is NOT ownership — a
          // stale same-named branch can carry ANOTHER task's open PR (the
          // 2026-08-07 incident where task 539 adopted task 538's PR #340 and
          // ci_repair then spun on the wrong task). Refuse to reuse unless the
          // `[Task-{id}]`/`[#{id}]` markers agree. No `gh pr create` fallback:
          // GitHub forbids a second open PR for the same head→base, so creating
          // would just burn an API call and fail.
          if (!titleMarkersAgree(title, pr.title)) {
            logger.warn(
              `[createPullRequest] Open PR #${pr.number} on ${currentBranch} (title: ${JSON.stringify(pr.title ?? null)}) does not carry this task's marker — refusing to adopt it`,
            );
            return {
              success: false,
              error: `${FOREIGN_PR_ERROR_PREFIX} branch ${currentBranch} already has open PR #${pr.number} that does not belong to this task`,
              foreignPrDetected: { prNumber: pr.number, prUrl: pr.url },
            };
          }
          // A reused PR may have been opened against the WRONG base by an earlier
          // run (e.g. main instead of the theme's develop — the recurring #170/#172
          // mistarget). Retarget to the intended base so completion lands on the
          // right branch. Best-effort: a retarget failure still reuses the PR.
          if (pr.baseRefName && pr.baseRefName !== targetBranch) {
            try {
              await execFileAsync(
                ghPath(),
                ['pr', 'edit', String(pr.number), '--base', targetBranch],
                {
                  cwd: workingDirectory,
                  encoding: 'utf8',
                  timeout: GIT_SLOW_OP_TIMEOUT_MS,
                },
              );
              logger.info(
                `[createPullRequest] Retargeted reused PR #${pr.number} base ${pr.baseRefName} -> ${targetBranch}`,
              );
            } catch (err) {
              logger.warn(
                { err, prNumber: pr.number },
                `[createPullRequest] Failed to retarget PR #${pr.number} base to ${targetBranch}`,
              );
            }
          }
          logger.info(`[createPullRequest] Reusing existing PR #${pr.number} for ${currentBranch}`);
          return { success: true, prUrl: pr.url, prNumber: pr.number };
        }
      }
    } catch {
      // No existing PR (or gh error) — fall through to create.
    }

    // NOTE: runGhCommandWithBody passes body via --body-file, bypassing the
    // Windows command-line length limit (~32 KB) and shell-quoting hazards.
    // `--head` is explicit so gh never infers the head from gitCwd's raw
    // checkout state (the reuse check above already passes --head; this makes
    // creation consistent with it).
    const prUrl = await runGhCommandWithBody(
      [
        'pr',
        'create',
        '--title',
        title,
        '--base',
        targetBranch,
        '--head',
        currentBranch,
        ...(draft ? ['--draft'] : []),
      ],
      body,
      workingDirectory,
    );
    const prMatch = prUrl.match(/\/pull\/(\d+)/);

    if (!prMatch?.[1]) {
      return { success: false, error: 'Failed to parse PR number from URL' };
    }

    const prNumber = parseInt(prMatch[1], 10);
    // Defensive: `gh pr create --base X` has been observed opening the PR against
    // the repo default (main) instead of X — notably when the head branch name was
    // reused and its previous PR had merged to main. Read the actual base back and
    // force-retarget if it drifted, so PRs always land on the intended branch.
    await ensurePrBase(workingDirectory, prNumber, targetBranch);
    logger.info(`[createPullRequest] Created PR #${prNumber} to ${targetBranch}: ${prUrl}`);
    return { success: true, prUrl, prNumber };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
