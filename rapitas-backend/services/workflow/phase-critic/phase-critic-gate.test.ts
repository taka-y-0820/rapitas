/**
 * phase-critic-gate テスト（applyPhaseCriticGate）
 *
 * priorBounces カウンタのフェイルクローズ検証: DBカウント失敗時に 0（fail-open）
 * ではなく cap（MAX_BOUNCES）を返し、既存の「予算枯渇時は proceed（fail-open）」
 * 分岐へ確実に流れること（= bounce を無限に繰り返さないこと）を確認する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: mock(() => {}), error: () => {}, debug: () => {} };

const mockPrisma = {
  workflowTransition: {
    count: mock(() => Promise.resolve(0)),
    findFirst: mock(() => Promise.resolve(null as { metadata: string } | null)),
  },
  task: {
    update: mock(() => Promise.resolve({})),
    updateMany: mock(() => Promise.resolve({ count: 1 })),
    findUnique: mock(() =>
      Promise.resolve(
        null as {
          title: string;
          description: string | null;
          acceptanceCriteria: string | null;
        } | null,
      ),
    ),
  },
  workflowFile: {
    findFirst: mock(() => Promise.resolve(null as { content: string } | null)),
  },
};
const recordTransition = mock(() => Promise.resolve());
const critiquePhase = mock(() =>
  Promise.resolve({
    verdict: 'fail' as 'fail' | 'pass' | 'unknown',
    severity: 'high' as const,
    reasons: ['issue A'],
    inputTruncated: false,
  }),
);
const isPhaseCriticEnabled = mock(() => true);
const archiveWorkflowFile = mock(() => Promise.resolve(true));

mock.module('../../../config/logger', () => ({ createLogger: () => noopLogger }));
mock.module('../../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../transition-recorder', () => ({ recordTransition }));
mock.module('../workflow-file-utils', () => ({ archiveWorkflowFile }));
mock.module('./phase-critic', () => ({ critiquePhase, isPhaseCriticEnabled }));
const scheduleWorkflowRedispatch = mock(() => {});
mock.module('../workflow-redispatch', () => ({
  REDISPATCH_DELAY_MS: 1000,
  scheduleWorkflowRedispatch,
}));

const { applyPhaseCriticGate } = await import('./phase-critic-gate');

describe('applyPhaseCriticGate — priorBounces fails CLOSED on DB error', () => {
  beforeEach(() => {
    mockPrisma.workflowTransition.count.mockReset().mockResolvedValue(0);
    mockPrisma.workflowTransition.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.task.update.mockReset().mockResolvedValue({});
    mockPrisma.task.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mockPrisma.task.findUnique.mockReset().mockResolvedValue(null);
    mockPrisma.workflowFile.findFirst.mockReset().mockResolvedValue(null);
    recordTransition.mockReset().mockResolvedValue(undefined);
    critiquePhase.mockReset().mockResolvedValue({
      verdict: 'fail',
      severity: 'high',
      reasons: ['issue A'],
      inputTruncated: false,
    });
    isPhaseCriticEnabled.mockReset().mockReturnValue(true);
    scheduleWorkflowRedispatch.mockClear();
  });

  test('カウント成功・予算内 → bounce する（archiveせず rollback）', async () => {
    mockPrisma.workflowTransition.count.mockResolvedValue(0); // < MAX_BOUNCES(1)
    const result = await applyPhaseCriticGate({
      taskId: 1,
      phase: 'research',
      content: 'bad research',
      currentStatus: 'research_done',
    });
    expect(result.bounced).toBe(true);
    expect(result.newStatus).toBe('draft');
    // bounce後は再生成の再ディスパッチが予約されること（task 547）。
    expect(scheduleWorkflowRedispatch).toHaveBeenCalledTimes(1);
    expect(scheduleWorkflowRedispatch).toHaveBeenCalledWith(1, 'research_critic_failed', 'ja');
    // task 911: bounceのrecordTransitionメタデータにinputTruncatedが記録されること。
    const rt = recordTransition.mock.calls[0]?.[0] as { metadata: { inputTruncated: boolean } };
    expect(rt.metadata.inputTruncated).toBe(false);
  });

  test('records truncated unknown evaluation without changing workflow status', async () => {
    critiquePhase.mockResolvedValueOnce({
      verdict: 'unknown',
      severity: 'high',
      reasons: [],
      inputTruncated: true,
    });
    const result = await applyPhaseCriticGate({
      taskId: 1,
      phase: 'research',
      content: 'long research',
      currentStatus: 'research_done',
    });
    expect(result.bounced).toBe(false);
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
    expect(recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'research_critic_incomplete',
        metadata: expect.objectContaining({ verdict: 'unknown', inputTruncated: true }),
      }),
    );
  });

  test('marks grounding unavailable when the task query fails', async () => {
    mockPrisma.task.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    await applyPhaseCriticGate({
      taskId: 1,
      phase: 'research',
      content: 'artifact',
      currentStatus: 'research_done',
    });
    expect(critiquePhase).toHaveBeenCalledWith('research', 'artifact', { unavailable: true });
  });

  test('FAIL CLOSED: カウントクエリが reject しても bounce を繰り返さず proceed（fail-open分岐）すること', async () => {
    // Fault injection: a prior `.catch(() => 0)` here would make priorBounces
    // always read as 0 (< MAX_BOUNCES) on every DB hiccup, so this gate would
    // re-archive + roll back the artifact forever instead of ever reaching
    // the "budget exhausted, proceed" branch.
    mockPrisma.workflowTransition.count.mockRejectedValue(new Error('connection reset'));

    const result = await applyPhaseCriticGate({
      taskId: 1,
      phase: 'research',
      content: 'bad research',
      currentStatus: 'research_done',
    });

    // Took the budget-exhausted proceed branch, NOT another bounce.
    expect(result.bounced).toBe(false);
    expect(result.newStatus).toBeUndefined();
    const rt = recordTransition.mock.calls[0]?.[0] as
      | {
          cause: string;
          metadata: { inputTruncated: boolean };
        }
      | undefined;
    expect(rt?.cause).toBe('research_critic_exhausted');
    expect(rt?.metadata.inputTruncated).toBe(false);
    // 予算枯渇(proceed)分岐では再ディスパッチしない。
    expect(scheduleWorkflowRedispatch).not.toHaveBeenCalled();
  });
});

describe('applyPhaseCriticGate — 遅延verdictのCASガード', () => {
  beforeEach(() => {
    mockPrisma.workflowTransition.count.mockReset().mockResolvedValue(0);
    mockPrisma.workflowTransition.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.task.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mockPrisma.task.findUnique.mockReset().mockResolvedValue(null);
    mockPrisma.workflowFile.findFirst.mockReset().mockResolvedValue(null);
    recordTransition.mockReset().mockResolvedValue(undefined);
    archiveWorkflowFile.mockReset().mockResolvedValue(true);
    critiquePhase.mockReset().mockResolvedValue({
      verdict: 'fail',
      severity: 'high',
      reasons: ['issue A'],
      inputTruncated: false,
    });
    isPhaseCriticEnabled.mockReset().mockReturnValue(true);
    scheduleWorkflowRedispatch.mockClear();
  });

  test('評価中にステータスが進んでいたら(CAS 0件) ロールバックせず fail-open', async () => {
    // task 494の再現: critic評価60-90秒の間に auto-approve が
    // plan_created → plan_approved に進めた。遅れて届いたFAILは
    // 生きている状態を踏み潰してはならない。
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    mockPrisma.task.updateMany.mockResolvedValue({ count: 0 }); // 別状態に遷移済み

    const result = await applyPhaseCriticGate({
      taskId: 494,
      phase: 'plan',
      content: 'plan body',
      currentStatus: 'plan_created',
    });

    expect(result.bounced).toBe(false);
    expect(result.newStatus).toBeUndefined();
    // ロールバック遷移もアーティファクトのarchiveも発生しない。
    expect(recordTransition).not.toHaveBeenCalled();
    expect(archiveWorkflowFile).not.toHaveBeenCalled();
    // ロールバックしていないので再ディスパッチも予約しない。
    expect(scheduleWorkflowRedispatch).not.toHaveBeenCalled();
  });

  test('CASが1件更新できたら通常どおり bounce する', async () => {
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    mockPrisma.task.updateMany.mockResolvedValue({ count: 1 });

    const result = await applyPhaseCriticGate({
      taskId: 494,
      phase: 'plan',
      content: 'plan body',
      currentStatus: 'plan_created',
    });

    expect(result.bounced).toBe(true);
    expect(result.newStatus).toBe('research_done');
    const call = mockPrisma.task.updateMany.mock.calls[0]?.[0] as {
      where: { id: number; workflowStatus: string };
    };
    // ガード条件が評価時点のステータスを固定していること。
    expect(call.where).toEqual({ id: 494, workflowStatus: 'plan_created' });
    // bounce成立時は再ディスパッチが予約されること（task 547）。
    expect(scheduleWorkflowRedispatch).toHaveBeenCalledWith(494, 'plan_critic_failed', 'ja');
  });
});

describe('gatherCriticContext — acceptanceCriteriaがcritiquePhase呼び出し引数まで伝搬する（task911）', () => {
  beforeEach(() => {
    mockPrisma.workflowTransition.count.mockReset().mockResolvedValue(0);
    mockPrisma.workflowTransition.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.task.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mockPrisma.task.findUnique.mockReset().mockResolvedValue(null);
    mockPrisma.workflowFile.findFirst.mockReset().mockResolvedValue(null);
    recordTransition.mockReset().mockResolvedValue(undefined);
    archiveWorkflowFile.mockReset().mockResolvedValue(true);
    critiquePhase
      .mockReset()
      .mockResolvedValue({ verdict: 'pass', severity: 0, reasons: [], inputTruncated: false });
    isPhaseCriticEnabled.mockReset().mockReturnValue(true);
    scheduleWorkflowRedispatch.mockClear();
  });

  test('Task.acceptanceCriteria列を解決し、critiquePhaseのcontext引数へ含める', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      title: 'タイトル',
      description: '説明文',
      acceptanceCriteria: JSON.stringify(['AC1: 満たすこと', 'AC2: 満たすこと']),
    });

    await applyPhaseCriticGate({
      taskId: 909,
      phase: 'research',
      content: 'research body',
      currentStatus: 'research_done',
    });

    const call = critiquePhase.mock.calls[0] as [string, string, { acceptanceCriteria?: string[] }];
    expect(call[2]?.acceptanceCriteria).toEqual(['AC1: 満たすこと', 'AC2: 満たすこと']);
  });

  test('acceptanceCriteria列・description両方が空なら context.acceptanceCriteria は undefined', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      title: 'タイトル',
      description: null,
      acceptanceCriteria: null,
    });

    await applyPhaseCriticGate({
      taskId: 910,
      phase: 'research',
      content: 'research body',
      currentStatus: 'research_done',
    });

    const call = critiquePhase.mock.calls[0] as [string, string, { acceptanceCriteria?: string[] }];
    expect(call[2]?.acceptanceCriteria).toBeUndefined();
  });
});
