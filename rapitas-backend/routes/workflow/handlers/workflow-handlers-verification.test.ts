/**
 * workflow-handlers-verification.test
 *
 * Unit tests for the implementer self-verification endpoint handler:
 * invalid id, missing worktree, happy path, gate error, and the per-task
 * in-flight guard. All collaborators are mocked.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const findFirstMock = mock(async (): Promise<unknown> => null);
const taskFindUniqueMock = mock(async (): Promise<unknown> => null);

mock.module('../../../config', () => ({
  prisma: {
    agentSession: { findFirst: findFirstMock },
    task: { findUnique: taskFindUniqueMock },
  },
}));

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), debug: mock(() => {}) }),
}));

const runAutomatedVerificationMock = mock(
  async (): Promise<{ ok: boolean; summary: string; checks: unknown[] }> => ({
    ok: true,
    summary: 'ok',
    checks: [],
  }),
);
const renderVerificationMarkdownMock = mock(() => '# 自動検証\nok');

mock.module('../../../services/agents/verification/automated-verifier', () => ({
  runAutomatedVerification: runAutomatedVerificationMock,
  renderVerificationMarkdown: renderVerificationMarkdownMock,
  // Mirrors the real detector closely enough for the requireTests tests.
  looksLikeBugFixTask: (text: string | null | undefined) =>
    !!text && /(バグ|不具合|クラッシュ|\bbug\b|\bcrash\b)/i.test(text),
}));

const readWorkflowFileMock = mock(async (): Promise<string | null> => null);
mock.module('../../../services/workflow/workflow-file-utils', () => ({
  readWorkflowFile: readWorkflowFileMock,
}));

const resolvePreferredBaseBranchMock = mock(async (): Promise<string | null> => 'develop');
mock.module('../../../services/task/task-resolver', () => ({
  resolvePreferredBaseBranch: resolvePreferredBaseBranchMock,
}));

const { handleRunVerification } = await import('./workflow-handlers-verification');

function ctx(taskId: string) {
  return { params: { taskId }, set: {} as { status?: number | string } };
}

beforeEach(() => {
  findFirstMock.mockClear();
  taskFindUniqueMock.mockClear();
  runAutomatedVerificationMock.mockClear();
  renderVerificationMarkdownMock.mockClear();
  readWorkflowFileMock.mockClear();
  resolvePreferredBaseBranchMock.mockClear();
  findFirstMock.mockImplementation(async () => ({ worktreePath: 'C:/wt/task-1' }));
  taskFindUniqueMock.mockImplementation(async () => null);
  runAutomatedVerificationMock.mockImplementation(async () => ({
    ok: true,
    summary: 'ok',
    checks: [],
  }));
});

describe('handleRunVerification', () => {
  it('rejects a non-numeric task id with 400', async () => {
    const c = ctx('abc');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(400);
    expect(res).toMatchObject({ success: false });
  });

  it('returns 404 when the task has no worktree session', async () => {
    findFirstMock.mockImplementation(async () => null);
    const c = ctx('7');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(404);
    expect(res).toMatchObject({ success: false });
  });

  it('runs the gate on the worktree and returns the measured result', async () => {
    readWorkflowFileMock.mockImplementation(async () => '# plan');
    const c = ctx('7');
    const res = await handleRunVerification(c);
    expect(res).toMatchObject({ success: true, ok: true, summary: 'ok' });
    expect(runAutomatedVerificationMock).toHaveBeenCalledWith(
      'C:/wt/task-1',
      expect.objectContaining({ planContent: '# plan', preferredBaseBranch: 'develop', taskId: 7 }),
    );
    expect(renderVerificationMarkdownMock).toHaveBeenCalledTimes(1);
  });

  it('forces requireTests and passes criteria/taskText for a bug-fix task', async () => {
    taskFindUniqueMock.mockImplementation(async () => ({
      title: '保存時にクラッシュするバグの修正',
      description: '## 受入基準\n- `services/foo/bar.ts` の修正で再現テストが通る',
      acceptanceCriteria: null,
    }));
    const res = await handleRunVerification(ctx('7'));
    expect(res).toMatchObject({ success: true, ok: true });
    expect(runAutomatedVerificationMock).toHaveBeenCalledWith(
      'C:/wt/task-1',
      expect.objectContaining({
        requireTests: true,
        acceptanceCriteria: ['`services/foo/bar.ts` の修正で再現テストが通る'],
        taskText: expect.stringContaining('保存時にクラッシュするバグの修正'),
      }),
    );
  });

  it('does not force requireTests for a non-bug-fix task', async () => {
    taskFindUniqueMock.mockImplementation(async () => ({
      title: '新しいダッシュボード widget を追加する',
      description: '説明のみ（受入基準の見出しなし）',
      acceptanceCriteria: null,
    }));
    await handleRunVerification(ctx('7'));
    expect(runAutomatedVerificationMock).toHaveBeenCalledWith(
      'C:/wt/task-1',
      expect.objectContaining({ requireTests: false }),
    );
    // No criteria resolvable → the option is omitted (acceptance stays fail-open).
    const opts = (runAutomatedVerificationMock.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(opts.acceptanceCriteria).toBeUndefined();
  });

  it('runs the gate with defaults when the task row cannot be loaded', async () => {
    taskFindUniqueMock.mockImplementation(async () => {
      throw new Error('db down');
    });
    const res = await handleRunVerification(ctx('7'));
    expect(res).toMatchObject({ success: true, ok: true });
    expect(runAutomatedVerificationMock).toHaveBeenCalledWith(
      'C:/wt/task-1',
      expect.objectContaining({ requireTests: false }),
    );
  });

  it('passes a failing gate result through as ok:false (not an error)', async () => {
    runAutomatedVerificationMock.mockImplementation(async () => ({
      ok: false,
      summary: 'lint failed',
      checks: [{ name: 'lint', ok: false }],
    }));
    const res = await handleRunVerification(ctx('7'));
    expect(res).toMatchObject({ success: true, ok: false, summary: 'lint failed' });
  });

  it('returns 500 when the gate itself throws, and releases the in-flight slot', async () => {
    runAutomatedVerificationMock.mockImplementation(async () => {
      throw new Error('boom');
    });
    const c = ctx('7');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(500);
    expect(res).toMatchObject({ success: false });
    // Slot released — a follow-up run must reach the gate again.
    runAutomatedVerificationMock.mockImplementation(async () => ({
      ok: true,
      summary: 'ok',
      checks: [],
    }));
    const res2 = await handleRunVerification(ctx('7'));
    expect(res2).toMatchObject({ success: true, ok: true });
  });

  it('rejects a concurrent run for the same task with 429', async () => {
    let release: (() => void) | undefined;
    runAutomatedVerificationMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: 'ok', checks: [] });
        }),
    );
    const first = handleRunVerification(ctx('9'));
    // Give the first call a tick to acquire the slot before the second tries.
    await new Promise((r) => setTimeout(r, 10));
    const c2 = ctx('9');
    const res2 = await handleRunVerification(c2);
    expect(c2.set.status).toBe(429);
    expect(res2).toMatchObject({ success: false });
    release?.();
    const res1 = await first;
    expect(res1).toMatchObject({ success: true, ok: true });
  });
});

it('reserves verification before the session lookup yields', async () => {
  let release!: (value: unknown) => void;
  findFirstMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = handleRunVerification(ctx('897'));
  const secondContext = ctx('897');
  try {
    await handleRunVerification(secondContext);
    expect(secondContext.set.status).toBe(429);
    expect(runAutomatedVerificationMock).not.toHaveBeenCalled();
  } finally {
    release({ worktreePath: 'C:/wt/task-897' });
    await first;
  }
});
it('releases admission after a missing session', async () => {
  findFirstMock.mockImplementationOnce(async () => null);
  expect(await handleRunVerification(ctx('897'))).toMatchObject({ success: false });
  expect(await handleRunVerification(ctx('897'))).toMatchObject({ success: true });
});
