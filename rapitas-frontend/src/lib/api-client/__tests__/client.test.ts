import { APIClient, isTransientError, UI_SOURCE_HEADER, UI_SOURCE_VALUE } from '../client';
import * as apiUtils from '@/utils/api';

vi.mock('@/utils/api', () => ({ API_BASE_URL: 'http://test:3001' }));

// Drive performFetch's underlying transport. The client uses offlineFetch in a
// browser env; mock it so we can simulate a stalled-then-recovered GET.
const mockOfflineFetch = vi.fn();
vi.mock('@/lib/offline-queue', () => ({
  offlineFetch: (...args: unknown[]) => mockOfflineFetch(...args),
}));

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

// ApiClientCache persists `/tasks/*` entries to the REAL localStorage (jsdom),
// and every `new APIClient()` eagerly loads them back into its in-memory
// cache. Without clearing between tests, a `/tasks/1` fetch cached by an
// earlier test would silently short-circuit a later test's network call.
beforeEach(() => {
  localStorage.clear();
});

describe('isTransientError', () => {
  it('flags timeout / network / 5xx as transient', () => {
    expect(isTransientError(new Error('Request timeout after 15000ms — GET /tasks/1'))).toBe(true);
    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientError(new Error('API Error: 503 (GET /x) - down'))).toBe(true);
  });

  it('does NOT flag 4xx or arbitrary errors', () => {
    expect(isTransientError(new Error('API Error: 404 (GET /x) - missing'))).toBe(false);
    expect(isTransientError(new Error('boom'))).toBe(false);
  });
});

describe('APIClient GET retry', () => {
  beforeEach(() => {
    mockOfflineFetch.mockReset();
  });

  it('retries a transient timeout on a GET and recovers', async () => {
    mockOfflineFetch
      .mockRejectedValueOnce(new Error('Request timeout after 15000ms — GET /tasks/234'))
      .mockResolvedValueOnce(okResponse({ id: 234, title: 'ok' }));

    const client = new APIClient();
    const result = await client.fetch<{ id: number }>('/tasks/234', { skipCache: true });

    expect(result).toEqual({ id: 234, title: 'ok' });
    expect(mockOfflineFetch).toHaveBeenCalledTimes(2); // first stalled, retry succeeded
  });

  it('does not retry non-transient (4xx) errors', async () => {
    mockOfflineFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'not found',
    } as unknown as Response);

    const client = new APIClient();
    await expect(client.fetch('/tasks/999', { skipCache: true })).rejects.toThrow();
    expect(mockOfflineFetch).toHaveBeenCalledTimes(1); // no retry on 404
  });

  it('does not retry mutations', async () => {
    mockOfflineFetch.mockRejectedValue(new Error('Request timeout after 30000ms — POST /tasks'));

    const client = new APIClient();
    await expect(
      client.fetch('/tasks', { method: 'POST', body: '{}', skipCache: true }),
    ).rejects.toThrow();
    expect(mockOfflineFetch).toHaveBeenCalledTimes(1); // POST never retried
  });
});

describe('APIClient caching and dedup', () => {
  beforeEach(() => {
    mockOfflineFetch.mockReset();
  });

  it('2回目以降のGETはキャッシュから返しネットワークを呼ばないこと', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    const first = await client.fetch('/tasks/1');
    const second = await client.fetch('/tasks/1');

    expect(first).toEqual({ id: 1 });
    expect(second).toEqual({ id: 1 });
    expect(mockOfflineFetch).toHaveBeenCalledTimes(1);
  });

  it('skipCache指定時はキャッシュを無視して再度ネットワークを呼ぶこと', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    await client.fetch('/tasks/1');
    await client.fetch('/tasks/1', { skipCache: true });

    expect(mockOfflineFetch).toHaveBeenCalledTimes(2);
  });

  it('同時に発行された同一リクエストは1回のfetchに集約されること（in-flight dedup）', async () => {
    let resolveFetch!: (v: Response) => void;
    mockOfflineFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const client = new APIClient();

    const p1 = client.fetch('/tasks/1', { skipCache: true });
    const p2 = client.fetch('/tasks/1', { skipCache: true });

    resolveFetch(okResponse({ id: 1 }));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ id: 1 });
    expect(r2).toEqual({ id: 1 });
    expect(mockOfflineFetch).toHaveBeenCalledTimes(1);
  });

  it('リクエスト失敗後は同じキーで再度ネットワークを呼べること（キュー解放）', async () => {
    mockOfflineFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'nope',
    } as unknown as Response);
    const client = new APIClient();

    await expect(client.fetch('/tasks/1', { skipCache: true })).rejects.toThrow();

    mockOfflineFetch.mockResolvedValueOnce(okResponse({ id: 1 }));
    const result = await client.fetch('/tasks/1', { skipCache: true });

    expect(result).toEqual({ id: 1 });
    expect(mockOfflineFetch).toHaveBeenCalledTimes(2);
  });
});

