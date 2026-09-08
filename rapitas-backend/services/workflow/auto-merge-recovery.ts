/**
 * auto-merge-recovery
 *
 * Recovers tasks whose PR is ALREADY merged on GitHub but whose local
 * completion write never landed (a lost CAS, a DB error, a crash between the
 * merge and the completion). `findCandidates` walks only OPEN PRs, so once the
 * PR closes such a task can never be rediscovered there — this is the path that
 * finds it.
 * Not responsible for merging anything: it never calls a mutating gh command,
 * and it completes a task only on GitHub's own MERGED verdict.
 */
import { existsSync } from 'node:fs';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { recordTransition } from './transition-recorder';
import { resolveAutomationPolicy } from './automation-policy';
import { canContinueAutoMerge } from './auto-merge-task-guard';
import { notify } from './auto-merge-notify';
import { resolveIntegrationId } from '../github/pr-link';
import { readAuthoritativeMergeState } from '../agents/orchestrator/git-operations/pr/pr-merge-ops';

const log = createLogger('workflow:auto-merge-recovery');

/**
 * Upper bound on tasks inspected per tick. The held set ("verified, PR on
 * record, merge outstanding") is normally single-digit; the cap only stops a
 * pathological backlog from issuing an unbounded number of `gh` calls in one
 * tick. Anything skipped is picked up by the next tick.
 */
const MAX_RECOVERY_SCAN = 50;

/** A task parked at verify_done whose recorded PR may already be merged. */
type HeldTask = {
  id: number;
  githubPrId: number | null;
  workingDirectory: string | null;
  theme: { repositoryUrl: string | null; workingDirectory: string | null } | null;
};

/**
 * Pick a directory that still exists on disk to run the read-only `gh` call in.
 * A held task's worktree may already have been cleaned up, so fall back to the
 * theme's stable checkout and finally the backend's own cwd.
 *
 * @param t - Held task with its directory hints. / ディレクトリ候補を持つ保留タスク
 * @returns An existing directory, or null. / 実在するディレクトリ（無ければ null）
 */
function resolveCwd(t: HeldTask): string | null {
  return (
    [t.workingDirectory, t.theme?.workingDirectory, process.cwd()].find(
      (d): d is string => !!d && existsSync(d),
    ) ?? null
  );
}

/**
 * Complete one held task when — and only when — GitHub reports its PR merged.
 *
 * @param t - Held task to evaluate. / 評価対象の保留タスク
 * @returns True when this task was completed here. / 完了させた場合 true
 */
