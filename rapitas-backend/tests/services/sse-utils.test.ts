/**
 * SSE Utils テスト
 * SSEヘルパー関数とストリームコントローラーのテスト
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  }),
}));

const {
  createSSEHeaders,
  formatSSEMessage,
  calculateRetryDelay,
  delay,
  isRetryableError,
  getUserFriendlyErrorMessage,
  SSEStreamController,
  DEFAULT_RETRY_CONFIG,
} = await import('../../services/communication/sse-utils');

describe('createSSEHeaders', () => {
  test('Content-Typeがtext/event-streamであること', () => {
    const headers = createSSEHeaders();
    expect(headers.get('Content-Type')).toBe('text/event-stream');
  });

  test('Cache-Controlがno-cacheであること', () => {
    const headers = createSSEHeaders();
    expect(headers.get('Cache-Control')).toBe('no-cache');
  });

  test('Connectionがkeep-aliveであること', () => {
    const headers = createSSEHeaders();
    expect(headers.get('Connection')).toBe('keep-alive');
  });

  test('CORSヘッダーはグローバルCORSミドルウェアに委任されていること', () => {
    const headers = createSSEHeaders();
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('formatSSEMessage', () => {
  test('SSE形式のメッセージを生成すること', () => {
    const result = formatSSEMessage({
      type: 'data',
      data: { message: 'hello' },
      timestamp: '2024-01-01T00:00:00Z',
    });
    expect(result).toContain('event: data\n');
    expect(result).toContain('data: ');
    expect(result).toEndWith('\n\n');
  });

  test('イベントタイプが正しく設定されること', () => {
    const result = formatSSEMessage({
      type: 'error',
      data: {},
      timestamp: '2024-01-01T00:00:00Z',
    });
    expect(result).toContain('event: error\n');
  });
});

describe('calculateRetryDelay', () => {
  test('初回リトライはinitialDelayを返すこと', () => {
    expect(calculateRetryDelay(0)).toBe(DEFAULT_RETRY_CONFIG.initialDelay);
  });

  test('指数バックオフで遅延が増加すること', () => {
    const delay0 = calculateRetryDelay(0);
    const delay1 = calculateRetryDelay(1);
    const delay2 = calculateRetryDelay(2);
    expect(delay1).toBeGreaterThan(delay0);
    expect(delay2).toBeGreaterThan(delay1);
  });

  test('maxDelayを超えないこと', () => {
    const result = calculateRetryDelay(100);
    expect(result).toBeLessThanOrEqual(DEFAULT_RETRY_CONFIG.maxDelay);
  });

  test('カスタム設定で計算できること', () => {
    const config = { maxRetries: 5, initialDelay: 500, maxDelay: 5000, backoffMultiplier: 3 };
    expect(calculateRetryDelay(0, config)).toBe(500);
    expect(calculateRetryDelay(1, config)).toBe(1500);
    expect(calculateRetryDelay(2, config)).toBe(4500);
    expect(calculateRetryDelay(3, config)).toBe(5000); // capped
  });
});

describe('delay', () => {
  test('指定ミリ秒後に解決すること', async () => {
    const start = Date.now();
    await delay(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe('isRetryableError', () => {
  test('ネットワークエラーはリトライ可能であること', () => {
    expect(isRetryableError(new Error('network error occurred'))).toBe(true);
  });

  test('タイムアウトエラーはリトライ可能であること', () => {
    expect(isRetryableError(new Error('request timeout'))).toBe(true);
  });

  test('接続リセットエラーはリトライ可能であること', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
  });

  test('接続拒否エラーはリトライ可能であること', () => {
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
  });

  test('レート制限エラーはリトライ可能であること', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('status 429'))).toBe(true);
  });

  test('503/504エラーはリトライ可能であること', () => {
    expect(isRetryableError(new Error('503 service unavailable'))).toBe(true);
    expect(isRetryableError(new Error('504 gateway timeout'))).toBe(true);
  });

  test('通常のエラーはリトライ不可であること', () => {
    expect(isRetryableError(new Error('invalid input'))).toBe(false);
    expect(isRetryableError(new Error('not found'))).toBe(false);
  });

  test('Error以外はリトライ不可であること', () => {
    expect(isRetryableError('string error')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });
});

describe('getUserFriendlyErrorMessage', () => {
  test('レート制限エラーの日本語メッセージを返すこと', () => {
    const msg = getUserFriendlyErrorMessage(new Error('rate limit exceeded'));
    expect(msg).toContain('レート制限');
  });

  test('タイムアウトエラーの日本語メッセージを返すこと', () => {
    const msg = getUserFriendlyErrorMessage(new Error('request timeout'));
    expect(msg).toContain('タイムアウト');
  });

  test('ネットワークエラーの日本語メッセージを返すこと', () => {
    const msg = getUserFriendlyErrorMessage(new Error('ECONNREFUSED'));
    expect(msg).toContain('ネットワーク');
  });

  test('APIキーエラーの日本語メッセージを返すこと', () => {
    const msg = getUserFriendlyErrorMessage(new Error('api key invalid'));
    expect(msg).toContain('APIキー');
  });

  test('404エラーの日本語メッセージを返すこと', () => {
    const msg = getUserFriendlyErrorMessage(new Error('resource not found'));
    expect(msg).toContain('見つかりません');
  });

  test('不明なエラーはそのままメッセージを返すこと', () => {
    const msg = getUserFriendlyErrorMessage(new Error('some custom error'));
    expect(msg).toBe('some custom error');
  });

  test('Error以外は汎用メッセージを返すこと', () => {
    const msg = getUserFriendlyErrorMessage('string error');
    expect(msg).toContain('予期しない');
  });
});

describe('SSEStreamController', () => {
  test('ストリームを作成できること', () => {
    const controller = new SSEStreamController();
    const stream = controller.createStream();
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  test('状態を保存・取得できること', () => {
    const controller = new SSEStreamController();
    const state = { count: 5, items: ['a', 'b'] };
    controller.saveState(state);

    const saved = controller.getSavedState() as typeof state;
    expect(saved).toEqual(state);
    // Verify it was deep cloned
    expect(saved).not.toBe(state);
  });

  test('閉じた後はsendが無視されること', () => {
    const controller = new SSEStreamController();
    controller.createStream();
    controller.close();
    // Should not throw
    controller.send({ type: 'data', data: {}, timestamp: '' });
  });

  test('二重closeでエラーにならないこと', () => {
    const controller = new SSEStreamController();
    controller.createStream();
    controller.close();
    controller.close(); // should not throw
  });

  test('カスタムリトライ設定を受け入れること', () => {
    const controller = new SSEStreamController({ maxRetries: 5, initialDelay: 500 });
    // Controller created successfully with custom config
    expect(controller).toBeDefined();
  });

  // eslint-disable-next-line local/prefer-test-each-for-similar -- each case asserts a different shape (immediate-fail message, retry count, success-after-retry return value, backoff timing) and isn't safely parameterizable
  test('executeWithRetryでリトライ不可エラーは即座に失敗すること', async () => {
    const controller = new SSEStreamController({ maxRetries: 3 });
    controller.createStream();

    let callCount = 0;
    try {
      await controller.executeWithRetry(async () => {
        callCount++;
        throw new Error('invalid input'); // not retryable
      });
    } catch (e: unknown) {
      expect(e instanceof Error ? e.message : String(e)).toBe('invalid input');
    }
    expect(callCount).toBe(1);
  });

  test('executeWithRetryでリトライ可能エラーはリトライすること', async () => {
    const controller = new SSEStreamController({
      maxRetries: 2,
      initialDelay: 10,
      maxDelay: 50,
      backoffMultiplier: 2,
    });
    controller.createStream();

    let callCount = 0;
    try {
      await controller.executeWithRetry(async () => {
        callCount++;
        throw new Error('network error');
      });
    } catch {
      // expected
    }
    expect(callCount).toBe(3); // initial + 2 retries
  });

  test('executeWithRetryで成功した場合結果を返すこと', async () => {
    const controller = new SSEStreamController({ maxRetries: 3, initialDelay: 10 });
    controller.createStream();

    let callCount = 0;
    const result = await controller.executeWithRetry(async () => {
      callCount++;
      if (callCount < 2) throw new Error('network error');
      return 'success';
    });
    expect(result).toBe('success');
    expect(callCount).toBe(2);
  });

  test('executeWithRetryで指数バックオフが動作すること', async () => {
    const controller = new SSEStreamController({ maxRetries: 3, initialDelay: 10 });
    controller.createStream();

    const requestedDelays: number[] = [];
    const realTimeout = globalThis.setTimeout;
    let calls = 0;
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      requestedDelays.push(ms);
      queueMicrotask(callback);
      return 1;
    }) as unknown as typeof setTimeout;
    try {
      await expect(
        controller.executeWithRetry(async () => {
          calls++;
          throw new Error('network connection failed');
        }),
      ).rejects.toThrow('network connection failed');
      expect(calls).toBe(4);
      expect(requestedDelays).toEqual([10, 20, 40]);
    } finally {
      globalThis.setTimeout = realTimeout;
      controller.close();
    }
  });
});

describe('SSE統合テスト', () => {
  test('完全なSSEワークフローが動作すること', async () => {
    const controller = new SSEStreamController();
    const stream = controller.createStream();

    // Send multiple event types
    controller.send({ type: 'status', data: 'connected' });
    controller.send({ type: 'message', data: 'hello world' });
    controller.send({ type: 'notification', data: { title: 'Test', body: 'Notification' } });

    // ReadableStream doesn't have .on() - use reader API for Web Streams
    const reader = stream.getReader();
    const chunks: string[] = [];

    // Read a few chunks
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(new TextDecoder().decode(value));
      }
    }

    // Verify some events were received
    expect(chunks.length).toBeGreaterThan(0);
    const allData = chunks.join('');
    expect(allData).toContain('status');
    expect(allData).toContain('connected');
  });

  // NOTE: SSEConnectionManager is not implemented in sse-utils.ts
  // These tests are skipped until the feature is added
  test.skip('コネクション管理が正常に動作すること', () => {
    // SSEConnectionManager not implemented
  });

  test.skip('ブロードキャスト機能が動作すること', () => {
    // SSEConnectionManager not implemented
  });
});
