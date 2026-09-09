/**
 * execution-resolver ユニットテスト
 *
 * investigation mode の短絡ロジックを中心に buildResolveAfterParse の分岐を検証する。
 */
import { describe, expect, mock, test } from 'bun:test';
import type { AgentExecutionResult } from '../base-agent';
import type { ResolverContext } from './execution-resolver';

// --- モックセットアップ（動的 import より先に定義すること） ---

mock.module('../../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// checkGitDiff を差し替え可能なクロージャ経由で提供する
let mockGitDiffResult: boolean = false;
mock.module('./git-diff-checker', () => ({
  checkGitDiff: () => Promise.resolve(mockGitDiffResult),
}));

// question-detection は型のみ使用。tolegacyQuestionType のランタイムモックが必要なため追加
mock.module('../question-detection', () => ({
  tolegacyQuestionType: (type: string) => type,
}));

// notification-service: 認証失敗通知の発火回数を追跡する（実DB/SSEを叩かない）
let authNotifyCallCount = 0;
mock.module('../../communication/notification-service', () => ({
  notifyAuthenticationFailure: () => {
    authNotifyCallCount += 1;
    return Promise.resolve(null);
  },
}));

// モック確定後に動的 import
const { buildResolveAfterParse } = await import('./execution-resolver');

// --- テストヘルパー ---

/** resolve が呼ばれたときに Promise が解決されるトラッカーを返す */
function createResolveTracker(): {
  resolve: (result: AgentExecutionResult) => void;
  promise: Promise<AgentExecutionResult>;
} {
  let resolveCapture!: (r: AgentExecutionResult) => void;
  const promise = new Promise<AgentExecutionResult>((res) => {
    resolveCapture = res;
  });
  return {
    resolve: (result: AgentExecutionResult) => resolveCapture(result),
    promise,
  };
}

/** テスト用の最小 ResolverContext を構築する */
function createCtx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    logPrefix: '[test]',
    resumeSessionId: undefined,
    continueConversation: undefined,
    outputBuffer: '',
    finalResultText: '',
    errorBuffer: '',
    lineBuffer: '',
    detectedQuestion: {
      hasQuestion: false,
      question: '',
      questionType: 'unknown',
      questionDetails: undefined,
      questionKey: undefined,
    },
    claudeSessionId: null,
    hasFileModifyingToolCalls: false,
    idleTimeoutForceKilled: false,
    wallClockTimeoutForceKilled: false,
    workerResultUsage: null,
    status: 'running',
    emitOutputInternal: () => {},
    ...overrides,
  } as ResolverContext;
}

// --- テストスイート ---

describe('buildResolveAfterParse — resume モード errorMessage 汚染除去', () => {
  test('resume モード失敗時: errorMessage に "session expired or not found" を合成注入しない', async () => {
    const ctx = createCtx({ resumeSessionId: 'session-abc-123' });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1, // exit 1
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    // NOTE: 旧実装は "session expired or not found" と "Session may be expired or invalid" を
    // resume モードの全失敗に無条件注入していた。この文言が SESSION_FAILURE_RE に常時マッチし誤検知の原因。
    expect(result.errorMessage).not.toContain('session expired or not found');
    expect(result.errorMessage).not.toContain('Session may be expired or invalid');
    // 中立ラベルとセッションIDは含まれる
    expect(result.errorMessage).toContain('Session Resume Mode');
    expect(result.errorMessage).toContain('session-abc-123');
  });

  test('resume モード失敗（短時間）: errorMessage に "session resume may have failed" を注入しない', async () => {
    const ctx = createCtx({ resumeSessionId: 'session-abc-123' });
    const { resolve, promise } = createResolveTracker();

    const startTime = Date.now() - 500; // 500ms 前の開始で短時間実行をシミュレート
    const callback = buildResolveAfterParse(
      ctx,
      1,
      '/tmp/workdir',
      startTime,
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    // NOTE: 旧実装は executionTimeMs < 10000 でも "session resume may have failed" を注入していた。
    expect(result.errorMessage).not.toContain('session resume may have failed');
    expect(result.errorMessage).not.toContain('session expired or not found');
    // 中立的な短時間警告は含まれる
    expect(result.errorMessage).toContain('is very short');
  });

  test('生 stderr は errorMessage に維持される（SESSION_FAILURE_RE が本物だけに当たるよう）', async () => {
    const ctx = createCtx({
      resumeSessionId: 'session-abc-123',
      errorBuffer: 'no conversation found',
    });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    // 生 stderr（本物の失効文言）は errorMessage に保持されること
    expect(result.errorMessage).toContain('no conversation found');
  });
});

describe('buildResolveAfterParse — 認証失敗 (401) 検知', () => {
  test('401 認証失敗出力: 失敗で解決し、再認証通知を発火し、ターミナル誘導を errorMessage に含む', async () => {
    authNotifyCallCount = 0;
    const ctx = createCtx({
      outputBuffer:
        '[System: api_retry]\nFailed to authenticate. API Error: 401 Invalid authentication credentials',
    });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1, // CLI は 401 で非ゼロ終了する
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(authNotifyCallCount).toBe(1);
    // 統合ターミナルでの再認証へ誘導していること
    expect(result.errorMessage).toContain('claude login');
    expect(result.errorMessage).toContain('認証');
  });

  test('認証エラーが無い通常の失敗では通知を発火しない', async () => {
    authNotifyCallCount = 0;
    const ctx = createCtx({ errorBuffer: 'some unrelated build error' });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(authNotifyCallCount).toBe(0);
  });
});

describe('buildResolveAfterParse — llmCallCount via workerResultUsage.numTurns', () => {
  test('numTurns が存在する場合、llmCallCount として result に載る', async () => {
    mockGitDiffResult = true;
    const ctx = createCtx({
      workerResultUsage: {
        costUsd: 0.001,
        inputTokens: 100,
        outputTokens: 50,
        numTurns: 3, // 3 LLM API calls in this CLI session
      },
    });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      0,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.llmCallCount).toBe(3);
  });

  test('numTurns が undefined の場合、llmCallCount も undefined', async () => {
    mockGitDiffResult = true;
    const ctx = createCtx({
      workerResultUsage: {
        costUsd: 0.001,
        inputTokens: 100,
        outputTokens: 50,
        // numTurns: undefined — CLI did not emit num_turns
      },
    });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      0,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.llmCallCount).toBeUndefined();
  });

  test('workerResultUsage が null の場合、llmCallCount は undefined', async () => {
    mockGitDiffResult = true;
    const ctx = createCtx({ workerResultUsage: null });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      0,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.llmCallCount).toBeUndefined();
  });
});

