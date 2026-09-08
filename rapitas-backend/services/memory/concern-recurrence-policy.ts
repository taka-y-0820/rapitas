/**
 * concern-recurrence-policy
 *
 * Opt-in recurrence/occurrence aggregation for `submitConcern` (task #801):
 * self-detection and log-health filings pass a `RecurrencePolicy` so a
 * signature that recurs while its prior filing is still open merges into
 * that row instead of creating a sibling, and a signature that recurs after
 * its follow-up task went `done` files one new row referencing the old one
 * with its severity escalated. Callers that omit the policy are unaffected —
 * `findBlockingDuplicate` in concern-backlog-service.ts stays the sole path.
 * Not responsible for filing itself (concern-backlog-service.ts owns create).
 */
import { createLogger } from '../../config/logger';
import type { ConcernSeverity } from './concern-backlog-types';
import {
  pickSuppressingCandidate,
  pickLatestDoneCandidate,
  type ResolvedCandidate,
} from './concern-recurrence-candidates';

const log = createLogger('memory:concern-recurrence-policy');

/**
 * Task statuses meaning a concern's follow-up work has closed out.
 * Kept in sync with concern-backlog-service.ts's TERMINAL_TASK_STATUSES
 * (duplicated, not imported, to avoid a circular module dependency).
 */
const TERMINAL_TASK_STATUSES = ['done', 'completed', 'failed', 'cancelled', 'archived'];

/** How many days after a follow-up task went terminal a recurrence still counts as "the same fix broke again". */
export const RECURRENCE_WINDOW_DAYS = 14;

/**
 * How long after a candidate row was created a fresh same-signature filing
 * still merges into it instead of creating a sibling (task #857: self-incident
 * watch passes re-detect the same repeat-loop every few minutes while its
 * follow-up task is still churning, so each pass filed a new concern the
 * instant the prior one went terminal). Matches the default self-incident
 * repeat-loop detection window (REPEAT_LOOP_WINDOW_MS, 60m) so at most one new
 * filing is produced per detection window.
 */
export const RECURRENCE_SUPPRESS_WINDOW_MS =
  parseInt(process.env.RAPITAS_CONCERN_RECURRENCE_SUPPRESS_MS ?? '', 10) || 60 * 60 * 1000;

/** Opt-in recurrence/occurrence policy passed by self-detection and log-health filings. */
export interface RecurrencePolicy {
  enabled: boolean;
  /** Instance-varying value recorded per occurrence (branch name, taskId, raw log line, etc). / 発生ごとの可変値 */
  instanceValue: string;
  /** Epoch ms this occurrence was detected; defaults to Date.now() when omitted. / 検出時刻 */
  detectedAt?: number;
}

/** A KnowledgeEntry row minimally shaped for recurrence resolution. */
export interface RecurrenceCandidateEntry {
  id: number;
  sourceId: string | null;
  tags: string;
  content: string;
  createdAt: Date;
}

/** Narrow Prisma client view `resolveRecurrence` needs — keeps tests independent of the full generated client shape. */
export interface RecurrencePrisma {
  knowledgeEntry: {
    findMany(args: {
      where: {
        contentHash: string;
        sourceType: string;
        forgettingStage: string;
        sourceId: { not: string };
      };
      select: { id: true; sourceId: true; tags: true; content: true; createdAt: true };
    }): Promise<RecurrenceCandidateEntry[]>;
    update(args: {
      where: { id: number };
      data: { tags: string; content: string };
    }): Promise<unknown>;
  };
  task: {
    findUnique(args: {
      where: { id: number };
      select: { status: true; completedAt: true };
    }): Promise<{ status: string; completedAt: Date | null } | null>;
  };
}

export type RecurrenceResolution =
  | { action: 'merged-open'; targetEntry: RecurrenceCandidateEntry }
  | { action: 'recurrence-of-done'; targetEntry: RecurrenceCandidateEntry }
  | { action: 'new' };

/**
 * Resolves how a same-signature filing should proceed: merge into a still-live
 * duplicate ('merged-open' — open, dismissed, a task_created entry whose task
 * is not yet terminal, or a terminal row created within `suppressWindowMs`),
 * recurrence-of-done when the same signature's most-recently-completed
 * follow-up task went terminal within `windowDays`, or 'new' otherwise.
 * Fails open to 'new' on any DB error — a duplicate filing is safer than a
 * silently dropped one.
 *
 * @param prismaClient - Prisma client (or test double) / DBクライアント
 * @param hash - contentHash of the concern being filed / 起票する懸念のハッシュ
 * @param windowDays - Recurrence window in days / 再発判定の日数窓
 * @param nowMs - Current time (ms); injectable for tests / 現在時刻
 * @param suppressWindowMs - Suppression window in ms (task #857) / 抑制ウィンドウ(ms)
 * @returns The resolution / 判定結果
 */
