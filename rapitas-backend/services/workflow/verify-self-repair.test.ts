/**
 * Tests for verify-self-repair's attemptVerifyRepair repair-budget
 * double-check (task 749).
 *
 * The feedback-block pure-function tests (sanitizeRepairReason,
 * buildRepairFeedbackBlock, mergeRepairFeedback) live in
 * verify-self-repair-feedback.test.ts (task 764 split).
 *
 * mock.module is registered below BEFORE verify-self-repair is imported
 * (via a top-level dynamic import, same pattern as verify-self-repair.cas.test.ts)
 * so the new attemptVerifyRepair tests don't load the real prisma client first.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';

const evaluatedAt = new Date('2026-09-08T00:00:00Z');
let taskWorkflowStatus = 'research_done';
const taskRow = () => ({
  status: 'in-progress',
  workflowStatus: taskWorkflowStatus,
  updatedAt: evaluatedAt,
  themeId: null,
  acceptanceCriteria: null,
});

const noopLogger = { info: () => {}, warn: mock(() => {}), error: () => {}, debug: () => {} };

const mockPrisma = {
  userSettings: { findFirst: mock(() => Promise.resolve(null)) },
  activityLog: { findFirst: mock(() => Promise.resolve(null)) },
  workflowTransition: {
    count: mock(() => Promise.resolve(0)),
    findFirst: mock(() => Promise.resolve(null)),
    findMany: mock(() => Promise.resolve([] as { metadata: string | null }[])),
  },
  task: {
    updateMany: mock(() => Promise.resolve({ count: 1 })),
    findFirst: mock(() => Promise.resolve(null)),
    findUnique: mock(() => Promise.resolve(null)),
  },
  workflowFile: { findFirst: mock(() => Promise.resolve(null)) },
};
const readWorkflowFile = mock(() => Promise.resolve(''));
const writeWorkflowFile = mock(() => Promise.resolve());
const recordTransition = mock(() => Promise.resolve());
Object.assign(mockPrisma, {
  $transaction: async (operation: (tx: typeof mockPrisma) => unknown) => operation(mockPrisma),
  agentExecution: { findFirst: async () => null },
  themeAutoRun: { findUnique: async () => null },
});
Object.assign(mockPrisma.workflowFile, { findUnique: () => mockPrisma.workflowFile.findFirst() });
Object.assign(mockPrisma.workflowTransition, {
  create: async (args: { data: { metadata: string } }) =>
    (recordTransition as (...args: unknown[]) => Promise<void>)({
      ...args.data,
      metadata: JSON.parse(args.data.metadata),
    }),
});

mock.module('../../config/logger', () => ({ createLogger: () => noopLogger }));
mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('./workflow-file-utils', () => ({ readWorkflowFile, writeWorkflowFile }));
mock.module('./transition-recorder', () => ({ recordTransition }));
mock.module('./auto-run/theme-auto-run-service', () => ({
  isThemeAutoRunActive: () => Promise.resolve(true),
}));
mock.module('./blocked-task-escalation', () => ({
  escalateBlockedTask: mock(() => Promise.resolve(true)),
  BLOCKED_ESCALATED_CAUSE: 'blocked_escalated',
  countEscalatedBlocked: () => Promise.resolve(0),
}));

const resumeAdmission = mock(async () => 'scheduler_owned');
mock.module('./verify-repair-queue', () => ({ enqueueCommittedRepair: resumeAdmission }));

const { attemptVerifyRepair, isTamperOnlyVerdict, VERIFY_NON_REPAIRABLE_CAUSE } =
  await import('./verify-self-repair');

describe('attemptVerifyRepair — 修復予算のダブルチェック (task 749)', () => {
  beforeEach(() => {
    resumeAdmission.mockReset().mockResolvedValue('scheduler_owned');
    taskWorkflowStatus = 'research_done';
    mockPrisma.task.findUnique
      .mockReset()
      .mockImplementation(async () => taskRow() as unknown as null);
    mockPrisma.userSettings.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.activityLog.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.workflowTransition.count.mockReset().mockResolvedValue(0);
    mockPrisma.workflowTransition.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.task.updateMany.mockReset().mockResolvedValue({ count: 1 });

    mockPrisma.workflowFile.findFirst.mockReset().mockResolvedValue(null);
    readWorkflowFile.mockReset().mockResolvedValue('');
    writeWorkflowFile.mockReset().mockResolvedValue(undefined);
    recordTransition.mockReset().mockResolvedValue(undefined);
  });

  // 既定 verifyRepairLimit=2 の境界値: prior=0/1 は再チェックを通過してbounceする。
  test.each([0, 1])(
    '既定上限2で prior=%i なら再チェック後も bounce する（attempt = prior+1）',
    async (prior) => {
      mockPrisma.workflowTransition.count.mockResolvedValue(prior);
      const result = await attemptVerifyRepair(700, 'research_done', 'reason', 'verify body');
      expect(result.bounced).toBe(true);
      expect(result.attempt).toBe(prior + 1);
      expect(recordTransition).toHaveBeenCalledTimes(1);
    },
  );

  test('既定上限2で prior=2 は初回チェックで遮断され recordTransition は呼ばれない', async () => {
    mockPrisma.workflowTransition.count.mockResolvedValue(2);
    const result = await attemptVerifyRepair(700, 'research_done', 'reason', 'verify body');
    expect(result.bounced).toBe(false);
    expect(recordTransition).not.toHaveBeenCalled();
  });

  // task#603/#710 の再現: 初回読み取り(prior=1)は予算内だが、コミット直前の再クエリでは
  // 別の呼び出し経路が同時に verify_repair を記録済みで prior=2（max=2）に達している。
  test('二重呼び出し: 初回読み取り後に別経路が予算を使い切っていれば再チェックで遮断する', async () => {
    mockPrisma.workflowTransition.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const result = await attemptVerifyRepair(700, 'research_done', 'reason', 'verify body');
    expect(result.bounced).toBe(false);
    expect(recordTransition).not.toHaveBeenCalled();
    // 再チェック失敗時は状態を一切変更しない(CASもフィードバック書込も行わない)。
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
    expect(writeWorkflowFile).not.toHaveBeenCalled();
  });
});

describe('attemptVerifyRepair — tamper 単独失敗は修復不能として即遮断 (task 867)', () => {
  const TAMPER_ONLY =
    '自動検証に失敗しました（自動検証: lint=ok / typecheck=ok / test=ok / format=ok / tamper=NG(1) / coverage=ok）。';

  test('isTamperOnlyVerdict は tamper だけが NG のときだけ true', () => {
    expect(isTamperOnlyVerdict(TAMPER_ONLY)).toBe(true);
    expect(isTamperOnlyVerdict(TAMPER_ONLY.replace('test=ok', 'test=NG(3)'))).toBe(false);
    expect(isTamperOnlyVerdict('verify.md explicitly marks the verification as failed.')).toBe(
      false,
    );
  });

  // task 892: tamper と schema-change が同時に NG のとき、tamper-only 誤分類で
  // schema-change 側の通常リトライ機会を奪ってはいけない。
  test('isTamperOnlyVerdict は tamper と schema-change の複合失敗では false', () => {
    const composite =
      '自動検証に失敗しました（自動検証: tamper=NG(1) / schema-change=NG(1) / lint=ok / typecheck=ok / test=ok）。';
    expect(isTamperOnlyVerdict(composite)).toBe(false);
  });

  test('tamper 単独失敗は bounce せず、非修復の遷移を記録して cutoffRecorded を返す', async () => {
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    taskWorkflowStatus = 'verify_done';
    const result = await attemptVerifyRepair(867, 'verify_done', TAMPER_ONLY, 'verify body');
    expect(result.bounced).toBe(false);
    expect(result.cutoffRecorded).toBe(true);
    expect(recordTransition).toHaveBeenCalledTimes(1);
    expect((recordTransition.mock.calls[0] as unknown[])[0]).toMatchObject({
      cause: VERIFY_NON_REPAIRABLE_CAUSE,
      taskId: 867,
    });
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
  });
});