describe('buildResolveAfterParse — investigation mode', () => {
  test('ケース1: investigationMode=true + exit0 + outputBuffer ≥200文字 → success: true', async () => {
    const ctx = createCtx({ outputBuffer: 'a'.repeat(250) });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      0,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
      undefined,
      true, // investigationMode
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.waitingForInput).toBe(false);
    // git diff は呼ばれない（短絡成立）
  });

  test('ケース1b: investigationMode=true + exit0 + finalResultText が非空 → success: true', async () => {
    const ctx = createCtx({ finalResultText: '調査結果サマリ', outputBuffer: '' });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      0,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
      undefined,
      true,
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(true);
  });

  test('ケース2: investigationMode=true + exit0 + 出力が空 → success: false（フォールスルー）', async () => {
    mockGitDiffResult = false;
    const ctx = createCtx({ outputBuffer: '', finalResultText: '' });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      0,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
      async () => false, // checkPlanCreated
      true, // investigationMode
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('no actual code changes');
  });

  test('ケース3: investigationMode=true + exit1 → success: false（exit code 失敗パス）', async () => {
    const ctx = createCtx({ outputBuffer: 'a'.repeat(300) });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1, // exit code 1 — short-circuit が評価される前に失敗確定
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
      undefined,
      true,
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
  });

  test('API過負荷: idleTimeoutForceKilled + exit1 + 529出力 → success:false（部分出力で誤完了させない）', async () => {
    const ctx = createCtx({
      idleTimeoutForceKilled: true,
      outputBuffer: 'partial work...\nAPI Error: 529 Overloaded. This is a server-side issue',
    });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1, // force-kill non-zero exit
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
      undefined,
      false, // not investigation mode — the overload guard applies regardless
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('API Overload');
  });

  test('wall-clock kill + git diff 変更あり → success:false かつ failureType=wall_clock_timeout', async () => {
    mockGitDiffResult = true;
    const ctx = createCtx({
      idleTimeoutForceKilled: true, // wall-clock 分岐は両フラグをセットする（idle-monitor.ts）
      wallClockTimeoutForceKilled: true,
      outputBuffer: 'implemented a lot of code...',
    });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1, // taskkill による非ゼロ終了
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('wall_clock_timeout');
  });

  test('wall-clock kill + git diff 変更なし → success:false かつ failureType=wall_clock_timeout', async () => {
    mockGitDiffResult = false;
    const ctx = createCtx({
      idleTimeoutForceKilled: true,
      wallClockTimeoutForceKilled: true,
      outputBuffer: 'was still reading files...',
    });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
      async () => false,
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('wall_clock_timeout');
  });

  test('idle-hang kill のみ（wall-clock でない）→ failureType は付与されない', async () => {
    mockGitDiffResult = true;
    const ctx = createCtx({
      idleTimeoutForceKilled: true,
      wallClockTimeoutForceKilled: false,
      outputBuffer: 'some output',
    });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      1,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
    );
    callback();

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.failureType).toBeUndefined();
  });

  test('ケース4: investigationMode=false + exit0 → git diff 経路（短絡しない）', async () => {
    mockGitDiffResult = false; // git diff: 変更なし
    const ctx = createCtx({ outputBuffer: 'a'.repeat(300) });
    const { resolve, promise } = createResolveTracker();

    const callback = buildResolveAfterParse(
      ctx,
      0,
      '/tmp/workdir',
      Date.now(),
      resolve,
      () => [],
      () => [],
      async () => false, // checkPlanCreated
      false, // investigationMode = false → 短絡しない
    );
    callback();

    const result = await promise;
    // git diff が false かつ file-modifying tools もなし → 既存の失敗パス
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('no actual code changes');
  });
});

describe('wall-clock timeout completion fence', () => {
  test.each([0, 1, null])(
    'rejects partial investigation output even with exit %s',
    async (code) => {
      const ctx = createCtx({
        wallClockTimeoutForceKilled: true,
        idleTimeoutForceKilled: true,
        outputBuffer: 'partial research '.repeat(30),
        finalResultText: 'earlier result',
      });
      const { resolve, promise } = createResolveTracker();
      buildResolveAfterParse(
        ctx,
        code,
        '/tmp/workdir',
        Date.now(),
        resolve,
        () => [],
        () => [],
        undefined,
        true,
      )();
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.waitingForInput).toBe(false);
      expect(result.failureType).toBe('wall_clock_timeout');
      expect(result.output).toBe(ctx.outputBuffer);
      expect(ctx.status).toBe('failed');
    },
  );
});
