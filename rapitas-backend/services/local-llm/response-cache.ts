/**
 * LLM Response Cache
 *
 * Caches LLM responses in SQLite keyed by a SHA-256 hash of the input
 * (system prompt + messages). Cache hits bypass the LLM call entirely,
 * saving both time and API/compute cost. TTL-based expiration ensures
 * stale entries are periodically purged.
 */
import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { createLogger } from '../../config';

const log = createLogger('local-llm:response-cache');

const DB_DIR = join(__dirname, '../../data');
const DB_PATH = join(DB_DIR, 'llm-response-cache.db');

/** Default time-to-live: 7 days in milliseconds. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum cache entries before LRU eviction triggers. */
const MAX_CACHE_ENTRIES = 10000;

let db: Database | null = null;

/** Cache entry stored in SQLite. */
interface CacheEntry {
  hash: string;
  response_content: string;
  tokens_used: number;
  provider: string;
  model: string;
  created_at: string;
  last_accessed_at: string;
  hit_count: number;
  ttl_ms: number;
}

/** Cache statistics. */
export interface CacheStats {
  totalEntries: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  oldestEntry: string | null;
  cacheSize: number;
}

// In-memory hit/miss counters for statistics.
let hitCount = 0;
let missCount = 0;

/**
 * Initialize the SQLite cache database.
 *
 * Creates the table and indexes if they do not exist.
 * Uses WAL mode for concurrent read performance.
 */
