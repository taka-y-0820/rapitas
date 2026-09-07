/**
 * self-incident-evidence.test
 *
 * Covers the evidence I/O boundary: gatherTaskState maps each prisma query
 * into the snapshot (including per-query failure fallbacks), and
 * formatIncidentDetail renders every required section with the documented
 * fallbacks for an empty timeline / missing session.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const transitionFindManyMock = mock((_args: unknown) => Promise.resolve([] as unknown[]));
const sessionFindFirstMock = mock(() => Promise.resolve<unknown>(null));
const executionFindFirstMock = mock(() => Promise.resolve<unknown>(null));
const queueItemFindFirstMock = mock(() => Promise.resolve<unknown>(null));

mock.module('../../config/logger', () => ({
  getBackendLogFilePath: () => '/tmp/backend.log',
  logger: noopLogger,
  createLogger: () => noopLogger,
}));
mock.module('../../config/database', () => ({
  prisma: {
    workflowTransition: { findMany: transitionFindManyMock },
    agentSession: { findFirst: sessionFindFirstMock },
    agentExecution: { findFirst: executionFindFirstMock },
    workflowQueueItem: { findFirst: queueItemFindFirstMock },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
}));

const { gatherTaskState, formatIncidentDetail } = await import('./self-incident-evidence');

const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const WINDOW_MS = 60 * 60 * 1000;
const task = { id: 546, title: '停滞テスト', updatedAt: new Date(NOW - 40 * 60 * 1000) };

function transitionRow(minutesAgo: number, over: Record<string, unknown> = {}) {
  return {
    fromStatus: 'draft',
    toStatus: 'research_done',
    actor: 'system',
    cause: 'file_saved:research',
    phase: 'researcher',
    createdAt: new Date(NOW - minutesAgo * 60 * 1000),
    ...over,
  };
}

describe('gatherTaskState', () => {
  beforeEach(() => {
    transitionFindManyMock.mockReset().mockResolvedValue([]);
    sessionFindFirstMock.mockReset().mockResolvedValue(null);
    executionFindFirstMock.mockReset().mockResolvedValue(null);
    queueItemFindFirstMock.mockReset().mockResolvedValue(null);
  });

  test('maps every query into the snapshot fields', async () => {
    // First findMany call = recent timeline (newest first); second = windowed causes.
    transitionFindManyMock
      .mockResolvedValueOnce([transitionRow(5, { toStatus: 'plan_created' }), transitionRow(30)])
      .mockResolvedValueOnce([
        { cause: 'ci_repair', createdAt: new Date(NOW - 10 * 60 * 1000), actor: 'system' },
      ]);
    sessionFindFirstMock.mockResolvedValue({
      id: 91,
      status: 'failed',
      updatedAt: new Date(NOW - 60_000),
      agentExecutions: [{ id: 402, status: 'running' }],
    });
    executionFindFirstMock.mockResolvedValue({ id: 402 });
    queueItemFindFirstMock.mockResolvedValue({ id: 7 });

    const state = await gatherTaskState(task, NOW, WINDOW_MS);

    expect(state.taskId).toBe(546);
    expect(state.title).toBe('停滞テスト');
    expect(state.taskUpdatedAtMs).toBe(task.updatedAt.getTime());
    // Timeline is reversed into oldest-first reading order.
    expect(state.timeline.map((t) => t.toStatus)).toEqual(['research_done', 'plan_created']);
    expect(state.latestTransitionAtMs).toBe(NOW - 5 * 60 * 1000);
    expect(state.latestTransitionCause).toBe('file_saved:research');
    expect(state.windowedCauses).toEqual([
      {
        cause: 'ci_repair',
        createdAtMs: NOW - 10 * 60 * 1000,
        actor: 'system',
        invariantViolation: false,
      },
    ]);
    expect(state.latestSessionId).toBe(91);
    expect(state.latestSessionStatus).toBe('failed');
    expect(state.latestSessionUpdatedAtMs).toBe(NOW - 60_000);
    expect(state.latestExecutionId).toBe(402);
    expect(state.latestExecutionStatus).toBe('running');
    expect(state.hasLiveExecution).toBe(true);
    expect(state.hasAnyExecution).toBe(true);
    expect(state.hasActiveQueueItem).toBe(true);
  });

  test('an empty DB yields the all-null / all-false snapshot', async () => {
    const state = await gatherTaskState(task, NOW, WINDOW_MS);

    expect(state.timeline).toEqual([]);
    expect(state.latestTransitionAtMs).toBeNull();
    expect(state.latestTransitionCause).toBeNull();
    expect(state.windowedCauses).toEqual([]);
    expect(state.latestSessionId).toBeNull();
    expect(state.latestSessionStatus).toBeNull();
    expect(state.latestSessionUpdatedAtMs).toBeNull();
    expect(state.latestExecutionId).toBeNull();
    expect(state.latestExecutionStatus).toBeNull();
    expect(state.hasLiveExecution).toBe(false);
    expect(state.hasAnyExecution).toBe(false);
    expect(state.hasActiveQueueItem).toBe(false);
  });

  test('a session with no executions leaves execution fields null', async () => {
    sessionFindFirstMock.mockResolvedValue({ id: 91, status: 'active', agentExecutions: [] });

    const state = await gatherTaskState(task, NOW, WINDOW_MS);

    expect(state.latestSessionId).toBe(91);
    expect(state.latestSessionStatus).toBe('active');
    expect(state.latestExecutionId).toBeNull();
    expect(state.latestExecutionStatus).toBeNull();
  });

  test('one failing query falls back to its default without aborting the rest', async () => {
    transitionFindManyMock.mockRejectedValue(new Error('db down'));
    sessionFindFirstMock.mockResolvedValue({
      id: 91,
      status: 'active',
      agentExecutions: [{ id: 402, status: 'completed' }],
    });

    const state = await gatherTaskState(task, NOW, WINDOW_MS);

    expect(state.timeline).toEqual([]);
    expect(state.windowedCauses).toEqual([]);
    // The session query still contributed its fields.
    expect(state.latestSessionId).toBe(91);
    expect(state.latestExecutionStatus).toBe('completed');
  });

  test('propagates invariantViolation=true rows into windowedCauses (task 681 wiring)', async () => {
    transitionFindManyMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        cause: 'verify_pr_not_created',
        createdAt: new Date(NOW - 10 * 60 * 1000),
        actor: 'system',
        invariantViolation: true,
      },
    ]);

    const state = await gatherTaskState(task, NOW, WINDOW_MS);

    expect(state.windowedCauses).toEqual([
      {
        cause: 'verify_pr_not_created',
        createdAtMs: NOW - 10 * 60 * 1000,
        actor: 'system',
        invariantViolation: true,
      },
    ]);
  });

  test('surfaces the newest transition cause of manual_execution_stop_withdraw (#875)', async () => {
    transitionFindManyMock
      .mockResolvedValueOnce([
        transitionRow(1, { cause: 'manual_execution_stop_withdraw', toStatus: 'in_progress' }),
        transitionRow(30),
      ])
      .mockResolvedValueOnce([]);

    const state = await gatherTaskState(task, NOW, WINDOW_MS);

    expect(state.latestTransitionCause).toBe('manual_execution_stop_withdraw');
  });

  test('queries the windowed causes with the window cutoff', async () => {
    await gatherTaskState(task, NOW, WINDOW_MS);

    const windowedCall = transitionFindManyMock.mock.calls[1]?.[0] as {
      where: { taskId: number; createdAt: { gte: Date } };
    };
    expect(windowedCall.where.taskId).toBe(546);
    expect(windowedCall.where.createdAt.gte.getTime()).toBe(NOW - WINDOW_MS);
  });
});

describe('formatIncidentDetail', () => {
  const baseState = {
    taskId: 546,
    title: '停滞テスト',
    taskUpdatedAtMs: NOW - 40 * 60 * 1000,
    timeline: [
      {
        createdAt: '2026-08-11T11:30:00.000Z',
        fromStatus: null,
        toStatus: 'research_done',
        actor: 'system',
        cause: 'file_saved:research',
        phase: 'researcher',
      },
    ],
    latestTransitionAtMs: NOW - 30 * 60 * 1000,
    windowedCauses: [],
    latestSessionId: 91,
    latestSessionStatus: 'failed',
    latestExecutionId: 402,
    latestExecutionStatus: 'running',
    hasLiveExecution: false,
    hasAnyExecution: false,
    hasActiveQueueItem: false,
  };

  test('renders every required section with the evidence', () => {
    const md = formatIncidentDetail({
      state: baseState,
      explanation: '40分間更新がありません',
      thresholdDescription: '停滞閾値 30分',
      detectedAtIso: '2026-08-11T12:00:00.000Z',
    });

    expect(md).toContain('## 概要');
    expect(md).toContain('40分間更新がありません');
    expect(md).toContain('## 対象タスク');
    expect(md).toContain('#546「停滞テスト」');
    expect(md).toContain('## 直近の遷移タイムライン(最大10件)');
    expect(md).toContain('(初回) → research_done');
    expect(md).toContain('cause: file_saved:research');
    expect(md).toContain('## 関連セッション/実行の状態');
    expect(md).toContain('最新セッション: #91 status=failed');
    expect(md).toContain('最新実行: #402 status=running');
    expect(md).toContain('## 検出条件');
    expect(md).toContain('検出時刻: 2026-08-11T12:00:00.000Z');
    expect(md).toContain('閾値: 停滞閾値 30分');
  });

  test('an empty timeline renders the no-history fallback', () => {
    const md = formatIncidentDetail({
      state: { ...baseState, timeline: [] },
      explanation: 'x',
      thresholdDescription: 'y',
      detectedAtIso: '2026-08-11T12:00:00.000Z',
    });
    expect(md).toContain('(遷移履歴なし)');
  });

  test('evidenceLines render a ## 検出証拠 section as bullet lines', () => {
    const md = formatIncidentDetail({
      state: baseState,
      explanation: 'x',
      thresholdDescription: 'y',
      detectedAtIso: '2026-08-11T12:00:00.000Z',
      evidenceLines: [
        '実行cwd: C:\\Projects\\rapitas\\rapitas-backend',
        'テーマ作業ディレクトリ: C:\\Projects\\ime-live-converter',
      ],
    });
    expect(md).toContain('## 検出証拠');
    expect(md).toContain('- 実行cwd: C:\\Projects\\rapitas\\rapitas-backend');
    expect(md).toContain('- テーマ作業ディレクトリ: C:\\Projects\\ime-live-converter');
  });

  test('omitting evidenceLines keeps the original sections without 検出証拠 (backward compat)', () => {
    const md = formatIncidentDetail({
      state: baseState,
      explanation: 'x',
      thresholdDescription: 'y',
      detectedAtIso: '2026-08-11T12:00:00.000Z',
    });
    expect(md).not.toContain('## 検出証拠');
    const mdEmpty = formatIncidentDetail({
      state: baseState,
      explanation: 'x',
      thresholdDescription: 'y',
      detectedAtIso: '2026-08-11T12:00:00.000Z',
      evidenceLines: [],
    });
    expect(mdEmpty).not.toContain('## 検出証拠');
  });

  test('a session-less task renders the no-session fallback', () => {
    const md = formatIncidentDetail({
      state: {
        ...baseState,
        latestSessionId: null,
        latestSessionStatus: null,
        latestExecutionId: null,
        latestExecutionStatus: null,
      },
      explanation: 'x',
      thresholdDescription: 'y',
      detectedAtIso: '2026-08-11T12:00:00.000Z',
    });
    expect(md).toContain('(セッションなし)');
  });
});
