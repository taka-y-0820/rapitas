/**
 * concern-backlog-service
 *
 * The "懸念バックログ" (Concern Backlog) — a bug/refactor/risk sibling of the
 * idea box. Agents and users file concerns spotted OUTSIDE the current task's
 * scope instead of fixing them inline; each concern can later be turned into a
 * dedicated task. Backed by KnowledgeEntry (sourceType 'concern'); metadata
 * lives in tags so no schema change is needed.
 */
import { createHash } from 'crypto';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { createTask } from '../task/task-mutations';
import { specForConcernSource } from './concern-task-spec';
import { sanitizeMarkdownContent } from '../../utils/common/mojibake-detector';
import { findSaturatedTheme, findNearDuplicate } from './theme-saturation';
import { resolveTaskThemeId, resolveDefaultThemeId } from './theme-resolution';
import { resolveFiling } from './concern-recurrence-policy';
import {
  CONCERN_TYPES,
  CONCERN_SEVERITIES,
  CONCERN_STATUSES,
  normalizeConcernType,
  normalizeConcernSeverity,
  SEVERITY_WEIGHT,
  type ConcernType,
  type ConcernSeverity,
  type ConcernStatus,
  type LinkedIssueRef,
  type ConcernEntry,
  type SubmitConcernInput,
  type ConcernFilingResult,
} from './concern-backlog-types';

// Re-exported for backward compatibility — log-health-check.ts imports
// resolveDefaultThemeId from this module.
export { resolveDefaultThemeId };

// Type/constant/normalizer re-exports — moved to concern-backlog-types.ts (#888)
// so existing importers (routes, concern-recurrence-policy.ts, the generated
// guards file) keep working unchanged.
export {
  CONCERN_TYPES,
  CONCERN_SEVERITIES,
  CONCERN_STATUSES,
  normalizeConcernType,
  normalizeConcernSeverity,
};
export type {
  ConcernType,
  ConcernSeverity,
  ConcernStatus,
  LinkedIssueRef,
  ConcernEntry,
  SubmitConcernInput,
  ConcernFilingOutcome,
  ConcernFilingReason,
  ConcernFilingResult,
} from './concern-backlog-types';

// Near-duplicate gate threshold (character-bigram Jaccard). Mirrors the idea box:
// rejects an almost-identical OPEN concern re-file (e.g. the gen/Prettier-drift
// concern filed twice) that the substring saturation gate misses when only 1-2
// copies exist. 0.45 catches clones (≥0.49) without touching distinct facets.
const CONCERN_NEARDUP_JACCARD = (() => {
  const v = parseFloat(process.env.RAPITAS_CONCERN_NEARDUP_JACCARD ?? '0.45');
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.45;
})();

// Theme-saturation additionally requires this whole-title bigram similarity so
// a single short shared token (e.g. "Codex") can no longer anchor an
// unrelated concern into the wrong theme (#888, concern #7336).
const CONCERN_SATURATION_MIN_JACCARD = (() => {
  const v = parseFloat(process.env.RAPITAS_CONCERN_SATURATION_MIN_JACCARD ?? '0.2');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.2;
})();

const log = createLogger('memory:concern-backlog');

/**
 * True when a concern id is safe to bind into a Prisma `where: { id }` clause.
 * Callers (route params, GitHub sync payloads) may pass out-of-range floats;
 * Prisma throws PrismaClientValidationError before this reaches SQLite when
 * the value doesn't fit a 64-bit signed integer, so this must be checked
 * before any `knowledgeEntry` query runs. / concernId が Prisma に渡して安全か
 *
 * @param concernId - Candidate concern id / 判定対象の懸念ID
 * @returns True when safe to query with / クエリに使って安全なら true
 */
function isValidConcernId(concernId: number): boolean {
  return Number.isSafeInteger(concernId) && concernId > 0;
}

function contentHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Task statuses meaning a concern's follow-up work has closed out. Kept in sync
 * with completed-task-cleanup's TERMINAL_SUBTASK_STATUSES.
 */
const TERMINAL_TASK_STATUSES = ['done', 'completed', 'failed', 'cancelled', 'archived'];

