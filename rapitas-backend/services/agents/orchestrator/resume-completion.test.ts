/**
 * resume-completion ユニットテスト
 *
 * handleResumeCompletion() の完了ハンドラを検証する。ResumeLockConflictError
 * は良性スキップとして task.status/agentSession.status を変更せず、通常の
 * Error は従来通り task.status を 'todo' に戻すことを確認する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ── Module-level mocks（import 前に宣言） ──────────────────────────────────────
// NOTE: mock.module はプロセスグローバル。他のテストファイルと同時実行すると
// mock が衝突するため、このファイルは単体（bun test <this file>）で実行する。

const taskUpdateMock = mock(async () => ({}));
let taskRow: { status: string; workflowStatus: string | null };
const taskUpdateManyMock = mock(
  async (args: {
    where: { id: number; status: { in: string[] }; workflowStatus?: string };
    data: { status: string };
  }) => {
    if (!args.where.status.in.includes(taskRow.status)) return { count: 0 };
    if (args.where.workflowStatus && args.where.workflowStatus !== taskRow.workflowStatus)
      return { count: 0 };
    taskRow.status = args.data.status;
    return { count: 1 };
  },
);
const agentSessionUpdateMock = mock(async () => ({}));
const notificationCreateMock = mock(async () => ({}));
const taskFindUniqueMock = mock(async () => taskRow);

mock.module('../../../config', () => ({
  prisma: {
    task: {
      update: taskUpdateMock,
      updateMany: taskUpdateManyMock,
      findUnique: taskFindUniqueMock,
    },
    agentSession: { updateMany: agentSessionUpdateMock },
    notification: { create: notificationCreateMock },
  },
  ensureDatabaseConnection: mock(async () => {}),
  logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) }),
  getDbProvider: () => 'PostgreSQL',
  getInsensitiveMode: () => ({}),
  getProjectRoot: () => 'C:\\Projects\\rapitas',
}));

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) }),
}));

let resumeInterruptedExecutionMock = mock(async () => ({ success: true, waitingForInput: false }));

mock.module('../../core/orchestrator-instance', () => ({
  orchestrator: {
    resumeInterruptedExecution: (...args: unknown[]) => resumeInterruptedExecutionMock(...args),
    getFullGitDiff: mock(async () => 'No changes detected'),
  },
}));

// ── 動的 import（全 mock.module 宣言後） ──────────────────────────────────────

const { handleResumeCompletion } = await import('./resume-completion');
const { ResumeLockConflictError } = await import('./execution-resume');

// ── ヘルパー ──────────────────────────────────────────────────────────────────

const TASK = {
  id: 5,
  title: 'テストタスク',
  description: null,
  theme: { name: 'テーマ', workingDirectory: 'C:\\Users\\test\\project' },
};

const EXECUTION = {
  sessionId: 20,
  session: { config: { id: 1, taskId: 5 } },
};

/** マイクロタスク/タイマーキューを flush して fire-and-forget チェーンの完了を待つ。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(() => {
  taskRow = { status: 'in-progress', workflowStatus: 'in_progress' };
  resumeInterruptedExecutionMock = mock(async () => ({ success: true, waitingForInput: false }));
  taskUpdateMock.mockClear();
  taskUpdateManyMock.mockClear();
  agentSessionUpdateMock.mockClear();
  notificationCreateMock.mockClear();
  taskFindUniqueMock.mockClear();
});

describe('resume completion respects task completion gates', () => {
  test.each([
    'draft',
    'research_done',
    'plan_created',
    'plan_approved',
    'in_progress',
    'verify_done',
    'awaiting_question',
    null,
  ])('successful CLI with workflow %s does not complete the task', async (workflowStatus) => {
    taskRow.workflowStatus = workflowStatus;
    handleResumeCompletion(10, EXECUTION, TASK, TASK.theme.workingDirectory, 900_000);
    await flush();
    expect(taskUpdateMock).not.toHaveBeenCalled();
    expect(taskRow.status).toBe('in-progress');
    expect(taskUpdateManyMock).not.toHaveBeenCalled();
  });

  test('only a completed workflow may complete an active task', async () => {
    taskRow.workflowStatus = 'completed';
    handleResumeCompletion(10, EXECUTION, TASK, TASK.theme.workingDirectory, 900_000);
    await flush();
    expect(taskRow.status).toBe('done');
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  test.each(['cancelled', 'blocked', 'done', 'todo'])(
    'a late success does not overwrite task status %s',
    async (status) => {
      taskRow = { status, workflowStatus: 'completed' };
      handleResumeCompletion(10, EXECUTION, TASK, TASK.theme.workingDirectory, 900_000);
      await flush();
      expect(taskRow.status).toBe(status);
      expect(taskUpdateMock).not.toHaveBeenCalled();
    },
  );

  test.each(['cancelled', 'blocked', 'done', 'todo'])(
    'a late error does not requeue task status %s',
    async (status) => {
      taskRow.status = status;
      resumeInterruptedExecutionMock = mock(async () => {
        throw new Error('late failure');
      });
      handleResumeCompletion(10, EXECUTION, TASK, TASK.theme.workingDirectory, 900_000);
      await flush();
      expect(taskRow.status).toBe(status);
      expect(taskUpdateMock).not.toHaveBeenCalled();
    },
  );
});

describe('handleResumeCompletion() — ResumeLockConflictError', () => {
  test('ResumeLockConflictError の reject では task.status / agentSession.status を変更しない', async () => {
    resumeInterruptedExecutionMock = mock(async () => {
      throw new ResumeLockConflictError(TASK.id);
    });

    handleResumeCompletion(10, EXECUTION, TASK, TASK.theme.workingDirectory, 900_000);
    await flush();

    expect(taskUpdateMock).not.toHaveBeenCalled();
    expect(agentSessionUpdateMock).not.toHaveBeenCalled();
  });

  test('name プロパティのみで ResumeLockConflictError と判定できる場合も同様にスキップする', async () => {
    const nameOnlyError = new Error('lock conflict');
    nameOnlyError.name = 'ResumeLockConflictError';
    resumeInterruptedExecutionMock = mock(async () => {
      throw nameOnlyError;
    });

    handleResumeCompletion(10, EXECUTION, TASK, TASK.theme.workingDirectory, 900_000);
    await flush();

    expect(taskUpdateMock).not.toHaveBeenCalled();
    expect(agentSessionUpdateMock).not.toHaveBeenCalled();
  });
});

describe('handleResumeCompletion() — 通常エラーの既存挙動（回帰）', () => {
  test('通常の Error では task.status を todo に戻す', async () => {
    resumeInterruptedExecutionMock = mock(async () => {
      throw new Error('unexpected failure');
    });

    handleResumeCompletion(10, EXECUTION, TASK, TASK.theme.workingDirectory, 900_000);
    await flush();

    expect(taskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TASK.id, status: { in: ['in-progress'] } },
        data: { status: 'todo' },
      }),
    );
    expect(agentSessionUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: EXECUTION.sessionId, status: { in: ['pending', 'running'] } },
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});
