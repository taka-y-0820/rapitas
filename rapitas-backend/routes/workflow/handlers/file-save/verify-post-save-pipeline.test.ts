/**
 * verify-post-save-pipeline テスト
 *
 * runVerifyPostSaveAutomation が registerVerifyCompletion に渡す Promise が、
 * 完了ゲート（runVerifyCompletionGate）→ 陪審審査（runAdversarialDiffReview）
 * → commit/PR（runVerifyCommitPrCompletion）の全区間をカバーし、かつ各段階の
 * early-return 分岐すべてで最終的に登録が解除されることを固定する回帰テスト。
 *
 * task 660: 旧実装は commit/PR 段階（verify-commit-pr.ts）だけを登録していた。
 * タスク658は verify_done 書き込み後、完了ゲート＋LLM陪審の実行中（未登録区間）
 * に60秒の基本猶予が切れて blocked と誤判定され、その3.5分後に PR #458 が
 * 作成された。ここでは REAL の verify-completion-inflight レジストリを使い、
 * 各段階が未解決の間 hasVerifyCompletionInFlight が true を維持することを
 * 直接検証する。
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { CompletionReviewReceipt } from '../../../../services/workflow/requirement-replan-commit';

mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// The real registry traces start/settle to the timeline; keep that off the DB.
const appendEventMock = mock((_e: { eventType: string; payload?: unknown }) =>
  Promise.resolve({ id: 1 }),
);
mock.module('../../../../services/memory/timeline', () => ({ appendEvent: appendEventMock }));

/** A promise plus its resolver/rejecter, so a stage can be held "in flight". */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface GateOutcome {
  verifyGateBlocked: boolean;
  conflictTask: { title: string | null; githubPrId: number | null } | null;
  isConflictResolutionTask: boolean;
  preferredBaseBranchForVerify: string | null;
}
interface ReviewOutcome {
  newStatus?: string;
  verifyGateBlocked: boolean;
  staleVerifyRequest: boolean;
}
interface CommitPrOutcome {
  newStatus?: string;
  taskMarkedDone: boolean;
  autoCommitPRResult: Record<string, unknown>;
}

let gate = deferred<GateOutcome>();
let review = deferred<ReviewOutcome>();
let commitPr = deferred<CommitPrOutcome>();

const gateMock = mock((_p: unknown) => gate.promise);
const reviewMock = mock((_p: unknown) => review.promise);
const commitPrMock = mock((_p: unknown) => commitPr.promise);

mock.module('./verify-completion-gate', () => ({ runVerifyCompletionGate: gateMock }));
mock.module('./verify-adversarial-review', () => ({ runAdversarialDiffReview: reviewMock }));
mock.module('./verify-commit-pr', () => ({ runVerifyCommitPrCompletion: commitPrMock }));

// NOTE: verify-completion-inflight is intentionally NOT mocked — this test
// exercises the real registry to prove hasVerifyCompletionInFlight() actually
// observes the whole pipeline's lifetime.
const { runVerifyPostSaveAutomation } = await import('./verify-post-save-pipeline');
const { hasVerifyCompletionInFlight, resetVerifyCompletionRegistry } =
  await import('../../../../services/workflow/verify-completion-inflight');

const GATE_OPEN: GateOutcome = {
  verifyGateBlocked: false,
  conflictTask: { title: 'task', githubPrId: null },
  isConflictResolutionTask: false,
  preferredBaseBranchForVerify: 'develop',
};

function params(taskId: number, fileType: 'verify' | 'research' = 'verify') {
  return { taskId, fileType, newStatus: 'verify_done', savedContent: '# 検証結果' };
}

