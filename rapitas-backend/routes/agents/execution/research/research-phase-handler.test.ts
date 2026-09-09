/**
 * research-phase-handler.test
 *
 * Focused coverage for the manual-execution research harvest: the
 * critic-rejection guard (task 539 resurrection bug) and the normal
 * save-and-advance path.
 */
import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';
import {
  acquireTaskExecutionLock,
  getTaskExecutionLockOwner,
  releaseTaskExecutionLock,
} from '../../../../services/agents/task-execution-lock';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const mockSessionFindUnique = mock(() =>
  Promise.resolve<{ startedAt: Date | null; createdAt: Date } | null>({
    startedAt: new Date('2026-08-07T17:05:00Z'),
    createdAt: new Date('2026-08-07T17:04:00Z'),
  }),
);
const mockSessionUpdate = mock(() => Promise.resolve({}));
const mockTaskUpdate = mock(() => Promise.resolve({}));
const mockTaskFindUnique = mock(() =>
  Promise.resolve<{ workflowStatus: string; workflowMode: string; updatedAt: Date } | null>({
    workflowStatus: 'draft',
    workflowMode: 'standard',
    updatedAt: new Date('2026-09-09T18:00:00Z'),
  }),
);
const mockExecUpdateMany = mock(() => Promise.resolve({ count: 1 }));
const mockExecFindFirst = mock(() => Promise.resolve(null));