describe('APIClient.batchFetch', () => {
  it('batch経由でも通常のfetchと同じ結果を得られること', async () => {
    mockOfflineFetch.mockReset();
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    vi.useFakeTimers();
    try {
      const client = new APIClient();
      const promise = client.batchFetch<{ id: number }>('/tasks/1', { skipCache: true });
      await vi.advanceTimersByTimeAsync(50);
      await expect(promise).resolves.toEqual({ id: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('APIClient.debouncedFetch', () => {
  beforeEach(() => {
    mockOfflineFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('遅延ウィンドウ内の連続呼び出しは最後の1回だけ実行されること', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 'latest' }));
    const client = new APIClient();

    const p1 = client.debouncedFetch('/search', { skipCache: true }, 100);
    const p2 = client.debouncedFetch('/search', { skipCache: true }, 100);

    await vi.advanceTimersByTimeAsync(100);

    await expect(p2).resolves.toEqual({ id: 'latest' });
    expect(mockOfflineFetch).toHaveBeenCalledTimes(1);
    void p1;
  });

  it('内部fetchが失敗した場合はPromiseをrejectすること', async () => {
    // A 4xx is non-transient (see isTransientError), so getWithRetries fails on
    // the first attempt without needing to advance fake timers through the
    // retry backoff delay.
    mockOfflineFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    } as unknown as Response);
    const client = new APIClient();

    const result = client.debouncedFetch('/search', { skipCache: true }, 50);
    const assertion = expect(result).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});

describe('APIClient.throttledFetch', () => {
  beforeEach(() => {
    mockOfflineFetch.mockReset();
  });

  it('間隔内の再呼び出しはキャッシュ済みデータを返しネットワークを呼ばないこと', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    const first = await client.throttledFetch('/tasks/1', {}, 5000);
    const second = await client.throttledFetch('/tasks/1', {}, 5000);

    expect(first).toEqual({ id: 1 });
    expect(second).toEqual({ id: 1 });
    expect(mockOfflineFetch).toHaveBeenCalledTimes(1);
  });

  it('間隔内でキャッシュが無い場合はエラーを投げること', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    // POST responses are never cached by fetch(), so the second throttled call
    // within the interval has nothing to fall back to.
    await client.throttledFetch('/tasks', { method: 'POST', body: '{}' }, 5000);
    await expect(
      client.throttledFetch('/tasks', { method: 'POST', body: '{}' }, 5000),
    ).rejects.toThrow('Request throttled and no cache available');
  });

  it('間隔を過ぎれば再度ネットワークを呼ぶこと', async () => {
    vi.useFakeTimers();
    try {
      mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
      const client = new APIClient();

      await client.throttledFetch('/tasks/1', { skipCache: true }, 1000);
      vi.setSystemTime(Date.now() + 1500);
      await client.throttledFetch('/tasks/1', { skipCache: true }, 1000);

      expect(mockOfflineFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('APIClient.parallelFetch', () => {
  it('個々の失敗が他の結果に影響しないこと', async () => {
    mockOfflineFetch.mockReset();
    mockOfflineFetch.mockResolvedValueOnce(okResponse({ id: 1 })).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
    } as unknown as Response);
    const client = new APIClient();

    const result = await client.parallelFetch<{
      good: { id: number };
      bad: { error: unknown };
    }>({
      good: { path: '/tasks/1', options: { skipCache: true } },
      bad: { path: '/tasks/2', options: { skipCache: true } },
    });

    expect(result.good).toEqual({ id: 1 });
    expect(result.bad).toHaveProperty('error');
  });
});

describe('APIClient.prefetch', () => {
  it('複数パスをフェッチしキャッシュへ格納すること', async () => {
    mockOfflineFetch.mockReset();
    mockOfflineFetch.mockResolvedValue(okResponse({ ok: true }));
    const client = new APIClient();

    await client.prefetch(['/tasks/1', '/tasks/2']);

    expect(mockOfflineFetch).toHaveBeenCalledTimes(2);
    // Subsequent fetch for the same path should hit the warmed cache.
    mockOfflineFetch.mockClear();
    await client.fetch('/tasks/1');
    expect(mockOfflineFetch).not.toHaveBeenCalled();
  });

  it('個々のパスが失敗しても例外を投げないこと', async () => {
    mockOfflineFetch.mockReset();
    mockOfflineFetch.mockRejectedValue(new Error('network down'));
    const client = new APIClient();

    await expect(client.prefetch(['/tasks/1'])).resolves.toBeUndefined();
  });
});

describe('APIClient.clearCache / getCacheStats', () => {
  beforeEach(() => {
    mockOfflineFetch.mockReset();
  });

  it('パターンに一致するキャッシュのみ消去し、以降は再度ネットワークを呼ぶこと', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    await client.fetch('/tasks/1');
    client.clearCache('/tasks/1');
    await client.fetch('/tasks/1');

    expect(mockOfflineFetch).toHaveBeenCalledTimes(2);
  });

  it('getCacheStatsはキャッシュ済みエントリの統計を返すこと', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    await client.fetch('/tasks/1');
    const stats = client.getCacheStats();

    expect(stats.entries.length).toBeGreaterThan(0);
    expect(stats.size).toBeGreaterThan(0);
  });
});

describe('APIClient.performFetch - X-Rapitas-Source header', () => {
  beforeEach(() => {
    mockOfflineFetch.mockReset();
  });

  it('GETリクエストに X-Rapitas-Source: ui ヘッダを付与すること', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    await client.fetch('/tasks/1', { skipCache: true });

    const [, init] = mockOfflineFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)[UI_SOURCE_HEADER]).toBe(UI_SOURCE_VALUE);
  });

  it('POSTリクエストにも X-Rapitas-Source: ui ヘッダを付与すること', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ ok: true }));
    const client = new APIClient();

    await client.fetch('/tasks', { method: 'POST', body: '{}', skipCache: true });

    const [, init] = mockOfflineFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)[UI_SOURCE_HEADER]).toBe(UI_SOURCE_VALUE);
  });

  it('呼び出し側が独自ヘッダを指定してもソースヘッダが維持されること', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    await client.fetch('/tasks/1', {
      skipCache: true,
      headers: { 'X-Custom': 'abc' },
    });

    const [, init] = mockOfflineFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[UI_SOURCE_HEADER]).toBe(UI_SOURCE_VALUE);
    expect(headers['X-Custom']).toBe('abc');
  });

  it('呼び出し側は既存規約どおりソースヘッダを明示上書きできること', async () => {
    mockOfflineFetch.mockResolvedValue(okResponse({ id: 1 }));
    const client = new APIClient();

    await client.fetch('/tasks/1', {
      skipCache: true,
      headers: { [UI_SOURCE_HEADER]: 'other' },
    });

    const [, init] = mockOfflineFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)[UI_SOURCE_HEADER]).toBe('other');
  });

  it('SSRフォールバック（native fetch）でもヘッダが付与されること', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(okResponse({ id: 1 }));
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('fetch', nativeFetch);
    try {
      const client = new APIClient();
      await client.fetch('/tasks/1', { skipCache: true });

      const [, init] = nativeFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)[UI_SOURCE_HEADER]).toBe(UI_SOURCE_VALUE);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('APIClient.performFetch - caller AbortSignal composition', () => {
  beforeEach(() => {
    mockOfflineFetch.mockReset();
  });

  it('composes the caller AbortSignal using the native AbortSignal.any when available', async () => {
    mockOfflineFetch.mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(okResponse({ id: 1 }));
    });

    const controller = new AbortController();
    const client = new APIClient();

    const result = await client.fetch('/tasks/1', {
      skipCache: true,
      signal: controller.signal,
    });

    expect(result).toEqual({ id: 1 });
  });
});

