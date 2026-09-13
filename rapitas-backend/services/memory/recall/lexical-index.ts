/**
 * lexical-index
 *
 * Character-bigram / IDF lexical recall channel for the knowledge base. The
 * embedding model in use is English-only, so Japanese task queries never clear
 * the cosine floor; bigram overlap is the technique already proven on this
 * corpus for dedup (see ../text-similarity.ts), here weighted by IDF so common
 * particles (「する」「して」…) stop dominating the score. Holds an in-memory,
 * TTL-cached index of every non-rejected entry; stage / theme / category are
 * kept per document and filtered at query time.
 *
 * NOT responsible for ranking fusion (rank-fusion.ts) or for deciding which
 * stages are eligible (recall-config.ts).
 */
import { prisma } from '../../../config/database';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { createLogger } from '../../../config/logger';
import { normalizeForMatch } from '../text-similarity';
import { getRecallConfig } from './recall-config';
import type { ForgettingStage } from '../types';

const log = createLogger('memory:recall:lexical-index');

/** Content chars folded into a document's bigram set (title is always whole). */
const DOC_CONTENT_CHARS = 400;
/** Query chars beyond the title folded into the query bigram set. */
const QUERY_CHARS = 600;

/** Same trust weights as the vector channel (rag/search.ts) so both agree. */
const TRUST_WEIGHT: Record<string, number> = { validated: 1.25, pending: 1.0, conflict: 0.5 };

/** Raw KB row the index is built from. */
export interface LexicalRow {
  id: number;
  title: string;
  content: string;
  forgettingStage: string;
  validationStatus: string;
  themeId: number | null;
  category: string;
}

/** One indexed document: sorted, de-duplicated bigram codes + filter columns. */
export interface LexicalDoc {
  id: number;
  codes: Int32Array;
  forgettingStage: string;
  validationStatus: string;
  themeId: number | null;
  category: string;
}

/** The searchable index. */
export interface LexicalIndex {
  docs: LexicalDoc[];
  /** bigram code → idf. Absent code = seen in no document. */
  idf: Map<number, number>;
  /** idf assigned to a query bigram that appears in no document (df = 0). */
  unseenIdf: number;
  docCount: number;
  builtAt: number;
}

/** A lexical hit. `score` is coverage (0..1); `rankScore` folds trust + stage weight. */
export interface LexicalHit {
  id: number;
  score: number;
  rankScore: number;
}

/** Options for {@link lexicalSearch}. */
export interface LexicalSearchOptions {
  limit?: number;
  minScore?: number;
  stages?: ForgettingStage[];
  stageWeights?: Partial<Record<ForgettingStage, number>>;
  themeId?: number;
  category?: string;
  /** Text that has already been normalized/truncated by the caller. */
  queryIsPrepared?: boolean;
}

/**
 * Encode a text as a sorted, de-duplicated array of character-bigram codes.
 * Each bigram packs two UTF-16 code units into one int32 so the whole corpus
 * fits in typed arrays (≈ 8 MB for 6k entries) and intersections are a merge.
 *
 * @param text - Raw text (normalized here). / 生テキスト
 * @returns Sorted unique bigram codes. / ソート済みユニーク bigram 符号
 */
export function toBigramCodes(text: string): Int32Array {
  const s = normalizeForMatch(text);
  if (s.length < 2) return new Int32Array(0);
  const set = new Set<number>();
  for (let i = 0; i < s.length - 1; i++) {
    set.add((s.charCodeAt(i) << 16) | s.charCodeAt(i + 1) | 0);
  }
  const arr = Int32Array.from(set);
  arr.sort();
  return arr;
}

/** BM25-style smoothed idf; df = 0 yields the maximum. */
function idfOf(docCount: number, df: number): number {
  return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
}

/**
 * Build the index from KB rows. Pure — no I/O.
 *
 * @param rows - Non-rejected knowledge rows. / 索引対象行
 * @returns The index. / 索引
 */
