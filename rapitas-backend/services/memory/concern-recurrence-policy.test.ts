/**
 * concern-recurrence-policy.test
 *
 * Tests for the opt-in recurrence/occurrence aggregation used by
 * self-detection and log-health filings (task #801). resolveRecurrence and
 * resolveFiling take the Prisma client as a parameter, so these tests use a
 * plain in-memory fake instead of bun's process-global mock.module.
 */
import { describe, it, expect, mock } from 'bun:test';
import {
  resolveRecurrence,
  resolveFiling,
  appendOccurrence,
  bumpSeverity,
  annotateRecurrenceOfDone,
  RECURRENCE_WINDOW_DAYS,
  RECURRENCE_SUPPRESS_WINDOW_MS,
  type RecurrencePrisma,
  type RecurrenceCandidateEntry,
} from './concern-recurrence-policy';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Older than RECURRENCE_SUPPRESS_WINDOW_MS so rows don't accidentally hit the suppression path. */
const OLD_CREATED_AT = new Date(Date.now() - 2 * DAY_MS);

function fakePrisma(opts: {
  rows?: RecurrenceCandidateEntry[];
  task?: { status: string; completedAt: Date | null } | null;
  /** Per-taskId lookup for windows holding rows from several follow-up tasks; falls back to `task`. / taskId別の解決結果 */
  tasksById?: Record<number, { status: string; completedAt: Date | null } | null>;
  findManyThrows?: boolean;
}): RecurrencePrisma & { update: ReturnType<typeof mock> } {
  const update = mock(() => Promise.resolve({}));
  return {
    knowledgeEntry: {
      findMany: () => {
        if (opts.findManyThrows) return Promise.reject(new Error('db down'));
        return Promise.resolve(opts.rows ?? []);
      },
      update,
    },
    task: {
      findUnique: (args) =>
        Promise.resolve(
          opts.tasksById ? (opts.tasksById[args.where.id] ?? null) : (opts.task ?? null),
        ),
    },
    update,
  };
}

// ─── resolveRecurrence ──────────────────────────────────────────────────────

