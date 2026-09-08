/**
 * concern-bridge
 *
 * Orchestrates the bridge between the concern backlog (KnowledgeEntry-backed)
 * and GitHub issues: publishing a concern as an issue, importing an issue as a
 * concern, and pushing a local dismissal out as an issue close.
 * Not responsible for reading/sync of issues (see sync-webhook) — it only links.
 */

import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { createIssue, closeIssue } from './issue-operations';
import {
  getConcern,
  submitConcern,
  normalizeConcernType,
  normalizeConcernSeverity,
  type LinkedIssueRef,
} from '../memory/concern-backlog-service';
import { parseOwnerRepo, ownerRepoFromGitRemote } from './git-exec';
import { makeOwnerRepoString } from './owner-repo';

const log = createLogger('github:concern-bridge');

/** Result of a bridge mutation; `status` is the HTTP status the route should use. */
type BridgeResult<T> = ({ success: true } & T) | { success: false; status: number; error: string };

/**
 * Extracts a `<prefix>:<value>` label from a JSON labels string.
 * Used to recover the concern type/severity encoded into issue labels.
 *
 * @param labelsJson - JSON array of label strings / ラベルのJSON配列
 * @param prefix - Label prefix without the colon / コロンを除いた接頭辞
 * @returns The value after `prefix:` or undefined / `prefix:`以降の値
 */
export function labelValue(labelsJson: string, prefix: string): string | undefined {
  try {
    const labels = JSON.parse(labelsJson || '[]') as string[];
    const hit = labels.find((l) => l.startsWith(`${prefix}:`));
    return hit?.slice(prefix.length + 1);
  } catch {
    return undefined;
  }
}

/** The concern fields needed to compose a GitHub issue. */
interface ConcernIssueSource {
  id: number;
  type: string;
  severity: string;
  detail: string;
  location: string | null;
}

/**
 * Builds the issue body and labels for a concern (pure mapping).
 * type → `type:<x>`, severity → `priority:<x>`; location and a provenance
 * footer are appended to the body.
 *
 * @param concern - Concern to map / 対象の懸念
 * @param extraLabels - Extra labels to append / 追加ラベル
 * @returns Issue body + labels / Issue本文とラベル
 */
export function buildIssueContent(
  concern: ConcernIssueSource,
  extraLabels: string[] = [],
): { body: string; labels: string[] } {
  const labels = [`type:${concern.type}`, `priority:${concern.severity}`, ...extraLabels];
  let body = concern.detail;
  if (concern.location) body += `\n\n対象箇所: ${concern.location}`;
  body += `\n\n— rapitas 懸念バックログ #${concern.id} から公開`;
  return { body, labels };
}

/**
 * Publishes a concern to GitHub as a new issue and links the two.
 * Idempotent: a concern that already has a linked issue is returned as-is.
 *
 * @param concernId - Concern to publish / 公開する懸念ID
 * @param integrationId - Target repository integration / 公開先リポジトリ
 * @param extraLabels - Optional extra labels / 追加ラベル
 * @returns The linked issue ref / リンクされたIssue
 */
export async function publishConcernToIssue(
  concernId: number,
  integrationId: number,
  extraLabels?: string[],
): Promise<BridgeResult<{ issue: LinkedIssueRef }>> {
  const concern = await getConcern(concernId);
  if (!concern) return { success: false, status: 404, error: '懸念が見つかりません' };
  if (concern.linkedIssue) {
    return { success: true, issue: concern.linkedIssue };
  }

  const integration = await prisma.gitHubIntegration.findUnique({ where: { id: integrationId } });
  if (!integration) return { success: false, status: 404, error: 'リポジトリ連携が見つかりません' };

  const repo = makeOwnerRepoString(integration.ownerName, integration.repositoryName);
  const { body, labels } = buildIssueContent(concern, extraLabels ?? []);

  let issue;
  try {
    issue = await createIssue(repo, { title: concern.title, body, labels });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ concernId, repo, labels, message }, 'Failed to create GitHub issue from concern');
    return { success: false, status: 502, error: `GitHub Issue の作成に失敗しました: ${message}` };
  }

  // gh returns the state UPPERCASE (OPEN/CLOSED); store it lowercase to match
  // the sync path and the UI's open/closed filters — otherwise the freshly
  // published issue is stored as "OPEN" and the issues list (state=open) hides it.
  const state = (issue.state || '').toLowerCase();

  const saved = await prisma.gitHubIssue.upsert({
    where: { integrationId_issueNumber: { integrationId, issueNumber: issue.number } },
    update: {
      title: issue.title,
      body: issue.body,
      state,
      labels: JSON.stringify(issue.labels),
      authorLogin: issue.authorLogin,
      url: issue.url,
      linkedConcernId: concernId,
      lastSyncedAt: new Date(),
    },
    create: {
      integrationId,
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      state,
      labels: JSON.stringify(issue.labels),
      authorLogin: issue.authorLogin,
      url: issue.url,
      linkedConcernId: concernId,
      lastSyncedAt: new Date(),
    },
  });

  log.info({ concernId, issueNumber: saved.issueNumber }, 'Concern published to GitHub issue');
  return {
    success: true,
    issue: { id: saved.id, issueNumber: saved.issueNumber, url: saved.url, state: saved.state },
  };
}

