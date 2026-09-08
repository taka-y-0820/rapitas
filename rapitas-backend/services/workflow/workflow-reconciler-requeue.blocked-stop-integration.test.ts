/**
 * workflow-reconciler-requeue — requeueBlockedTasks の停止/CAS競合耐性を実装で証明する
 * (task 895 検証者指摘: 2nd repair round)
 *
 * 検証者指摘: `canReviveBlockedPrRetry` が停止/CAS敗北で false 相当を返しても、
 * `requeueBlockedTasks` はそれを「軽量リトライ失敗」と区別できず、後段の盲目
 * フルリセット（status:'todo', workflowStatus:'draft'）へ到達して新規実行を
 * 再ディスパッチしていた。この結合テストは `attemptPrOnlyRecovery` /
 * `canReviveBlockedPrRetry` / `isAwaitingRequiredMerge` / `holdForRequiredMerge` /
 * `taskHasLinkedPr` / `isLatestExecutionCancelled` / `resolveAutomationPolicy`
 * を**すべてモックせず実装のまま**呼び出し、`requeueBlockedTasks` 全体を通して
 * 次を証明する:
 *  1. テーマ armed のまま「個別タスクの最新実行が cancelled」だけで停止扱いに
 *     なるケース（`requeueBlockedTasks` 自体の armedThemeIds フィルタでは
 *     捕捉できない個別停止）で、フルリセット（task.update）が一切呼ばれない。
 *  2. `requeueBlockedTasks` のスキャン時点では armed だったテーマが、
 *     `canReviveBlockedPrRetry` の再読取り時点で停止済みに変わっていた
 *     （スキャンとチェックの間の競合）場合も、フルリセットが一切呼ばれない。
 *  3. hold の CAS 自体が競合で書き込めなかった場合も、フルリセットが
 *     一切呼ばれない。
 *  4. 何も異常が無い正当なケースでは実際に hold の CAS が成功し、
 *     フルリセットを経由せずに再帰復旧が完了する（回帰確認）。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
};
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

/** The single stateful task row every real module below reads/writes through the fake prisma. */
type TaskRow = {
  id: number;
  status: string;
  workflowStatus: string;
  themeId: number | null;
  autoMergePR: boolean;
  githubPrId: number | null;
};
let row: TaskRow = {
  id: 673,
  status: 'blocked',
  workflowStatus: 'verify_done',
  themeId: 1,
  autoMergePR: true,
  githubPrId: 999,
};

/** themeAutoRun as seen by requeueBlockedTasks's OWN scan-time gate (findMany). */
let scanTimeArmedThemes: Array<{ themeId: number }> = [{ themeId: 1 }];
/** themeAutoRun as seen by canReviveBlockedPrRetry's fresh re-read (findUnique) — independently controllable to simulate a stop landing between the scan and the recheck. */
let liveThemeAutoRun: { enabled: boolean; status: string } | null = {
  enabled: true,
  status: 'running',
};
/** Latest AgentExecution — controls isLatestExecutionCancelled's verdict. */
let latestExecution: { id: number; status: string } | null = { id: 1, status: 'completed' };

const taskUpdateCalls: unknown[] = [];
const taskUpdateManyCalls: unknown[] = [];
const recordTransition = mock(() => Promise.resolve());