async function recoverOne(t: HeldTask): Promise<boolean> {
  const prNumber = t.githubPrId;
  if (prNumber == null) return false;

  // Only a REQUESTED merge is recoverable this way. Without autoMergePR the
  // task's completion point is elsewhere and a merged PR proves nothing here.
  const policy = await resolveAutomationPolicy(prisma, t.id).catch(() => null);
  if (policy?.autoMergePR !== true) return false;

  const cwd = resolveCwd(t);
  if (!cwd) return false;

  // Repository scoping is mandatory: prNumber collides across the repos sharing
  // the GitHubPullRequest table, and completing a task from ANOTHER project's
  // same-numbered merged PR would be a silent false completion.
  const integrationId = await resolveIntegrationId(
    prisma,
    t.theme?.repositoryUrl ?? null,
    t.workingDirectory ?? t.theme?.workingDirectory ?? null,
  ).catch(() => null);
  if (integrationId == null) {
    log.warn(
      { taskId: t.id, prNumber },
      "[auto-merge-recovery] Could not resolve this task's GitHub integration — skipping rather than risking another repo's same-numbered PR",
    );
    return false;
  }
  const scopedPr = await prisma.gitHubPullRequest
    .findFirst({
      where: { integrationId, prNumber },
      select: {
        id: true,
        baseBranch: true,
        linkedTaskId: true,
        integration: { select: { ownerName: true, repositoryName: true } },
      },
    })
    .catch(() => null);
  if (!scopedPr) return false;
  if (
    scopedPr.linkedTaskId !== t.id ||
    !scopedPr.baseBranch ||
    !scopedPr.integration?.ownerName ||
    !scopedPr.integration.repositoryName
  )
    return false;
  const repository = `${scopedPr.integration.ownerName}/${scopedPr.integration.repositoryName}`;

  // GitHub is the ONLY authority for "merged". A local row, a log line, or a
  // saved verify.md are not evidence (task 895).
  const remote = await readAuthoritativeMergeState(cwd, prNumber, repository);
  if (
    !remote ||
    remote.number !== prNumber ||
    remote.state !== 'MERGED' ||
    remote.baseRefName !== scopedPr.baseBranch ||
    typeof remote.mergedAt !== 'string' ||
    !Number.isFinite(Date.parse(remote.mergedAt))
  ) {
    return false;
  }

  // Re-read the stop intent AFTER the network call: a task stopped meanwhile
  // must not be completed, even though its PR did land.
  if (!(await canContinueAutoMerge(t.id))) return false;

  // Conditional write. Losing this race (a concurrent path completed it, a new
  // run moved the task on, the PR pointer changed) is a no-op, never an
  // overwrite of the newer state.
  const completed = await prisma.task
    .updateMany({
      where: {
        id: t.id,
        githubPrId: prNumber,
        workflowStatus: 'verify_done',
        status: { in: ['in-progress', 'in_progress'] },
      },
      data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
    })
    .catch((err) => {
      log.warn({ err, taskId: t.id }, '[auto-merge-recovery] Completion write failed');
      return { count: 0 };
    });
  if (completed.count === 0) return false;

  await prisma.gitHubPullRequest
    .updateMany({
      where: { integrationId, prNumber, state: 'open' },
      data: { state: 'merged', updatedAt: new Date() },
    })
    .catch(() => {});

  await recordTransition({
    taskId: t.id,
    fromStatus: 'verify_done',
    toStatus: 'completed',
    actor: 'system',
    cause: 'auto_merge_recovered',
    phase: 'verify',
    metadata: { prNumber, mergedAt: remote.mergedAt, baseRefName: remote.baseRefName },
  }).catch(() => {});

  await notify({
    taskId: t.id,
    type: 'auto_merge_success',
    title: '自動マージ完了',
    message: `PR #${prNumber} は既にマージ済みでしたが、タスクの完了記録が残っていませんでした。GitHub の MERGED 状態を確認のうえ完了にしました。`,
  }).catch(() => {});

  log.warn(
    { taskId: t.id, prNumber, mergedAt: remote.mergedAt },
    '[auto-merge-recovery] PR was already merged on GitHub but the task was still held — completed from the authoritative merge state',
  );
  return true;
}

/**
 * Scan tasks held at verify_done with a recorded PR and complete the ones whose
 * PR GitHub already merged.
 *
 * @returns IDs of the tasks completed by this pass. / 今回完了させたタスクID
 */
export async function recoverMergedTasks(): Promise<number[]> {
  const held = await prisma.task
    .findMany({
      where: {
        workflowStatus: 'verify_done',
        status: { in: ['in-progress', 'in_progress'] },
        githubPrId: { not: null },
      },
      select: {
        id: true,
        githubPrId: true,
        workingDirectory: true,
        theme: { select: { repositoryUrl: true, workingDirectory: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: MAX_RECOVERY_SCAN,
    })
    .catch((err) => {
      log.warn({ err }, '[auto-merge-recovery] Held-task scan failed');
      return [] as HeldTask[];
    });

  const recovered: number[] = [];
  for (const t of held) {
    try {
      if (await recoverOne(t)) recovered.push(t.id);
    } catch (err) {
      log.warn({ err, taskId: t.id }, '[auto-merge-recovery] Recovery attempt failed');
    }
  }
  return recovered;
}
