/**
 * verify-self-repair テスト
 *
 * verify.md 検証失敗時に実装フェーズへ差し戻す自己修復ループの検証:
 * plan 有無での戻し先 status（plan_approved / research_done）、リトライ上限到達で
 * block（bounced:false）、無効化（MAX=0）、question.md への差し戻しフィードバック。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const mockPrisma = {
  workflowTransition: {
    count: mock(() => Promise.resolve(0)),
    findFirst: mock(() => Promise.resolve(null as { cause: string; createdAt: Date } | null)),
    // NOTE: Added (task 619) — the non-convergence check reads prior repair
    // reasons. Default [] keeps every pre-existing case on the bounce path.
    findMany: mock(() => Promise.resolve([] as { metadata: string | null }[])),
  },
  workflowFile: { findFirst: mock(() => Promise.resolve(null)) },
  task: {
    // NOTE: updateMany に追随（96012d96 の CAS 化でサービス側が update → updateMany に
    // 変わった際、このモックが未更新で全ケース throw していた）。count:1 = CAS成立。
    updateMany: mock(() => Promise.resolve({ count: 1 })),
    findUnique: mock(() =>
      Promise.resolve({ themeId: null } as {
        themeId: number | null;
        title?: string;
        acceptanceCriteria?: string | null;
      }),
    ),
  },
  // NOTE: Added — verify-self-repair.ts:52 reads verifyRepairLimit from userSettings.
  userSettings: { findFirst: mock(() => Promise.resolve(null)) },
  // NOTE: Added — verify-self-repair.ts:65 reads the last task_retried entry from activityLog.
  activityLog: { findFirst: mock(() => Promise.resolve(null)) },
};
const recordTransition = mock(() => Promise.resolve());
const writeWorkflowFile = mock(() => Promise.resolve('/p/question.md'));
const readWorkflowFile = mock(() => Promise.resolve('' as string | null));
const resolveWorkflowDir = mock(() => Promise.resolve({ dir: '/wf/1' }));

const evaluatedAt = new Date('2026-09-08T00:00:00Z');
const queuedItem = mock(async (): Promise<{ id: number } | null> => null);
const databaseMock = {
  ...mockPrisma,
  task: {
    ...mockPrisma.task,
    findUnique: async (...args: unknown[]) => {
      const row = await (
        mockPrisma.task.findUnique as (
          ...args: unknown[]
        ) => Promise<Record<string, unknown> | null>
      )(...args);
      return row
        ? { status: 'in-progress', workflowStatus: 'in_progress', updatedAt: evaluatedAt, ...row }
        : null;
    },
  },
  agentExecution: { findFirst: async () => null },
  themeAutoRun: { findUnique: async () => null },
  workflowQueueItem: { findFirst: queuedItem },
  workflowFile: {
    ...mockPrisma.workflowFile,
    findUnique: () => mockPrisma.workflowFile.findFirst(),
  },
  workflowTransition: {
    ...mockPrisma.workflowTransition,
    findFirst: async (...args: unknown[]) => {
      const row = await (
        mockPrisma.workflowTransition.findFirst as (
          ...args: unknown[]
        ) => Promise<{ cause: string; createdAt: Date } | null>
      )(...args);
      const query = args[0] as { where?: { cause?: { in: string[] } } };
      return row && query.where?.cause && !query.where.cause.in.includes(row.cause) ? null : row;
    },
    create: async (args: { data: { metadata: string } }) =>
      (recordTransition as (...args: unknown[]) => Promise<void>)({
        ...args.data,
        metadata: JSON.parse(args.data.metadata),
      }),
  },
};
Object.assign(databaseMock, {
  $transaction: async (operation: (tx: typeof databaseMock) => unknown) => operation(databaseMock),
});

const noopLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
mock.module('../../config/database', () => ({
  prisma: databaseMock,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));
mock.module('../../services/workflow/workflow-file-utils', () => ({
  resolveWorkflowDir,
  readWorkflowFile,
  writeWorkflowFile,
  cleanupRootWorkflowFiles: () => Promise.resolve(),
  extractMarkdownFromOutput: () => null,
}));
mock.module('../../services/workflow/transition-recorder', () => ({ recordTransition }));

// Self-drive (B fix): the bounce re-queues the task and idempotently starts the
// runner. Capture both to assert they fire on bounce but not on exhaustion.
const enqueue = mock(() => Promise.resolve({ id: 1 }));
const startProcessing = mock(() => {});
mock.module('../../services/workflow/workflow-queue', () => ({
  WorkflowQueueService: { getInstance: () => ({ enqueue }) },
}));
mock.module('../../services/workflow/workflow-runner', () => ({
  WorkflowRunner: { getInstance: () => ({ startProcessing }) },
}));
// Theme auto-run state: default INACTIVE so ensureRunnerResumes self-drives
// (single/manual exec) — the behavior the existing assertions expect. The
// concurrency-guard test flips this to active.
const isThemeAutoRunActive = mock(() => Promise.resolve(false));
mock.module('../../services/workflow/auto-run/theme-auto-run-service', () => ({
  isThemeAutoRunActive,
}));

// task 619: 収束打ち切り時のエスカレーション呼び出しを spy 化（フルミラー必須 —
// bun mock.module はモジュール全体を置換するため実 export を全て提供する）。
const escalateBlockedTask = mock(() => Promise.resolve(true));
mock.module('../../services/workflow/blocked-task-escalation', () => ({
  escalateBlockedTask,
  BLOCKED_ESCALATED_CAUSE: 'blocked_escalated',
  countEscalatedBlocked: () => Promise.resolve(0),
}));

const { attemptVerifyRepair, hasFreshVerifyRejection } =
  await import('../../services/workflow/verify-self-repair');

describe('attemptVerifyRepair', () => {
  beforeEach(() => {
    queuedItem.mockReset().mockResolvedValue(null);
    delete process.env.RAPITAS_MAX_VERIFY_REPAIRS;
    mockPrisma.workflowTransition.count.mockReset();
    mockPrisma.workflowFile.findFirst.mockReset();
    mockPrisma.task.updateMany.mockReset();
    recordTransition.mockReset();
    writeWorkflowFile.mockReset();
    readWorkflowFile.mockReset();
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    mockPrisma.workflowFile.findFirst.mockResolvedValue(null);
    mockPrisma.task.updateMany.mockResolvedValue({ count: 1 });
    recordTransition.mockResolvedValue(undefined);
    writeWorkflowFile.mockResolvedValue('/p/question.md');
    readWorkflowFile.mockResolvedValue('');
    enqueue.mockReset();
    startProcessing.mockReset();
    enqueue.mockResolvedValue({ id: 1 });
    mockPrisma.task.findUnique.mockReset();
    mockPrisma.task.findUnique.mockResolvedValue({ themeId: null });
    isThemeAutoRunActive.mockReset();
    isThemeAutoRunActive.mockResolvedValue(false);
    // NOTE: Must reset per-test — a test that sets verifyRepairLimit would
    // otherwise leak into later tests since these mocks are shared across it()s.
    mockPrisma.userSettings.findFirst.mockReset();
    mockPrisma.userSettings.findFirst.mockResolvedValue(null);
    mockPrisma.activityLog.findFirst.mockReset();
    mockPrisma.activityLog.findFirst.mockResolvedValue(null);
    // NOTE: task 619 — non-convergence inputs must reset per test.
    mockPrisma.workflowTransition.findMany.mockReset();
    mockPrisma.workflowTransition.findMany.mockResolvedValue([]);
    // NOTE (task 832 premortem #1): workflowTransition.findFirst is shared with
    // the `hasFreshVerifyRejection` describe below. Without a reset here, an
    // implementation it sets earlier in a full-suite run leaks into this
    // describe's window-boundary query and only fails when run alongside it.
    mockPrisma.workflowTransition.findFirst.mockReset();
    mockPrisma.workflowTransition.findFirst.mockResolvedValue(null);
    escalateBlockedTask.mockReset();
    escalateBlockedTask.mockResolvedValue(true);
  });

  test('plan あり → plan_approved へ bounce（attempt 1）すること', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });

    const r = await attemptVerifyRepair(1, 'in_progress', 'self-contradicts', '...verify...');

    expect(r.bounced).toBe(true);
    expect(r.newStatus).toBe('plan_approved');
    expect(r.attempt).toBe(1);
    // task を in-progress に戻し、修復 transition を記録すること
    const tu = mockPrisma.task.updateMany.mock.calls[0][0] as { data: { status: string } };
    expect(
      (mockPrisma.task.updateMany.mock.calls[0][0] as { where: { status: string } }).where.status,
    ).toBe('in-progress');
    const rt = recordTransition.mock.calls[0][0] as { cause: string; toStatus: string };
    expect(rt.cause).toBe('verify_repair');
    expect(rt.toStatus).toBe('plan_approved');
  });

  test('plan なし → research_done へ bounce すること', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue(null);
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.newStatus).toBe('research_done');
  });

  test('リトライ上限に達したら bounced:false（caller が block）になること', async () => {
    mockPrisma.workflowTransition.count.mockResolvedValue(2); // == default max
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.bounced).toBe(false);
    expect(recordTransition).not.toHaveBeenCalled();
    // 上限到達時は再実行を駆動しない（block するのみ）
    expect(enqueue).not.toHaveBeenCalled();
    expect(startProcessing).not.toHaveBeenCalled();
    // task 705: budget-exhausted (not the non-convergence cutoff) must NOT set
    // cutoffRecorded — caller still records its own verify_validation_failed.
    expect(r.cutoffRecorded).toBeUndefined();
  });

  test('bounce 時に再キュー投入＋ランナー起動で自走させること（単発実行の詰まり対策）', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.bounced).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0][0] as { taskId: number }).taskId).toBe(1);
    expect(startProcessing).toHaveBeenCalledTimes(1);
    // workflowStatus も実装エントリへ戻すこと
    const tu = mockPrisma.task.updateMany.mock.calls[0][0] as {
      data: { status: string; workflowStatus: string };
    };
    expect(tu.data.workflowStatus).toBe('plan_approved');
  });

  test('既にキュー済み(enqueue が throw)でもランナー起動は行い、bounce は継続すること', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    enqueue.mockRejectedValueOnce(new Error('already in the queue'));
    queuedItem.mockResolvedValueOnce({ id: 1 });
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.bounced).toBe(true);
    expect(startProcessing).toHaveBeenCalledTimes(1);
  });

  test('テーマ自動実行が稼働中なら自走しない（スケジューラに委譲＝並列起動を防ぐ）', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    mockPrisma.task.findUnique.mockResolvedValue({ themeId: 1 });
    isThemeAutoRunActive.mockResolvedValue(true); // theme auto-run owns this task
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.bounced).toBe(true); // 差し戻し自体は行う
    // ただし themeId-less な enqueue / runner 起動はしない（並列起動の原因を断つ）
    expect(enqueue).not.toHaveBeenCalled();
    expect(startProcessing).not.toHaveBeenCalled();
  });

  test('差し戻しフィードバックを verify.md に書き、テスト改ざん禁止を明記すること', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    // NOTE: verify.md が読めない（null）ときに verifyContent 引数へフォールバック
    // する契約 — '' では ?? が発動しないため null を返す。
    readWorkflowFile.mockResolvedValue(null);
    await attemptVerifyRepair(1, 'in_progress', 'self-contradicts', 'VERIFY BODY');

    expect(writeWorkflowFile).toHaveBeenCalledTimes(1);
    const args = writeWorkflowFile.mock.calls[0] as unknown[];
    expect(args[1]).toBe('verify');
    const content = args[2] as string;
    expect(content).toContain('検証フェーズからの差し戻し');
    expect(content).toContain('テストを実際に通す');
    expect(content).toContain('VERIFY BODY');
  });

  // Task 727 ケース5a: 却下された verify.md の失敗テスト file:line だけでなく、
  // 次行のエラーメッセージも差し戻しフィードバックに具体的な位置情報として含める。
  test('差し戻しフィードバックが verify.md 中の失敗テスト file:line・エラーメッセージを含むこと', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    readWorkflowFile.mockResolvedValue(null);
    const verifyContent = [
      '## テスト結果',
      'FAIL services/workflow/__tests__/verify-self-repair.test.ts:418',
      '  Error: expected true to equal false',
    ].join('\n');
    await attemptVerifyRepair(1, 'in_progress', '自己矛盾を検出', verifyContent);

    const args = writeWorkflowFile.mock.calls[0] as unknown[];
    const content = args[2] as string;
    expect(content).toMatch(/Failed test:.*\.(test|spec)\.ts:\d+/);
    expect(content).toContain('services/workflow/__tests__/verify-self-repair.test.ts:418');
    expect(content).toContain('Error: expected true to equal false');
  });

  // Task 727 ケース5b: 抽出した失敗詳細からも数値集計（\d+\s+failed）は除去されること
  // （phase-output-validator.ts の自己矛盾検知の再発防止、task 494 の教訓）。
  test('差し戻しフィードバックに数値集計（N failed）が再混入しないこと', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    readWorkflowFile.mockResolvedValue(null);
    // NOTE: verifyContent 自体 (prior として素通しされる元本文) に数値集計を含めると
    // sanitize 対象外の既存本文と衝突するため、reason 側でのみ数値集計を検証する。
    const verifyContent = 'services/foo.test.ts:99 — assertion failed unexpectedly';
    await attemptVerifyRepair(1, 'in_progress', 'claims pass (Tests 3 failed)', verifyContent);

    const args = writeWorkflowFile.mock.calls[0] as unknown[];
    const content = args[2] as string;
    expect(/\d+\s+failed/i.test(content)).toBe(false);
    expect(content).toContain('services/foo.test.ts:99');
  });

  test('境界値: prior = max-1 は bounce する（attempt = max）こと', async () => {
    // Default max is 2 (DEFAULT_VERIFY_REPAIR_LIMIT, blocked-task-policy.ts); prior=1 is the last bounce-able attempt.
    mockPrisma.workflowTransition.count.mockResolvedValue(1);
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.bounced).toBe(true);
    expect(r.attempt).toBe(2);
    // task 770: リトライなし（activityLog 既定 null）なら windowStart は null であること
    const rt = recordTransition.mock.calls[0][0] as { metadata: { windowStart: string | null } };
    expect(rt.metadata.windowStart).toBeNull();
  });

  // NOTE: RAPITAS_MAX_VERIFY_REPAIRS is read into a MODULE-LEVEL constant
  // (DEFAULT_VERIFY_REPAIR_LIMIT, blocked-task-policy.ts) at import time, so
  // setting the env var from a test cannot change it post-import. The
  // runtime-configurable disable path is
  // UserSettings.verifyRepairLimit=0 (covered below), which resolveMaxRepairs()
  // reads dynamically on every call.

  test('UserSettings.verifyRepairLimit が設定されていれば env/既定より優先されること（上限を1に絞る）', async () => {
    mockPrisma.userSettings.findFirst.mockResolvedValue({ verifyRepairLimit: 1 });
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    // prior=1 === configured max(1) -> exhausted, must block instead of the
    // env-default max(2) which would still allow this attempt.
    mockPrisma.workflowTransition.count.mockResolvedValue(1);
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.bounced).toBe(false);
  });

  test('UserSettings.verifyRepairLimit=0 は明示的な無効化として尊重されること', async () => {
    mockPrisma.userSettings.findFirst.mockResolvedValue({ verifyRepairLimit: 0 });
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.bounced).toBe(false);
    expect(mockPrisma.workflowTransition.count).not.toHaveBeenCalled();
  });

  // FAIL CLOSED: countPriorRepairs (verify-self-repair.ts) explicitly catches a
  // rejecting count() and returns Number.MAX_SAFE_INTEGER instead of 0 — a bare
  // `.catch(() => 0)` would make a transient DB error read as "no prior
  // repairs", letting the bounce loop re-enter forever on every failed count.
  // This asserts the caller-visible effect: a rejecting count blocks (bounced:
  // false) instead of bouncing, regardless of the configured cap.
  test('FAIL CLOSED: カウントクエリが reject したら bounced:false（block）になり、無限バウンスしないこと', async () => {
    mockPrisma.workflowTransition.count.mockImplementation(() =>
      Promise.reject(new Error('connection reset')),
    );
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });

    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');

    expect(r.bounced).toBe(false);
    // Must not attempt the bounce (no transition recorded, no self-drive re-queue).
    expect(recordTransition).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(startProcessing).not.toHaveBeenCalled();
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
  });

  test('FAIL CLOSED: カウントクエリが reject したら、非常に高い上限(cap)を設定しても block すること', async () => {
    // Even a generous configured cap must not let a failed count masquerade as
    // "budget available" — MAX_SAFE_INTEGER prior must exceed any realistic cap.
    mockPrisma.userSettings.findFirst.mockResolvedValue({ verifyRepairLimit: 1_000_000 });
    mockPrisma.workflowTransition.count.mockImplementation(() =>
      Promise.reject(new Error('timeout')),
    );
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });

    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');

    expect(r.bounced).toBe(false);
  });

  test('直近の task_retried 以降の repair のみをカウントし、リトライで予算がリセットされること', async () => {
    // A retry happened after 2 prior repairs (>= default max 2) — the count query
    // is scoped to createdAt > lastRetry.createdAt, so a fresh mock returning 0
    // for "since last retry" must reset the budget (not read as exhausted).
    const retriedAt = new Date('2026-01-01T00:00:00Z');
    mockPrisma.activityLog.findFirst.mockResolvedValue({ createdAt: retriedAt });
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');
    expect(r.bounced).toBe(true);
    expect(r.attempt).toBe(1);
    // The count query must have been scoped by the retry timestamp.
    const firstCall = mockPrisma.workflowTransition.count.mock.calls[0] as unknown as unknown[];
    const countArgs = firstCall[0] as { where: { createdAt?: { gt: Date } } };
    expect(countArgs.where.createdAt?.gt).toEqual(retriedAt);
    // task 770: windowStart はリトライ時刻の ISO 文字列と一致すること
    const rt = recordTransition.mock.calls[0][0] as { metadata: { windowStart: string | null } };
    expect(rt.metadata.windowStart).toBe(retriedAt.toISOString());
  });

  test('受入基準の差し替えも収束判定の窓の境界になること', async () => {
    // 実測 2026-08-27 (task 672): 受入基準を訂正した直後の1回の差し戻しで
    // カットオフが発火した。訂正前の理由2件を数えていたため。旧理由は基準を
    // 「番号で」指しており、差し替え後その番号は別の基準を指す。比較不能。
    const changedAt = new Date('2026-01-02T00:00:00Z');
    mockPrisma.activityLog.findFirst.mockResolvedValue({ createdAt: changedAt });
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    mockPrisma.workflowTransition.findMany.mockResolvedValue([]);
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });

    await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');

    // 境界の問い合わせが両方のアクションを対象にしていること。
    const whereArg = mockPrisma.activityLog.findFirst.mock.calls[0]?.[0] as {
      where: { action: { in: string[] } | string };
    };
    const actions = typeof whereArg.where.action === 'string' ? [] : whereArg.where.action.in;
    expect(actions).toContain('task_retried');
    expect(actions).toContain('acceptance_criteria_changed');
  });

  // task 832 実測 (#827, #830): question_resolved / plan_invalid_replan は
  // WorkflowTransition.cause に記録されるため、窓の境界クエリは ActivityLog
  // だけでなく WorkflowTransition も参照しなければならない。
  test('question_resolved 後の最初の verify_repair ではカットオフに達しないこと（#827/#830 回帰）', async () => {
    const resolvedAt = new Date('2026-01-03T00:00:00Z');
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'question_resolved',
      createdAt: resolvedAt,
    });
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });

    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');

    expect(r.bounced).toBe(true);
    expect(r.attempt).toBe(1);
    const countArgs = mockPrisma.workflowTransition.count.mock.calls[0][0] as {
      where: { createdAt?: { gt: Date } };
    };
    expect(countArgs.where.createdAt?.gt).toEqual(resolvedAt);
    const rt = recordTransition.mock.calls[0][0] as { metadata: { windowStart: string | null } };
    expect(rt.metadata.windowStart).toBe(resolvedAt.toISOString());
  });

  test('plan_invalid_replan 後の最初の verify_repair ではカットオフに達しないこと', async () => {
    const replanAt = new Date('2026-01-04T00:00:00Z');
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'plan_invalid_replan',
      createdAt: replanAt,
    });
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });

    const r = await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');

    expect(r.bounced).toBe(true);
    expect(r.attempt).toBe(1);
    const rt = recordTransition.mock.calls[0][0] as { metadata: { windowStart: string | null } };
    expect(rt.metadata.windowStart).toBe(replanAt.toISOString());
  });

  test('窓境界クエリが question_resolved と plan_invalid_replan の両方を対象にすること', async () => {
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');

    const whereArg = mockPrisma.workflowTransition.findFirst.mock.calls[0]?.[0] as {
      where: { cause: { in: string[] } };
    };
    expect(whereArg.where.cause.in).toContain('question_resolved');
    expect(whereArg.where.cause.in).toContain('plan_invalid_replan');
  });

  test('ActivityLog と WorkflowTransition の両境界がヒットしたら新しい方を採用すること', async () => {
    const olderActivity = new Date('2026-01-01T00:00:00Z');
    const newerTransition = new Date('2026-01-05T00:00:00Z');
    mockPrisma.activityLog.findFirst.mockResolvedValue({ createdAt: olderActivity });
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'question_resolved',
      createdAt: newerTransition,
    });
    mockPrisma.workflowTransition.count.mockResolvedValue(0);
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });

    await attemptVerifyRepair(1, 'in_progress', 'fail', 'v');

    const rt = recordTransition.mock.calls[0][0] as { metadata: { windowStart: string | null } };
    expect(rt.metadata.windowStart).toBe(newerTransition.toISOString());
  });

  // ---- 非収束打ち切り（task 619）----
  // task 614 実データ型のフィクスチャ: 基準1がパス、基準2が識別子で特定できる。
  const CRITERIA_JSON = JSON.stringify([
    'tests/services/test-triage.test.ts のすべてのテストが成功する',
    '`detectRepeatLoop` が bounce 回数との対応関係を検証する',
    '`escalateBlockedTask` が通知を送る',
  ]);
  const R1 =
    '受入基準1「tests/services/test-triage.test.ts のすべてのテストが成功する」が一切対応されていない';
  const R2 = 'detectRepeatLoop の phase_completed:* 除外が bounce 回数との対応関係を検証していない';
  const R3 =
    '受入基準1 に対して diff は test-triage.test.ts を一切変更しておらず、元原因にも触れていない';

  const withCriteria = () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      themeId: 5,
      title: '対象タスク',
      acceptanceCriteria: CRITERIA_JSON,
    });
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
  };
  const priorRows = (...reasons: string[]) =>
    reasons.map((reason, i) => ({ metadata: JSON.stringify({ attempt: i + 1, max: 10, reason }) }));

  test('非収束: A→B→A（同一受入基準2回指摘）で bounce せずエスカレーションすること（受入基準1・2）', async () => {
    withCriteria();
    mockPrisma.workflowTransition.findMany.mockResolvedValue(priorRows(R1, R2));

    const r = await attemptVerifyRepair(614, 'in_progress', R3, 'v');

    expect(r.bounced).toBe(false);
    // 実装フェーズへ戻さない（task.update も自走もフィードバック書込みも無し）
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(writeWorkflowFile).not.toHaveBeenCalled();
    // エスカレーション: verify_no_convergence + 「どの基準が何回」の detail
    expect(escalateBlockedTask).toHaveBeenCalledTimes(1);
    const eArgs = escalateBlockedTask.mock.calls[0] as unknown as unknown[];
    expect((eArgs[1] as { id: number }).id).toBe(614);
    expect(eArgs[2]).toBe('verify_no_convergence');
    expect(eArgs[4]).toContain('受入基準1');
    expect(eArgs[4]).toContain('2回');
    // 判定根拠が専用 cause の遷移 metadata に残ること
    expect(recordTransition).toHaveBeenCalledTimes(1);
    const rt = recordTransition.mock.calls[0][0] as {
      cause: string;
      metadata: { criterionIndex: number; count: number; reason: string };
    };
    expect(rt.cause).toBe('verify_repair_non_convergence');
    expect(rt.metadata.criterionIndex).toBe(1);
    expect(rt.metadata.count).toBe(2);
    expect(rt.metadata.reason).toBe(R3);
    // task 705: cutoffRecorded=true tells callers this call already recorded
    // its own terminal transition — they must NOT record verify_validation_failed too.
    expect(r.cutoffRecorded).toBe(true);
  });

  test('収束中: 毎回異なる指摘（A→B→C）は回数に関わらず bounce を継続すること（受入基準3）', async () => {
    withCriteria();
    mockPrisma.workflowTransition.findMany.mockResolvedValue(priorRows(R1, R2));
    // ユーザー設定で上限を大きくし、回数では切られない状況を再現
    mockPrisma.userSettings.findFirst.mockResolvedValue({ verifyRepairLimit: 10 });
    mockPrisma.workflowTransition.count.mockResolvedValue(2);

    const r = await attemptVerifyRepair(
      614,
      'in_progress',
      'escalateBlockedTask の通知が送られていない',
      'v',
    );

    expect(r.bounced).toBe(true);
    expect(escalateBlockedTask).not.toHaveBeenCalled();
    const rt = recordTransition.mock.calls[0][0] as { cause: string };
    expect(rt.cause).toBe('verify_repair');
  });

  test('fail-open: 過去理由の読取り(findMany)が reject しても bounce を継続すること（受入基準4）', async () => {
    withCriteria();
    mockPrisma.workflowTransition.findMany.mockImplementation(() =>
      Promise.reject(new Error('db down')),
    );

    const r = await attemptVerifyRepair(614, 'in_progress', R3, 'v');

    expect(r.bounced).toBe(true);
    expect(escalateBlockedTask).not.toHaveBeenCalled();
  });

  test('fail-open: acceptanceCriteria が無ければ収束判定をスキップし bounce すること（受入基準4）', async () => {
    // 既定 findUnique は acceptanceCriteria を含まない（既存ケースと同じ）
    mockPrisma.workflowFile.findFirst.mockResolvedValue({ id: 7 });
    mockPrisma.workflowTransition.findMany.mockResolvedValue(priorRows(R1, R1));

    const r = await attemptVerifyRepair(614, 'in_progress', R1, 'v');

    expect(r.bounced).toBe(true);
    expect(escalateBlockedTask).not.toHaveBeenCalled();
    // criteria 空の短絡により過去遷移は読まれない
    expect(mockPrisma.workflowTransition.findMany).not.toHaveBeenCalled();
  });

  test('fail-open: 汎用文言のみ（基準を特定できない理由）の反復では打ち切らないこと（受入基準4）', async () => {
    withCriteria();
    mockPrisma.workflowTransition.findMany.mockResolvedValue(
      priorRows('受入基準を満たしていません', '受入基準を満たしていません'),
    );

    const r = await attemptVerifyRepair(614, 'in_progress', '受入基準を満たしていません', 'v');

    expect(r.bounced).toBe(true);
    expect(escalateBlockedTask).not.toHaveBeenCalled();
  });

  // task 832: 非収束判定 (detectRepairNonConvergence) も countPriorRepairs と
  // 同じ窓境界 (question_resolved 等) を共有していること — 複製クエリのまま
  // だと ActivityLog/WorkflowTransition の境界追加が非収束判定に反映されない。
  test('非収束判定の過去理由クエリも question_resolved 境界でスコープされること', async () => {
    withCriteria();
    const resolvedAt = new Date('2026-01-06T00:00:00Z');
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'question_resolved',
      createdAt: resolvedAt,
    });
    mockPrisma.workflowTransition.findMany.mockResolvedValue(priorRows(R1, R2));

    await attemptVerifyRepair(614, 'in_progress', R3, 'v');

    const findManyArgs = mockPrisma.workflowTransition.findMany.mock.calls[0][0] as {
      where: { createdAt?: { gt: Date } };
    };
    expect(findManyArgs.where.createdAt?.gt).toEqual(resolvedAt);
  });
});

describe('hasFreshVerifyRejection', () => {
  beforeEach(() => {
    mockPrisma.workflowTransition.findFirst.mockReset();
    mockPrisma.workflowTransition.findFirst.mockResolvedValue(null);
  });

  test('直近 transition が verify_repair なら true（完了処理を止める）', async () => {
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'verify_repair',
      createdAt: new Date(),
    });
    expect(await hasFreshVerifyRejection(1)).toBe(true);
  });

  test('直近 transition が adversarial_review_failed でも true (task 485 回帰)', async () => {
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'adversarial_review_failed',
      createdAt: new Date(),
    });
    expect(await hasFreshVerifyRejection(1)).toBe(true);
  });

  test('直近 transition が verify_pr_not_created なら true（PR生成失敗の二重試行を防止、task 673 回帰）', async () => {
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'verify_pr_not_created',
      createdAt: new Date(),
    });
    expect(await hasFreshVerifyRejection(1)).toBe(true);
  });

  test('直近 transition が verify_invariant_no_convergence なら true（不変条件カットオフ後のPR再試行を防止、task 794 回帰）', async () => {
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'verify_invariant_no_convergence',
      createdAt: new Date(),
    });
    expect(await hasFreshVerifyRejection(1)).toBe(true);
  });

  test('直近 transition が別 cause なら false', async () => {
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'verify_passed',
      createdAt: new Date(),
    });
    expect(await hasFreshVerifyRejection(1)).toBe(false);
  });

  test('古い rejection（有効期間超過）は false', async () => {
    mockPrisma.workflowTransition.findFirst.mockResolvedValue({
      cause: 'verify_repair',
      createdAt: new Date(Date.now() - 60 * 60_000),
    });
    expect(await hasFreshVerifyRejection(1, 30 * 60_000)).toBe(false);
  });

  test('transition が無ければ false', async () => {
    expect(await hasFreshVerifyRejection(1)).toBe(false);
  });
});