/**
 * Finds a LIVE concern that should dedup-block a new filing with this hash, or
 * null when none does. "Live" = still actionable: an `open` concern, or a
 * `task_created` concern whose follow-up task hasn't reached a terminal state.
 *
 * Resolved, dismissed-elsewhere by forgetting (non-active), and `task_created`
 * rows whose task already finished do NOT block: the same signature recurring
 * after its follow-up closed out is a genuine regression — e.g. a mainline
 * workflow ci_watch filed, that got fixed, then broke again — and must file a
 * fresh concern instead of being silently swallowed by the closed-out row's
 * hash. A `dismissed` row still blocks (respects the user's explicit dismiss).
 *
 * @param hash - contentHash of the concern being filed / 起票する懸念のハッシュ
 * @returns Blocking concern id, or null when a fresh filing is allowed / ブロックするID、無ければnull
 */
async function findBlockingDuplicate(hash: string): Promise<number | null> {
  // `resolved` and forgotten (forgettingStage != 'active') rows are excluded in
  // the query: they represent a closed-out problem, so a recurrence is new.
  const rows = await prisma.knowledgeEntry.findMany({
    where: {
      contentHash: hash,
      sourceType: 'concern',
      forgettingStage: 'active',
      sourceId: { not: 'resolved' },
    },
    select: { id: true, sourceId: true },
  });
  for (const row of rows) {
    const sourceId = row.sourceId ?? 'open';
    const taskMatch = sourceId.match(/^task_(\d+)$/);
    if (!taskMatch) return row.id; // 'open' or 'dismissed' → still live/blocking
    // task_created: block only while the follow-up task is still in flight. A
    // terminal (or deleted) task means the fix landed, so a recurrence re-files.
    const task = await prisma.task
      .findUnique({ where: { id: Number(taskMatch[1]) }, select: { status: true } })
      .catch(() => null);
    if (task && !TERMINAL_TASK_STATUSES.includes(task.status)) return row.id;
  }
  return null;
}

/**
 * Files a concern into the backlog. Deduplicates by `dedupKey` when provided,
 * otherwise by title+detail. The returned `outcome`/`reason` let a caller
 * tell a genuine new filing apart from a merge into an existing row or a
 * silent anti-monoculture suppression (#888) — `id` alone cannot.
 *
 * @param input - Concern details / 懸念の詳細
 * @returns The anchoring/created KnowledgeEntry id plus how it got there / ID と起票結果の内訳
 */