export async function resolveRecurrence(
  prismaClient: RecurrencePrisma,
  hash: string,
  windowDays: number,
  nowMs: number = Date.now(),
  suppressWindowMs: number = RECURRENCE_SUPPRESS_WINDOW_MS,
): Promise<RecurrenceResolution> {
  try {
    const rows = await prismaClient.knowledgeEntry.findMany({
      where: {
        contentHash: hash,
        sourceType: 'concern',
        forgettingStage: 'active',
        sourceId: { not: 'resolved' },
      },
      select: { id: true, sourceId: true, tags: true, content: true, createdAt: true },
    });
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    // Resolved up front, then judged in passes (task 835): the findMany
    // above has no orderBy, so returning on the first matching row made the
    // verdict depend on row order — a done row arriving before a still-live
    // one filed a NEW concern instead of merging into the live one, splitting
    // one signature across sibling rows (#7412 done → #8613 live → #835).
    // A live duplicate now always wins, whatever order the rows came back in.
    const resolved: Array<{
      row: RecurrenceCandidateEntry;
      task: { status: string; completedAt: Date | null } | null;
      isTaskRow: boolean;
    }> = [];
    for (const row of rows) {
      const taskMatch = (row.sourceId ?? 'open').match(/^task_(\d+)$/);
      const task = taskMatch
        ? await prismaClient.task
            .findUnique({
              where: { id: Number(taskMatch[1]) },
              select: { status: true, completedAt: true },
            })
            .catch(() => null)
        : null;
      resolved.push({ row, task, isTaskRow: taskMatch !== null });
    }

    for (const { row, task, isTaskRow } of resolved) {
      if (!isTaskRow) return { action: 'merged-open', targetEntry: row }; // 'open' or 'dismissed' → still live
      if (task && !TERMINAL_TASK_STATUSES.includes(task.status))
        return { action: 'merged-open', targetEntry: row };
    }

    // Every remaining candidate is terminal at this point (task 857): a
    // signature that keeps re-triggering while its terminal follow-up row is
    // still fresh merges into that row instead of spawning a new sibling on
    // every detection pass.
    const terminalCandidates: ResolvedCandidate<RecurrenceCandidateEntry>[] = resolved.map(
      ({ row, task }) => ({ row, completedAt: task?.completedAt ?? null }),
    );
    const suppressing = pickSuppressingCandidate(terminalCandidates, nowMs, suppressWindowMs);
    if (suppressing) return { action: 'merged-open', targetEntry: suppressing };

    const latestDone = pickLatestDoneCandidate(terminalCandidates, nowMs, windowMs);
    if (latestDone) return { action: 'recurrence-of-done', targetEntry: latestDone };

    return { action: 'new' };
  } catch (err) {
    log.warn({ err, hash }, '[concern-recurrence] resolution failed — falling open to new filing');
    return { action: 'new' };
  }
}

const OCCURRENCE_TAG_RE = /^occurrence:(\d+)$/;

/**
 * Appends one occurrence record to an existing entry's content and bumps its
 * `occurrence:<N>` tag, preserving every other tag untouched.
 *
 * @param entry - The entry being merged into / マージ先エントリ
 * @param instanceValue - This occurrence's instance-varying value / 発生固有値
 * @param detectedAtMs - Epoch ms this occurrence was detected / 検出時刻
 * @returns Updated tags (JSON string) and content / 更新後の tags・content
 */
export function appendOccurrence(
  entry: { tags: string; content: string },
  instanceValue: string,
  detectedAtMs: number,
): { tags: string; content: string } {
  const tags = JSON.parse(entry.tags || '[]') as string[];
  const occurrenceTag = tags.find((t) => OCCURRENCE_TAG_RE.test(t));
  const priorCount = occurrenceTag ? Number(occurrenceTag.match(OCCURRENCE_TAG_RE)![1]) : 1;
  const nextTags = [
    ...tags.filter((t) => !OCCURRENCE_TAG_RE.test(t)),
    `occurrence:${priorCount + 1}`,
  ];
  const record = `- ${new Date(detectedAtMs).toISOString()} (instanceValue: ${instanceValue})`;
  const content = entry.content.includes('### 発生記録')
    ? `${entry.content}\n${record}`
    : `${entry.content}\n\n### 発生記録\n${record}`;
  return { tags: JSON.stringify(nextTags), content };
}

