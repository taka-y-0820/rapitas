/**
 * auto-merge-recovery ユニットテスト (task 895)
 *
 * findCandidates は open PR のみを走査するため、GitHub 上でマージ済みなのに
 * ローカルの完了書き込みが失われたタスクは二度と候補に現れない。その回収経路が
 * 「GitHub の MERGED を権威として確認したときだけ」完了させ、統合ID未解決・
 * 別リポジトリ・停止・CAS競合では何もしないことを検証する。
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

mock.module('node:fs', () => ({ existsSync: () => true }));

const heldTask = {
  id: 895,
  githubPrId: 621,
  workingDirectory: 'C:\\repo',
  theme: { repositoryUrl: 'https://github.com/acme/repo', workingDirectory: 'C:\\repo' },
};

const taskFindMany = mock(() => Promise.resolve([heldTask]) as ReturnType<typeof mock>);
const taskUpdateMany = mock(() => Promise.resolve({ count: 1 }) as ReturnType<typeof mock>);
const scopedPr = {
  id: 5,
  baseBranch: 'develop',
  linkedTaskId: 895,
  integration: { ownerName: 'acme', repositoryName: 'repo' },
};
const prFindFirst = mock(() => Promise.resolve(scopedPr) as ReturnType<typeof mock>);
const prUpdateMany = mock(() => Promise.resolve({ count: 1 }));
mock.module('../../config/database', () => ({
  prisma: {
    task: { findMany: taskFindMany, updateMany: taskUpdateMany },
    gitHubPullRequest: { findFirst: prFindFirst, updateMany: prUpdateMany },
  },
}));

const recordTransition = mock(() => Promise.resolve());
mock.module('./transition-recorder', () => ({ recordTransition }));

let autoMergePR = true;
mock.module('./automation-policy', () => ({
  resolveAutomationPolicy: () =>
    Promise.resolve({ autoCommit: true, autoCreatePR: true, autoMergePR }),
}));

let canContinue = true;
mock.module('./auto-merge-task-guard', () => ({
  canContinueAutoMerge: () => Promise.resolve(canContinue),
}));

const notify = mock(() => Promise.resolve());
mock.module('./auto-merge-notify', () => ({ notify }));

let integrationId: number | null = 3;
mock.module('../github/pr-link', () => ({
  resolveIntegrationId: () => Promise.resolve(integrationId),
}));

type RemoteState = {
  number: number;
  state: string;
  mergedAt: string | null;
  baseRefName: string | null;
} | null;
let remoteState: RemoteState = {
  number: 621,
  state: 'MERGED',
  mergedAt: '2026-09-08T02:27:44Z',
  baseRefName: 'develop',
};
const readAuthoritativeMergeState = mock(() => Promise.resolve(remoteState));
mock.module('../agents/orchestrator/git-operations/pr/pr-merge-ops', () => ({
  readAuthoritativeMergeState,
}));

const { recoverMergedTasks } = await import('./auto-merge-recovery');

beforeEach(() => {
  taskFindMany.mockClear();
  taskUpdateMany.mockClear();
  prFindFirst.mockClear();
  prUpdateMany.mockClear();
  recordTransition.mockClear();
  notify.mockClear();
  readAuthoritativeMergeState.mockClear();
  taskFindMany.mockResolvedValue([heldTask]);
  taskUpdateMany.mockResolvedValue({ count: 1 });
  prFindFirst.mockResolvedValue(scopedPr);
  autoMergePR = true;
  canContinue = true;
  integrationId = 3;
  remoteState = {
    number: 621,
    state: 'MERGED',
    mergedAt: '2026-09-08T02:27:44Z',
    baseRefName: 'develop',
  };
});

describe('recoverMergedTasks — 正常回収', () => {
  test('GitHubがMERGEDならCASで完了させ、遷移と通知を記録する', async () => {
    const recovered = await recoverMergedTasks();

    expect(recovered).toEqual([895]);
    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 895,
        githubPrId: 621,
        workflowStatus: 'verify_done',
        status: { in: ['in-progress', 'in_progress'] },
      },
      data: expect.objectContaining({ status: 'done', workflowStatus: 'completed' }),
    });
    expect(recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'auto_merge_recovered', toStatus: 'completed' }),
    );
    expect(notify).toHaveBeenCalled();
  });

  test('保留対象の抽出条件は verify_done + 進行中 + PR記録あり', async () => {
    await recoverMergedTasks();

    const where = (taskFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      workflowStatus: 'verify_done',
      status: { in: ['in-progress', 'in_progress'] },
      githubPrId: { not: null },
    });
  });
});

describe('recoverMergedTasks — 回収してはいけないケース', () => {
  test('supervisor: cwd fallback cannot choose another repository', async () => {
    await recoverMergedTasks();
    expect(readAuthoritativeMergeState).toHaveBeenCalledWith(expect.any(String), 621, 'acme/repo');
  });
  test('supervisor: a different base branch is not completion evidence', async () => {
    remoteState = { ...remoteState!, baseRefName: 'unrelated' };
    expect(await recoverMergedTasks()).toEqual([]);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });
  test('supervisor: another task ownership or missing repository identity cannot complete', async () => {
    prFindFirst.mockResolvedValueOnce({ ...scopedPr, linkedTaskId: 123 });
    expect(await recoverMergedTasks()).toEqual([]);
    prFindFirst.mockResolvedValueOnce({ ...scopedPr, integration: null });
    expect(await recoverMergedTasks()).toEqual([]);
    expect(readAuthoritativeMergeState).not.toHaveBeenCalled();
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });
  test('統合IDが解決できなければ gh を呼ばず何もしない', async () => {
    integrationId = null;

    expect(await recoverMergedTasks()).toEqual([]);
    expect(readAuthoritativeMergeState).not.toHaveBeenCalled();
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  test('自リポジトリにその番号のPR行が無ければ（別リポジトリの同番号）何もしない', async () => {
    prFindFirst.mockResolvedValueOnce(null);

    expect(await recoverMergedTasks()).toEqual([]);
    expect(readAuthoritativeMergeState).not.toHaveBeenCalled();
  });

  test('GitHubがまだOPENなら完了させない', async () => {
    remoteState = { number: 621, state: 'OPEN', mergedAt: null, baseRefName: 'develop' };

    expect(await recoverMergedTasks()).toEqual([]);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  test('MERGEDでも mergedAt が不正なら完了させない', async () => {
    remoteState = { number: 621, state: 'MERGED', mergedAt: 'not-a-date', baseRefName: 'develop' };

    expect(await recoverMergedTasks()).toEqual([]);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  test('gh が読めない（null）なら完了させない', async () => {
    remoteState = null;

    expect(await recoverMergedTasks()).toEqual([]);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  test('autoMergePR を要求していないタスクは対象外', async () => {
    autoMergePR = false;

    expect(await recoverMergedTasks()).toEqual([]);
    expect(readAuthoritativeMergeState).not.toHaveBeenCalled();
  });

  test('GitHub確認後に停止されていたら完了させない', async () => {
    canContinue = false;

    expect(await recoverMergedTasks()).toEqual([]);
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  test('CASに負けた（他経路が先に完了/新規実行が進めた）場合は通知も遷移も出さない', async () => {
    taskUpdateMany.mockResolvedValueOnce({ count: 0 });

    expect(await recoverMergedTasks()).toEqual([]);
    expect(recordTransition).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
