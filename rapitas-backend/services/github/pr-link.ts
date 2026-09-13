/**
 * GitHub Auto-PR Linking
 *
 * Persists a PR that the workflow auto-created via `gh pr create` into the local
 * GitHubPullRequest table and links it to its task, so the "PRを開く" button can
 * resolve the task → local PR id and navigate to the PR detail page.
 * Not responsible for creating the PR on GitHub — that lives in branch-pr-ops.ts.
 */

import { PrismaClient } from '../../generated/prisma-postgres';
import { createLogger } from '../../config/logger';
import { parseOwnerRepo, ownerRepoFromGitRemote } from './git-exec';
import { verifyPrOwnership } from './pr-ownership';
import { notify } from '../workflow/auto-merge-notify';
import { updateTaskPublicationMetadata } from './task-publication-metadata';

const log = createLogger('github-service:pr-link');
type PrismaClientInstance = InstanceType<typeof PrismaClient>;

/** Parameters for {@link linkAutoCreatedPr}. */
export interface LinkAutoCreatedPrParams {
  /** Task the PR was generated for. / PRの生成元タスク */
  taskId: number;
  /** PR number parsed from `gh pr create` output. / PR番号 */
  prNumber: number;
  /** PR web URL. / PRのURL */
  prUrl: string;
  /** PR title used at creation. / PRタイトル */
  title: string;
  /** Head (feature) branch the PR was opened from. / ヘッドブランチ */
  headBranch: string;
  /** Base branch the PR targets. / ベースブランチ */
  baseBranch: string;
  /** Theme repository URL, when known, used to pick the integration. / リポジトリURL */
  repositoryUrl?: string | null;
  /** Working directory, used as a git-remote fallback for the repo identity. / 作業ディレクトリ */
  workingDirectory?: string | null;
}

/**
 * Resolve the GitHubIntegration that owns the repo behind a PR or task.
 * Prefers an owner/repo match (from the theme URL, else the git remote); falls
 * back to the sole integration when exactly one exists. Exported so any call
 * site scoping a `GitHubPullRequest` lookup by `prNumber` can also scope it by
 * repo — RAPITAS tracks multiple projects, and `prNumber` alone collides
 * across them (e.g. two different repos each having their own PR #8).
 *
 * @returns Matching integration id, or null when none can be resolved / 一致する統合ID
 */
export async function resolveIntegrationId(
  prisma: PrismaClientInstance,
  repositoryUrl: string | null | undefined,
  workingDirectory: string | null | undefined,
): Promise<number | null> {
  let ident = parseOwnerRepo(repositoryUrl);
  if (!ident && workingDirectory) {
    ident = await ownerRepoFromGitRemote(workingDirectory);
  }

  const integrations = await prisma.gitHubIntegration.findMany({
    select: { id: true, ownerName: true, repositoryName: true },
  });
  if (integrations.length === 0) return null;

  if (ident) {
    const match = integrations.find(
      (i) =>
        i.ownerName.toLowerCase() === ident.owner && i.repositoryName.toLowerCase() === ident.repo,
    );
    if (match) return match.id;
  }

  // Unambiguous when only one integration is configured (the desktop default).
  return integrations.length === 1 ? integrations[0].id : null;
}

/**
 * Persist an auto-created PR locally and link it to its task.
 *
 * Best-effort: any failure is logged and swallowed so a persistence problem
 * never aborts the task-completion flow. Sets both the direct
 * `GitHubPullRequest.linkedTaskId` link and the `Task.githubPrId` fallback the
 * by-task resolver reads.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param params - PR identity and repo hints / PRの識別情報
 * @returns Local GitHubPullRequest id, or null when it could not be persisted / ローカルPR ID
 */
export async function linkAutoCreatedPr(
  prisma: PrismaClientInstance,
  params: LinkAutoCreatedPrParams,
): Promise<number | null> {
  const { taskId, prNumber, prUrl, title, headBranch, baseBranch } = params;
  try {
    const integrationId = await resolveIntegrationId(
      prisma,
      params.repositoryUrl,
      params.workingDirectory,
    );
    if (integrationId == null) {
      log.warn(
        { taskId, prNumber },
        '[linkAutoCreatedPr] No GitHub integration resolved — PR not persisted locally; "PRを開く" will not navigate.',
      );
      return null;
    }

    // Task-identity gate (last line of defense): when a row for this PR already
    // exists — e.g. a webhook sync pulled in ANOTHER task's PR that happens to
    // share the head branch — never steal its linkedTaskId, and never claim a
    // row whose markers name a different task (or prove nothing).
    const existingRow = await prisma.gitHubPullRequest.findUnique({
      where: { integrationId_prNumber: { integrationId, prNumber } },
      select: { linkedTaskId: true, title: true, body: true },
    });
    if (existingRow) {
      const verdict = verifyPrOwnership(
        {
          linkedTaskId: existingRow.linkedTaskId,
          title: existingRow.title,
          body: existingRow.body,
        },
        taskId,
      );
      if (!verdict.canClaim) {
        log.warn(
          {
            taskId,
            prNumber,
            reason: verdict.reason,
            existingLinkedTaskId: existingRow.linkedTaskId,
          },
          '[linkAutoCreatedPr] Refusing to link PR — task identity could not be verified',
        );
        await notify({
          taskId,
          type: 'auto_pr_identity_mismatch',
          title: 'PRリンクを拒否しました',
          message: `PR #${prNumber} はタスク ${taskId} のPRと確認できないためリンクしませんでした（理由: ${verdict.reason}）。${prUrl}`,
        });
        return null;
      }
    }

    const integration = await prisma.gitHubIntegration.findUnique({
      where: { id: integrationId },
      select: { ownerName: true },
    });

    const now = new Date();
    const pr = await prisma.gitHubPullRequest.upsert({
      where: { integrationId_prNumber: { integrationId, prNumber } },
      // Link an existing row (e.g. one a prior webhook sync already pulled in)
      // without clobbering fields a real sync owns.
      update: { linkedTaskId: taskId, url: prUrl, lastSyncedAt: now },
      create: {
        integrationId,
        prNumber,
        title,
        state: 'open',
        headBranch,
        baseBranch,
        authorLogin: integration?.ownerName ?? 'rapitas-agent',
        url: prUrl,
        linkedTaskId: taskId,
        lastSyncedAt: now,
      },
      select: { id: true },
    });

    // Fallback path for the by-task resolver, and the source of truth other
    // task views read.
    if (!(await updateTaskPublicationMetadata(prisma, taskId, { githubPrId: prNumber }))) {
      throw new Error('Task changed while linking its publication metadata');
    }

    log.info({ taskId, prNumber, localPrId: pr.id }, '[linkAutoCreatedPr] PR linked to task');
    return pr.id;
  } catch (err) {
    log.error({ err, taskId, prNumber }, '[linkAutoCreatedPr] Failed to persist/link auto PR');
    return null;
  }
}
