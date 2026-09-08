/**
 * workflow-reconciler-blocked テスト
 *
 * blocked ヒールパス（受入基準1〜4）: 成功証拠あり → done 是正（再試行なし）、
 * 証拠なし → requeueBlockedTasks が従来どおり盲目再試行、awaiting_question は
 * 盲目再試行されない（最重要回帰）、retryable はエスカレーションされない
 * （プレモーテム2）、classifyBlockedExclusion の境界値、を検証する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const mockPrisma = {
  task: {
    findMany: mock(() => Promise.resolve([] as unknown[])),
    update: mock(() => Promise.resolve({})),
  },
  agentExecution: { findFirst: mock(() => Promise.resolve(null as unknown)) },
  workflowTransition: {
    count: mock(() => Promise.resolve(0)),
    findFirst: mock(() => Promise.resolve(null as unknown)),
  },
  themeAutoRun: { findMany: mock(() => Promise.resolve([{ themeId: 1 }] as unknown[])) },
  userSettings: { findFirst: mock(() => Promise.resolve(null as unknown)) },
  activityLog: { findFirst: mock(() => Promise.resolve(null as unknown)) },
};
const recordTransition = mock(() => Promise.resolve());
const automationPolicy = mock(async () => ({ autoMergePR: false }));
mock.module('../../services/workflow/automation-policy', () => ({
  resolveAutomationPolicy: automationPolicy,
}));
const resolveBlockedTaskEvidence = mock(() =>
  Promise.resolve({ isSuccess: false, source: 'none' as const }),
);
const escalateBlockedTask = mock(() => Promise.resolve(true));
const reescalateIfOverdue = mock(() => Promise.resolve(false));
const attemptPrOnlyRecovery = mock(() => Promise.resolve(false));

const noopLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));
mock.module('../../services/workflow/transition-recorder', () => ({ recordTransition }));
mock.module('../../services/workflow/blocked-task-evidence', () => ({
  resolveBlockedTaskEvidence,
}));
mock.module('../../services/workflow/blocked-task-escalation', () => ({
  escalateBlockedTask,
  reescalateIfOverdue,
  countEscalatedBlocked: mock(() => Promise.resolve(0)),
  BLOCKED_ESCALATED_CAUSE: 'blocked_escalated',
  BLOCKED_REESCALATED_CAUSE: 'blocked_reescalated',
}));
mock.module('../../services/workflow/blocked-pr-retry-recovery', () => ({
  attemptPrOnlyRecovery,
}));

const { correctBlockedByEvidence, escalateAbandonedBlocked, healBlockedStatusDesync } =
  await import('../../services/workflow/workflow-reconciler-blocked');
const { requeueBlockedTasks } = await import('../../services/workflow/workflow-reconciler-requeue');
const {
  classifyBlockedExclusion,
  MAX_ORPHAN_REQUEUE_AGE_MS,
  MAX_PR_RECOVERY_ATTEMPTS,
  DEFAULT_VERIFY_REPAIR_LIMIT,
} = await import('../../services/workflow/blocked-task-policy');

const NOW = 1_800_000_000_000;
const OLD = new Date(NOW - 60 * 60 * 1000); // 1h 前（settle 済み・2日以内）
const ANCIENT = new Date(NOW - 3 * 24 * 60 * 60 * 1000); // 3日前（再試行対象外の古さ）

function blockedTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 595,
    title: 'blocked タスク',
    themeId: 1,
    workflowStatus: 'draft',
    completedAt: null,
    updatedAt: OLD,
    ...overrides,
  };
}

beforeEach(() => {
  automationPolicy.mockReset().mockResolvedValue({ autoMergePR: false });
  mockPrisma.task.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.task.update.mockReset().mockResolvedValue({});
  mockPrisma.agentExecution.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.workflowTransition.count.mockReset().mockResolvedValue(0);
  mockPrisma.workflowTransition.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.themeAutoRun.findMany.mockReset().mockResolvedValue([{ themeId: 1 }]);
  mockPrisma.userSettings.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.activityLog.findFirst.mockReset().mockResolvedValue(null);
  recordTransition.mockReset().mockResolvedValue(undefined);
  resolveBlockedTaskEvidence.mockReset().mockResolvedValue({ isSuccess: false, source: 'none' });
  escalateBlockedTask.mockReset().mockResolvedValue(true);
  reescalateIfOverdue.mockReset().mockResolvedValue(false);
  attemptPrOnlyRecovery.mockReset().mockResolvedValue(false);
});

describe('correctBlockedByEvidence（受入基準1・3）', () => {
  test.each(['open', 'merged'])(
    'required merge cannot complete from a local %s PR row',
    async (prState) => {
      mockPrisma.task.findMany.mockResolvedValue([blockedTask()]);
      automationPolicy.mockResolvedValue({ autoMergePR: true });
      resolveBlockedTaskEvidence.mockResolvedValue({
        isSuccess: true,
        source: 'linked_pr',
        prState,
      });
      expect(await correctBlockedByEvidence(NOW)).toBe(0);
      expect(mockPrisma.task.update).not.toHaveBeenCalled();
      expect(recordTransition).not.toHaveBeenCalled();
    },
  );
  test('unreadable automation policy cannot authorize completion', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask()]);
    automationPolicy.mockRejectedValue(new Error('database unavailable'));
    resolveBlockedTaskEvidence.mockResolvedValue({ isSuccess: true, source: 'linked_pr' });
    expect(await correctBlockedByEvidence(NOW)).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });
  test('成功証拠あり → done + workflowStatus completed へ是正し blocked_evidence_done を記録', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask()]);
    resolveBlockedTaskEvidence.mockResolvedValue({
      isSuccess: true,
      source: 'linked_pr',
      prState: 'open',
    });

    const corrected = await correctBlockedByEvidence(NOW);

    expect(corrected).toBe(1);
    const tu = mockPrisma.task.update.mock.calls[0][0] as {
      data: { status: string; workflowStatus: string; completedAt: Date };
    };
    expect(tu.data.status).toBe('done');
    expect(tu.data.workflowStatus).toBe('completed');
    expect(tu.data.completedAt).toBeInstanceOf(Date);
    const rt = recordTransition.mock.calls[0][0] as { cause: string; toStatus: string };
    expect(rt.cause).toBe('blocked_evidence_done');
    expect(rt.toStatus).toBe('completed');
  });

  test('既存 completedAt がある場合はそれを尊重する', async () => {
    const existing = new Date(NOW - 2 * 60 * 60 * 1000);
    mockPrisma.task.findMany.mockResolvedValue([blockedTask({ completedAt: existing })]);
    resolveBlockedTaskEvidence.mockResolvedValue({
      isSuccess: true,
      source: 'linked_pr',
      prState: 'merged',
    });

    await correctBlockedByEvidence(NOW);

    const tu = mockPrisma.task.update.mock.calls[0][0] as { data: { completedAt: Date } };
    expect(tu.data.completedAt).toBe(existing);
  });

  test('補完: awaiting_question × 成功証拠あり → done 是正される（是正は盲目再試行ではない）', async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      blockedTask({ id: 578, workflowStatus: 'awaiting_question' }),
    ]);
    resolveBlockedTaskEvidence.mockResolvedValue({
      isSuccess: true,
      source: 'scoped_pr',
      prState: 'open',
    });

    const corrected = await correctBlockedByEvidence(NOW);

    expect(corrected).toBe(1);
    const tu = mockPrisma.task.update.mock.calls[0][0] as {
      data: { status: string; workflowStatus: string };
    };
    // 質問を破壊する draft リセットではなく、done への直接確定であること
    expect(tu.data.status).toBe('done');
    expect(tu.data.workflowStatus).toBe('completed');
  });

  test('受入3: 証拠が曖昧（isSuccess=false）なら是正しない', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask()]);
    resolveBlockedTaskEvidence.mockResolvedValue({
      isSuccess: false,
      source: 'none',
      prState: 'closed',
    });

    const corrected = await correctBlockedByEvidence(NOW);

    expect(corrected).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  test('live 実行が居るタスクはスキップ', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask()]);
    mockPrisma.agentExecution.findFirst.mockResolvedValue({ id: 1 });
    resolveBlockedTaskEvidence.mockResolvedValue({ isSuccess: true, source: 'linked_pr' });

    const corrected = await correctBlockedByEvidence(NOW);

    expect(corrected).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  test('候補クエリに上限年齢（notOlderThan）が無い（古い blocked も是正対象）', async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);

    await correctBlockedByEvidence(NOW);

    const where = (
      mockPrisma.task.findMany.mock.calls[0][0] as {
        where: { updatedAt: Record<string, unknown> };
      }
    ).where;
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
    expect(where.updatedAt.gt).toBeUndefined();
  });
});

describe('requeueBlockedTasks 回帰（受入基準2・4）', () => {
  test('受入2: 成功証拠なしの blocked は従来どおり盲目再試行される（blocked_auto_retry）', async () => {
    // 是正パスは何もしない
    mockPrisma.task.findMany.mockResolvedValue([blockedTask()]);
    const corrected = await correctBlockedByEvidence(NOW);
    expect(corrected).toBe(0);

    // requeue は同じタスクを todo/draft へ戻す
    mockPrisma.task.findMany.mockReset().mockResolvedValue([{ id: 595, workflowStatus: 'draft' }]);
    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(1);
    const tu = mockPrisma.task.update.mock.calls[0][0] as {
      data: { status: string; workflowStatus: string };
    };
    expect(tu.data.status).toBe('todo');
    expect(tu.data.workflowStatus).toBe('draft');
    const rt = recordTransition.mock.calls[0][0] as { cause: string };
    expect(rt.cause).toBe('blocked_auto_retry');
  });

  test('受入4（最重要回帰）: awaiting_question は盲目再試行されない', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: 578, workflowStatus: 'awaiting_question' }]);

    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test('task 619: 非収束打ち切り済み（verify_repair_non_convergence 遷移あり）は盲目再試行されない', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: 614, workflowStatus: 'draft' }]);
    // 修復予算は残っている（repairs 0 < limit 3）が、非収束遷移が 1 件ある状態
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      return Promise.resolve(where.cause === 'verify_repair_non_convergence' ? 1 : 0);
    });

    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test('task 673/681: 軽量PR再試行が成功したら、workflowStatus:draft を伴うフルリセットをせずに retried が1になる', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: 673, workflowStatus: 'verify_done' }]);
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      if (where.cause === 'verify_pr_not_created') return Promise.resolve(1);
      return Promise.resolve(0);
    });
    attemptPrOnlyRecovery.mockResolvedValue(true);

    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(1);
    expect(attemptPrOnlyRecovery).toHaveBeenCalledTimes(1);
    expect(attemptPrOnlyRecovery).toHaveBeenCalledWith(673);
    // 軽量リトライが成功した場合、フルリセット（task.update への workflowStatus:draft 書き込み）は行われない
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  test('task 673/681: 軽量PR再試行が失敗したら、PR_RETRY_LIGHTWEIGHT_CAUSE記録後に既存の盲目フルリセットへフォールスルーする', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: 673, workflowStatus: 'verify_done' }]);
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      if (where.cause === 'verify_pr_not_created') return Promise.resolve(1);
      return Promise.resolve(0);
    });
    attemptPrOnlyRecovery.mockResolvedValue(false);

    const retried = await requeueBlockedTasks(NOW);

    expect(attemptPrOnlyRecovery).toHaveBeenCalledTimes(1);
    // 軽量リトライ失敗後、既存の盲目フルリセット（blocked_auto_retry/draft）に到達する
    expect(retried).toBe(1);
    const tu = mockPrisma.task.update.mock.calls[0][0] as {
      data: { status: string; workflowStatus: string };
    };
    expect(tu.data.status).toBe('todo');
    expect(tu.data.workflowStatus).toBe('draft');
    const rt = recordTransition.mock.calls[0][0] as { cause: string };
    expect(rt.cause).toBe('blocked_auto_retry');
  });

  test('task 673/681: 既に軽量リトライ試行済み（verify_pr_retry_lightweight あり）のタスクは軽量リトライを再試行しない', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: 673, workflowStatus: 'verify_done' }]);
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      if (where.cause === 'verify_pr_not_created') return Promise.resolve(1);
      if (where.cause === 'verify_pr_retry_lightweight') return Promise.resolve(1);
      return Promise.resolve(0);
    });

    await requeueBlockedTasks(NOW);

    expect(attemptPrOnlyRecovery).not.toHaveBeenCalled();
  });

  test('task 713: verify_pr_not_created が MAX_PR_RECOVERY_ATTEMPTS(累計・無期限)に達したタスクは軽量リトライもフルリセットも試行しない', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: 705, workflowStatus: 'verify_done' }]);
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      // 累計(lastRetryによる期間フィルタなし)でMAX_PR_RECOVERY_ATTEMPTSに到達
      if (where.cause === 'verify_pr_not_created') return Promise.resolve(MAX_PR_RECOVERY_ATTEMPTS);
      return Promise.resolve(0);
    });

    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(0);
    expect(attemptPrOnlyRecovery).not.toHaveBeenCalled();
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  test('task 713: verify_pr_not_created が上限未満なら従来どおり軽量リトライを試行する', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: 705, workflowStatus: 'verify_done' }]);
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      if (where.cause === 'verify_pr_not_created') {
        return Promise.resolve(MAX_PR_RECOVERY_ATTEMPTS - 1);
      }
      return Promise.resolve(0);
    });
    attemptPrOnlyRecovery.mockResolvedValue(true);

    const retried = await requeueBlockedTasks(NOW);

    expect(attemptPrOnlyRecovery).toHaveBeenCalledTimes(1);
    expect(retried).toBe(1);
  });

  test('task 673/681（プレモーテム3）: フルリセット予算(MAX_BLOCKED_RETRY)を使い切っていても軽量リトライは試行される', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: 673, workflowStatus: 'verify_done' }]);
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      if (where.cause === 'blocked_auto_retry') return Promise.resolve(2); // MAX_BLOCKED_RETRY到達済み
      if (where.cause === 'verify_pr_not_created') return Promise.resolve(1);
      return Promise.resolve(0);
    });
    attemptPrOnlyRecovery.mockResolvedValue(true);

    const retried = await requeueBlockedTasks(NOW);

    expect(attemptPrOnlyRecovery).toHaveBeenCalledTimes(1);
    expect(retried).toBe(1);
  });
});

describe('escalateAbandonedBlocked（受入基準5まわり・プレモーテム2）', () => {
  test('retryable と分類されるタスクはエスカレーションされない（requeue が担当）', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask()]); // 1h前・repairs 0・attempts 0

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(0);
    expect(escalateBlockedTask).not.toHaveBeenCalled();
  });

  test('awaiting_question は理由 awaiting_question でエスカレーションされる', async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      blockedTask({ id: 597, workflowStatus: 'awaiting_question' }),
    ]);

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(1);
    const call = escalateBlockedTask.mock.calls[0] as unknown[];
    expect((call[1] as { id: number }).id).toBe(597);
    expect(call[2]).toBe('awaiting_question');
    // task 770: 呼び出し元が保持する t.workflowStatus が末尾引数として伝搬すること
    expect(call[5]).toBe('awaiting_question');
  });

  test('2日超の古い blocked は abandoned_old でエスカレーションされる（条件4の救済）', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask({ updatedAt: ANCIENT })]);

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(1);
    const call = escalateBlockedTask.mock.calls[0] as unknown[];
    expect(call[2]).toBe('abandoned_old');
  });

  test('再試行上限到達 (attempts >= 2) は retry_cap_exhausted でエスカレーションされる', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask()]);
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      return Promise.resolve(where.cause === 'blocked_auto_retry' ? 2 : 0);
    });

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(1);
    const call = escalateBlockedTask.mock.calls[0] as unknown[];
    expect(call[2]).toBe('retry_cap_exhausted');
  });

  test('task 713: verify_pr_not_created が累計でMAX_PR_RECOVERY_ATTEMPTSに達したタスクは pr_recovery_exhausted でエスカレーションされる', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask({ id: 705 })]);
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      return Promise.resolve(
        where.cause === 'verify_pr_not_created' ? MAX_PR_RECOVERY_ATTEMPTS : 0,
      );
    });

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(1);
    const call = escalateBlockedTask.mock.calls[0] as unknown[];
    expect(call[2]).toBe('pr_recovery_exhausted');
  });

  test('task 619: 非収束打ち切り済みタスクは verify_no_convergence でエスカレーションに渡る（二重試行しない）', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask({ id: 614 })]);
    // 修復予算・再試行上限とも未到達でも、非収束遷移があれば retryable 扱いにしない
    mockPrisma.workflowTransition.count.mockImplementation((args: unknown) => {
      const where = (args as { where: { cause: string } }).where;
      return Promise.resolve(where.cause === 'verify_repair_non_convergence' ? 1 : 0);
    });

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(1);
    const call = escalateBlockedTask.mock.calls[0] as unknown[];
    expect((call[1] as { id: number }).id).toBe(614);
    expect(call[2]).toBe('verify_no_convergence');
  });

  test('成功証拠のあるタスクはエスカレーションしない（是正パスの担当）', async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      blockedTask({ workflowStatus: 'awaiting_question' }),
    ]);
    resolveBlockedTaskEvidence.mockResolvedValue({ isSuccess: true, source: 'linked_pr' });

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(0);
    expect(escalateBlockedTask).not.toHaveBeenCalled();
  });

  test('task 703: escalateBlockedTask が false（既にエスカレーション済み）→ reescalateIfOverdue が同じ task/classification/nowMs で呼ばれ、戻り値が escalated 件数に反映される', async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      blockedTask({ id: 666, workflowStatus: 'awaiting_question' }),
    ]);
    escalateBlockedTask.mockResolvedValue(false);
    reescalateIfOverdue.mockResolvedValue(true);

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(1);
    expect(reescalateIfOverdue).toHaveBeenCalledTimes(1);
    const call = reescalateIfOverdue.mock.calls[0] as unknown[];
    expect((call[1] as { id: number }).id).toBe(666);
    expect(call[2]).toBe('awaiting_question');
    expect(call[3]).toBe(NOW);
  });

  test('task 703: escalateBlockedTask が true（今回初めて発火）→ reescalateIfOverdue は呼ばれない', async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      blockedTask({ workflowStatus: 'awaiting_question' }),
    ]);
    escalateBlockedTask.mockResolvedValue(true);

    const escalated = await escalateAbandonedBlocked(NOW);

    expect(escalated).toBe(1);
    expect(reescalateIfOverdue).not.toHaveBeenCalled();
  });
});

describe('classifyBlockedExclusion（境界値）', () => {
  const base = {
    workflowStatus: 'draft',
    ageMs: 1000,
    repairs: 0,
    verifyRepairLimit: 3,
    attempts: 0,
  };

  test('既定は retryable', () => {
    expect(classifyBlockedExclusion(base)).toBe('retryable');
  });

  test('awaiting_question が他のどの条件よりも優先される', () => {
    expect(
      classifyBlockedExclusion({
        ...base,
        workflowStatus: 'awaiting_question',
        ageMs: MAX_ORPHAN_REQUEUE_AGE_MS + 1,
        repairs: 99,
        attempts: 99,
      }),
    ).toBe('awaiting_question');
  });

  test('年齢境界: ちょうど上限は retryable、超過で abandoned_old', () => {
    expect(classifyBlockedExclusion({ ...base, ageMs: MAX_ORPHAN_REQUEUE_AGE_MS })).toBe(
      'retryable',
    );
    expect(classifyBlockedExclusion({ ...base, ageMs: MAX_ORPHAN_REQUEUE_AGE_MS + 1 })).toBe(
      'abandoned_old',
    );
  });

  test('修復予算境界: repairs >= limit で verify_repair_exhausted', () => {
    expect(classifyBlockedExclusion({ ...base, repairs: 2 })).toBe('retryable');
    expect(classifyBlockedExclusion({ ...base, repairs: 3 })).toBe('verify_repair_exhausted');
  });

  test('再試行上限境界: attempts >= 2 で retry_cap_exhausted', () => {
    expect(classifyBlockedExclusion({ ...base, attempts: 1 })).toBe('retryable');
    expect(classifyBlockedExclusion({ ...base, attempts: 2 })).toBe('retry_cap_exhausted');
  });

  test('task 713: PR作成再試行上限境界: prNotCreatedCount >= MAX_PR_RECOVERY_ATTEMPTS で pr_recovery_exhausted', () => {
    expect(
      classifyBlockedExclusion({ ...base, prNotCreatedCount: MAX_PR_RECOVERY_ATTEMPTS - 1 }),
    ).toBe('retryable');
    expect(classifyBlockedExclusion({ ...base, prNotCreatedCount: MAX_PR_RECOVERY_ATTEMPTS })).toBe(
      'pr_recovery_exhausted',
    );
  });

  test('task 713: prNotCreatedCount 未指定(undefined)は retryable 側に倒れる(後方互換)', () => {
    expect(classifyBlockedExclusion(base)).toBe('retryable');
  });

  test('task 713: pr_recovery_exhausted は retry_cap_exhausted より先に判定される(より具体的な失敗パターンを優先)', () => {
    expect(
      classifyBlockedExclusion({
        ...base,
        attempts: 2, // retry_cap_exhausted の条件も同時に満たす
        prNotCreatedCount: MAX_PR_RECOVERY_ATTEMPTS,
      }),
    ).toBe('pr_recovery_exhausted');
  });

  test('task 619: nonConverged は awaiting_question 以外のどの条件よりも優先される', () => {
    expect(classifyBlockedExclusion({ ...base, nonConverged: true })).toBe('verify_no_convergence');
    expect(
      classifyBlockedExclusion({
        ...base,
        nonConverged: true,
        ageMs: MAX_ORPHAN_REQUEUE_AGE_MS + 1,
        repairs: 99,
        attempts: 99,
      }),
    ).toBe('verify_no_convergence');
    // 人間の回答待ちは常に最優先（質問を破壊しない）
    expect(
      classifyBlockedExclusion({
        ...base,
        nonConverged: true,
        workflowStatus: 'awaiting_question',
      }),
    ).toBe('awaiting_question');
  });
});

// task 705: タスク#684の反復タイムラインを模した統合シナリオ。修正前は CLI 経路が
// attemptVerifyRepair を一度も呼ばなかったため、修復予算(repairs)を1回しか消費
// しないまま blocked_auto_retry(attempts) を2回消費し、classifyBlockedExclusion
// は retry_cap_exhausted で（本来より遅れて）エスカレーションしていた。修正後は
// HTTP/CLI いずれの経路でも検証失敗のたびに修復予算が正しく消費されるため、
// attempts=0（盲目再試行を一度も消費しない）のまま予算(repairs)が枯渇し、
// verify_repair_exhausted へ直接到達する。
describe('classifyBlockedExclusion（task 705: タスク#684タイムラインの統合シナリオ）', () => {
  test('HTTP/CLI 両経路で修復予算が正しく消費された結果、blocked_auto_retry を消費せず verify_repair_exhausted に到達すること', () => {
    // タスク#684実測: verify_repair 1回(HTTP, 08:47) + verify_validation_failed 3回
    // (修正後はいずれも CLI 経路で attemptVerifyRepair 経由の予算消費に変わる) =
    // repairs が DEFAULT_VERIFY_REPAIR_LIMIT(2) に到達。blocked_auto_retry は
    // 一度も発生しない（attempts=0）。
    const classification = classifyBlockedExclusion({
      workflowStatus: 'in_progress',
      ageMs: 20 * 60 * 1000,
      repairs: DEFAULT_VERIFY_REPAIR_LIMIT,
      verifyRepairLimit: DEFAULT_VERIFY_REPAIR_LIMIT,
      attempts: 0,
    });

    expect(classification).toBe('verify_repair_exhausted');
  });

  test('比較対象（修正前の実測挙動）: 予算が1回しか消費されず attempts が上限に達すると retry_cap_exhausted になること', () => {
    // 修正前のタスク#684実測: repairs=1（HTTP経路の1回のみ）のまま
    // blocked_auto_retry が2回（attempts=2, MAX_BLOCKED_RETRY）発生していた。
    const classification = classifyBlockedExclusion({
      workflowStatus: 'in_progress',
      ageMs: 20 * 60 * 1000,
      repairs: 1,
      verifyRepairLimit: DEFAULT_VERIFY_REPAIR_LIMIT,
      attempts: 2,
    });

    expect(classification).toBe('retry_cap_exhausted');
  });
});

describe('healBlockedStatusDesync（task 802: status/workflowStatus 不整合の復旧）', () => {
  const BLOCKED_AT = new Date(NOW - 30 * 60 * 1000);

  function mockTransitions(opts: { hasBlocked: boolean; hasUserAdvance: boolean }) {
    mockPrisma.workflowTransition.findFirst.mockImplementation(
      (args: { where: { toStatus?: string; actor?: string } }) => {
        if (args.where.toStatus === 'blocked') {
          return Promise.resolve(opts.hasBlocked ? { createdAt: BLOCKED_AT } : null);
        }
        if (args.where.actor === 'user') {
          return Promise.resolve(opts.hasUserAdvance ? { id: 1 } : null);
        }
        return Promise.resolve(null);
      },
    );
  }

  test('status=blocked + workflowStatus=plan_approved + actor:user遷移ありで status のみ todo へ復旧される', async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      blockedTask({ id: 800, workflowStatus: 'plan_approved' }),
    ]);
    mockTransitions({ hasBlocked: true, hasUserAdvance: true });

    const healed = await healBlockedStatusDesync(NOW);

    expect(healed).toBe(1);
    const tu = mockPrisma.task.update.mock.calls[0][0] as {
      data: { status: string; workflowStatus?: string };
    };
    expect(tu.data.status).toBe('todo');
    expect(tu.data.workflowStatus).toBeUndefined();
    const rt = recordTransition.mock.calls[0][0] as { cause: string; toStatus: string };
    expect(rt.cause).toBe('status_desync_healed');
    expect(rt.toStatus).toBe('plan_approved');
  });

  test('workflowStatus=draft（人手先行の痕跡なし）では対象外', async () => {
    mockPrisma.task.findMany.mockResolvedValue([blockedTask({ id: 801, workflowStatus: 'draft' })]);
    mockTransitions({ hasBlocked: true, hasUserAdvance: true });

    const healed = await healBlockedStatusDesync(NOW);

    expect(healed).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  test('actor:user 遷移が無い（システム由来の前進のみ）場合は対象外', async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      blockedTask({ id: 802, workflowStatus: 'plan_approved' }),
    ]);
    mockTransitions({ hasBlocked: true, hasUserAdvance: false });

    const healed = await healBlockedStatusDesync(NOW);

    expect(healed).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });
});
