/**
 * auto-merge-candidates
 *
 * Finds the tasks whose open, task-linked PRs are eligible for CI-gated
 * auto-merge (or staged CI-green completion) this tick. NOT responsible for
 * evaluating checks or merging — that is the AutoMergeWatcher's job.
 */
import { existsSync } from 'node:fs';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { resolveAutomationPolicy } from './automation-policy';
import { resolveTaskForAutoMerge } from '../task/task-resolver';
import { decideTerminalState } from './auto-merge-exhaustion';
import { notify } from './auto-merge-notify';
import { resolveIntegrationId } from '../github/pr-link';
import { findScopedOpenPr } from '../github/pr-lookup';

const log = createLogger('workflow:auto-merge-candidates');

/**
 * Retry a previously `auto_merge_blocked` PR until this many blocks accumulate
 * WITHIN {@link BLOCK_RETRY_WINDOW_MS}, then back off (avoids re-notifying every
 * tick on a PR that genuinely cannot merge). Each failed merge records one more
 * block. The window matters: an ALL-TIME count permanently stranded a PR that
 * was transiently un-mergeable hours ago but is mergeable now (observed: PR #256
 * / task 316, MERGEABLE but blocked=3 from an earlier troubled period, never
 * auto-merged). Counting only recent blocks lets a now-mergeable PR recover
 * while a still-stuck PR keeps re-accumulating blocks and stays backed off —
 * until the ALL-TIME escape valve in auto-merge-exhaustion parks it for good.
 */
const MAX_BLOCK_RETRIES = 3;
/** Only `auto_merge_blocked` marks newer than this count toward the budget. */
const BLOCK_RETRY_WINDOW_MS = 30 * 60_000;

/**
 * Staged completion (RAPITAS_STAGED_COMPLETION): when ON, a task that landed via
 * a PR is NOT completed at PR creation — `pr` mode completes when the PR's CI is
 * green (no merge), `merge` mode completes when the PR is merged. The watcher
 * therefore also picks up not-yet-completed tasks (verify_done) and marks them
 * done at the right point. When OFF, only already-`done` autoMergePR tasks merge
 * (legacy behaviour), so nothing regresses.
 */
function stagedCompletionEnabled(): boolean {
  return (
    process.env.RAPITAS_STAGED_COMPLETION === 'true' ||
    process.env.RAPITAS_STAGED_COMPLETION === '1'
  );
}

/** A task whose PR is waiting on CI before auto-merge / CI-green completion. */
export interface Candidate {
  taskId: number;
  taskTitle: string;
  prNumber: number;
  baseBranch: string;
  cwd: string;
  threshold: number;
  completedAt: Date | null;
  /** `merge`: merge on CI green, then complete. `pr`: complete on CI green (no merge). */
  mode: 'merge' | 'pr';
}

/**
 * Find tasks whose linked PR is open, that opted into auto-merge, and that are
 * not terminally resolved or parked. Bounded by the (small) set of open linked PRs.
 *
 * @returns Candidates for this tick. / 今tickの候補
 */