mock.module('../../../../config/database', () => ({
  prisma: {
    agentSession: { findUnique: mockSessionFindUnique, update: mockSessionUpdate },
    task: { update: mockTaskUpdate, findUnique: mockTaskFindUnique },
    agentExecution: { updateMany: mockExecUpdateMany, findFirst: mockExecFindFirst },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../../../../config/logger', () => ({ createLogger: () => noopLogger }));

const recordTransition = mock(() => Promise.resolve());
mock.module('../../../../services/workflow/transition-recorder', () => ({ recordTransition }));

mock.module('../../../../services/workflow/completion-gate', () => ({
  researchConcludesNoChange: (content: string) => content.includes('## 結論: 修正不要'),
}));
mock.module('../../../../services/workflow/workflow-invariants', () => ({
  checkWorkflowInvariants: () => Promise.resolve([]),
}));

mock.module('./research-output-utils', () => ({
  isIsolatedWorktree: () => true,
  validateResearchReport: () => ({ ok: true, missingSections: [], reason: '' }),
  extractFinalAgentMessage: (s: string) => s,
  sliceResearchReport: (s: string) => (s.includes('# 調査レポート') ? s : null),
}));

// git diff / reset / clean — always "clean tree" so the revert path is a no-op.
mock.module('node:child_process', () => ({
  exec: (
    _cmd: string,
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => cb(null, { stdout: '', stderr: '' }),
}));

const mockCriticRejectedSince = mock(() => Promise.resolve(false));
mock.module('../../../../services/workflow/phase-critic/critic-rejection-guard', () => ({
  criticRejectedSince: mockCriticRejectedSince,
}));

const mockWriteWorkflowFile = mock(() => Promise.resolve());
const mockResolveWorkflowDir = mock(() => Promise.resolve({ task: { id: 539 } }));
const mockReadWorkflowFile = mock<() => Promise<string | null>>(() => Promise.resolve(null));
mock.module('../../../../services/workflow/workflow-file-utils', () => ({
  writeWorkflowFile: mockWriteWorkflowFile,
  resolveWorkflowDir: mockResolveWorkflowDir,
  readWorkflowFile: mockReadWorkflowFile,
}));
mock.module('../../../../services/workflow/research-complexity', () => ({
  applyResearchAssessedComplexity: () => Promise.resolve(),
}));
mock.module('../../../../services/memory/timeline', () => ({
  appendEvent: () => Promise.resolve(),
}));

const advance = mock(async () => ({ success: true }));
mock.module('../../../../services/workflow/workflow-orchestrator', () => ({
  WorkflowOrchestrator: { getInstance: () => ({ advanceWorkflow: advance }) },
}));
const { handleResearchResult } = await import('./research-phase-handler');

const REPORT = '# 調査レポート\n\n## 前提監査\n本文';

function baseParams() {
  return {
    result: { success: true, output: REPORT },
    taskIdNum: 539,
    sessionId: 2088,
    executionDir: 'C:/tmp/worktree-539',
  };
}

describe('handleResearchResult — critic-rejection guard', () => {
  beforeEach(() => {
    mockSessionFindUnique.mockClear();
    mockSessionUpdate.mockClear();
    mockTaskUpdate.mockClear();
    mockTaskFindUnique.mockClear();
    mockExecUpdateMany.mockClear();
    mockWriteWorkflowFile.mockClear();
    mockReadWorkflowFile.mockReset().mockResolvedValue(null);
    mockCriticRejectedSince.mockReset().mockResolvedValue(false);
  });

  test('stop during the final task read does not complete or advance the research run', async () => {
    mockTaskFindUnique.mockImplementationOnce(async () => {
      releaseTaskExecutionLock(539);
      return { workflowStatus: 'draft', workflowMode: 'standard', updatedAt: new Date() };
    });
    await handleResearchResult(baseParams());
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
    expect(mockExecUpdateMany).not.toHaveBeenCalled();
  });

  test('a concurrent task update prevents session completion after a failed conditional write', async () => {
    mockTaskUpdate.mockRejectedValueOnce(new Error('record changed'));
    await handleResearchResult(baseParams());
    expect(mockTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 539, updatedAt: new Date('2026-09-09T18:00:00Z') },
      }),
    );
    expect(mockSessionUpdate).not.toHaveBeenCalled();
    expect(mockExecUpdateMany).not.toHaveBeenCalled();
  });

  for (const stopped of [false, true]) {
    test(`deferred advance ${stopped ? 'is revoked by stop' : 'survives normal lease release'}`, async () => {
      advance.mockClear();
      acquireTaskExecutionLock(539);
      const owner = getTaskExecutionLockOwner(539)!;
      let queued!: () => Promise<void>;
      const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: () => Promise<void>,
      ) => {
        queued = callback;
        return 0;
      }) as typeof setTimeout);
      try {
        await handleResearchResult(baseParams());
        releaseTaskExecutionLock(539, stopped ? undefined : owner);
        await queued();
        expect(advance).toHaveBeenCalledTimes(stopped ? 0 : 1);
      } finally {
        timer.mockRestore();
        releaseTaskExecutionLock(539, owner);
      }
    });
  }

  test('critic 差し戻し後は research.md を再保存せず、ワークフローも前進させない', async () => {
    mockCriticRejectedSince.mockResolvedValue(true);
    await handleResearchResult(baseParams());

    expect(mockWriteWorkflowFile).not.toHaveBeenCalled();
    // No status advance and no blocked-marking — the critic rollback owns it.
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    // The session is still closed and the execution flipped off post_processing.
    expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
    const sessionArg = (
      mockSessionUpdate.mock.calls[0] as unknown as [{ data: { status: string } }]
    )[0];
    expect(sessionArg.data.status).toBe('completed');
    expect(mockExecUpdateMany).toHaveBeenCalled();
    // NOTE: completedAt は CLI 終了時に記録済み。フリップでの再スタンプは
    // 批評ゲートの所要時間を wall へ混入させるため上書きしない（task #560）。
    const flipArg = (
      mockExecUpdateMany.mock.calls[0] as unknown as [{ data: { completedAt?: Date } }]
    )[0];
    expect(flipArg.data.completedAt).toBeUndefined();
  });

  test('差し戻しが無ければ保存してワークフローを前進させる', async () => {
    await handleResearchResult(baseParams());

    expect(mockCriticRejectedSince).toHaveBeenCalledWith(539, 'research', expect.any(Date));
    expect(mockWriteWorkflowFile).toHaveBeenCalledWith(539, 'research', REPORT);
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 539, updatedAt: new Date('2026-09-09T18:00:00Z') },
      data: { status: 'in-progress', workflowStatus: 'research_done' },
    });
  });

  test('no-change research preserves verification and completion gates', async () => {
    const params = baseParams();
    params.result.output += '\n\n## 結論: 修正不要\nOperational verification remains outstanding.';
    await handleResearchResult(params);

    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 539, updatedAt: new Date('2026-09-09T18:00:00Z') },
      data: { status: 'in-progress', workflowStatus: 'research_done' },
    });
  });

  test('差し戻し後でも改訂済み live 行が存在すれば正常フローに戻る（セッション内回復）', async () => {
    mockCriticRejectedSince.mockResolvedValue(true);
    mockReadWorkflowFile.mockResolvedValue('# 調査結果(改訂版)\n\n本文');
    await handleResearchResult(baseParams());

    // Recovery: the revised artifact supersedes the rejection, so the harvest
    // saves and the workflow advances exactly like the no-rejection path.
    expect(mockWriteWorkflowFile).toHaveBeenCalledWith(539, 'research', REPORT);
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 539, updatedAt: new Date('2026-09-09T18:00:00Z') },
      data: { status: 'in-progress', workflowStatus: 'research_done' },
    });
  });

  test('セッション開始時刻は startedAt を優先して境界に使う', async () => {
    await handleResearchResult(baseParams());
    const since = (mockCriticRejectedSince.mock.calls[0] as unknown as [number, string, Date])[2];
    expect(since.toISOString()).toBe('2026-08-07T17:05:00.000Z');
  });
});
