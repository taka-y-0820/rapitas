/**
 * task-mutations ユニットテスト（updateTask: フィールド更新ロジック）
 *
 * updateTask のフィールドマッピング・ストリーク記録・タスク未検出エラーを検証する。
 * ラベル更新・actualHours再計算は task-mutations.update-misc.test.ts に、
 * 副作用系（通知・SSE・サブタスク完了連携）は task-mutations.update-effects.test.ts /
 * task-mutations.update-broadcast.test.ts に分割している（300行制限のため）。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// HACK(agent): bun:test の mock.module はプロセスグローバルなため、
// 全エクスポートをミラーしないとバレルが "export not found" をスローする。
const noopLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  fatal: () => {},
};
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

mock.module('../../src/services/user-behavior-service', () => ({
  UserBehaviorService: {
    recordTaskCreated: mock(() => Promise.resolve()),
    recordTaskStarted: mock(() => Promise.resolve()),
    recordTaskCompleted: mock(() => Promise.resolve()),
    recordBehavior: mock(() => Promise.resolve()),
  },
}));

mock.module('../communication/notification-service', () => ({
  notifyTaskCompleted: mock(() => Promise.resolve()),
  createNotification: mock(() => Promise.resolve({ id: 1 })),
  notifyAgentExecutionCompleted: mock(() => Promise.resolve()),
  notifyApprovalRequested: mock(() => Promise.resolve()),
  notifyAuthenticationFailure: mock(() => Promise.resolve()),
  notifyPomodoroCompleted: mock(() => Promise.resolve()),
  AUTH_FAILURE_NOTIFICATION_TITLE: 'Claude 認証切れ',
}));

mock.module('../scheduling/recurring-task-service', () => ({
  calculateNextOccurrence: mock(() => null),
  setTaskRecurrence: mock(() => Promise.resolve({})),
  removeTaskRecurrence: mock(() => Promise.resolve({})),
  generateNextTaskInstance: mock(() => Promise.resolve(null)),
  processAllPendingRecurrences: mock(() => Promise.resolve([])),
  onGeneratedTaskCompleted: mock(() => Promise.resolve()),
  getUpcomingOccurrences: mock(() => []),
  getGeneratedTasks: mock(() => Promise.resolve([])),
  RECURRENCE_PRESETS: {},
}));

mock.module('./task-create-helpers', () => ({
  createSubtask: mock(() => Promise.resolve(null)),
  createParentTask: mock(() => Promise.resolve(null)),
}));

mock.module('../communication/realtime-service', () => ({
  realtimeService: { sendTaskUpdate: mock(() => {}), broadcast: mock(() => {}) },
  RealtimeService: class {},
}));

mock.module('../scheduling/task-calendar-sync', () => ({
  syncTaskToCalendar: mock(() => Promise.resolve()),
  syncCalendarToTask: mock(() => Promise.resolve()),
}));

mock.module('../search/search-miss-service', () => ({
  recordSearchMiss: mock(() => Promise.resolve()),
  getTopMissedQueries: mock(() => Promise.resolve([])),
  getRelatedMisses: mock(() => Promise.resolve([])),
  getMissAnalytics: mock(() => Promise.resolve({})),
  linkTaskToMiss: mock(() => Promise.resolve()),
  autoLinkMatchingMisses: mock(() => Promise.resolve()),
  resolveSearchMissForTask: mock(() => Promise.resolve()),
}));

mock.module('../workflow/subtask-completion-handler', () => ({
  isSubtaskFinished: mock(() => false),
  isSubtaskFailed: mock(() => false),
  isSubtaskPassed: mock(() => false),
  isParentFinalizable: mock(() => false),
  onSubtaskCompleted: mock(() => Promise.resolve()),
}));

mock.module('../memory/task-knowledge-extractor', () => ({
  extractKnowledgeFromTask: mock(() => Promise.resolve([])),
  reflectOnFailure: mock(() => Promise.resolve([])),
  findRelatedKnowledge: mock(() => Promise.resolve([])),
  searchCrossProjectKnowledge: mock(() => Promise.resolve([])),
}));

const { updateTask } = await import('./task-mutations');

function createMockPrisma() {
  return {
    task: {
      findUnique: mock(() => Promise.resolve(null)) as ReturnType<typeof mock>,
      update: mock(() => Promise.resolve({})) as ReturnType<typeof mock>,
      findMany: mock(() => Promise.resolve([])) as ReturnType<typeof mock>,
    },
    taskLabel: {
      deleteMany: mock(() => Promise.resolve({ count: 0 })) as ReturnType<typeof mock>,
      createMany: mock(() => Promise.resolve({ count: 0 })) as ReturnType<typeof mock>,
    },
    studyStreak: {
      upsert: mock(() => Promise.resolve({})) as ReturnType<typeof mock>,
    },
    activityLog: {
      create: mock(() => Promise.resolve({})) as ReturnType<typeof mock>,
    },
  };
}

let mockPrisma = createMockPrisma();

/** Queues the two sequential `task.findUnique` calls (current-state fetch, then post-update fetch). */
function setupFindUnique(
  current: Record<string, unknown> | null,
  updated: Record<string, unknown> | null,
) {
  mockPrisma.task.findUnique.mockResolvedValueOnce(current).mockResolvedValueOnce(updated);
}

