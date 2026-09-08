/**
 * blocked-pr-retry-recovery ユニットテスト
 *
 * attemptPrOnlyRecovery の3系統（PR作成成功→完了/PR作成失敗→
 * PR_RETRY_LIGHTWEIGHT_CAUSE記録/既にPRリンク済み→即完了）を、
 * performAutoCommitAndPR の呼び出し有無を直接アサートして検証する
 * （プレモーテム#1: mock.module の相対パスがソースの実際の import
 * 解決先とズレるとモックが効かず偽陽性で通過するリスクへの対策）。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

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

const mockTaskUpdateMany = mock(() => Promise.resolve({ count: 1 }));
// canReviveBlockedPrRetry (task 895) reads these fresh before allowing a
// `blocked` revival — default to "armed theme, blocked status, live execution"
// so the pre-existing happy-path cases below are unaffected by that addition.
let taskFindUniqueRow: { status: string; themeId: number | null } | null = {
  status: 'blocked',
  themeId: 1,
};
const mockTaskFindUnique = mock(() => Promise.resolve(taskFindUniqueRow));
let themeAutoRunRow: { enabled: boolean; status: string } | null = {
  enabled: true,
  status: 'running',
};
const mockThemeAutoRunFindUnique = mock(() => Promise.resolve(themeAutoRunRow));
let latestExecutionRow: { id: number; status: string } | null = { id: 1, status: 'completed' };
const mockAgentExecutionFindFirst = mock(() => Promise.resolve(latestExecutionRow));
mock.module('../../config/database', () => ({
  prisma: {
    task: { updateMany: mockTaskUpdateMany, findUnique: mockTaskFindUnique },
    themeAutoRun: { findUnique: mockThemeAutoRunFindUnique },
    agentExecution: { findFirst: mockAgentExecutionFindFirst },
  },
}));

const mockReadWorkflowFile = mock(() => Promise.resolve('# verify.md content'));
mock.module('./workflow-file-utils', () => ({
  readWorkflowFile: mockReadWorkflowFile,
}));

const mockRecordTransition = mock(() => Promise.resolve());
mock.module('./transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

let linkedPr = false;
const mockTaskHasLinkedPr = mock(() => Promise.resolve(linkedPr));
mock.module('./workflow-cli-executor-helpers', () => ({
  taskHasLinkedPr: mockTaskHasLinkedPr,
}));

type AutoCommitPRResultLike = {
  autoCommitResult?: { success: boolean; filesChanged?: number; error?: string };
  autoPRResult?: { success: boolean; prUrl?: string; prNumber?: number; error?: string };
  error?: string;
};
let acprResult: AutoCommitPRResultLike = {
  autoCommitResult: { success: true },
  autoPRResult: { success: true, prUrl: 'https://example.com/pr/1', prNumber: 1 },
};
const mockPerformAutoCommitAndPR = mock(() => Promise.resolve(acprResult));
mock.module('../../routes/workflow/workflow-auto-commit', () => ({
  performAutoCommitAndPR: mockPerformAutoCommitAndPR,
}));

// Required-merge gate (task 895). Default false so the pre-existing cases keep
// exercising the completion path unchanged.
let awaitingRequiredMerge = false;
const mockIsAwaitingRequiredMerge = mock(() => Promise.resolve(awaitingRequiredMerge));
mock.module('./verify-settle-artifact-recovery', () => ({
  isAwaitingRequiredMerge: mockIsAwaitingRequiredMerge,
}));

const mockHoldForRequiredMerge = mock(() => Promise.resolve(true));
mock.module('./required-merge-hold', () => ({
  holdForRequiredMerge: mockHoldForRequiredMerge,
  AWAITING_REQUIRED_MERGE_CAUSE: 'verify_awaiting_required_merge',
}));

const { attemptPrOnlyRecovery } = await import('./blocked-pr-retry-recovery');

describe('attemptPrOnlyRecovery', () => {
  beforeEach(() => {
    mockTaskUpdateMany.mockClear();
    mockReadWorkflowFile.mockClear();
    mockRecordTransition.mockClear();
    mockTaskHasLinkedPr.mockClear();
    mockPerformAutoCommitAndPR.mockClear();
    linkedPr = false;
    acprResult = {
      autoCommitResult: { success: true },
      autoPRResult: { success: true, prUrl: 'https://example.com/pr/1', prNumber: 1 },
    };
    mockTaskUpdateMany.mockResolvedValue({ count: 1 });
    mockIsAwaitingRequiredMerge.mockClear();
    mockHoldForRequiredMerge.mockClear();
    awaitingRequiredMerge = false;
    mockTaskFindUnique.mockClear();
    mockThemeAutoRunFindUnique.mockClear();
    mockAgentExecutionFindFirst.mockClear();
    taskFindUniqueRow = { status: 'blocked', themeId: 1 };
    themeAutoRunRow = { enabled: true, status: 'running' };
    latestExecutionRow = { id: 1, status: 'completed' };
  });

  test("PR作成成功: performAutoCommitAndPRが呼ばれ、taskが完了しverify_passedが記録され、'completed'を返す", async () => {
    const result = await attemptPrOnlyRecovery(673);

    expect(mockPerformAutoCommitAndPR).toHaveBeenCalledTimes(1);
    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: 673, workflowStatus: 'verify_done' },
      data: expect.objectContaining({ status: 'done', workflowStatus: 'completed' }),
    });
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 673, cause: 'verify_passed', toStatus: 'completed' }),
    );
    expect(result).toBe('completed');
  });

  test("PR作成失敗: performAutoCommitAndPRが呼ばれるが、PR_RETRY_LIGHTWEIGHT_CAUSEを記録し'failed'を返す（完了させない）", async () => {
    acprResult = {
      autoCommitResult: { success: true, filesChanged: 3 },
      autoPRResult: { success: false, error: 'gh pr create failed' },
    };
    linkedPr = false;

    const result = await attemptPrOnlyRecovery(673);

    expect(mockPerformAutoCommitAndPR).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 673, cause: 'verify_pr_retry_lightweight' }),
    );
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(result).toBe('failed');
  });

  test("既にPRリンク済み: performAutoCommitAndPRを呼ばずに直接完了扱いにし、'completed'を返す", async () => {
    linkedPr = true;

    const result = await attemptPrOnlyRecovery(673);

    expect(mockPerformAutoCommitAndPR).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: 673, workflowStatus: 'verify_done' },
      data: expect.objectContaining({ status: 'done', workflowStatus: 'completed' }),
    });
    expect(result).toBe('completed');
  });
});

describe('attemptPrOnlyRecovery — autoMergePR要求時はマージ確認まで完了させない (task 895)', () => {
  beforeEach(() => {
    mockTaskUpdateMany.mockClear();
    mockRecordTransition.mockClear();
    mockPerformAutoCommitAndPR.mockClear();
    mockHoldForRequiredMerge.mockClear();
    mockTaskUpdateMany.mockResolvedValue({ count: 1 });
    awaitingRequiredMerge = true;
    mockTaskFindUnique.mockClear();
    mockThemeAutoRunFindUnique.mockClear();
    mockAgentExecutionFindFirst.mockClear();
    taskFindUniqueRow = { status: 'blocked', themeId: 1 };
    themeAutoRunRow = { enabled: true, status: 'running' };
    latestExecutionRow = { id: 1, status: 'completed' };
  });

  test("既にPRリンク済み: armedかつ非停止のときのみ holdForRequiredMerge を blocked許容で呼び、完了させず 'held' を返す", async () => {
    linkedPr = true;

    const result = await attemptPrOnlyRecovery(895);

    expect(mockHoldForRequiredMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 895,
        source: 'blocked-pr-retry-recovery',
        fromStatusIn: ['blocked'],
      }),
    );
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockRecordTransition).not.toHaveBeenCalled();
    expect(result).toBe('held');
  });

  test("停止由来(テーマ停止)なら holdForRequiredMerge を呼ばず'declined_stopped'を返す（task 895 verify.md #1回帰防止。'failed'とは別種別 — 呼び出し元requeueBlockedTasksが完全リセットへ誤って落とさないための区別）", async () => {
    linkedPr = true;
    themeAutoRunRow = { enabled: false, status: 'idle' };

    const result = await attemptPrOnlyRecovery(895);

    expect(mockHoldForRequiredMerge).not.toHaveBeenCalled();
    expect(result).toBe('declined_stopped');
  });

  test("停止由来(最新実行cancelled)なら holdForRequiredMerge を呼ばず'declined_stopped'を返す", async () => {
    linkedPr = true;
    latestExecutionRow = { id: 2, status: 'cancelled' };

    const result = await attemptPrOnlyRecovery(895);

    expect(mockHoldForRequiredMerge).not.toHaveBeenCalled();
    expect(result).toBe('declined_stopped');
  });

  test("hold自体がCASに負けて false を返したら、このリカバリは'cas_lost'を返す（停止由来'declined_stopped'とは別種別に区別し、いずれも'failed'と混同しない）", async () => {
    linkedPr = true;
    mockHoldForRequiredMerge.mockResolvedValueOnce(false);

    const result = await attemptPrOnlyRecovery(895);

    expect(result).toBe('cas_lost');
  });

  test("PR作成成功: PRを作っても完了させず verify_done に保留し'held'を返す", async () => {
    linkedPr = false;
    acprResult = {
      autoCommitResult: { success: true },
      autoPRResult: { success: true, prUrl: 'https://example.com/pr/2', prNumber: 2 },
    };

    const result = await attemptPrOnlyRecovery(895);

    expect(mockPerformAutoCommitAndPR).toHaveBeenCalledTimes(1);
    expect(mockHoldForRequiredMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 895,
        source: 'blocked-pr-retry-recovery',
        fromStatusIn: ['blocked'],
      }),
    );
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(result).toBe('held');
  });

  test("PR作成失敗時は保留にも入らず、従来どおり軽量リトライ失敗として'failed'を返す", async () => {
    linkedPr = false;
    acprResult = {
      autoCommitResult: { success: true, filesChanged: 3 },
      autoPRResult: { success: false, error: 'gh pr create failed' },
    };

    const result = await attemptPrOnlyRecovery(895);

    expect(mockHoldForRequiredMerge).not.toHaveBeenCalled();
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'verify_pr_retry_lightweight' }),
    );
    expect(result).toBe('failed');
  });
});