export async function submitConcern(input: SubmitConcernInput): Promise<ConcernFilingResult> {
  // 文字化けチェック＆修正: repair title/detail BEFORE storing so a garbled concern
  // never lands in the backlog (agent submissions over curl/files on Windows can
  // arrive mojibake'd). Only an effective fix is adopted; clean text is untouched.
  const sanTitle = sanitizeMarkdownContent(input.title);
  const sanDetail = sanitizeMarkdownContent(input.detail);
  input = { ...input, title: sanTitle.content, detail: sanDetail.content };
  if (sanTitle.wasFixed || sanDetail.wasFixed) {
    log.info(
      { issues: [...sanTitle.issues, ...sanDetail.issues] },
      '[concern-backlog] Repaired mojibake before registering concern',
    );
  }
  const type = normalizeConcernType(input.type);
  const severity = normalizeConcernSeverity(input.severity);
  // A stable dedupKey wins over title+detail so a recurring concern whose detail
  // carries volatile parts (stack traces, counts) is still filed only once.
  const hash = input.dedupKey
    ? contentHash(`concern-dedup:${input.dedupKey}`)
    : contentHash(`concern:${input.title}:${input.detail}`);

  const decision = await resolveFiling(prisma, { input, hash, severity, findBlockingDuplicate });
  if (decision.reuseId != null) {
    return {
      id: decision.reuseId,
      outcome: 'reused',
      reason: decision.reuseReason ?? 'dedup-live-duplicate',
    };
  }

  // Anti-monoculture: concerns are the bigger flood source — the agent re-files
  // near-identical "gen:type-guards / SSOT / Prettier-drift" concerns as it works
  // the same theme, and they promote to tasks FIRST. Reject a title that shares a
  // ≥8-char substring with ≥3 existing OPEN concerns (a near-dup re-file or an
  // over-covered theme). Skipped for dedupKey'd concerns (those have their own
  // stable identity, e.g. test-baseline:<file>). Returns the anchor id as a no-op.
  if (!input.dedupKey) {
    const dupId = await findNearDuplicate(
      input.title,
      { sourceType: 'concern', openConcernOnly: true },
      CONCERN_NEARDUP_JACCARD,
    );
    if (dupId != null) {
      log.info(
        { dupId, title: input.title, threshold: CONCERN_NEARDUP_JACCARD },
        '[concern-backlog] Rejected concern: near-duplicate of an existing concern (anti-monoculture)',
      );
      return { id: dupId, outcome: 'suppressed', reason: 'near-duplicate' };
    }

    const anchorId = await findSaturatedTheme(input.title, {
      sourceType: 'concern',
      cap: 3,
      // 8 chars was too high for Japanese: theme markers like "境界値テスト"(6),
      // "差分スキャン"(6), "マニフェスト"(6), "型ガード生成"(6) share only 4-6 chars,
      // so a "境界値テスト自動生成/drift検知" monoculture slipped straight through
      // (lcsLen maxed at 6 across the cluster). 5 catches those 5-6 char clusters
      // while staying above the 3-char generic words (テスト/自動/生成/CI) that must
      // NOT trip the gate. Env-tunable. (Idea gate uses SALIENT_LEN=4 / cap=8.)
      salient: Number(process.env.RAPITAS_CONCERN_SATURATION_SALIENT) || 5,
      openConcernOnly: true,
      minJaccard: CONCERN_SATURATION_MIN_JACCARD,
    });
    if (anchorId != null) {
      log.info(
        { anchorId, title: input.title },
        '[concern-backlog] Rejected concern: theme over-represented / near-duplicate (anti-monoculture)',
      );
      return { id: anchorId, outcome: 'suppressed', reason: 'theme-saturation' };
    }
  }

  // 'agent' fallback mirrors hypothesis-service's `input.source ?? 'agent'`; every
  // current caller passes source explicitly, so this only guards future direct calls.
  const tags = [`severity:${decision.severity ?? severity}`, `source:${input.source ?? 'agent'}`];
  if (input.location?.trim()) tags.push(`loc:${input.location.trim()}`);
  if (decision.extraTag) tags.push(decision.extraTag);

  // Always attribute a concern to a real theme, mirroring submitIdea's same
  // invariant (idea-box-service.ts): use the caller's themeId, else the
  // origin task's theme, else the default theme. Without this, any caller
  // that omitted themeId (whether or not it passed originTaskId) left the
  // concern permanently theme-less — invisible in theme-filtered UI, AND
  // invisible to per-theme backlog auto-promotion (listConcerns' `where.
  // themeId = themeId` never matches a null row), silently stalling forever.
  let themeId = input.themeId ?? null;
  if (themeId == null) {
    if (input.originTaskId != null) themeId = await resolveTaskThemeId(input.originTaskId);
    if (themeId == null) themeId = await resolveDefaultThemeId();
  }

  const entry = await prisma.knowledgeEntry.create({
    data: {
      sourceType: 'concern',
      // sourceId encodes the lifecycle status ('open' | 'task_<id>' | 'dismissed').
      sourceId: 'open',
      title: input.title,
      content: decision.detail ?? input.detail,
      contentHash: hash,
      // category holds the type so getConcernStats can group by it.
      category: type,
      tags: JSON.stringify(tags),
      confidence: SEVERITY_WEIGHT[decision.severity ?? severity],
      themeId,
      taskId: input.originTaskId ?? null,
      forgettingStage: 'active',
      decayScore: 1.0,
      validationStatus: 'pending',
    },
  });

  log.info(
    {
      id: entry.id,
      type,
      severity: decision.severity ?? severity,
      themeId,
      originTaskId: input.originTaskId,
      source: input.source,
    },
    'Concern filed',
  );
  return {
    id: entry.id,
    outcome: 'created',
    reason: decision.detail != null ? 'recurrence-of-done' : 'new',
  };
}

