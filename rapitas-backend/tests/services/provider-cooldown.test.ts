/**
 * Provider Cooldown テスト
 *
 * Verifies cooldown registration, expiry, listActive behavior, and the
 * consecutive-rate_limit escalation (long cooldown + clear-on-success).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// ── Module-level mocks（import 前に宣言） ──────────────────────────────────────

// Capture pino warn/info calls so the escalation log contract (task #633
// requirement 3: observable via logs) can be asserted.
const warnCalls: Array<[Record<string, unknown>, string]> = [];
const infoCalls: Array<[Record<string, unknown>, string]> = [];
const fakeLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => warnCalls.push([obj, msg]),
  info: (obj: Record<string, unknown>, msg: string) => infoCalls.push([obj, msg]),
  debug: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
};
mock.module('../../config/logger', () => ({
  createLogger: () => fakeLogger,
  logger: fakeLogger,
  getBackendLogFilePath: () => '',
}));

// ── 動的 import（全 mock.module 宣言後） ──────────────────────────────────────

const {
  __resetCooldowns,
  clearCooldown,
  inferProviderFromModelName,
  isProviderInCooldown,
  listActiveCooldowns,
  listFailureStreaks,
  markProviderCooldown,
  recordProviderSuccess,
} = await import('../../services/ai/provider-cooldown');

const ESCALATION_ENV_KEYS = [
  'RAPITAS_PROVIDER_ESCALATION_THRESHOLD',
  'RAPITAS_PROVIDER_ESCALATION_COOLDOWN_MS',
  'RAPITAS_PROVIDER_ESCALATION_WINDOW_MS',
] as const;

beforeEach(() => {
  __resetCooldowns();
  warnCalls.length = 0;
  infoCalls.length = 0;
});

afterEach(() => {
  for (const key of ESCALATION_ENV_KEYS) delete process.env[key];
});

describe('markProviderCooldown', () => {
  it('quotaを記録すると isProviderInCooldown が true を返す', () => {
    markProviderCooldown('openai', 'quota');
    expect(isProviderInCooldown('openai')).toBe(true);
  });

  it('明示的な resetAt を尊重する', () => {
    const future = new Date(Date.now() + 5_000);
    markProviderCooldown('claude', 'quota', future);
    const list = listActiveCooldowns();
    expect(list.length).toBe(1);
    expect(list[0].until).toBe(future.getTime());
  });

  it('既存より短い resetAt では上書きしない', () => {
    const longer = new Date(Date.now() + 10_000);
    const shorter = new Date(Date.now() + 1_000);
    markProviderCooldown('openai', 'quota', longer);
    markProviderCooldown('openai', 'rate_limit', shorter);
    const entry = listActiveCooldowns()[0];
    expect(entry.until).toBe(longer.getTime());
  });

  it('過ぎた cooldown は listActiveCooldowns から除外される', () => {
    markProviderCooldown('gemini', 'quota', new Date(Date.now() - 10_000));
    const list = listActiveCooldowns();
    expect(list.length).toBe(0);
    expect(isProviderInCooldown('gemini')).toBe(false);
  });

  it('clearCooldown は即時削除する', () => {
    markProviderCooldown('claude', 'rate_limit');
    clearCooldown('claude');
    expect(isProviderInCooldown('claude')).toBe(false);
  });
});

describe('rate_limit 連続失敗の長期クールダウン昇格', () => {
  it('閾値未満(2回)では短期(約60秒)のまま昇格しない', () => {
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    const entry = listActiveCooldowns()[0];
    // Short cooldown = 60s; escalated would be 6h. 10-minute bound separates them.
    expect(entry.until - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    const streaks = listFailureStreaks();
    expect(streaks.length).toBe(1);
    expect(streaks[0]).toMatchObject({ provider: 'gemini', reason: 'rate_limit', count: 2 });
  });

  it('連続3回目で until が6時間近傍へ昇格する', () => {
    const before = Date.now();
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    const entry = listActiveCooldowns()[0];
    expect(entry.until).toBeGreaterThanOrEqual(before + 6 * 60 * 60 * 1000 - 5_000);
    expect(listFailureStreaks()[0].count).toBe(3);
  });

  it('昇格時に provider/reason/streak/until を含む warn ログが出る', () => {
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    const escalation = warnCalls.find(([, msg]) => msg.includes('escalated'));
    expect(escalation).toBeDefined();
    const [payload] = escalation as [Record<string, unknown>, string];
    expect(payload.provider).toBe('gemini');
    expect(payload.reason).toBe('rate_limit');
    expect(payload.streak).toBe(3);
    expect(typeof payload.untilIso).toBe('string');
  });

  it('claude は連続3回 rate_limit しても昇格しない(主経路保護)', () => {
    markProviderCooldown('claude', 'rate_limit');
    markProviderCooldown('claude', 'rate_limit');
    markProviderCooldown('claude', 'rate_limit');
    const entry = listActiveCooldowns()[0];
    expect(entry.provider).toBe('claude');
    expect(entry.until - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    // claude never enters the streak map at all.
    expect(listFailureStreaks().length).toBe(0);
  });

  it('明示 resetAt 付きの失敗は昇格もカウントもしない', () => {
    const resetAt = new Date(Date.now() + 5_000);
    markProviderCooldown('gemini', 'rate_limit', resetAt);
    markProviderCooldown('gemini', 'rate_limit', resetAt);
    markProviderCooldown('gemini', 'rate_limit', resetAt);
    expect(listFailureStreaks().length).toBe(0);
    expect(listActiveCooldowns()[0].until).toBe(resetAt.getTime());
  });

  it('判定窓を超えた失敗は連続と見なさず count が1に戻る', async () => {
    process.env.RAPITAS_PROVIDER_ESCALATION_WINDOW_MS = '100';
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    await new Promise((r) => setTimeout(r, 150));
    markProviderCooldown('gemini', 'rate_limit');
    // 3rd failure but outside the window → streak restarts at 1, no escalation.
    const streaks = [...listFailureStreaks()];
    expect(streaks.length).toBe(1);
    expect(streaks[0].count).toBe(1);
    const entry = listActiveCooldowns()[0];
    expect(entry.until - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('昇格後の短期 mark 再呼出で until が短縮されない(既存ガード維持)', () => {
    const before = Date.now();
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'transient'); // 30s short cooldown attempt
    const entry = listActiveCooldowns()[0];
    expect(entry.until).toBeGreaterThanOrEqual(before + 6 * 60 * 60 * 1000 - 5_000);
  });

  it('閾値と期間は env で上書きできる(不正値は既定にフォールバック)', () => {
    process.env.RAPITAS_PROVIDER_ESCALATION_THRESHOLD = '2';
    process.env.RAPITAS_PROVIDER_ESCALATION_COOLDOWN_MS = '120000';
    const before = Date.now();
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    const entry = listActiveCooldowns()[0];
    expect(entry.until).toBeGreaterThanOrEqual(before + 120_000 - 2_000);
    expect(entry.until).toBeLessThanOrEqual(before + 120_000 + 5_000);

    // Malformed value falls back to default threshold=3 (2 failures stay short).
    __resetCooldowns();
    process.env.RAPITAS_PROVIDER_ESCALATION_THRESHOLD = 'not-a-number';
    process.env.RAPITAS_PROVIDER_ESCALATION_COOLDOWN_MS = '-1';
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    expect(listActiveCooldowns()[0].until - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe('recordProviderSuccess(成功で解除)', () => {
  it('昇格後の成功で streak と cooldown が解除される', () => {
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    expect(isProviderInCooldown('gemini')).toBe(true);

    recordProviderSuccess('gemini');
    expect(isProviderInCooldown('gemini')).toBe(false);
    expect(listFailureStreaks().some((s) => s.provider === 'gemini')).toBe(false);
    // Clearing is logged (observability).
    expect(infoCalls.some(([obj]) => obj.provider === 'gemini')).toBe(true);
  });

  it('claude の成功は gemini の streak/cooldown を消さない(provider分離)', () => {
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    recordProviderSuccess('claude');
    expect(listFailureStreaks().some((s) => s.provider === 'gemini' && s.count === 2)).toBe(true);
    expect(isProviderInCooldown('gemini')).toBe(true);
  });

  it('状態が無い provider への成功記録は no-op でログも出ない', () => {
    recordProviderSuccess('openai');
    expect(infoCalls.length).toBe(0);
  });
});

describe('inferProviderFromModelName', () => {
  it('モデルIDから provider を導出する', () => {
    expect(inferProviderFromModelName('claude-sonnet-4-5')).toBe('claude');
    expect(inferProviderFromModelName('gemini-2.5-pro')).toBe('gemini');
    expect(inferProviderFromModelName('gpt-5-codex')).toBe('openai');
    expect(inferProviderFromModelName('qwen2.5-coder')).toBe('ollama');
    expect(inferProviderFromModelName('unknown-model-x')).toBeNull();
    expect(inferProviderFromModelName(null)).toBeNull();
    expect(inferProviderFromModelName(undefined)).toBeNull();
  });
});

// ── 統合: execution-persistence clear-on-success 連携 ─────────────────────────
// saveExecutionResult (services/agents/orchestrator/execution-persistence) が
// completed + modelName のときだけ、そのモデルの provider の streak を解除する
// ことを実モジュール連携で検証する（plan テスト計画の統合ケース）。

const { saveExecutionResult } =
  await import('../../services/agents/orchestrator/execution-persistence');
import type { ExecutionState } from '../../services/agents/orchestrator/types';

function makeIntegrationState(): ExecutionState {
  return {
    executionId: 1,
    sessionId: 2,
    agentId: 'agent-1',
    taskId: 3,
    status: 'running',
    startedAt: new Date(),
    output: '',
  } as ExecutionState;
}

function makeIntegrationFileLogger() {
  return {
    logStatusChange: mock(() => {}),
    logExecutionEnd: mock(() => {}),
    logGitCommit: mock(() => {}),
    logError: mock(() => {}),
  } as unknown as import('../../services/agents/execution-file-logger').ExecutionFileLogger;
}

function makeIntegrationPrisma() {
  return {
    agentExecution: {
      update: mock(async () => ({})),
      updateMany: mock(async () => ({ count: 1 })),
      // config=null → learning recorder is skipped (out of scope here).
      findUnique: mock(async () => ({ session: { config: null } })),
    },
    agentSession: { update: mock(async () => ({})) },
    gitCommit: { create: mock(async () => ({})) },
  };
}

describe('統合: saveExecutionResult の clear-on-success', () => {
  it('gemini モデルで completed → gemini の streak/cooldown が解除される', async () => {
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');
    expect(isProviderInCooldown('gemini')).toBe(true);

    await saveExecutionResult(
      makeIntegrationPrisma() as never,
      1,
      2,
      makeIntegrationState(),
      { success: true, modelName: 'gemini-2.5-pro' },
      makeIntegrationFileLogger(),
    );

    expect(isProviderInCooldown('gemini')).toBe(false);
    expect(listFailureStreaks().some((s) => s.provider === 'gemini')).toBe(false);
  });

  it('claude モデルで completed → gemini の streak は維持される', async () => {
    markProviderCooldown('gemini', 'rate_limit');
    markProviderCooldown('gemini', 'rate_limit');

    await saveExecutionResult(
      makeIntegrationPrisma() as never,
      1,
      2,
      makeIntegrationState(),
      { success: true, modelName: 'claude-sonnet-4-5' },
      makeIntegrationFileLogger(),
    );

    expect(listFailureStreaks().some((s) => s.provider === 'gemini' && s.count === 2)).toBe(true);
    expect(isProviderInCooldown('gemini')).toBe(true);
  });

  it('modelName 無しの completed では何も解除しない', async () => {
    markProviderCooldown('gemini', 'rate_limit');

    await saveExecutionResult(
      makeIntegrationPrisma() as never,
      1,
      2,
      makeIntegrationState(),
      { success: true },
      makeIntegrationFileLogger(),
    );

    expect(isProviderInCooldown('gemini')).toBe(true);
  });
});
