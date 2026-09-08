/**
 * status-transition テスト — 不変条件カットオフの配線 (task 755)
 *
 * task #572: checkWorkflowInvariants の違反が newStatus 確定パス
 * (fileType 問わず全て) で記録されるだけで是正アクションに接続されておらず、
 * 同一違反が状態リセット後も再発していた。attemptInvariantCutoff への接続後、
 * 初回違反は素通り（従来どおり file_saved:<fileType> を記録）、再発した違反は
 * カットオフが記録した終端遷移のみが残り、二重記録されないことを検証する。
 * 非収束カットオフ以外のシナリオ（verify_validation_failed 系）は
 * status-transition.test.ts で別途カバー済み — mock.module 汚染を避けるため
 * 別ファイルに分離。
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
mock.module('../../../../services/workflow/requirement-replan-service', () => ({
  attemptRequirementReplan: async () => ({
    committed: false,
    reason: 'no_mismatch',
    completionReceipt: { taskId: 715 },
  }),
}));

mock.module('../../../../services/workflow/requirement-replan-commit', () => ({
  advanceReviewedVerify: async (_db: unknown, receipt: unknown) => receipt,
}));

mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const mockTaskUpdate = mock(() => Promise.resolve({})) as any;
const mockPrisma = {
  task: { update: mockTaskUpdate, findUnique: mock(() => Promise.resolve(null)) },
  workflowTransition: { findFirst: mock(() => Promise.resolve(null)) },
};
mock.module('../../../../config', () => ({ prisma: mockPrisma }));

mock.module('../../../../services/workflow/completion-gate', () => ({
  researchConcludesNoChange: () => false,
}));

const mockRecordTransition = mock(() => Promise.resolve()) as any;
mock.module('../../../../services/workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

const mockCheckWorkflowInvariants = mock(() =>
  Promise.resolve([] as { code: string; message: string }[]),
) as any;
mock.module('../../../../services/workflow/workflow-invariants', () => ({
  checkWorkflowInvariants: mockCheckWorkflowInvariants,
}));

const mockAttemptInvariantCutoff = mock(() => Promise.resolve(false)) as any;
mock.module('../../../../services/workflow/verify-invariant-repair', () => ({
  attemptInvariantCutoff: mockAttemptInvariantCutoff,
}));

// Task 766: missing_file self-repair is dispatched from the same violations
// list — mocked so this file stays focused on the cutoff wiring (repair's
// own behavior is covered by invariant-repair.test.ts).
const mockRepairMissingFile = mock(() => Promise.resolve({ repaired: false })) as any;
mock.module('../../../../services/workflow/invariant-repair', () => ({
  repairMissingFile: mockRepairMissingFile,
}));

const mockMarkLatestExecutionFailed = mock(() => Promise.resolve()) as any;
mock.module('./shared', () => ({
  markLatestExecutionFailed: mockMarkLatestExecutionFailed,
  wasNonConvergenceCutoffJustRecorded: mock(() => Promise.resolve(false)),
}));

mock.module('../../../../services/workflow/phase-output-validator', () => ({
  validateVerify: () => ({ ok: true, missingSections: [], severity: 0, summary: '' }),
}));

const { computeAndApplyStatusTransition } = await import('./status-transition');

function buildParams(
  overrides: Partial<Parameters<typeof computeAndApplyStatusTransition>[0]> = {},
) {
  return {
    taskId: 572,
    fileType: 'verify' as const,
    currentStatus: 'in_progress',
    savedContent: 'verify body — all green',
    ...overrides,
  };
}

describe('computeAndApplyStatusTransition — 不変条件カットオフの配線', () => {
  beforeEach(() => {
    mockRecordTransition.mockClear();
    mockTaskUpdate.mockClear();
    mockMarkLatestExecutionFailed.mockClear();
    mockCheckWorkflowInvariants.mockReset().mockResolvedValue([]);
    mockAttemptInvariantCutoff.mockReset().mockResolvedValue(false);
    mockRepairMissingFile.mockReset().mockResolvedValue({ repaired: false });
  });

  test('violation なしなら attemptInvariantCutoff を呼ばず従来どおり file_saved:verify を記録すること', async () => {
    await computeAndApplyStatusTransition(buildParams());

    expect(mockAttemptInvariantCutoff).not.toHaveBeenCalled();
    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'file_saved:verify', invariantViolation: false }),
    );
    expect(mockTaskUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'blocked' }) }),
    );
  });

  test('初回違反（カットオフ未発生）は素通りし file_saved:verify を1回だけ記録すること', async () => {
    mockCheckWorkflowInvariants.mockResolvedValue([
      { code: 'missing_file', message: 'workflowStatus="verify_done" but plan.md is missing' },
    ]);
    mockAttemptInvariantCutoff.mockResolvedValue(false);

    await computeAndApplyStatusTransition(buildParams());

    expect(mockAttemptInvariantCutoff).toHaveBeenCalledWith(
      572,
      'in_progress',
      'missing_file:workflowStatus="verify_done" but plan.md is missing',
      null,
    );
    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'file_saved:verify', invariantViolation: true }),
    );
    expect(mockTaskUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'blocked' }) }),
    );
    // Task 766: カットオフが発生しなかった missing_file 違反は自己修復を試みる。
    expect(mockRepairMissingFile).toHaveBeenCalledWith(
      572,
      expect.objectContaining({
        code: 'missing_file',
        message: 'workflowStatus="verify_done" but plan.md is missing',
      }),
    );
  });

  test('再発違反（task #572 shape）はカットオフのみが記録され file_saved:verify は記録されないこと', async () => {
    mockCheckWorkflowInvariants.mockResolvedValue([
      { code: 'missing_file', message: 'workflowStatus="verify_done" but plan.md is missing' },
    ]);
    mockAttemptInvariantCutoff.mockResolvedValue(true);

    const result = await computeAndApplyStatusTransition(buildParams());

    // 二重記録防止: カットオフが自前で終端遷移を記録済みなので、この汎用
    // recordTransition (cause: file_saved:verify) は一切呼ばれない。
    expect(mockRecordTransition).not.toHaveBeenCalled();
    expect(mockTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 572 },
        data: expect.objectContaining({ status: 'blocked' }),
      }),
    );
    expect(mockMarkLatestExecutionFailed).toHaveBeenCalledTimes(1);
    // workflowStatus 自体は確定済みのまま — 遷移経路上の矛盾シグナルとして残す。
    expect(result.newStatus).toBe('verify_done');
    // Task 766: カットオフでブロック済みのため自己修復は試みない（ブロック直後の巻き戻しを避ける）。
    expect(mockRepairMissingFile).not.toHaveBeenCalled();
  });

  test('attemptInvariantCutoff が例外を投げても fail-open し通常の記録を継続すること', async () => {
    mockCheckWorkflowInvariants.mockResolvedValue([{ code: 'status_mismatch', message: 'x' }]);
    mockAttemptInvariantCutoff.mockImplementation(() => Promise.reject(new Error('db down')));

    await computeAndApplyStatusTransition(buildParams());

    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'file_saved:verify', invariantViolation: true }),
    );
  });

  test('同一タスク・同一保存で recordTransition が2件記録されないこと（カットオフ発生時）', async () => {
    mockCheckWorkflowInvariants.mockResolvedValue([
      { code: 'incomplete_subtasks', message: 'workflowStatus="verify_done" but 1 subtask(s)...' },
    ]);
    mockAttemptInvariantCutoff.mockResolvedValue(true);

    await computeAndApplyStatusTransition(buildParams());

    expect(mockRecordTransition.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