/** Let the registry's microtask chain run after a stage settles. */
async function tick(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('runVerifyPostSaveAutomation — in-flight は完了ゲート〜commit/PR の全区間をカバーする', () => {
  test('preserves the server receipt across asynchronous review until commit completion', async () => {
    const receipt = {
      taskId: 700,
      executionId: 8,
      evaluatedUpdatedAt: new Date(),
      review: {
        snapshotDigest: 'test',
        durationMs: 1,
        tokensUsed: 2,
        modelName: null,
        verdict: { kind: 'no_mismatch', reason: 'test' },
      },
    } satisfies CompletionReviewReceipt;
    const running = runVerifyPostSaveAutomation({ ...params(700), completionReceipt: receipt });
    expect(gateMock).toHaveBeenCalledWith(expect.objectContaining({ completionReceipt: receipt }));
    gate.resolve(GATE_OPEN);
    await tick();
    review.resolve({
      newStatus: 'verify_done',
      verifyGateBlocked: false,
      staleVerifyRequest: false,
    });
    await tick();
    expect(commitPrMock).toHaveBeenCalledWith(
      expect.objectContaining({ completionReceipt: receipt }),
    );
    commitPr.resolve({ newStatus: 'verify_done', taskMarkedDone: false, autoCommitPRResult: {} });
    await running;
  });
  beforeEach(() => {
    resetVerifyCompletionRegistry();
    gate = deferred<GateOutcome>();
    review = deferred<ReviewOutcome>();
    commitPr = deferred<CommitPrOutcome>();
    gateMock.mockClear();
    reviewMock.mockClear();
    commitPrMock.mockClear();
    appendEventMock.mockClear();
  });

  test('(d) 正常完了: 完了ゲート実行中から commit/PR 解決まで in-flight を維持し、解決後に解除される', async () => {
    const taskId = 658;
    const run = runVerifyPostSaveAutomation(params(taskId));

    // Registered synchronously, before the gate has even resolved — this is
    // the window in which task 658 was wrongly judged stuck.
    expect(hasVerifyCompletionInFlight(taskId)).toBe(true);
    expect(gateMock).toHaveBeenCalledTimes(1);
    expect(reviewMock).not.toHaveBeenCalled();

    gate.resolve(GATE_OPEN);
    await tick();
    expect(hasVerifyCompletionInFlight(taskId)).toBe(true);
    expect(reviewMock).toHaveBeenCalledTimes(1);
    expect(commitPrMock).not.toHaveBeenCalled();

    review.resolve({
      newStatus: 'verify_done',
      verifyGateBlocked: false,
      staleVerifyRequest: false,
    });
    await tick();
    expect(hasVerifyCompletionInFlight(taskId)).toBe(true);
    expect(commitPrMock).toHaveBeenCalledTimes(1);
    expect(commitPrMock.mock.calls[0][0]).toMatchObject({
      taskId,
      newStatus: 'verify_done',
      verifyGateBlocked: false,
      staleVerifyRequest: false,
      isConflictResolutionTask: false,
      conflictTask: GATE_OPEN.conflictTask,
      preferredBaseBranchForVerify: 'develop',
    });

    commitPr.resolve({ newStatus: 'completed', taskMarkedDone: true, autoCommitPRResult: {} });
    const result = await run;
    await tick();

    expect(result).toEqual({
      newStatus: 'completed',
      taskMarkedDone: true,
      autoCommitPRResult: {},
    });
    expect(hasVerifyCompletionInFlight(taskId)).toBe(false);
  });

  test('(a) 完了ゲート blocked: 後段は通常どおり呼ばれ、解決後に in-flight が解除される', async () => {
    const taskId = 601;
    const run = runVerifyPostSaveAutomation(params(taskId));
    expect(hasVerifyCompletionInFlight(taskId)).toBe(true);

    gate.resolve({ ...GATE_OPEN, verifyGateBlocked: true });
    await tick();
    expect(hasVerifyCompletionInFlight(taskId)).toBe(true);
    expect(reviewMock.mock.calls[0][0]).toMatchObject({ verifyGateBlocked: true });

    // The downstream stages short-circuit on verifyGateBlocked (unchanged logic).
    review.resolve({
      newStatus: 'verify_done',
      verifyGateBlocked: true,
      staleVerifyRequest: false,
    });
    await tick();
    commitPr.resolve({ newStatus: 'verify_done', taskMarkedDone: false, autoCommitPRResult: {} });
    const result = await run;
    await tick();

    expect(result.taskMarkedDone).toBe(false);
    expect(commitPrMock.mock.calls[0][0]).toMatchObject({ verifyGateBlocked: true });
    expect(hasVerifyCompletionInFlight(taskId)).toBe(false);
  });

  test('(b) 陪審 FAIL → self-repair バウンス: in_progress へ戻った後も in-flight が解除される', async () => {
    const taskId = 602;
    const run = runVerifyPostSaveAutomation(params(taskId));

    gate.resolve(GATE_OPEN);
    await tick();
    // While the jury deliberates (the 120s-per-juror stage) the task is live work.
    expect(hasVerifyCompletionInFlight(taskId)).toBe(true);

    review.resolve({
      newStatus: 'in_progress',
      verifyGateBlocked: false,
      staleVerifyRequest: false,
    });
    await tick();
    expect(commitPrMock.mock.calls[0][0]).toMatchObject({ newStatus: 'in_progress' });
    commitPr.resolve({ newStatus: 'in_progress', taskMarkedDone: false, autoCommitPRResult: {} });
    const result = await run;
    await tick();

    expect(result.newStatus).toBe('in_progress');
    expect(hasVerifyCompletionInFlight(taskId)).toBe(false);
  });

  test('(c) 陪審 FAIL → history-contamination recovery 失敗で blocked: in-flight が解除される', async () => {
    const taskId = 603;
    const run = runVerifyPostSaveAutomation(params(taskId));

    gate.resolve(GATE_OPEN);
    await tick();
    review.resolve({
      newStatus: 'verify_done',
      verifyGateBlocked: true,
      staleVerifyRequest: false,
    });
    await tick();
    expect(hasVerifyCompletionInFlight(taskId)).toBe(true);
    commitPr.resolve({ newStatus: 'verify_done', taskMarkedDone: false, autoCommitPRResult: {} });
    const result = await run;
    await tick();

    expect(result.taskMarkedDone).toBe(false);
    expect(hasVerifyCompletionInFlight(taskId)).toBe(false);
  });

  test('段階が例外を投げても in-flight 登録が解除され、例外は呼び出し元へ伝播する', async () => {
    const taskId = 604;
    const run = runVerifyPostSaveAutomation(params(taskId));
    expect(hasVerifyCompletionInFlight(taskId)).toBe(true);

    gate.reject(new Error('gate threw'));
    await expect(run).rejects.toThrow('gate threw');
    await tick();

    expect(hasVerifyCompletionInFlight(taskId)).toBe(false);
    expect(reviewMock).not.toHaveBeenCalled();
  });

  test('verify 以外の保存 / verify_done 以外の遷移では段階を呼ばず登録もしない', async () => {
    const research = await runVerifyPostSaveAutomation(params(605, 'research'));
    expect(research).toEqual({
      newStatus: 'verify_done',
      taskMarkedDone: false,
      autoCommitPRResult: {},
    });

    const notDone = await runVerifyPostSaveAutomation({
      ...params(606),
      newStatus: 'in_progress',
    });
    expect(notDone).toEqual({
      newStatus: 'in_progress',
      taskMarkedDone: false,
      autoCommitPRResult: {},
    });

    expect(gateMock).not.toHaveBeenCalled();
    expect(hasVerifyCompletionInFlight(605)).toBe(false);
    expect(hasVerifyCompletionInFlight(606)).toBe(false);
  });
});