/** Severity escalation for a done-task recurrence. Capped at 'high' — 'urgent' never auto-escalates further. */
const SEVERITY_ESCALATION: Record<ConcernSeverity, ConcernSeverity> = {
  low: 'medium',
  medium: 'high',
  high: 'high',
  urgent: 'urgent',
};

/** Escalates severity one step for a done-task recurrence (low→medium→high, capped). */
export function bumpSeverity(current: ConcernSeverity): ConcernSeverity {
  return SEVERITY_ESCALATION[current];
}

/**
 * Annotates a fresh concern's detail with a recurrence note and returns the
 * `recurrenceOf:<id>` tag to add, for when a signature's prior filing is done.
 *
 * @param detail - The concern's original detail text / 元の詳細本文
 * @param previousEntryId - The done KnowledgeEntry this recurs from / 参照元の懸念ID
 * @param detectedAtMs - Epoch ms this recurrence was detected / 検出時刻
 * @returns Annotated content and the tag to add / 注記済み本文と追加タグ
 */
export function annotateRecurrenceOfDone(
  detail: string,
  previousEntryId: number,
  detectedAtMs: number,
): { content: string; extraTag: string } {
  const note =
    `### 再発\n` +
    `以前 #${previousEntryId} として起票・修正済み（done）だった同一原因の問題が` +
    `${new Date(detectedAtMs).toISOString()} に再発しました。`;
  return { content: `${detail}\n\n${note}`, extraTag: `recurrenceOf:${previousEntryId}` };
}

/** Outcome of resolveFiling: either reuse an existing id, or adjustments to apply before creating a new entry. */
export interface ConcernFilingDecision {
  /** Set when an existing entry was reused (blocked dup, or merged recurrence) — the caller returns this id, no create(). */
  reuseId?: number;
  /** Why `reuseId` was reused — lets submitConcern report it without re-deriving. */
  reuseReason?: 'dedup-live-duplicate' | 'recurrence-merged-open';
  severity?: ConcernSeverity;
  detail?: string;
  extraTag?: string;
}

/**
 * Single decision point for `submitConcern`: without a policy, defers to the
 * caller's existing live-duplicate check unchanged; with one, resolves
 * open-merge / done-recurrence / new via `resolveRecurrence` and performs the
 * open-merge update itself, so `submitConcern` stays a flat branch instead of
 * duplicating recurrence bookkeeping inline.
 *
 * @param prismaClient - Prisma client / DBクライアント
 * @param opts - Filing context / 起票コンテキスト
 * @returns Reuse id, or creation adjustments / 再利用ID または作成時の調整内容
 */
export async function resolveFiling(
  prismaClient: RecurrencePrisma,
  opts: {
    input: { detail: string; recurrencePolicy?: RecurrencePolicy };
    hash: string;
    severity: ConcernSeverity;
    findBlockingDuplicate: (hash: string) => Promise<number | null>;
  },
): Promise<ConcernFilingDecision> {
  const policy = opts.input.recurrencePolicy;
  if (!policy?.enabled) {
    const blockingId = await opts.findBlockingDuplicate(opts.hash);
    return blockingId != null ? { reuseId: blockingId, reuseReason: 'dedup-live-duplicate' } : {};
  }
  const detectedAt = policy.detectedAt ?? Date.now();
  const resolution = await resolveRecurrence(
    prismaClient,
    opts.hash,
    RECURRENCE_WINDOW_DAYS,
    detectedAt,
  );
  if (resolution.action === 'merged-open') {
    const updated = appendOccurrence(resolution.targetEntry, policy.instanceValue, detectedAt);
    await prismaClient.knowledgeEntry.update({
      where: { id: resolution.targetEntry.id },
      data: { tags: updated.tags, content: updated.content },
    });
    return { reuseId: resolution.targetEntry.id, reuseReason: 'recurrence-merged-open' };
  }
  if (resolution.action === 'recurrence-of-done') {
    const annotated = annotateRecurrenceOfDone(
      opts.input.detail,
      resolution.targetEntry.id,
      detectedAt,
    );
    return {
      severity: bumpSeverity(opts.severity),
      detail: annotated.content,
      extraTag: annotated.extraTag,
    };
  }
  return {};
}