interface ConcernRow {
  id: number;
  title: string;
  content: string;
  category: string;
  tags: string;
  sourceId: string | null;
  themeId: number | null;
  taskId: number | null;
  createdAt: Date;
}

/** Maps a KnowledgeEntry row to a ConcernEntry. */
function toConcernEntry(entry: ConcernRow): ConcernEntry {
  const parsedTags = JSON.parse(entry.tags || '[]') as string[];
  const severityTag = parsedTags.find((t) => t.startsWith('severity:'));
  const locTag = parsedTags.find((t) => t.startsWith('loc:'));
  const sourceTag = parsedTags.find((t) => t.startsWith('source:'));
  const sourceId = entry.sourceId ?? 'open';
  const taskMatch = sourceId.match(/^task_(\d+)$/);
  const status: ConcernStatus = taskMatch
    ? 'task_created'
    : sourceId === 'dismissed'
      ? 'dismissed'
      : sourceId === 'resolved'
        ? 'resolved'
        : 'open';
  return {
    id: entry.id,
    title: entry.title,
    detail: entry.content,
    type: normalizeConcernType(entry.category),
    severity: normalizeConcernSeverity(severityTag?.slice('severity:'.length)),
    location: locTag ? locTag.slice('loc:'.length) : null,
    status,
    // Pre-source rows can't be attributed after the fact — 'unknown', not 'agent'.
    source: sourceTag ? sourceTag.slice('source:'.length) : 'unknown',
    originTaskId: entry.taskId,
    createdTaskId: taskMatch ? parseInt(taskMatch[1]) : null,
    themeId: entry.themeId,
    createdAt: entry.createdAt,
  };
}

const CONCERN_SELECT = {
  id: true,
  title: true,
  content: true,
  category: true,
  tags: true,
  sourceId: true,
  themeId: true,
  taskId: true,
  createdAt: true,
} as const;

/**
 * Looks up the GitHub issues linked to the given concern ids and returns a
 * map keyed by concern id, so concern lists can show a publish badge.
 *
 * @param concernIds - Concern ids to resolve links for / 対象の懸念ID
 * @returns Map of concernId → linked issue / 懸念ID→リンクIssue のマップ
 */
async function fetchLinkedIssues(concernIds: number[]): Promise<Map<number, LinkedIssueRef>> {
  const map = new Map<number, LinkedIssueRef>();
  if (concernIds.length === 0) return map;
  const issues = await prisma.gitHubIssue.findMany({
    where: { linkedConcernId: { in: concernIds } },
    select: { id: true, issueNumber: true, url: true, state: true, linkedConcernId: true },
  });
  for (const issue of issues) {
    if (issue.linkedConcernId == null) continue;
    map.set(issue.linkedConcernId, {
      id: issue.id,
      issueNumber: issue.issueNumber,
      url: issue.url,
      state: issue.state,
    });
  }
  return map;
}

/**
 * Lists concerns with optional filtering and pagination.
 *
 * @param options - Filters (status/type/theme) + pagination / フィルタ・ページング
 * @returns Concerns and total count / 懸念リストと総数
 */
