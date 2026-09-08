/**
 * blocked-pr-retry-recovery — 経路5の必須マージ保留を実holdで証明する (task 895 verify.md #1)
 *
 * verify.md が指摘した回帰: `holdForRequiredMerge` の既定CASは `status:'blocked'`
 * を除外するため、blockedタスクからの呼び出しは常に count=0 で失敗するのに、
 * `attemptPrOnlyRecovery` は戻り値を確認せず無条件で true を返していた。
 *
 * `holdForRequiredMerge` と `canReviveBlockedPrRetry` は**モックしない**。
 * ステートフルな疑似DBに対して実際にCASを実行させ、次の3点を証明する:
 *  1. armed かつ非キャンセルの正当な場合は実際に status='blocked'→'in-progress' /
 *     workflowStatus='verify_done' へ書き込まれ、true を返す。
 *  2. 停止由来（テーマ停止 / 最新実行cancelled）の場合は行を一切変更せず、
 *     false を返す（無条件成功を返さない）。
 *  3. CASが競合して書き込めなかった場合（行が既に blocked から離れていた）も
 *     false を返し、二重に遷移を記録しない。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

/** Stateful fake row — the single source of truth the fake prisma reads/writes. */
type Row = { status: string; workflowStatus: string; themeId: number | null; githubPrId: number };
let row: Row = { status: 'blocked', workflowStatus: 'verify_done', themeId: 1, githubPrId: 42 };
let themeAutoRunRow: { enabled: boolean; status: string } | null = {
  enabled: true,
  status: 'running',
};
let latestExecution: { id: number; status: string } | null = { id: 1, status: 'completed' };

const updateManyCalls: Array<{ where: unknown; data: unknown }> = [];
const findUniqueCalls: Array<{ select?: unknown }> = [];

mock.module('../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: {
    task: {
      findUnique: (args: { select?: unknown }) => {
        findUniqueCalls.push(args);
        return Promise.resolve({ ...row });
      },
      updateMany: (args: {
        where: { id: number; workflowStatus?: string; status?: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        updateManyCalls.push(args);
        const statusOk = !args.where.status || args.where.status.in.includes(row.status);
        const wfOk =
          args.where.workflowStatus === undefined ||
          args.where.workflowStatus === row.workflowStatus;
        if (!statusOk || !wfOk) return Promise.resolve({ count: 0 });
        row = { ...row, ...(args.data as Partial<Row>) } as Row;
        return Promise.resolve({ count: 1 });
      },
    },
    themeAutoRun: {
      findUnique: () => Promise.resolve(themeAutoRunRow),
    },
    agentExecution: {
      findFirst: () => Promise.resolve(latestExecution),
    },
    workflowTransition: { findFirst: async () => null },
    gitHubPullRequest: {
      // taskHasLinkedPr's primary lookup — null so it falls back to task.githubPrId.
      findFirst: () => Promise.resolve(null),
    },
  },
}));

const recordTransition = mock(() => Promise.resolve());
mock.module('./transition-recorder', () => ({ recordTransition }));

// isAwaitingRequiredMerge itself (policy resolution + PR lookup) is a separate,
// already-tested unit — this integration test's subject is what happens AFTER
// it says "yes, a merge is required", so it is the one collaborator stubbed.
let awaitingRequiredMerge = true;
mock.module('./verify-settle-artifact-recovery', () => ({
  isAwaitingRequiredMerge: () => Promise.resolve(awaitingRequiredMerge),
}));

// NOTE: required-merge-hold.ts and blocked-pr-retry-recovery.ts's own
// canReviveBlockedPrRetry are loaded FOR REAL (not mocked) — that is the point.
const { attemptPrOnlyRecovery, canReviveBlockedPrRetry } =
  await import('./blocked-pr-retry-recovery');
const { AWAITING_REQUIRED_MERGE_CAUSE } = await import('./required-merge-hold');

beforeEach(() => {
  row = { status: 'blocked', workflowStatus: 'verify_done', themeId: 1, githubPrId: 42 };
  themeAutoRunRow = { enabled: true, status: 'running' };
  latestExecution = { id: 1, status: 'completed' };
  awaitingRequiredMerge = true;
  updateManyCalls.length = 0;
  findUniqueCalls.length = 0;
  recordTransition.mockClear();
});