describe('resolveRecurrence', () => {
  it('returns "new" when no matching row exists', async () => {
    const prisma = fakePrisma({ rows: [] });
    const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS);
    expect(result.action).toBe('new');
  });

  it('merges into an open row', async () => {
    const row = {
      id: 5,
      sourceId: 'open',
      tags: '[]',
      content: 'detail',
      createdAt: OLD_CREATED_AT,
    };
    const prisma = fakePrisma({ rows: [row] });
    const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS);
    expect(result).toEqual({ action: 'merged-open', targetEntry: row });
  });

  it('merges into a dismissed row (respects the explicit dismiss)', async () => {
    const row = {
      id: 5,
      sourceId: 'dismissed',
      tags: '[]',
      content: 'detail',
      createdAt: OLD_CREATED_AT,
    };
    const prisma = fakePrisma({ rows: [row] });
    const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS);
    expect(result.action).toBe('merged-open');
  });

  it('merges into a task_created row whose task is still in flight', async () => {
    const row = {
      id: 5,
      sourceId: 'task_9',
      tags: '[]',
      content: 'detail',
      createdAt: OLD_CREATED_AT,
    };
    const prisma = fakePrisma({ rows: [row], task: { status: 'in-progress', completedAt: null } });
    const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS);
    expect(result.action).toBe('merged-open');
  });

  it('is a recurrence-of-done when the follow-up task completed within the window (13 days)', async () => {
    const row = {
      id: 5,
      sourceId: 'task_9',
      tags: '[]',
      content: 'detail',
      createdAt: OLD_CREATED_AT,
    };
    const nowMs = Date.now();
    const completedAt = new Date(nowMs - 13 * DAY_MS);
    const prisma = fakePrisma({ rows: [row], task: { status: 'done', completedAt } });
    const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
    expect(result).toEqual({ action: 'recurrence-of-done', targetEntry: row });
  });

  it('is "new" when the follow-up task completed outside the window (15 days)', async () => {
    const row = {
      id: 5,
      sourceId: 'task_9',
      tags: '[]',
      content: 'detail',
      createdAt: OLD_CREATED_AT,
    };
    const nowMs = Date.now();
    const completedAt = new Date(nowMs - 15 * DAY_MS);
    const prisma = fakePrisma({ rows: [row], task: { status: 'done', completedAt } });
    const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
    expect(result.action).toBe('new');
  });

  it('is "new" when the terminal task has no completedAt recorded', async () => {
    const row = {
      id: 5,
      sourceId: 'task_9',
      tags: '[]',
      content: 'detail',
      createdAt: OLD_CREATED_AT,
    };
    const prisma = fakePrisma({ rows: [row], task: { status: 'done', completedAt: null } });
    const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS);
    expect(result.action).toBe('new');
  });

  it('fails open to "new" when the DB query throws', async () => {
    const prisma = fakePrisma({ findManyThrows: true });
    const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS);
    expect(result.action).toBe('new');
  });

  // Task 835: findMany has no orderBy, so a done row arriving before a live
  // one used to short-circuit to recurrence-of-done and file a sibling concern
  // instead of merging into the live row (#7412 done → #8613 live → #835).
  // A live duplicate must win in either row order.
  describe('live rows win over done rows regardless of findMany order', () => {
    const nowMs = Date.now();
    const doneRow = {
      id: 1,
      sourceId: 'task_10',
      tags: '[]',
      content: 'done row',
      createdAt: new Date(nowMs - 2 * DAY_MS),
    };
    const liveRow = {
      id: 2,
      sourceId: 'task_20',
      tags: '[]',
      content: 'live row',
      createdAt: new Date(nowMs - 2 * DAY_MS),
    };
    const tasksById = {
      10: { status: 'done', completedAt: new Date(nowMs - 1 * DAY_MS) },
      20: { status: 'in-progress', completedAt: null },
    };

    it('merges into the live row when the done row comes first', async () => {
      const prisma = fakePrisma({ rows: [doneRow, liveRow], tasksById });
      const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
      expect(result).toEqual({ action: 'merged-open', targetEntry: liveRow });
    });

    it('merges into the live row when the live row comes first', async () => {
      const prisma = fakePrisma({ rows: [liveRow, doneRow], tasksById });
      const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
      expect(result).toEqual({ action: 'merged-open', targetEntry: liveRow });
    });

    // With no live row left, the done row still escalates as a recurrence.
    it('still reports recurrence-of-done when every candidate row is terminal', async () => {
      const prisma = fakePrisma({ rows: [doneRow], tasksById });
      const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
      expect(result).toEqual({ action: 'recurrence-of-done', targetEntry: doneRow });
    });
  });

  // Task #857: a terminal row created moments ago (inside the suppress
  // window) merges the fresh re-detection instead of spawning a sibling —
  // regardless of how long ago its follow-up task completed.
  describe('suppresses fresh re-filings against a just-created terminal row', () => {
    const nowMs = Date.now();

    it('merges into a terminal row created within the suppress window', async () => {
      const row = {
        id: 7,
        sourceId: 'task_30',
        tags: '[]',
        content: 'fresh done row',
        createdAt: new Date(nowMs - 10 * 60 * 1000),
      };
      const prisma = fakePrisma({
        rows: [row],
        task: { status: 'done', completedAt: new Date(nowMs) },
      });
      const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
      expect(result).toEqual({ action: 'merged-open', targetEntry: row });
    });

    it('does not suppress a terminal row created outside the suppress window', async () => {
      const row = {
        id: 8,
        sourceId: 'task_31',
        tags: '[]',
        content: 'old done row',
        createdAt: new Date(nowMs - RECURRENCE_SUPPRESS_WINDOW_MS - HOUR_MS),
      };
      const completedAt = new Date(nowMs - 1 * DAY_MS);
      const prisma = fakePrisma({ rows: [row], task: { status: 'done', completedAt } });
      const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
      expect(result).toEqual({ action: 'recurrence-of-done', targetEntry: row });
    });
  });

  // Regression test for the #7412-固定参照 bug: findMany has no orderBy, so
  // among several terminal candidates the most recently completed one must
  // win regardless of array order.
  describe('picks the most recently completed done row regardless of findMany order', () => {
    const nowMs = Date.now();
    const olderDone = {
      id: 9,
      sourceId: 'task_40',
      tags: '[]',
      content: 'older done row',
      createdAt: new Date(nowMs - 13 * DAY_MS),
    };
    const newerDone = {
      id: 10,
      sourceId: 'task_41',
      tags: '[]',
      content: 'newer done row',
      createdAt: new Date(nowMs - 2 * DAY_MS),
    };
    const tasksById = {
      40: { status: 'done', completedAt: new Date(nowMs - 10 * DAY_MS) },
      41: { status: 'done', completedAt: new Date(nowMs - 1 * DAY_MS) },
    };

    it('picks the newer done row when the older row comes first', async () => {
      const prisma = fakePrisma({ rows: [olderDone, newerDone], tasksById });
      const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
      expect(result).toEqual({ action: 'recurrence-of-done', targetEntry: newerDone });
    });

    it('picks the newer done row when the newer row comes first', async () => {
      const prisma = fakePrisma({ rows: [newerDone, olderDone], tasksById });
      const result = await resolveRecurrence(prisma, 'hash1', RECURRENCE_WINDOW_DAYS, nowMs);
      expect(result).toEqual({ action: 'recurrence-of-done', targetEntry: newerDone });
    });
  });
});

// ─── appendOccurrence ───────────────────────────────────────────────────────

