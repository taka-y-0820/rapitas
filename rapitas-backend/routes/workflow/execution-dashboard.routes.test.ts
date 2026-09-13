/**
 * execution-dashboard routes テスト
 *
 * GET /workflow/execution-dashboard の一覧集計・50件超過時のtruncated、
 * GET /execution-dashboard/:taskId のドリルダウン、GET /execution-dashboard/export
 * のCSV生成・404ケースを検証する(task #870)。
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';

const findFirstUserSettings = mock(() =>
  Promise.resolve({ executionStallThresholdMinutes: 5 }),
) as ReturnType<typeof mock>;
const findManyQueueItems = mock(() => Promise.resolve([])) as ReturnType<typeof mock>;
const findFirstQueueItem = mock(() => Promise.resolve(null)) as ReturnType<typeof mock>;
const findManyTasks = mock(() => Promise.resolve([])) as ReturnType<typeof mock>;
const findUniqueTask = mock(() => Promise.resolve(null)) as ReturnType<typeof mock>;
const findFirstTransition = mock(() => Promise.resolve(null)) as ReturnType<typeof mock>;
const findManyTransitions = mock(() => Promise.resolve([])) as ReturnType<typeof mock>;
const countTransitions = mock(() => Promise.resolve(0)) as ReturnType<typeof mock>;

const mockPrisma = {
  userSettings: { findFirst: findFirstUserSettings },
  workflowQueueItem: { findMany: findManyQueueItems, findFirst: findFirstQueueItem },
  task: { findMany: findManyTasks, findUnique: findUniqueTask },
  workflowTransition: {
    findFirst: findFirstTransition,
    findMany: findManyTransitions,
    count: countTransitions,
  },
};

mock.module('../../config', () => ({
  prisma: mockPrisma,
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { executionDashboardRoutes } = await import('./execution-dashboard.routes');

const BASE = 'http://localhost/workflow';

function resetMocks() {
  findFirstUserSettings.mockReset();
  findFirstUserSettings.mockResolvedValue({ executionStallThresholdMinutes: 5 });
  findManyQueueItems.mockReset();
  findManyQueueItems.mockResolvedValue([]);
  findFirstQueueItem.mockReset();
  findFirstQueueItem.mockResolvedValue(null);
  findManyTasks.mockReset();
  findManyTasks.mockResolvedValue([]);
  findUniqueTask.mockReset();
  findUniqueTask.mockResolvedValue(null);
  findFirstTransition.mockReset();
  findFirstTransition.mockResolvedValue(null);
  findManyTransitions.mockReset();
  findManyTransitions.mockResolvedValue([]);
  countTransitions.mockReset();
  countTransitions.mockResolvedValue(0);
}

describe('GET /workflow/execution-dashboard', () => {
  beforeEach(resetMocks);

  test('returns derived state for each active task', async () => {
    findManyQueueItems.mockResolvedValue([
      {
        taskId: 870,
        themeId: 1,
        status: 'running',
        currentPhase: 'verify',
        queuedAt: new Date(),
        startedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    findManyTasks.mockResolvedValue([{ id: 870, title: 'テストタスク', themeId: 1 }]);
    findFirstTransition.mockResolvedValue({ cause: 'verify_repair' });
    countTransitions.mockResolvedValue(2);

    const res = await executionDashboardRoutes.handle(new Request(`${BASE}/execution-dashboard`));
    const body = (await res.json()) as {
      success: boolean;
      stallThresholdMinutes: number;
      truncated: boolean;
      tasks: Array<{
        taskId: number;
        state: string;
        repairCount: number;
        frequentFailure: boolean;
      }>;
    };

    expect(body.success).toBe(true);
    expect(body.stallThresholdMinutes).toBe(5);
    expect(body.truncated).toBe(false);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].taskId).toBe(870);
    expect(body.tasks[0].state).toBe('repairing');
    expect(body.tasks[0].repairCount).toBe(2);
    expect(body.tasks[0].frequentFailure).toBe(false);
  });

  test('marks truncated=true and reports totalActiveCount when over 50 tasks', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      taskId: i + 1,
      themeId: null,
      status: 'queued',
      currentPhase: 'draft',
      queuedAt: new Date(),
      startedAt: null,
      updatedAt: new Date(),
    }));
    findManyQueueItems.mockResolvedValue(items);
    findManyTasks.mockResolvedValue([]);

    const res = await executionDashboardRoutes.handle(new Request(`${BASE}/execution-dashboard`));
    const body = (await res.json()) as {
      truncated: boolean;
      totalActiveCount: number;
      tasks: unknown[];
    };

    expect(body.truncated).toBe(true);
    expect(body.totalActiveCount).toBe(60);
    expect(body.tasks).toHaveLength(50);
  });
});

describe('GET /workflow/execution-dashboard/:taskId', () => {
  beforeEach(resetMocks);

  test('returns transitions in chronological order', async () => {
    const t1 = new Date('2026-09-07T09:00:00.000Z');
    const t2 = new Date('2026-09-07T09:05:00.000Z');
    findFirstQueueItem.mockResolvedValue({
      taskId: 870,
      status: 'waiting_approval',
      currentPhase: 'verify',
      queuedAt: t1,
      startedAt: t1,
      updatedAt: t2,
    });
    findUniqueTask.mockResolvedValue({ title: 'テストタスク', themeId: 1 });
    findManyTransitions.mockResolvedValue([
      {
        id: 1,
        fromStatus: null,
        toStatus: 'running',
        cause: 'auto_advance',
        phase: 'implement',
        actor: 'system',
        createdAt: t1,
      },
      {
        id: 2,
        fromStatus: 'running',
        toStatus: 'waiting_approval',
        cause: 'file_saved:verify',
        phase: 'verify',
        actor: 'implementer',
        createdAt: t2,
      },
    ]);

    const res = await executionDashboardRoutes.handle(
      new Request(`${BASE}/execution-dashboard/870`),
    );
    const body = (await res.json()) as {
      success: boolean;
      state: string;
      transitions: Array<{ id: number; createdAt: string }>;
    };

    expect(body.success).toBe(true);
    expect(body.state).toBe('awaiting_judgement');
    expect(body.transitions).toHaveLength(2);
    expect(body.transitions[0].id).toBe(1);
    expect(body.transitions[1].id).toBe(2);
  });

  test('returns 404 when the task has no queue item', async () => {
    findFirstQueueItem.mockResolvedValue(null);

    const res = await executionDashboardRoutes.handle(
      new Request(`${BASE}/execution-dashboard/999999`),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });
});

describe('GET /workflow/execution-dashboard/export', () => {
  beforeEach(resetMocks);

  test('returns 404 when taskId is specified but not found', async () => {
    findUniqueTask.mockResolvedValue(null);

    const res = await executionDashboardRoutes.handle(
      new Request(`${BASE}/execution-dashboard/export?taskId=999999`),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  test('returns CSV with header and data rows for a valid taskId', async () => {
    findUniqueTask.mockResolvedValue({ id: 870 });
    findManyTransitions.mockResolvedValue([
      {
        id: 1,
        taskId: 870,
        fromStatus: null,
        toStatus: 'running',
        cause: 'auto_advance',
        phase: 'implement',
        actor: 'system',
        createdAt: new Date('2026-09-07T09:00:00.000Z'),
      },
    ]);
    findManyTasks.mockResolvedValue([{ id: 870, title: 'テストタスク' }]);

    const res = await executionDashboardRoutes.handle(
      new Request(`${BASE}/execution-dashboard/export?taskId=870`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const text = await res.text();
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'taskId,taskTitle,transitionId,fromStatus,toStatus,cause,phase,actor,createdAt',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('870');
    expect(lines[1]).toContain('テストタスク');
  });

  test('returns JSON rows when format=json', async () => {
    findUniqueTask.mockResolvedValue({ id: 870 });
    findManyTransitions.mockResolvedValue([
      {
        id: 1,
        taskId: 870,
        fromStatus: null,
        toStatus: 'running',
        cause: 'auto_advance',
        phase: 'implement',
        actor: 'system',
        createdAt: new Date('2026-09-07T09:00:00.000Z'),
      },
    ]);
    findManyTasks.mockResolvedValue([{ id: 870, title: 'テストタスク' }]);

    const res = await executionDashboardRoutes.handle(
      new Request(`${BASE}/execution-dashboard/export?taskId=870&format=json`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const rows = (await res.json()) as Array<{ taskId: number; taskTitle: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBe(870);
    expect(rows[0].taskTitle).toBe('テストタスク');
  });
});