export async function listConcerns(options: {
  status?: ConcernStatus | 'all';
  type?: ConcernType;
  severity?: ConcernSeverity;
  source?: string;
  themeId?: number;
  limit?: number;
  offset?: number;
}): Promise<{ concerns: ConcernEntry[]; total: number }> {
  const { status = 'open', type, severity, source, themeId, limit = 20, offset = 0 } = options;

  const where: Record<string, unknown> = { sourceType: 'concern', forgettingStage: 'active' };
  if (type) where.category = type;
  // Severity/source live as `severity:<level>` / `source:<value>` tags. Both must
  // survive simultaneous filtering, so they go through AND instead of two plain
  // `where.tags` assignments (the second would silently clobber the first).
  const tagConditions: { contains: string }[] = [];
  if (severity) tagConditions.push({ contains: `severity:${severity}` });
  // NOTE: source keeps the JSON-serialized quotes in the needle — real source values
  // have prefix pairs (vuln_scan / vuln_scan_audit), so an unquoted contains would
  // cross-match them; severity values have no such pairs and stay unquoted as-is.
  if (source) tagConditions.push({ contains: `"source:${source}"` });
  if (tagConditions.length === 1) where.tags = tagConditions[0];
  else if (tagConditions.length > 1) where.AND = tagConditions.map((c) => ({ tags: c }));
  if (themeId) where.themeId = themeId;
  if (status === 'open') where.sourceId = 'open';
  else if (status === 'task_created') where.sourceId = { startsWith: 'task_' };
  else if (status === 'dismissed') where.sourceId = 'dismissed';
  else if (status === 'resolved') where.sourceId = 'resolved';
  // status === 'all' → no sourceId filter.

  const [entries, total] = await Promise.all([
    prisma.knowledgeEntry.findMany({
      where,
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
      select: CONCERN_SELECT,
    }),
    prisma.knowledgeEntry.count({ where }),
  ]);

  const concerns = entries.map(toConcernEntry);
  const linked = await fetchLinkedIssues(concerns.map((c) => c.id));
  for (const concern of concerns) concern.linkedIssue = linked.get(concern.id) ?? null;

  return { concerns, total };
}

/**
 * Fetches a single concern by id, enriched with its linked GitHub issue.
 *
 * @param concernId - Concern id / 懸念ID
 * @returns Concern or null when not found / 懸念、無ければ null
 */
export async function getConcern(concernId: number): Promise<ConcernEntry | null> {
  if (!isValidConcernId(concernId)) return null;
  const row = await prisma.knowledgeEntry.findFirst({
    where: { id: concernId, sourceType: 'concern' },
    select: CONCERN_SELECT,
  });
  if (!row) return null;
  const concern = toConcernEntry(row);
  const linked = await fetchLinkedIssues([concern.id]);
  concern.linkedIssue = linked.get(concern.id) ?? null;
  return concern;
}

/**
 * Reflects a linked GitHub issue's open/closed state onto the concern.
 * Only toggles between `open` and `resolved` so it never clobbers a concern
 * that was dismissed or already turned into a task.
 *
 * @param concernId - Concern id / 懸念ID
 * @param resolved - True when the GitHub issue is closed / Issueがクローズされたか
 * @returns True when the concern's status actually changed / 変化したか
 */
export async function markConcernResolved(concernId: number, resolved: boolean): Promise<boolean> {
  if (!isValidConcernId(concernId)) return false;
  const row = await prisma.knowledgeEntry.findFirst({
    where: { id: concernId, sourceType: 'concern' },
    select: { id: true, sourceId: true },
  });
  if (!row) return false;
  const current = row.sourceId ?? 'open';
  const next = resolved ? 'resolved' : 'open';
  // Guard: only the open<->resolved pair is synced from GitHub.
  if (resolved && current !== 'open') return false;
  if (!resolved && current !== 'resolved') return false;
  await prisma.knowledgeEntry.update({ where: { id: concernId }, data: { sourceId: next } });
  log.info({ concernId, next }, 'Concern status synced from GitHub issue');
  return true;
}

/**
 * Updates a concern's status ('dismissed' or back to 'open').
 *
 * @param concernId - Concern id / 懸念ID
 * @param status - New status (dismissed | open) / 新しい状態
 * @returns True when updated / 更新できたか
 */
export async function setConcernStatus(
  concernId: number,
  status: 'dismissed' | 'open',
): Promise<boolean> {
  if (!isValidConcernId(concernId)) return false;
  const existing = await prisma.knowledgeEntry.findFirst({
    where: { id: concernId, sourceType: 'concern' },
    select: { id: true },
  });
  if (!existing) return false;
  await prisma.knowledgeEntry.update({ where: { id: concernId }, data: { sourceId: status } });
  log.info({ concernId, status }, 'Concern status updated');
  return true;
}