describe('APIClient.performFetch - caller AbortSignal composition without AbortSignal.any', () => {
  const originalAny = AbortSignal.any;

  beforeEach(() => {
    mockOfflineFetch.mockReset();
    // Force the manual-chaining fallback branches (taken in runtimes where the
    // AbortSignal.any static method is unavailable).
    // @ts-expect-error simulating an environment without AbortSignal.any
    delete AbortSignal.any;
  });

  afterEach(() => {
    AbortSignal.any = originalAny;
  });

  it('immediately aborts the composed signal when the caller signal is already aborted', async () => {
    mockOfflineFetch.mockImplementation((_url: string, init: RequestInit) => {
      expect((init.signal as AbortSignal).aborted).toBe(true);
      return Promise.resolve(okResponse({ id: 1 }));
    });

    const controller = new AbortController();
    controller.abort(new Error('caller aborted'));
    const client = new APIClient();

    const result = await client.fetch('/tasks/1', {
      skipCache: true,
      signal: controller.signal,
    });

    expect(result).toEqual({ id: 1 });
    expect(mockOfflineFetch).toHaveBeenCalledTimes(1);
  });

  it('registers an abort listener that propagates a not-yet-aborted caller signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockOfflineFetch.mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return Promise.resolve(okResponse({ id: 1 }));
    });

    const controller = new AbortController();
    const client = new APIClient();

    await client.fetch('/tasks/1', {
      skipCache: true,
      signal: controller.signal,
    });

    expect(capturedSignal!.aborted).toBe(false);
    controller.abort(new Error('late abort'));
    // The bridging listener fires synchronously, propagating the abort onto
    // the composed timeout signal.
    expect(capturedSignal!.aborted).toBe(true);
  });
});

