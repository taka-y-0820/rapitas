import { describe, test, expect, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  generateCacheKey,
  getCachedResponse,
  setCachedResponse,
  getCacheStats,
  purgeExpiredEntries,
} from './response-cache';

// This module has no injectable DB path — it always opens the real, shared
// data/llm-response-cache.db that the running app uses for real LLM caching.
// NEVER call clearCache() here (it would wipe real cached entries); use a
// clearly test-only hash prefix and delete ONLY those rows directly via a
// raw connection, never touching real data.
const TEST_PREFIX = 'test-response-cache-';
const DB_PATH = join(__dirname, '../../data', 'llm-response-cache.db');

function cleanupTestRows(): void {
  const raw = new Database(DB_PATH);
  raw.prepare('DELETE FROM llm_cache WHERE hash LIKE ?').run(`${TEST_PREFIX}%`);
  raw.close();
}

describe('generateCacheKey', () => {
  test('is deterministic for identical inputs', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const a = generateCacheKey('claude', 'model-x', 'sys', messages);
    const b = generateCacheKey('claude', 'model-x', 'sys', messages);
    expect(a).toBe(b);
  });

  test('matches a manually-computed sha256 of the same JSON shape', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const expected = createHash('sha256')
      .update(
        JSON.stringify({ provider: 'claude', model: 'model-x', systemPrompt: 'sys', messages }),
      )
      .digest('hex');
    expect(generateCacheKey('claude', 'model-x', 'sys', messages)).toBe(expected);
  });

  test('differs when any input component differs', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const base = generateCacheKey('claude', 'model-x', 'sys', messages);
    expect(generateCacheKey('gpt', 'model-x', 'sys', messages)).not.toBe(base);
    expect(generateCacheKey('claude', 'model-y', 'sys', messages)).not.toBe(base);
    expect(generateCacheKey('claude', 'model-x', 'other', messages)).not.toBe(base);
    expect(
      generateCacheKey('claude', 'model-x', 'sys', [{ role: 'user', content: 'bye' }]),
    ).not.toBe(base);
  });

  test('treats an undefined systemPrompt the same as an empty string', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    expect(generateCacheKey('claude', 'model-x', undefined, messages)).toBe(
      generateCacheKey('claude', 'model-x', '', messages),
    );
  });
});

describe('getCachedResponse / setCachedResponse', () => {
  test.each([0, 2000])('expires exactly at the UTC deadline (ttlMs=%i)', (ttlMs) => {
    const hash = `${TEST_PREFIX}utc-deadline-${ttlMs}`;
    setCachedResponse(hash, 'boundary', 1, 'claude', 'model-x', ttlMs);
    const raw = new Database(DB_PATH);
    raw
      .prepare('UPDATE llm_cache SET created_at = ? WHERE hash = ?')
      .run('2026-09-09 00:00:00', hash);
    raw.close();
    const clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-09T00:00:00Z') + ttlMs);
    try {
      if (ttlMs > 0) {
        clock.mockReturnValue(Date.parse('2026-09-09T00:00:00Z') + ttlMs - 1);
        expect(getCachedResponse(hash)).toEqual({ content: 'boundary', tokensUsed: 1 });
        clock.mockReturnValue(Date.parse('2026-09-09T00:00:00Z') + ttlMs);
      }
      expect(getCachedResponse(hash)).toBeNull();
      const verify = new Database(DB_PATH);
      try {
        expect(verify.prepare('SELECT hash FROM llm_cache WHERE hash = ?').get(hash)).toBeNull();
      } finally {
        verify.close();
      }
    } finally {
      clock.mockRestore();
      cleanupTestRows();
    }
  });

  test('returns null for a hash that has never been cached', () => {
    const hash = `${TEST_PREFIX}${createHash('sha256').update('never-cached').digest('hex')}`;
    expect(getCachedResponse(hash)).toBeNull();
  });

  test('round-trips a stored response', () => {
    const hash = `${TEST_PREFIX}${createHash('sha256').update('round-trip').digest('hex')}`;
    setCachedResponse(hash, 'the cached content', 42, 'claude', 'model-x');
    try {
      const result = getCachedResponse(hash);
      expect(result).toEqual({ content: 'the cached content', tokensUsed: 42 });
    } finally {
      cleanupTestRows();
    }
  });

  test('a cache hit increments hit_count (visible via a second lookup not throwing)', () => {
    const hash = `${TEST_PREFIX}${createHash('sha256').update('hit-count').digest('hex')}`;
    setCachedResponse(hash, 'content', 1, 'claude', 'model-x');
    try {
      expect(getCachedResponse(hash)).not.toBeNull();
      expect(getCachedResponse(hash)).not.toBeNull();
    } finally {
      cleanupTestRows();
    }
  });

  test('setCachedResponse overwrites an existing entry for the same hash', () => {
    const hash = `${TEST_PREFIX}${createHash('sha256').update('overwrite').digest('hex')}`;
    setCachedResponse(hash, 'first', 1, 'claude', 'model-x');
    setCachedResponse(hash, 'second', 2, 'claude', 'model-x');
    try {
      expect(getCachedResponse(hash)).toEqual({ content: 'second', tokensUsed: 2 });
    } finally {
      cleanupTestRows();
    }
  });

  test('an expired entry (ttlMs=0) is treated as a miss and removed', () => {
    const hash = `${TEST_PREFIX}${createHash('sha256').update('expired').digest('hex')}`;
    setCachedResponse(hash, 'stale', 1, 'claude', 'model-x', 0);
    try {
      // ttlMs=0 means "expired the instant it was created".
      expect(getCachedResponse(hash)).toBeNull();
    } finally {
      cleanupTestRows();
    }
  });
});