export function buildLexicalIndex(rows: LexicalRow[]): LexicalIndex {
  const steps = buildIndexSteps(rows);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Same index as the pure builder, with I/O turns between bounded batches. */
export async function buildLexicalIndexAsync(rows: LexicalRow[]): Promise<LexicalIndex> {
  const steps = buildIndexSteps(rows);
  let step = steps.next();
  while (!step.done) {
    await yieldToIO();
    step = steps.next();
  }
  return step.value;
}

function* buildIndexSteps(rows: LexicalRow[]): Generator<void, LexicalIndex> {
  const df = new Map<number, number>();
  const docs: LexicalDoc[] = [];
  for (const r of rows) {
    const codes = toBigramCodes(`${r.title} ${r.content.slice(0, DOC_CONTENT_CHARS)}`);
    for (const g of codes) df.set(g, (df.get(g) ?? 0) + 1);
    docs.push({
      id: r.id,
      codes,
      forgettingStage: r.forgettingStage,
      validationStatus: r.validationStatus,
      themeId: r.themeId,
      category: r.category,
    });
    if (docs.length % 32 === 0) yield;
  }
  const docCount = docs.length;
  const idf = new Map<number, number>();
  for (const [g, n] of df) {
    idf.set(g, idfOf(docCount, n));
    if (idf.size % 2048 === 0) yield;
  }
  return { docs, idf, unseenIdf: idfOf(docCount, 0), docCount, builtAt: Date.now() };
}

/**
 * Coverage score: share of the query's idf mass that the document covers.
 *
 * @param queryCodes - Sorted query bigram codes. / クエリ bigram
 * @param docCodes - Sorted document bigram codes. / 文書 bigram
 * @param idf - Bigram → idf. / idf 表
 * @param unseenIdf - idf for query bigrams absent from the corpus (0 = ignore them). / 未出現 bigram の idf
 * @returns Score in 0..1. / スコア
 */
export function scoreDocument(
  queryCodes: Int32Array,
  docCodes: Int32Array,
  idf: Map<number, number>,
  unseenIdf = 0,
): number {
  let denom = 0;
  for (const g of queryCodes) denom += idf.get(g) ?? unseenIdf;
  if (denom === 0) return 0;
  let covered = 0;
  let i = 0;
  let j = 0;
  while (i < queryCodes.length && j < docCodes.length) {
    const a = queryCodes[i];
    const b = docCodes[j];
    if (a === b) {
      covered += idf.get(a) ?? 0;
      i++;
      j++;
    } else if (a < b) {
      i++;
    } else {
      j++;
    }
  }
  return covered / denom;
}

let cache: LexicalIndex | null = null;
let inflight: Promise<LexicalIndex> | null = null;

/**
 * Load every non-rejected entry and (re)build the index; cached for the TTL.
 * Concurrent callers share one build.
 *
 * @returns The current index. / 現在の索引
 */
export async function getLexicalIndex(): Promise<LexicalIndex> {
  const ttl = getRecallConfig().lexicalIndexTtlMs;
  if (cache && Date.now() - cache.builtAt < ttl) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const started = Date.now();
    const rows = await prisma.knowledgeEntry.findMany({
      where: { validationStatus: { not: 'rejected' } },
      select: {
        id: true,
        title: true,
        content: true,
        forgettingStage: true,
        validationStatus: true,
        themeId: true,
        category: true,
      },
      orderBy: { id: 'asc' },
    });
    const built = await buildLexicalIndexAsync(rows);
    cache = built;
    log.info(
      { docs: built.docCount, bigrams: built.idf.size, ms: Date.now() - started },
      '[lexical-index] rebuilt',
    );
    return built;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Drop the cached index (call after a knowledge write so new entries are searchable). */
export function invalidateLexicalIndex(): void {
  cache = null;
}

/**
 * Prepare a recall query for the lexical channel: title whole + first
 * QUERY_CHARS of the remainder, so long descriptions do not dilute coverage.
 *
 * @param query - `title\ndescription` style text. / クエリ
 * @returns Truncated query text. / 切詰め済みクエリ
 */
export function prepareLexicalQuery(query: string): string {
  const nl = query.indexOf('\n');
  if (nl < 0) return query.slice(0, QUERY_CHARS);
  return `${query.slice(0, nl)} ${query.slice(nl + 1, nl + 1 + QUERY_CHARS)}`;
}

/**
 * Search the lexical index.
 *
 * @param query - Query text. / クエリ
 * @param options - Limit, floor, stage / theme / category filters, weights. / 検索オプション
 * @returns Hits sorted by rankScore desc, id asc. / ヒット一覧
 */
export async function lexicalSearch(
  query: string,
  options: LexicalSearchOptions = {},
): Promise<LexicalHit[]> {
  const cfg = getRecallConfig();
  const {
    limit = cfg.maxEntries,
    minScore = cfg.lexicalMinScore,
    stages = cfg.stages,
    stageWeights = cfg.stageWeights,
    themeId,
    category,
    queryIsPrepared = false,
  } = options;
  const queryCodes = toBigramCodes(queryIsPrepared ? query : prepareLexicalQuery(query));
  if (queryCodes.length === 0) return [];

  const index = await getLexicalIndex();
  const stageSet = new Set<string>(stages);
  const hits: LexicalHit[] = [];
  let scanned = 0;
  for (const doc of index.docs) {
    if (++scanned % 64 === 0) await yieldToIO();
    if (!stageSet.has(doc.forgettingStage)) continue;
    if (themeId !== undefined && doc.themeId !== themeId) continue;
    if (category !== undefined && doc.category !== category) continue;
    const score = scoreDocument(queryCodes, doc.codes, index.idf, index.unseenIdf);
    if (score < minScore || score <= 0) continue;
    const stageW = stageWeights[doc.forgettingStage as ForgettingStage] ?? 1;
    hits.push({
      id: doc.id,
      score,
      rankScore: score * (TRUST_WEIGHT[doc.validationStatus] ?? 1) * stageW,
    });
  }
  hits.sort((a, b) => b.rankScore - a.rankScore || a.id - b.id);
  return hits.slice(0, limit);
}