const fakePrisma = {
  task: {
    findMany: () => Promise.resolve([{ id: row.id, workflowStatus: row.workflowStatus }]),
    findUnique: () => Promise.resolve({ ...row }),
    update: (args: unknown) => {
      taskUpdateCalls.push(args);
      return Promise.resolve({});
    },
    updateMany: (args: {
      where: { id: number; workflowStatus?: string; status?: { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      taskUpdateManyCalls.push(args);
      const statusOk = !args.where.status || args.where.status.in.includes(row.status);
      const wfOk =
        args.where.workflowStatus === undefined || args.where.workflowStatus === row.workflowStatus;
      if (!statusOk || !wfOk) return Promise.resolve({ count: 0 });
      row = { ...row, ...(args.data as Partial<TaskRow>) };
      return Promise.resolve({ count: 1 });
    },
  },
  themeAutoRun: {
    findMany: () => Promise.resolve(scanTimeArmedThemes),
    findUnique: () => Promise.resolve(liveThemeAutoRun),
  },
  userSettings: { findFirst: () => Promise.resolve(null) },
  activityLog: { findFirst: () => Promise.resolve(null) },
  workflowTransition: {
    findFirst: () => Promise.resolve(null),
    // Drive requeueBlockedTasks past its verify_pr_not_created gate (task 673/
    // 681's lightweight-recovery trigger) and into attemptPrOnlyRecovery for
    // every scenario here — every OTHER cutoff count (verify_repair,
    // verify_repair_non_convergence, blocked_auto_retry, the lightweight-
    // already-attempted marker) stays at 0 so none of them short-circuit first.
    count: (args: { where: { cause: string } }) =>
      Promise.resolve(args.where.cause === 'verify_pr_not_created' ? 1 : 0),
  },
  agentExecution: {
    findFirst: (args: { where?: { status?: { in: string[] } } }) => {
      // Two distinct callers share this one method:
      //  - hasLiveExecution (workflow-reconciler-requeue.ts): filters by status.in
      //  - isLatestExecutionCancelled (publication-cancellation-guard.ts): no status filter
      if (args?.where?.status) return Promise.resolve(null); // no live execution
      return Promise.resolve(latestExecution);
    },
  },
  gitHubPullRequest: {
    // taskHasLinkedPr's primary lookup — PR is linked, so branch A (no
    // performAutoCommitAndPR call) is exercised; the heavy git/PR pipeline
    // does not need mocking for this test's scenarios.
    findFirst: () => Promise.resolve({ id: 42 }),
  },
};

mock.module('../../config/database', () => ({
  prisma: fakePrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../../config', () => ({
  prisma: fakePrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('./transition-recorder', () => ({ recordTransition }));

// NOTE: everything downstream of these three mocks — attemptPrOnlyRecovery,
// canReviveBlockedPrRetry, isAwaitingRequiredMerge, resolveAutomationPolicy,
// taskHasLinkedPr, holdForRequiredMerge, isLatestExecutionCancelled — is loaded
// FOR REAL. That is the point of this test: prove the actual wiring, not a
// re-mocked stand-in.
const { requeueBlockedTasks } = await import('./workflow-reconciler-requeue');

const NOW = 1_800_000_000_000;

beforeEach(() => {
  row = {
    id: 673,
    status: 'blocked',
    workflowStatus: 'verify_done',
    themeId: 1,
    autoMergePR: true,
    githubPrId: 999,
  };
  scanTimeArmedThemes = [{ themeId: 1 }];
  liveThemeAutoRun = { enabled: true, status: 'running' };
  latestExecution = { id: 1, status: 'completed' };
  taskUpdateCalls.length = 0;
  taskUpdateManyCalls.length = 0;
  recordTransition.mockClear();
});

describe('requeueBlockedTasks — 実装での停止/CAS競合耐性 (task 895, 2nd repair round)', () => {
  test('個別タスクの最新実行がcancelled（テーマはarmedのまま）でもフルリセットしない', async () => {
    latestExecution = { id: 2, status: 'cancelled' };

    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(0);
    expect(taskUpdateCalls.length).toBe(0); // 盲目フルリセットが一切呼ばれない
    expect(row.status).toBe('blocked'); // 行は一切変更されない
    expect(row.workflowStatus).toBe('verify_done');
  });

  test('スキャン時点はarmedだが、canReviveBlockedPrRetryの再読取り時点で停止済みならフルリセットしない', async () => {
    scanTimeArmedThemes = [{ themeId: 1 }]; // requeueBlockedTasks自身のゲートは通過させる
    liveThemeAutoRun = { enabled: false, status: 'idle' }; // 個別再確認時点では停止済み

    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(0);
    expect(taskUpdateCalls.length).toBe(0);
    expect(row.status).toBe('blocked');
  });

  test('holdのCASが競合して書き込めなかった場合もフルリセットしない', async () => {
    // canReviveBlockedPrRetry は通過するが、CASのwhere句(workflowStatus:'verify_done')
    // が要求時点の実際の行と一致しない状況を再現する。
    row.workflowStatus = 'completed';

    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(0);
    expect(taskUpdateManyCalls.length).toBe(1); // holdは試みられたがCASで拒否された
    expect(taskUpdateCalls.length).toBe(0); // フルリセットには絶対に到達しない
    expect(row.status).toBe('blocked'); // 行は変化しない
  });

  test('正当なケース: 実際にholdのCASが成功し、フルリセットを経由せず再帰復旧が完了する', async () => {
    const retried = await requeueBlockedTasks(NOW);

    expect(retried).toBe(1);
    expect(taskUpdateCalls.length).toBe(0); // フルリセットは呼ばれない
    expect(taskUpdateManyCalls.length).toBe(1);
    expect(row.status).toBe('in-progress'); // 実際にDB行がholdされている
    expect(row.workflowStatus).toBe('verify_done');
    expect(recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 673, cause: 'verify_awaiting_required_merge' }),
    );
  });
});