describe('getCacheStats', () => {
  test('returns a well-shaped stats object', () => {
    const stats = getCacheStats();
    expect(typeof stats.totalEntries).toBe('number');
    expect(typeof stats.totalHits).toBe('number');
    expect(typeof stats.totalMisses).toBe('number');
    expect(typeof stats.hitRate).toBe('number');
    expect(typeof stats.cacheSize).toBe('number');
    expect(stats.hitRate).toBeGreaterThanOrEqual(0);
    expect(stats.hitRate).toBeLessThanOrEqual(1);
  });

  test('totalEntries reflects at least the entry this test just added', () => {
    const hash = `${TEST_PREFIX}${createHash('sha256').update('stats-count').digest('hex')}`;
    setCachedResponse(hash, 'content', 1, 'claude', 'model-x');
    try {
      const stats = getCacheStats();
      expect(stats.totalEntries).toBeGreaterThanOrEqual(1);
      expect(stats.cacheSize).toBe(stats.totalEntries);
    } finally {
      cleanupTestRows();
    }
  });
});

describe('purgeExpiredEntries', () => {
  test('removes a test entry whose TTL has already elapsed', () => {
    const hash = `${TEST_PREFIX}${createHash('sha256').update('purge-me').digest('hex')}`;
    setCachedResponse(hash, 'to purge', 1, 'claude', 'model-x');

    // Backdate created_at directly (public API only supports "now") so the
    // row is unambiguously expired without waiting in real time.
    const raw = new Database(DB_PATH);
    raw
      .prepare(
        "UPDATE llm_cache SET created_at = datetime('now', '-1 hour'), ttl_ms = 1 WHERE hash = ?",
      )
      .run(hash);
    raw.close();

    try {
      const deleted = purgeExpiredEntries();
      expect(deleted).toBeGreaterThanOrEqual(1);

      const raw2 = new Database(DB_PATH);
      const row = raw2.prepare('SELECT hash FROM llm_cache WHERE hash = ?').get(hash);
      raw2.close();
      expect(row).toBeNull();
    } finally {
      cleanupTestRows();
    }
  });

  test('does not remove a fresh, non-expired entry', () => {
    const hash = `${TEST_PREFIX}${createHash('sha256').update('keep-me').digest('hex')}`;
    setCachedResponse(hash, 'keep', 1, 'claude', 'model-x'); // default 7-day TTL
    try {
      purgeExpiredEntries();
      expect(getCachedResponse(hash)).not.toBeNull();
    } finally {
      cleanupTestRows();
    }
  });
});
