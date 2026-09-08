/**
 * workflow-cli-executor-verify-gate ユニットテスト (task 895)
 *
 * CLI/オーケストレータ駆動の verify エピローグが、autoMergePR 要求時に
 * PR 作成だけで done/completed へ進まないことを検証する。
 * autoMergePR 無効 / 未設定のケースでは従来どおり完了することも確認する。
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

const taskUpdate = mock(() => Promise.resolve({}));
mock.module('../../config', () => ({
  prisma: { task: { update: taskUpdate } },
}));

const recordTransition = mock(() => Promise.resolve());
mock.module('./transition-recorder', () => ({ recordTransition }));

mock.module('./workflow-file-utils', () => ({
  readWorkflowFile: mock(() => Promise.resolve('# verify')),
}));

mock.module('./completion-gate', () => ({
  evaluateCompletionGate: () => Promise.resolve({ allow: true, reason: 'real diff' }),
}));

mock.module('./durable-blocked-write', () => ({
  writeBlockedStatusDurable: mock(() => Promise.resolve()),
}));

mock.module('./verify-self-repair', () => ({
  hasFreshVerifyRejection: () => Promise.resolve(false),
  attemptVerifyRepair: () => Promise.resolve({ bounced: false, stale: false }),
}));

mock.module('./workflow-cli-executor-helpers', () => ({
  taskHasLinkedPr: () => Promise.resolve(true),
  wasVerifyValidationFailureJustRecorded: () => Promise.resolve(false),
}));

let awaitingRequiredMerge = false;
mock.module('./verify-settle-artifact-recovery', () => ({
  isAwaitingRequiredMerge: () => Promise.resolve(awaitingRequiredMerge),
}));

const holdForRequiredMerge = mock(() => Promise.resolve(true));
mock.module('./required-merge-hold', () => ({
  holdForRequiredMerge,
  AWAITING_REQUIRED_MERGE_CAUSE: 'verify_awaiting_required_merge',
}));

const { resolveVerifyPhaseStatus } = await import('./workflow-cli-executor-verify-gate');

/** Minimal passing-verify input: PR already linked, completion gate allows. */
function params() {
  return {
    taskId: 895,
    transition: { role: 'verifier', outputFile: 'verify', nextStatus: 'completed' },
    session: { id: 7 },
    currentWfStatus: 'verify_done',
    fileContent: '# 検証結果',
    validation: { ok: true, severity: 0, summary: 'ok', missingSections: [] },
    resolvedWorktreePath: 'C:\\work\\wt',
  } as unknown as Parameters<typeof resolveVerifyPhaseStatus>[0];
}

beforeEach(() => {
  taskUpdate.mockClear();
  recordTransition.mockClear();
  holdForRequiredMerge.mockClear();
  awaitingRequiredMerge = false;
});

describe('resolveVerifyPhaseStatus — 完了と必須マージ待ちの分岐', () => {
  test('autoMergePR=true かつ PR あり: completed にせず verify_done で保留する', async () => {
    awaitingRequiredMerge = true;

    const status = await resolveVerifyPhaseStatus(params());

    expect(status).toBe('verify_done');
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(holdForRequiredMerge).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 895, source: 'WorkflowCLIExecutor' }),
    );
    expect(recordTransition).not.toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'verify_passed' }),
    );
  });

  test('autoMergePR=false: 従来どおり done/completed にする', async () => {
    awaitingRequiredMerge = false;

    const status = await resolveVerifyPhaseStatus(params());

    expect(status).toBe('completed');
    expect(holdForRequiredMerge).not.toHaveBeenCalled();
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: 895 },
      data: expect.objectContaining({ status: 'done', workflowStatus: 'completed' }),
    });
    expect(recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'verify_passed', toStatus: 'completed' }),
    );
  });

  test('autoMergePR 未設定（isAwaitingRequiredMerge が false）でも完了できる', async () => {
    // 未設定は resolveAutomationPolicy の既定 (autoMergePR=false) に落ちるため
    // isAwaitingRequiredMerge が false を返す。= 上の false ケースと同じ経路。
    awaitingRequiredMerge = false;

    const status = await resolveVerifyPhaseStatus(params());

    expect(status).toBe('completed');
    expect(holdForRequiredMerge).not.toHaveBeenCalled();
  });
});