beforeEach(() => {
  mockPrisma = createMockPrisma();
});

describe('updateTask — タスク未検出', () => {
  test('currentTask が存在しない場合、エラーをスローすること', async () => {
    mockPrisma.task.findUnique.mockResolvedValueOnce(null);

    await expect(updateTask(mockPrisma as never, 999, { title: 'X' })).rejects.toThrow(
      'タスク(ID: 999)が見つかりません',
    );
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });
});

describe('updateTask — ストリーク記録', () => {
  test('status=done の場合、studyStreak.upsert を呼ぶこと', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'done', parentId: null });

    await updateTask(mockPrisma as never, 1, { status: 'done' });

    expect(mockPrisma.studyStreak.upsert).toHaveBeenCalledTimes(1);
    const call = mockPrisma.studyStreak.upsert.mock.calls[0]![0] as {
      where: { date: Date };
      create: { tasksCompleted: number };
    };
    expect(call.where.date.getHours()).toBe(0);
    expect(call.create.tasksCompleted).toBe(1);
  });

  test('status が done 以外の場合、studyStreak.upsert を呼ばないこと', async () => {
    setupFindUnique(
      { status: 'todo', parentId: null },
      { id: 1, status: 'in-progress', parentId: null },
    );

    await updateTask(mockPrisma as never, 1, { status: 'in-progress' });

    expect(mockPrisma.studyStreak.upsert).not.toHaveBeenCalled();
  });
});

