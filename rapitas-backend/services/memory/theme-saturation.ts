/**
 * theme-saturation
 *
 * Shared anti-monoculture gate for the idea box and concern backlog. Embedding
 * cosine (all-MiniLM-L6-v2) proved useless for Japanese near-duplicate detection
 * (novel ideas scored HIGHER than near-dups), so this uses a LEXICAL signal:
 * reject a new title that shares a long-enough substring with too many existing
 * entries of the same kind — i.e. the theme is already over-represented, or the
 * item is a near-duplicate re-file. Self-contained (no embeddings); reliable for
 * the observed monoculture where titles literally share 「型ガード」/「SSOT」/
 * 「gen:type-guards」/「Prettier」. Not responsible for creating/deleting entries.
 */
import { prisma } from '../../config/database';

/** Longest common substring length between two strings (small inputs only). */
export function lcsLen(a: string, b: string): number {
  if (!a || !b) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = diag + 1;
        if (prev[j] > best) best = prev[j];
      } else prev[j] = 0;
      diag = tmp;
    }
  }
  return best;
}

/**
 * Character-bigram set of a title, normalised (lowercased, whitespace/punctuation
 * stripped) so spacing and delimiter noise don't perturb the overlap. Character
 * bigrams work for Japanese where word-tokenisation and embeddings do not.
 *
 * @param s - Source title. / 元タイトル
 * @returns Set of 2-character shingles. / 2文字シングルの集合
 */
export function charBigrams(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/[\s　-〿＀-￯!-/:-@[-`{-~、-〜「」（）・]/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) grams.add(norm.slice(i, i + 2));
  return grams;
}

/** Jaccard similarity of two titles' character-bigram sets (0..1). */
export function bigramJaccard(a: string, b: string): number {
  const A = charBigrams(a);
  const B = charBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * Find an existing OPEN entry that is a NEAR-DUPLICATE of `title` (character-bigram
 * Jaccard ≥ threshold), or null. Complements findSaturatedTheme: the saturation
 * gate caps how many same-THEME items may coexist, while this rejects an almost-
 * IDENTICAL re-file (e.g. the idea-extractor emitting "コマンド型ゲートの実体取り込み
 * (SSOT/型ガード/…)" three times). A HIGH threshold (~0.6) catches only near-clones
 * and leaves distinct facets of one theme admittable, so it does not over-reject.
 *
 * @param title - Candidate title. / 候補タイトル
 * @param opts - Pool selector. / 対象プール
 * @param threshold - Min bigram-Jaccard counting as a near-duplicate. / 近重複とみなす最小Jaccard
 * @returns Existing near-duplicate id, else null. / 近重複のID、無ければ null
 */
export async function findNearDuplicate(
  title: string,
  opts: Pick<SaturationOptions, 'sourceType' | 'openConcernOnly'>,
  threshold: number,
): Promise<number | null> {
  if (title.trim().length < 6) return null;
  const where: { sourceType: string; sourceId?: string; forgettingStage?: string } = {
    sourceType: opts.sourceType,
  };
  if (opts.openConcernOnly) {
    where.sourceId = 'open';
    where.forgettingStage = 'active'; // Match the visible/actionable concern backlog.
  }
  const rows = await prisma.knowledgeEntry
    .findMany({ where, select: { id: true, title: true }, take: 600 })
    .catch(() => [] as { id: number; title: string }[]);
  for (const e of rows) {
    if (bigramJaccard(title, e.title) >= threshold) return e.id;
  }
  return null;
}

/** Options selecting which KB entries form the saturation pool and the thresholds. */
export interface SaturationOptions {
  /** KnowledgeEntry.sourceType to scan (e.g. 'idea_box' | 'concern'). */
  sourceType: string;
  /** Reject once this many existing entries share a salient substring. */
  cap: number;
  /** Minimum shared-substring length that counts as "same theme". */
  salient: number;
  /** When true, restrict the pool to OPEN concerns (sourceId='open'). */
  openConcernOnly?: boolean;
}

/**
 * Find an existing entry that anchors an over-represented theme for `title`, or
 * null when the title is novel enough to admit. Returns the first matching id so
 * callers can treat a hit as a no-op dedup (point at the existing item).
 *
 * @param title - Candidate entry title. / 候補タイトル
 * @param opts - Pool + thresholds. / 対象プールと閾値
 * @returns Anchor id when saturated, else null. / 飽和時はID、それ以外 null
 */
/**
 * Bracketed markers carried by nearly every filed title — `[Bug]`, `[Idea]`,
 * `[自己検出]`, `[ログ:ERROR]`, `[回顧]` and friends.
 *
 * They say what KIND of row this is, never what it is ABOUT, so they must not
 * count as shared theme. Measured 2026-08-27: `[Bug]` is exactly five
 * characters, the salient length for concerns, and 23 open concerns carried it
 * — so every new `[Bug] …` concern tripped the cap of 3 on that marker alone
 * and was silently dropped while the caller was told it had been filed.
 */
const TITLE_MARKER_RE = /\[[^\]]{0,24}\]/g;

/**
 * Strip format markers so the saturation scan compares subject matter.
 *
 * @param title - Raw title. / 生のタイトル
 * @returns The title with bracketed markers removed. / マーカー除去後のタイトル
 */
export function stripTitleMarkers(title: string): string {
  return title.replace(TITLE_MARKER_RE, ' ').replace(/\s+/g, ' ').trim();
}

export async function findSaturatedTheme(
  title: string,
  opts: SaturationOptions,
): Promise<number | null> {
  const { sourceType, cap, salient, openConcernOnly } = opts;
  const subject = stripTitleMarkers(title);
  if (subject.length < salient) return null;
  const where: { sourceType: string; sourceId?: string; forgettingStage?: string } = { sourceType };
  if (openConcernOnly) {
    where.sourceId = 'open';
    where.forgettingStage = 'active'; // Archived rows must not swallow new reports.
  }
  const rows = await prisma.knowledgeEntry
    .findMany({ where, select: { id: true, title: true }, take: 600 })
    .catch(() => [] as { id: number; title: string }[]);
  let matches = 0;
  let anchor: number | null = null;
  for (const e of rows) {
    if (lcsLen(subject, stripTitleMarkers(e.title)) >= salient) {
      matches += 1;
      anchor = anchor ?? e.id;
      if (matches >= cap) return anchor;
    }
  }
  return null;
}