export async function findCandidates(): Promise<Candidate[]> {
  // Two link sources. pr-link.ts sets BOTH GitHubPullRequest.linkedTaskId AND the
  // Task.githubPrId fallback, but rows pulled in by a webhook sync (or created
  // when integration resolution failed at link time) have a NULL linkedTaskId
  // while task.githubPrId is still set. The watcher used to query only
  // linkedTaskId, so those PRs were invisible and never auto-merged (observed:
  // #211-#215, all CLEAN/MERGEABLE, linkedTaskId=null but task.githubPrId set).
  const links = new Map<number, { prNumber: number; baseBranch: string | null }>();

  const openPrs = await prisma.gitHubPullRequest.findMany({
    where: { state: 'open', linkedTaskId: { not: null } },
    select: { prNumber: true, baseBranch: true, linkedTaskId: true },
  });
  for (const pr of openPrs) {
    if (pr.linkedTaskId != null && !links.has(pr.linkedTaskId)) {
      links.set(pr.linkedTaskId, { prNumber: pr.prNumber, baseBranch: pr.baseBranch });
    }
  }

  // Fallback: tasks carrying a githubPrId whose PR row is not linkedTaskId-linked.
  // Only adopt one when an OPEN local PR row for that number exists in the
  // TASK'S OWN repo — prNumber alone collides across the repos sharing this
  // table, and an unscoped lookup adopted another project's same-numbered PR
  // (observed: task 491 / tripla mis-adopting the converter repo's #7, which
  // also mis-fired the duplicate_open_prs notification).
  type PrTaskRow = {
    id: number;
    githubPrId: number | null;
    workingDirectory: string | null;
    theme: { repositoryUrl: string | null; workingDirectory: string | null } | null;
  };
  const prTasks = await prisma.task
    .findMany({
      where: { githubPrId: { not: null } },
      select: {
        id: true,
        githubPrId: true,
        workingDirectory: true,
        theme: { select: { repositoryUrl: true, workingDirectory: true } },
      },
    })
    .catch(() => [] as PrTaskRow[]);
  // Memoized per tick so resolveIntegrationId's git-subprocess fallback runs at
  // most once per distinct repo hint, not once per task (with a theme
  // repositoryUrl set it never spawns a subprocess at all).
  const integrationIdMemo = new Map<string, number | null>();
  for (const t of prTasks) {
    if (t.githubPrId == null) continue;
    const existing = links.get(t.id);
    if (existing && existing.prNumber === t.githubPrId) continue;
    const repositoryUrl = t.theme?.repositoryUrl ?? null;
    const wd = t.workingDirectory ?? t.theme?.workingDirectory ?? null;
    const memoKey = `${repositoryUrl ?? ''}|${wd ?? ''}`;
    let integrationId: number | null;
    if (integrationIdMemo.has(memoKey)) {
      integrationId = integrationIdMemo.get(memoKey) ?? null;
    } else {
      integrationId = await resolveIntegrationId(prisma, repositoryUrl, wd).catch(() => null);
      integrationIdMemo.set(memoKey, integrationId);
    }
    if (integrationId == null) {
      // Fail-closed: skipping is recoverable next tick; adopting another
      // repo's PR could feed the watcher a wrong merge target.
      log.warn(
        { taskId: t.id, prNumber: t.githubPrId },
        "[auto-merge] Could not resolve this task's GitHub integration — skipping its githubPrId fallback rather than risking another repo's same-numbered PR",
      );
      continue;
    }
    const row = await findScopedOpenPr(prisma, integrationId, t.githubPrId, {
      baseBranch: true,
    }).catch(() => null);
    if (!row) continue;
    if (existing) {
      // The task has TWO open PRs (a re-run created a fresh PR while the old one
      // stayed open — observed: task 322 with #260 AND #262). Task.githubPrId is
      // written at PR creation, so it names the LATEST PR; watch that one instead
      // of an arbitrary linkedTaskId row (which map order made the OLDER PR).
      // Notify once ever (not on the 4h cooldown) so the user can close the stale PR.
      const already = await prisma.notification
        .findFirst({ where: { type: 'duplicate_open_prs', link: `/tasks/${t.id}` } })
        .catch(() => null);
      if (!already) {
        await notify({
          taskId: t.id,
          type: 'duplicate_open_prs',
          title: '同一タスクに複数のopen PR',
          message: `タスク#${t.id} にPR #${existing.prNumber} と #${t.githubPrId} が両方openです。最新の #${t.githubPrId} を自動マージ対象にします。古い #${existing.prNumber} は手動でcloseしてください。`,
        });
      }
    }
    links.set(t.id, { prNumber: t.githubPrId, baseBranch: row.baseBranch });
  }

  const out: Candidate[] = [];
  for (const [taskId, link] of links) {
    const task = await resolveTaskForAutoMerge(taskId);
    if (!task) continue;

    const staged = stagedCompletionEnabled();
    const isCompleted = task.status === 'done' || task.status === 'completed';
    // Under staged completion the task is still in-progress at verify_done while
    // its PR's CI runs; pick those up so the watcher can complete them.
    const policy = await resolveAutomationPolicy(prisma, taskId).catch(() => null);
    const isAwaitingCi =
      (staged || policy?.autoMergePR === true) &&
      task.workflowStatus === 'verify_done' &&
      ['in-progress', 'in_progress'].includes(task.status);
    if (!isCompleted && !isAwaitingCi) continue;

    // merge mode in any era; pr mode (complete on CI green, no merge) only when
    // staged completion is enabled — otherwise pr-mode tasks already completed at
    // verify and the watcher must not touch them.
    const mode: 'merge' | 'pr' | null = policy?.autoMergePR
      ? 'merge'
      : staged && policy?.autoCreatePR
        ? 'pr'
        : null;
    if (!mode) continue;

    // gh pr checks/merge/update-branch are GitHub-API calls — they only need a
    // valid local clone (for the remote), NOT the task's own worktree. A DONE
    // task's worktree is usually already cleaned up, so its workingDirectory no
    // longer exists on disk; running gh there fails with a spawn error that
    // surfaces as "Failed to read PR checks" every tick and the PR NEVER
    // auto-merges (observed: #257/#258/#259 mergeable yet stuck; #259 merged
    // instantly by hand from the primary checkout). Pick the first directory that
    // still EXISTS: the worktree if present, else the theme's stable primary
    // checkout, else the backend's own cwd.
    const cwd = [task.workingDirectory, task.theme?.workingDirectory, process.cwd()].find(
      (d): d is string => !!d && existsSync(d),
    );
    if (!cwd) continue;

    // Terminally resolved (merged / CI-completed) or parked exhausted — skip.
    // A parked candidate is re-admitted only when its PR head commit changed.
    const terminal = await decideTerminalState(taskId, link.prNumber, cwd);
    if (terminal.skip) {
      if (terminal.kind === 'exhausted_now') {
        await notify({
          taskId,
          type: 'auto_merge_exhausted',
          title: '自動マージ停止（再試行上限）',
          message: `PR #${link.prNumber} の自動マージ再試行が上限に達したため停止しました。新しいコミットがpushされると自動で再開します。`,
        });
      }
      continue;
    }

    // Previously blocked: retry (the block may have been transient — e.g. a
    // wrong-base conflict since retargeted) until the budget is spent. Count only
    // RECENT blocks so a PR that was stuck hours ago but is mergeable now is not
    // stranded forever (see BLOCK_RETRY_WINDOW_MS).
    const blocked = await prisma.workflowTransition
      .count({
        where: {
          taskId,
          cause: 'auto_merge_blocked',
          createdAt: { gte: new Date(Date.now() - BLOCK_RETRY_WINDOW_MS) },
        },
      })
      .catch(() => 0);
    if (blocked >= MAX_BLOCK_RETRIES) continue;

    const cfg = await prisma.agentExecutionConfig
      .findUnique({ where: { taskId }, select: { mergeCommitThreshold: true } })
      .catch(() => null);

    out.push({
      taskId,
      taskTitle: task.title,
      prNumber: link.prNumber,
      // Prefer the PR's OWN synced base branch (real GitHub data); when that's
      // unavailable, fall back to the THEME's configured default branch rather
      // than a hardcoded 'develop' — themes on a different default (e.g. main)
      // would otherwise get a conflict-resolution instruction merging the wrong
      // branch. 'develop' is only the last-resort default, matching Theme's own
      // schema default so this never invents an assumption the schema doesn't.
      baseBranch: link.baseBranch || task.theme?.defaultBranch || 'develop',
      cwd,
      threshold: cfg?.mergeCommitThreshold ?? 5,
      completedAt: task.completedAt,
      mode,
    });
  }
  return out;
}