describe('APIClient.performFetch - SSR / non-browser fallbacks', () => {
  beforeEach(() => {
    mockOfflineFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to native fetch (not offlineFetch) when window is undefined', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(okResponse({ id: 42 }));
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('fetch', nativeFetch);

    const client = new APIClient();
    const result = await client.fetch('/tasks/1', { skipCache: true });

    expect(result).toEqual({ id: 42 });
    expect(nativeFetch).toHaveBeenCalled();
    expect(mockOfflineFetch).not.toHaveBeenCalled();
  });

  it('falls back to the raw URL for the request label when the base URL cannot be parsed', async () => {
    const original = apiUtils.API_BASE_URL;
    // Mutate the mocked export so `${API_BASE_URL}${path}` produces a
    // relative (non-absolute) string that `new URL()` cannot parse.
    (apiUtils as { API_BASE_URL: string }).API_BASE_URL = '';
    try {
      mockOfflineFetch.mockImplementation((url: string) => {
        // pathname parsing failed -> the raw relative url is used as-is
        expect(url).toBe('/tasks/1');
        return Promise.resolve(okResponse({ id: 1 }));
      });

      const client = new APIClient();
      const result = await client.fetch('/tasks/1', { skipCache: true });

      expect(result).toEqual({ id: 1 });
    } finally {
      (apiUtils as { API_BASE_URL: string }).API_BASE_URL = original;
    }
  });
});

describe('APIClient timeout logging', () => {
  it('warns instead of error logging while still rejecting the timed out request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockOfflineFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    );
    try {
      const client = new APIClient();
      await expect(
        client.fetch('/tasks/805', { skipCache: true, skipRetry: true, timeoutMs: 1 }),
      ).rejects.toThrow('Request timeout');
      expect(warn).toHaveBeenCalledWith('[api-client]', '[api-client] timeout', 'GET /tasks/805');
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
