/**
 * dev-restart-on-dry.test
 *
 * maybeRestartForUpdate() の各 gate による早期リターンを検証する。
 *
 * 対象 gate: 2 (TAURI_BUILD!=true) / 3 (active>0) / 4 (runningPhases>0)
 *            / 5 (restartEnabled=off) / 6 (activeAutoRun=0)
 *            / 8 (startupCommit=null — recordStartupCommit 未呼出)
 *
 * 対象外: gate1 (restarting=true) と gracefulRestart 通過パスは
 * process.exit(75) を含みモジュール変数を汚染するため検証しない。
 * 呼出し順序の検証は dev-restart-shutdown.test.ts が担当する。
 */
import { describe, test, expect, mock, afterAll, beforeEach } from 'bun:test';

// ── 可変スタブ値（各テストが書き換えてゲートを制御する） ─────────────────────────

let mockActiveCount = 0;
let mockRunningPhases = 0;
let mockRestartEnabled = false;
let mockActiveAutoRun = 0;
const executionCount = mock(async (_args: unknown) => 0);
const phaseCount = mock(async () => mockRunningPhases);
const settingsRead = mock(async () => ({
  restartOnAutoRunDry: mockRestartEnabled,
  id: 1,
  userId: null,
}));

beforeEach(() => {
  executionCount.mockReset();
  executionCount.mockResolvedValue(0);
  phaseCount.mockReset();
  phaseCount.mockImplementation(async () => mockRunningPhases);
  settingsRead.mockClear();
});

// ── Module-level mocks（import 前に宣言） ──────────────────────────────────────

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

mock.module('../../agents/agent-orchestrator', () => ({
  AgentOrchestrator: {
    getInstance: () => ({
      getActiveExecutionCount: () => mockActiveCount,
      gracefulShutdown: async () => {},
    }),
  },
}));

mock.module('../../../config/database', () => ({
  // mock.module replaces the whole module — mirror ensureDatabaseConnection so config/index.ts re-export survives shuffled test order (else 'export not found').
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: {
    agentExecution: { count: executionCount },
    workflowQueueItem: {
      count: phaseCount,
    },
    themeAutoRun: {
      count: () => Promise.resolve(mockActiveAutoRun),
    },
    userSettings: {
      findFirst: settingsRead,
    },
  },
}));

mock.module('../../observability', () => ({
  logCycleEvent: () => {},
}));

mock.module('../workflow-runner', () => ({
  WorkflowRunner: {
    getInstance: () => ({ stopProcessing: async () => {} }),
  },
}));

// NOTE: headCommit() は execFileAsync('git', ['rev-parse', 'HEAD']) を呼ぶ。
// 標準 promisify ラッパー経由では stdout を { stdout } で解決しないため
// headCommit() が null を返す。gate8 は !startupCommit (=null) で false を
// 返すため、current=null でも期待動作は変わらない。
// NOTE: 'child_process' と 'node:child_process' の両方をモックする。
// bun では両 specifier がプロセスグローバルで共有されるため、片方のみだと
// シャッフル実行時に 'node:child_process' の named export が見つからない
// というエラーで後続テストファイルが失敗する。
const execFileMock = (
  _cmd: string,
  _args: string[],
  _opts: unknown,
  callback?: (err: Error | null, stdout: string) => void,
) => {
  const cb = (typeof _opts === 'function' ? _opts : callback) as
    | ((err: Error | null, stdout: string) => void)
    | undefined;
  if (cb) cb(null, 'abc123fakehash\n');
};
mock.module('child_process', () => ({ execFile: execFileMock }));
mock.module('node:child_process', () => ({ execFile: execFileMock }));

// ── 動的 import（全 mock.module 宣言後） ──────────────────────────────────────

const { maybeRestartForUpdate } = await import('./dev-restart-on-dry');

// process.exit をスタブ化して gracefulRestart が誤爆しても安全に
const originalExit = process.exit;
// @ts-expect-error: replacing process.exit for tests
process.exit = mock((_code?: number) => {});