/** Deletes a concern. */
export async function deleteConcern(concernId: number): Promise<boolean> {
  if (!isValidConcernId(concernId)) return false;
  const existing = await prisma.knowledgeEntry.findFirst({
    where: { id: concernId, sourceType: 'concern' },
    select: { id: true },
  });
  if (!existing) return false;
  await prisma.knowledgeEntry.delete({ where: { id: concernId } });
  return true;
}

/** Severity → task priority. */
const SEVERITY_TO_PRIORITY: Record<ConcernSeverity, 'urgent' | 'high' | 'medium' | 'low'> = {
  urgent: 'urgent',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** Type → task title prefix. */
const TYPE_PREFIX: Record<ConcernType, string> = {
  bug: '[Bug]',
  refactor: '[Refactor]',
  security: '[Security]',
  perf: '[Perf]',
  other: '[Concern]',
};

/**
 * Converts a concern into a dedicated task (deterministically, no AI), then
 * marks the concern as task_created.
 *
 * @param concernId - Concern id / 懸念ID
 * @returns Created task id, or null on failure / 作成タスクID
 */
export async function convertConcernToTask(concernId: number): Promise<number | null> {
  if (!isValidConcernId(concernId)) return null;
  const row = await prisma.knowledgeEntry.findFirst({
    where: { id: concernId, sourceType: 'concern' },
    select: CONCERN_SELECT,
  });
  if (!row) return null;
  const concern = toConcernEntry(row);
  if (concern.status === 'task_created') {
    throw new Error('この懸念は既にタスク化されています');
  }

  const descriptionParts = [concern.detail];
  if (concern.location) descriptionParts.push(`\n対象箇所: ${concern.location}`);
  if (concern.originTaskId) descriptionParts.push(`発見元タスク: #${concern.originTaskId}`);
  descriptionParts.push(`種別: ${concern.type} / 重大度: ${concern.severity}`);

  // Fall back to the default theme so the task is never theme-less (and thus
  // hidden from the category-filtered home task list). See resolveDefaultThemeId.
  const themeId = concern.themeId ?? (await resolveDefaultThemeId()) ?? undefined;
  if (concern.themeId == null && themeId != null) {
    log.info(
      { concernId, themeId },
      'Concern had no theme — assigning default theme on conversion',
    );
  }

  // A log-derived concern carries a logger name and a stack sample but no
  // spec, so the intake gate stops and asks an operator before anything runs
  // (tasks 700/702). Seed the spec its origin implies instead.
  const spec = specForConcernSource(concern.source);

  const task = await createTask(prisma, {
    title: `${TYPE_PREFIX[concern.type]} ${concern.title}`.slice(0, 200),
    description: descriptionParts.join('\n'),
    priority: SEVERITY_TO_PRIORITY[concern.severity],
    status: 'todo',
    themeId,
    ...(spec ?? {}),
  });
  if (!task) return null;

  await prisma.knowledgeEntry.update({
    where: { id: concernId },
    data: { sourceId: `task_${task.id}` },
  });
  log.info({ concernId, taskId: task.id }, 'Concern converted to task');
  return task.id;
}

/**
 * Concern counts by status and type.
 *
 * @returns Aggregate stats / 集計統計
 */
export async function getConcernStats(): Promise<{
  open: number;
  taskCreated: number;
  dismissed: number;
  resolved: number;
  byType: Array<{ type: string; count: number }>;
}> {
  const base = { sourceType: 'concern' as const, forgettingStage: 'active' };
  const [open, taskCreated, dismissed, resolved, grouped] = await Promise.all([
    prisma.knowledgeEntry.count({ where: { ...base, sourceId: 'open' } }),
    prisma.knowledgeEntry.count({ where: { ...base, sourceId: { startsWith: 'task_' } } }),
    prisma.knowledgeEntry.count({ where: { ...base, sourceId: 'dismissed' } }),
    prisma.knowledgeEntry.count({ where: { ...base, sourceId: 'resolved' } }),
    prisma.knowledgeEntry.groupBy({
      by: ['category'],
      where: { ...base, sourceId: 'open' },
      _count: { id: true },
    }),
  ]);
  return {
    open,
    taskCreated,
    dismissed,
    resolved,
    byType: grouped.map((g) => ({ type: g.category, count: g._count.id })),
  };
}