function getDb(): Database {
  if (db) return db;

  try {
    if (!existsSync(DB_DIR)) {
      mkdirSync(DB_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_cache (
        hash              TEXT PRIMARY KEY,
        response_content  TEXT NOT NULL,
        tokens_used       INTEGER DEFAULT 0,
        provider          TEXT NOT NULL,
        model             TEXT DEFAULT '',
        created_at        TEXT DEFAULT (datetime('now')),
        last_accessed_at  TEXT DEFAULT (datetime('now')),
        hit_count         INTEGER DEFAULT 0,
        ttl_ms            INTEGER DEFAULT ${DEFAULT_TTL_MS}
      );
      CREATE INDEX IF NOT EXISTS idx_cache_accessed ON llm_cache(last_accessed_at);
      CREATE INDEX IF NOT EXISTS idx_cache_created ON llm_cache(created_at);
    `);

    log.info('LLM response cache initialized');
    return db;
  } catch (error) {
    log.error({ err: error }, 'Failed to initialize LLM cache database');
    throw error;
  }
}

/**
 * Generate a SHA-256 hash key from the input parameters.
 *
 * The hash is deterministic for the same (provider, model, systemPrompt, messages)
 * combination, enabling exact cache lookups.
 *
 * @param provider - AI provider name. / AIプロバイダー名
 * @param model - Model identifier. / モデルID
 * @param systemPrompt - System prompt text. / システムプロンプト
 * @param messages - Conversation messages. / 会話メッセージ
 * @returns SHA-256 hex hash. / SHA-256ハッシュ
 */
export function generateCacheKey(
  provider: string,
  model: string,
  systemPrompt: string | undefined,
  messages: Array<{ role: string; content: string }>,
): string {
  const input = JSON.stringify({ provider, model, systemPrompt: systemPrompt || '', messages });
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Look up a cached response by hash key.
 *
 * Returns null on cache miss or if the entry has expired.
 * Updates access metadata on hit.
 *
 * @param hash - Cache key hash. / キャッシュキーハッシュ
 * @returns Cached response or null. / キャッシュされたレスポンスまたはnull
 */
export function getCachedResponse(hash: string): { content: string; tokensUsed: number } | null {
  try {
    const database = getDb();
    const row = database.prepare('SELECT * FROM llm_cache WHERE hash = ?').get(hash) as
      | CacheEntry
      | undefined;

    if (!row) {
      missCount++;
      return null;
    }

    // SQLite datetime('now') is UTC without a zone suffix. Parsing it as
    // local time shifts expiry on non-UTC hosts. The deadline is exclusive:
    // an entry with a zero TTL must never be returned, even in the same tick.
    const createdAt = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
    if (row.ttl_ms <= 0 || !Number.isFinite(createdAt) || Date.now() - createdAt >= row.ttl_ms) {
      database.prepare('DELETE FROM llm_cache WHERE hash = ?').run(hash);
      missCount++;
      return null;
    }

    // Update access metadata
    database
      .prepare(
        "UPDATE llm_cache SET last_accessed_at = datetime('now'), hit_count = hit_count + 1 WHERE hash = ?",
      )
      .run(hash);

    hitCount++;
    log.debug({ hash: hash.slice(0, 12) }, 'Cache hit');

    return { content: row.response_content, tokensUsed: row.tokens_used };
  } catch (error) {
    log.warn({ err: error }, 'Cache lookup failed');
    missCount++;
    return null;
  }
}

/**
 * Store a response in the cache.
 *
 * Triggers LRU eviction if the cache exceeds MAX_CACHE_ENTRIES.
 *
 * @param hash - Cache key hash. / キャッシュキーハッシュ
 * @param content - Response content to cache. / キャッシュするレスポンス内容
 * @param tokensUsed - Token count from the response. / レスポンスのトークン数
 * @param provider - AI provider name. / AIプロバイダー名
 * @param model - Model identifier. / モデルID
 * @param ttlMs - Time-to-live in milliseconds. / TTL（ミリ秒）
 */
export function setCachedResponse(
  hash: string,
  content: string,
  tokensUsed: number,
  provider: string,
  model: string,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  try {
    const database = getDb();

    database
      .prepare(
        `
      INSERT OR REPLACE INTO llm_cache (hash, response_content, tokens_used, provider, model, ttl_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(hash, content, tokensUsed, provider, model, ttlMs);

    // LRU eviction: delete oldest entries when cache is full.
    const count = (
      database.prepare('SELECT COUNT(*) as cnt FROM llm_cache').get() as { cnt: number }
    ).cnt;
    if (count > MAX_CACHE_ENTRIES) {
      const deleteCount = count - MAX_CACHE_ENTRIES + 100; // Delete extra 100 to avoid frequent evictions
      database
        .prepare(
          'DELETE FROM llm_cache WHERE hash IN (SELECT hash FROM llm_cache ORDER BY last_accessed_at ASC LIMIT ?)',
        )
        .run(deleteCount);
      log.info({ evicted: deleteCount }, 'Cache LRU eviction performed');
    }
  } catch (error) {
    // NOTE: Cache write failure should not block the caller.
    log.warn({ err: error }, 'Cache write failed');
  }
}

/**
 * Get cache performance statistics.
 *
 * @returns Cache statistics including hit rate and entry count. / キャッシュ統計
 */
export function getCacheStats(): CacheStats {
  try {
    const database = getDb();
    const countRow = database.prepare('SELECT COUNT(*) as cnt FROM llm_cache').get() as {
      cnt: number;
    };
    const oldestRow = database.prepare('SELECT MIN(created_at) as oldest FROM llm_cache').get() as {
      oldest: string | null;
    };
    const totalRequests = hitCount + missCount;

    return {
      totalEntries: countRow.cnt,
      totalHits: hitCount,
      totalMisses: missCount,
      hitRate: totalRequests > 0 ? hitCount / totalRequests : 0,
      oldestEntry: oldestRow.oldest,
      cacheSize: countRow.cnt,
    };
  } catch {
    return {
      totalEntries: 0,
      totalHits: hitCount,
      totalMisses: missCount,
      hitRate: 0,
      oldestEntry: null,
      cacheSize: 0,
    };
  }
}

/**
 * Purge all expired entries from the cache.
 *
 * @returns Number of entries deleted. / 削除されたエントリ数
 */
export function purgeExpiredEntries(): number {
  try {
    const database = getDb();
    const beforeCount = (
      database.prepare('SELECT COUNT(*) as cnt FROM llm_cache').get() as { cnt: number }
    ).cnt;
    database
      .prepare(
        `
      DELETE FROM llm_cache
      WHERE ttl_ms <= 0 OR (julianday('now') - julianday(created_at)) * 86400000 >= ttl_ms
    `,
      )
      .run();
    const afterCount = (
      database.prepare('SELECT COUNT(*) as cnt FROM llm_cache').get() as { cnt: number }
    ).cnt;
    const deleted = beforeCount - afterCount;
    if (deleted > 0) {
      log.info({ purged: deleted }, 'Expired cache entries purged');
    }
    return deleted;
  } catch (error) {
    log.warn({ err: error }, 'Cache purge failed');
    return 0;
  }
}

/**
 * Clear all cache entries.
 */
export function clearCache(): void {
  try {
    const database = getDb();
    database.prepare('DELETE FROM llm_cache').run();
    hitCount = 0;
    missCount = 0;
    log.info('LLM response cache cleared');
  } catch (error) {
    log.warn({ err: error }, 'Cache clear failed');
  }
}

/**
 * Close the cache database connection.
 */
export function closeCacheDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