afterAll(() => {
  // NOTE: process.exit を復元して他テストファイルへの汚染を防ぐ
  process.exit = originalExit;
  delete process.env.TAURI_BUILD;
});

// ── テスト ────────────────────────────────────────────────────────────────────

describe('maybeRestartForUpdate() — gate 早期リターン', () => {
  test('別workerの実行がDBに残る間はローカル実行ゼロでも再起動判定を進めない', async () => {
    process.env.TAURI_BUILD = 'true';
    executionCount.mockResolvedValue(1);
    expect(await maybeRestartForUpdate(1)).toBe(false);
    expect(executionCount).toHaveBeenCalledWith({
      where: { status: { in: ['pending', 'running', 'waiting_for_input', 'canceling'] } },
    });
    expect(settingsRead).not.toHaveBeenCalled();
  });

  test('実行状態のDB照会失敗は実行ゼロとして扱わない', async () => {
    process.env.TAURI_BUILD = 'true';
    executionCount.mockRejectedValue(new Error('database unavailable'));
    expect(await maybeRestartForUpdate(1)).toBe(false);
    expect(settingsRead).not.toHaveBeenCalled();
  });

  test('キュー状態のDB照会失敗も再起動を保留する', async () => {
    process.env.TAURI_BUILD = 'true';
    phaseCount.mockRejectedValue(new Error('database unavailable'));
    expect(await maybeRestartForUpdate(1)).toBe(false);
    expect(settingsRead).not.toHaveBeenCalled();
  });

  test('永続実行とキューの両方がゼロなら設定の判定へ進む', async () => {
    process.env.TAURI_BUILD = 'true';
    expect(await maybeRestartForUpdate(1)).toBe(false);
    expect(executionCount).toHaveBeenCalledTimes(1);
    expect(settingsRead).toHaveBeenCalledTimes(1);
  });
  test('gate2: TAURI_BUILD が "true" でないとき false を返す', async () => {
    delete process.env.TAURI_BUILD;
    expect(await maybeRestartForUpdate(1)).toBe(false);
  });

  test('gate3: アクティブなエージェントが 1 以上のとき false を返す', async () => {
    process.env.TAURI_BUILD = 'true';
    mockActiveCount = 1;
    const result = await maybeRestartForUpdate(1);
    mockActiveCount = 0;
    expect(result).toBe(false);
  });

  test('gate4: 実行中ワークフローフェーズが 1 以上のとき false を返す', async () => {
    process.env.TAURI_BUILD = 'true';
    mockActiveCount = 0;
    mockRunningPhases = 1;
    const result = await maybeRestartForUpdate(1);
    mockRunningPhases = 0;
    expect(result).toBe(false);
  });

  test('gate5: restartOnAutoRunDry が false のとき false を返す', async () => {
    process.env.TAURI_BUILD = 'true';
    mockActiveCount = 0;
    mockRunningPhases = 0;
    mockRestartEnabled = false;
    expect(await maybeRestartForUpdate(1)).toBe(false);
  });

  test('gate6: 有効な auto-run テーマが 0 のとき false を返す', async () => {
    process.env.TAURI_BUILD = 'true';
    mockActiveCount = 0;
    mockRunningPhases = 0;
    mockRestartEnabled = true;
    mockActiveAutoRun = 0;
    expect(await maybeRestartForUpdate(1)).toBe(false);
  });

  test('gate8: recordStartupCommit 未呼出（startupCommit=null）のとき false を返す', async () => {
    // NOTE: recordStartupCommit を呼ばないため startupCommit=null のまま。
    // !startupCommit が true となり、gracefulRestart に到達しない。
    // restarting=true を立てないため以後のテストへの影響もない。
    process.env.TAURI_BUILD = 'true';
    mockActiveCount = 0;
    mockRunningPhases = 0;
    mockRestartEnabled = true;
    mockActiveAutoRun = 1;
    expect(await maybeRestartForUpdate(1)).toBe(false);
  });
});