describe('updateTask — フィールドマッピング', () => {
  test('未定義フィールドは update data に含めないこと', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'todo', parentId: null });

    await updateTask(mockPrisma as never, 1, {});

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Object.keys(call.data)).toEqual([]);
  });

  test('themeId=0（falsy値）でも update data に含めること', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'todo', parentId: null });

    await updateTask(mockPrisma as never, 1, { themeId: 0 });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { themeId?: number } };
    expect(call.data.themeId).toBe(0);
  });

  test('estimatedHours=0 でも update data に含めること', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'todo', parentId: null });

    await updateTask(mockPrisma as never, 1, { estimatedHours: 0 });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { estimatedHours?: number } };
    expect(call.data.estimatedHours).toBe(0);
  });

  test('estimatedHours=null（クリア）でも update data に含めること', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'todo', parentId: null });

    await updateTask(mockPrisma as never, 1, { estimatedHours: null });

    const call = mockPrisma.task.update.mock.calls[0]![0] as {
      data: { estimatedHours?: number | null };
    };
    expect(call.data.estimatedHours).toBeNull();
  });

  test('dueDate が文字列の場合、Date に変換すること', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'todo', parentId: null });

    await updateTask(mockPrisma as never, 1, { dueDate: '2026-01-01' });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { dueDate?: Date } };
    expect(call.data.dueDate).toBeInstanceOf(Date);
  });

  test('dueDate=null の場合、null をセットすること', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'todo', parentId: null });

    await updateTask(mockPrisma as never, 1, { dueDate: null });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { dueDate?: Date | null } };
    expect(call.data.dueDate).toBeNull();
  });

  test('status=done の場合、completedAt を設定すること', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'done', parentId: null });

    await updateTask(mockPrisma as never, 1, { status: 'done' });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { completedAt?: Date } };
    expect(call.data.completedAt).toBeInstanceOf(Date);
  });

  test('status=done かつ workflowStatus が completed 以外の場合、workflowStatus を completed にすること', async () => {
    setupFindUnique(
      { status: 'in-progress', parentId: null, workflowStatus: 'in_progress' },
      { id: 1, status: 'done', parentId: null },
    );

    await updateTask(mockPrisma as never, 1, { status: 'done' });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { workflowStatus?: string } };
    expect(call.data.workflowStatus).toBe('completed');
  });

  test('workflowStatus が既に completed の場合、更新しないこと', async () => {
    setupFindUnique(
      { status: 'in-progress', parentId: null, workflowStatus: 'completed' },
      { id: 1, status: 'done', parentId: null },
    );

    await updateTask(mockPrisma as never, 1, { status: 'done' });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { workflowStatus?: string } };
    expect(call.data.workflowStatus).toBeUndefined();
  });

  test('workflowStatus が未設定（通常タスク）の場合、workflowStatus を触らないこと', async () => {
    setupFindUnique(
      { status: 'in-progress', parentId: null, workflowStatus: null },
      { id: 1, status: 'done', parentId: null },
    );

    await updateTask(mockPrisma as never, 1, { status: 'done' });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { workflowStatus?: string } };
    expect(call.data.workflowStatus).toBeUndefined();
  });

  test('status=in-progress かつ現在 in-progress でない場合、startedAt を設定すること', async () => {
    setupFindUnique(
      { status: 'todo', parentId: null },
      { id: 1, status: 'in-progress', parentId: null },
    );

    await updateTask(mockPrisma as never, 1, { status: 'in-progress' });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { startedAt?: Date } };
    expect(call.data.startedAt).toBeInstanceOf(Date);
  });

  test('既に in-progress の場合、startedAt を再設定しないこと', async () => {
    setupFindUnique(
      { status: 'in-progress', parentId: null },
      { id: 1, status: 'in-progress', parentId: null },
    );

    await updateTask(mockPrisma as never, 1, { status: 'in-progress' });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { startedAt?: Date } };
    expect(call.data.startedAt).toBeUndefined();
  });

  test('goals/constraints/acceptanceCriteria を JSON 文字列化すること', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'todo', parentId: null });

    await updateTask(mockPrisma as never, 1, {
      goals: ['g1'],
      constraints: ['c1'],
      acceptanceCriteria: ['a1'],
    });

    const call = mockPrisma.task.update.mock.calls[0]![0] as {
      data: { goals?: string; constraints?: string; acceptanceCriteria?: string };
    };
    expect(call.data.goals).toBe(JSON.stringify(['g1']));
    expect(call.data.constraints).toBe(JSON.stringify(['c1']));
    expect(call.data.acceptanceCriteria).toBe(JSON.stringify(['a1']));
  });

  test('isProtected=false（falsy値）でも update data に含めること', async () => {
    setupFindUnique({ status: 'todo', parentId: null }, { id: 1, status: 'todo', parentId: null });

    await updateTask(mockPrisma as never, 1, { isProtected: false });

    const call = mockPrisma.task.update.mock.calls[0]![0] as { data: { isProtected?: boolean } };
    expect(call.data.isProtected).toBe(false);
  });
});

describe('manual hold revision', () => {
  test('a re-block advances the revision and conditions the write on the observed version', async () => {
    const revision = new Date(Date.now() + 60_000);
    setupFindUnique({ status: 'blocked', updatedAt: revision }, { id: 1, status: 'blocked' });
    await updateTask(mockPrisma as never, 1, { status: 'blocked' });
    const call = mockPrisma.task.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 1, updatedAt: revision });
    expect(call.data.updatedAt.getTime()).toBe(revision.getTime() + 1);
    expect(call.data.status).toBe('blocked');
  });

  test('a conflicting manual hold write reports failure instead of claiming success', async () => {
    setupFindUnique({ status: 'blocked', updatedAt: new Date() }, null);
    mockPrisma.task.update.mockRejectedValueOnce(new Error('revision conflict'));
    await expect(updateTask(mockPrisma as never, 1, { status: 'blocked' })).rejects.toThrow(
      'revision conflict',
    );
    expect(mockPrisma.activityLog.create).not.toHaveBeenCalled();
  });
});