describe('appendOccurrence', () => {
  it('adds an occurrence:2 tag on the first merge, preserving other tags', () => {
    const entry = { tags: JSON.stringify(['severity:high', 'source:agent']), content: '本文' };
    const result = appendOccurrence(entry, 'taskId:9', Date.parse('2026-08-31T00:00:00.000Z'));
    const tags = JSON.parse(result.tags) as string[];
    expect(tags).toContain('severity:high');
    expect(tags).toContain('source:agent');
    expect(tags).toContain('occurrence:2');
  });

  it('increments an existing occurrence tag instead of duplicating it', () => {
    const entry = { tags: JSON.stringify(['occurrence:3']), content: '本文' };
    const result = appendOccurrence(entry, 'taskId:9', Date.now());
    const tags = JSON.parse(result.tags) as string[];
    expect(tags).toEqual(['occurrence:4']);
  });

  it('appends a 発生記録 record line carrying the instance value', () => {
    const entry = { tags: '[]', content: '本文' };
    const result = appendOccurrence(entry, 'taskId:9', Date.parse('2026-08-31T00:00:00.000Z'));
    expect(result.content).toContain('### 発生記録');
    expect(result.content).toContain('instanceValue: taskId:9');
  });
});

// ─── bumpSeverity ───────────────────────────────────────────────────────────

describe('bumpSeverity', () => {
  it.each([
    ['low', 'medium'],
    ['medium', 'high'],
    ['high', 'high'],
    ['urgent', 'urgent'],
  ] as const)('escalates %s to %s', (current, expected) => {
    expect(bumpSeverity(current)).toBe(expected);
  });
});

// ─── annotateRecurrenceOfDone ───────────────────────────────────────────────

describe('annotateRecurrenceOfDone', () => {
  it('appends a 再発 note and returns a recurrenceOf tag', () => {
    const result = annotateRecurrenceOfDone('元の詳細', 42, Date.now());
    expect(result.content).toContain('### 再発');
    expect(result.content).toContain('#42');
    expect(result.extraTag).toBe('recurrenceOf:42');
  });
});

// ─── resolveFiling ──────────────────────────────────────────────────────────

describe('resolveFiling', () => {
  it('defers to findBlockingDuplicate when no recurrencePolicy is given', async () => {
    const prisma = fakePrisma({});
    const findBlockingDuplicate = mock(() => Promise.resolve(7));
    const decision = await resolveFiling(prisma, {
      input: { detail: '詳細' },
      hash: 'h',
      severity: 'medium',
      findBlockingDuplicate,
    });
    expect(findBlockingDuplicate).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({ reuseId: 7, reuseReason: 'dedup-live-duplicate' });
  });

  it('returns no reuseId when findBlockingDuplicate finds nothing and no policy is given', async () => {
    const prisma = fakePrisma({});
    const findBlockingDuplicate = mock(() => Promise.resolve(null));
    const decision = await resolveFiling(prisma, {
      input: { detail: '詳細' },
      hash: 'h',
      severity: 'medium',
      findBlockingDuplicate,
    });
    expect(decision).toEqual({});
  });

  it('merges into an open duplicate and updates it in place when the policy is enabled', async () => {
    const row = {
      id: 5,
      sourceId: 'open',
      tags: '[]',
      content: '既存の詳細',
      createdAt: OLD_CREATED_AT,
    };
    const prisma = fakePrisma({ rows: [row] });
    const findBlockingDuplicate = mock(() => Promise.resolve(null));
    const decision = await resolveFiling(prisma, {
      input: { detail: '詳細', recurrencePolicy: { enabled: true, instanceValue: 'taskId:1' } },
      hash: 'h',
      severity: 'medium',
      findBlockingDuplicate,
    });
    expect(decision).toEqual({ reuseId: 5, reuseReason: 'recurrence-merged-open' });
    expect(prisma.update).toHaveBeenCalledTimes(1);
    expect(findBlockingDuplicate).not.toHaveBeenCalled();
  });

  it('escalates severity and annotates a fresh entry for a done-task recurrence', async () => {
    const nowMs = Date.now();
    const row = {
      id: 5,
      sourceId: 'task_9',
      tags: '[]',
      content: '既存の詳細',
      createdAt: new Date(nowMs - 2 * DAY_MS),
    };
    const completedAt = new Date(nowMs - 1 * DAY_MS);
    const prisma = fakePrisma({ rows: [row], task: { status: 'done', completedAt } });
    const findBlockingDuplicate = mock(() => Promise.resolve(null));
    const decision = await resolveFiling(prisma, {
      input: {
        detail: '新しい詳細',
        recurrencePolicy: { enabled: true, instanceValue: 'taskId:2', detectedAt: nowMs },
      },
      hash: 'h',
      severity: 'medium',
      findBlockingDuplicate,
    });
    expect(decision.reuseId).toBeUndefined();
    expect(decision.severity).toBe('high');
    expect(decision.extraTag).toBe('recurrenceOf:5');
    expect(decision.detail).toContain('### 再発');
  });

  it('returns no adjustments when the policy is enabled but nothing matches (genuinely new)', async () => {
    const prisma = fakePrisma({ rows: [] });
    const findBlockingDuplicate = mock(() => Promise.resolve(null));
    const decision = await resolveFiling(prisma, {
      input: { detail: '詳細', recurrencePolicy: { enabled: true, instanceValue: 'taskId:3' } },
      hash: 'h',
      severity: 'low',
      findBlockingDuplicate,
    });
    expect(decision).toEqual({});
  });
});