/**
 * Resolve the GitHub integration (repo) a concern should publish to, from its
 * theme. A concern belongs to a theme (directly, or via its origin task), and a
 * theme maps to a repo through its `repositoryUrl` or its working directory's
 * git `origin` remote — so the target is normally determinable without asking
 * the user. As a final fallback, if exactly one repo is connected, that one is
 * used (no ambiguity). Returns null only when nothing connected can be matched.
 *
 * @param concernId - Concern id. / 懸念ID
 * @returns The matching integration id, or null. / 一致した連携ID、無ければnull
 */
export async function resolveConcernIntegration(concernId: number): Promise<{ id: number } | null> {
  const integrations = await prisma.gitHubIntegration.findMany({
    where: { isActive: true },
    select: { id: true, ownerName: true, repositoryName: true },
  });
  if (integrations.length === 0) return null;

  const concern = await getConcern(concernId);
  if (!concern) return null;

  let themeId = concern.themeId;
  if (themeId == null && concern.originTaskId != null) {
    const task = await prisma.task.findUnique({
      where: { id: concern.originTaskId },
      select: { themeId: true },
    });
    themeId = task?.themeId ?? null;
  }

  // Pin down the theme's repo: prefer the configured repositoryUrl, else read
  // the working directory's git origin (covers themes that only set a workdir).
  let ownerRepo: { owner: string; repo: string } | null = null;
  if (themeId != null) {
    const theme = await prisma.theme.findUnique({
      where: { id: themeId },
      select: { repositoryUrl: true, workingDirectory: true },
    });
    ownerRepo = parseOwnerRepo(theme?.repositoryUrl ?? null);
    if (!ownerRepo && theme?.workingDirectory) {
      ownerRepo = await ownerRepoFromGitRemote(theme.workingDirectory);
    }
  }

  if (ownerRepo) {
    // NOTE: const退避でclosure内のnarrowing有効化（letはclosure内でnarrowされない）
    const resolved = ownerRepo;
    const match = integrations.find(
      // OwnerRepo guarantees lowercase; only the DB fields need .toLowerCase()
      (i) =>
        i.ownerName.toLowerCase() === resolved.owner &&
        i.repositoryName.toLowerCase() === resolved.repo,
    );
    if (match) return { id: match.id };
  }

  // Couldn't pinpoint the repo — if only one is connected, it's unambiguous.
  if (integrations.length === 1) return { id: integrations[0].id };

  return null;
}

/**
 * Imports a synced GitHub issue into the concern backlog and links the two.
 * Idempotent: an already-linked issue returns its existing concern id.
 *
 * @param issueId - GitHubIssue row id / GitHubIssue の行ID
 * @returns The linked concern id / リンクされた懸念ID
 */
export async function importIssueAsConcern(
  issueId: number,
): Promise<BridgeResult<{ concernId: number }>> {
  const issue = await prisma.gitHubIssue.findUnique({ where: { id: issueId } });
  if (!issue) return { success: false, status: 404, error: 'Issue が見つかりません' };
  if (issue.linkedConcernId) {
    return { success: true, concernId: issue.linkedConcernId };
  }

  const filing = await submitConcern({
    title: issue.title,
    detail: issue.body?.trim() || `(GitHub Issue #${issue.issueNumber})`,
    // Recover type/severity from labels if the issue was a published concern,
    // otherwise default to a generic concern.
    type: normalizeConcernType(labelValue(issue.labels, 'type') ?? 'other'),
    severity: normalizeConcernSeverity(labelValue(issue.labels, 'priority')),
    source: 'github_issue',
    // Stable per-issue key so re-importing the same issue never duplicates.
    dedupKey: `gh-issue:${issue.id}`,
  });
  const concernId = filing.id;

  await prisma.gitHubIssue.update({ where: { id: issueId }, data: { linkedConcernId: concernId } });
  log.info({ issueId, concernId }, 'GitHub issue imported as concern');
  return { success: true, concernId };
}

/**
 * Closes the GitHub issue linked to a concern (used when the concern is
 * dismissed locally). No-op when there is no open linked issue.
 *
 * @param concernId - Dismissed concern id / 却下された懸念ID
 */
export async function closeIssueForConcern(concernId: number): Promise<void> {
  const link = await prisma.gitHubIssue.findFirst({
    where: { linkedConcernId: concernId, state: 'open' },
    include: { integration: true },
  });
  if (!link) return;
  const repo = makeOwnerRepoString(link.integration.ownerName, link.integration.repositoryName);
  try {
    await closeIssue(repo, link.issueNumber);
    await prisma.gitHubIssue.update({ where: { id: link.id }, data: { state: 'closed' } });
    log.info(
      { concernId, issueNumber: link.issueNumber },
      'Closed GitHub issue for dismissed concern',
    );
  } catch (err) {
    // Best-effort: a failed remote close must not block the local dismissal.
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ concernId, message }, 'Failed to close linked GitHub issue');
  }
}
