/**
 * fallback-decision ユニットテスト
 *
 * wall-clock kill バイパス（プロバイダ分類・クールダウンの非発動）と
 * 既存のフォールバック判定の維持を検証する。
 */
import { describe, expect, mock, test } from 'bun:test';
import type { AgentExecutionResult } from '../base-agent';

// --- モックセットアップ（動的 import より先に定義すること） ---

mock.module('../../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// classifyAgentError の呼び出し回数を追跡する（wall-clock バイパスでは呼ばれないこと）
let classifyCallCount = 0;
mock.module('../../ai/agent-error-classifier', () => ({
  classifyAgentError: (blob: string) => {
    classifyCallCount += 1;
    // rate_limit 様の文字列があれば gemini の rate_limit として分類（誤分類の再現）
    if (/resource_exhausted|429/i.test(blob)) {
      return { reason: 'rate_limit', provider: 'gemini', retryWithFallback: true };
    }
    return null;
  },
}));

mock.module('../../ai/agent-fallback', () => ({
  agentTypeToProvider: () => 'anthropic',
}));

// モック確定後に動的 import
const { checkNeedsFallback } = await import('./fallback-decision');

// --- テストヘルパー ---

function createResult(overrides: Partial<AgentExecutionResult> = {}): AgentExecutionResult {
  return {
    success: true,
    output: '',
    executionTimeMs: 1000,
    ...overrides,
  } as AgentExecutionResult;
}

// --- テストスイート ---

describe('checkNeedsFallback — wall_clock_timeout バイパス (task 546)', () => {
  test('wall-clock kill + 成功 + rate_limit 様出力 → needsFallback:false、分類器を呼ばない', async () => {
    classifyCallCount = 0;
    const result = createResult({
      success: true,
      failureType: 'wall_clock_timeout',
      output: 'reading agent-error-classifier.ts ... resource_exhausted ... 429 ...',
    });

    const decision = await checkNeedsFallback(result, 'claude-code', false, 2090);
    expect(decision.needsFallback).toBe(false);
    expect(classifyCallCount).toBe(0);
  });

  test('wall-clock kill + 失敗 → needsFallback:false（!success の無条件フォールバックより優先）', async () => {
    classifyCallCount = 0;
    const result = createResult({
      success: false,
      failureType: 'wall_clock_timeout',
      errorMessage: 'Process exited with code 1',
      output: 'partial work ... 429 rate limit example text',
    });

    const decision = await checkNeedsFallback(result, 'claude-code');
    expect(decision.needsFallback).toBe(false);
    expect(classifyCallCount).toBe(0);
  });

  test('wall-clock kill でも errorBlob は従来どおり構築される', async () => {
    const result = createResult({
      success: false,
      failureType: 'wall_clock_timeout',
      errorMessage: 'exit 1',
      output: 'tail of output',
    });

    const decision = await checkNeedsFallback(result, 'claude-code');
    expect(decision.errorBlob).toContain('exit 1');
    expect(decision.errorBlob).toContain('tail of output');
  });
});

describe('checkNeedsFallback — cancelled バイパス (#808)', () => {
  test('cancelled + 失敗 → needsFallback:false、分類器を呼ばない', async () => {
    classifyCallCount = 0;
    const result = createResult({
      success: false,
      failureType: 'cancelled',
      errorMessage: 'Execution cancelled',
      output: 'partial work ... 429 rate limit example text',
    });

    const decision = await checkNeedsFallback(result, 'claude-code');
    expect(decision.needsFallback).toBe(false);
    expect(classifyCallCount).toBe(0);
  });

  test('cancelled でも errorBlob は従来どおり構築される', async () => {
    const result = createResult({
      success: false,
      failureType: 'cancelled',
      errorMessage: 'Execution cancelled',
      output: 'tail of output',
    });

    const decision = await checkNeedsFallback(result, 'claude-code');
    expect(decision.errorBlob).toContain('Execution cancelled');
    expect(decision.errorBlob).toContain('tail of output');
  });
});

describe('checkNeedsFallback — 既存判定の維持', () => {
  test('通常の失敗（failureType 未設定）→ needsFallback:true', async () => {
    const result = createResult({ success: false, errorMessage: 'build failed' });

    const decision = await checkNeedsFallback(result, 'claude-code');
    expect(decision.needsFallback).toBe(true);
  });

  test('成功 + プロバイダエラー様出力 → 分類器判定で needsFallback:true（従来挙動）', async () => {
    classifyCallCount = 0;
    const result = createResult({
      success: true,
      output: 'partial result',
      errorMessage: 'resource_exhausted (429)',
    });

    const decision = await checkNeedsFallback(result, 'claude-code', false, 1);
    expect(decision.needsFallback).toBe(true);
    expect(classifyCallCount).toBe(1);
  });

  test('成功 + disableFallback=true → 分類器を呼ばず needsFallback:false', async () => {
    classifyCallCount = 0;
    const result = createResult({ success: true, output: '429 resource_exhausted' });

    const decision = await checkNeedsFallback(result, 'claude-code', true);
    expect(decision.needsFallback).toBe(false);
    expect(classifyCallCount).toBe(0);
  });

  test('成功 + 無害な出力 → needsFallback:false', async () => {
    const result = createResult({ success: true, output: 'all tests green' });

    const decision = await checkNeedsFallback(result, 'claude-code');
    expect(decision.needsFallback).toBe(false);
  });
});

test('successful plan discussing HTTP429 never triggers provider fallback', async () => {
  classifyCallCount = 0;
  const result = createResult({
    success: true,
    output:
      '# Plan\nConcurrent verification requests return HTTP429. Test resource_exhausted handling.',
  });
  expect((await checkNeedsFallback(result, 'claude-code')).needsFallback).toBe(false);
  expect(classifyCallCount).toBe(0);
});