describe('canReviveBlockedPrRetry — 実データでの判定', () => {
  test('armedなテーマ・非キャンセルなら true', async () => {
    expect(await canReviveBlockedPrRetry(895)).toBe(true);
  });

  test('テーマが停止(enabled=false)なら false', async () => {
    themeAutoRunRow = { enabled: false, status: 'idle' };
    expect(await canReviveBlockedPrRetry(895)).toBe(false);
  });

  test('テーマのrunがrunning以外なら false', async () => {
    themeAutoRunRow = { enabled: true, status: 'paused' };
    expect(await canReviveBlockedPrRetry(895)).toBe(false);
  });

  test('最新実行がcancelledなら false（停止由来のblockedを復活させない）', async () => {
    latestExecution = { id: 2, status: 'cancelled' };
    expect(await canReviveBlockedPrRetry(895)).toBe(false);
  });

  test('タスクが既に blocked から離れていたら false', async () => {
    row.status = 'in-progress';
    expect(await canReviveBlockedPrRetry(895)).toBe(false);
  });
});

describe('attemptPrOnlyRecovery — 経路5: PR既存リンク済み branch（実hold）', () => {
  test("正当なケース: 実際にDB行が blocked→in-progress/verify_done へ書き換わり'held'を返す", async () => {
    const result = await attemptPrOnlyRecovery(895);

    expect(result).toBe('held');
    expect(row.status).toBe('in-progress');
    expect(row.workflowStatus).toBe('verify_done');
    expect(updateManyCalls.length).toBe(1);
    expect(updateManyCalls[0]!.where).toMatchObject({
      id: 895,
      workflowStatus: 'verify_done',
      status: { in: ['blocked'] },
    });
    expect(recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 895, cause: AWAITING_REQUIRED_MERGE_CAUSE }),
    );
  });

  test("停止由来(テーマ停止): 行を一切変更せず'declined_stopped'を返す（無条件成功を返さない — verify.md #1回帰の再現防止。'failed'とは別種別に区別する — 2nd repair round）", async () => {
    themeAutoRunRow = { enabled: false, status: 'idle' };

    const result = await attemptPrOnlyRecovery(895);

    expect(result).toBe('declined_stopped');
    expect(row.status).toBe('blocked');
    expect(row.workflowStatus).toBe('verify_done');
    expect(updateManyCalls.length).toBe(0);
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test("停止由来(最新実行cancelled): 行を一切変更せず'declined_stopped'を返す", async () => {
    latestExecution = { id: 3, status: 'cancelled' };

    const result = await attemptPrOnlyRecovery(895);

    expect(result).toBe('declined_stopped');
    expect(row.status).toBe('blocked');
    expect(updateManyCalls.length).toBe(0);
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test("CAS競合: canReviveBlockedPrRetry通過後に行が動いていた場合、書き込めず'cas_lost'を返す（'declined_stopped'とは別種別）", async () => {
    // Simulate a concurrent process moving the row between the guard check and
    // the CAS write by making updateMany observe a different row than findUnique
    // reported: flip workflowStatus right before the CAS by overriding updateMany
    // via a one-shot wrapper is awkward with the shared fake, so instead prove
    // the CAS's own where-clause is honored by pre-moving the row's workflowStatus
    // (a legitimate concurrent-completion scenario) before calling.
    row.workflowStatus = 'completed';

    const result = await attemptPrOnlyRecovery(895);

    expect(result).toBe('cas_lost');
    expect(updateManyCalls.length).toBe(1); // attempted, but CAS where-clause rejects it
    expect(row.status).toBe('blocked'); // unchanged
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test("autoMergePR非要求: 従来どおり完了CASを実行し'completed'を返す（本テストの対象外パスの回帰なし）", async () => {
    awaitingRequiredMerge = false;

    const result = await attemptPrOnlyRecovery(895);

    expect(result).toBe('completed');
    expect(row.status).toBe('done');
    expect(row.workflowStatus).toBe('completed');
  });
});
