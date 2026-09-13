/**
 * lexical-index テスト
 *
 * bigram 符号化・idf・日本語関連文書の順位・一般語文書の低スコア・
 * stage/theme フィルタ・minScore・TTL キャッシュ・id タイブレークを検証する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

type Row = {
  id: number;
  title: string;
  content: string;
  forgettingStage: string;
  validationStatus: string;
  themeId: number | null;
  category: string;
};

let rows: Row[] = [];
let findManyCalls = 0;

mock.module('../../../config/database', () => ({
  prisma: {
    knowledgeEntry: {
      findMany: () => {
        findManyCalls += 1;
        return Promise.resolve(rows);
      },
    },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
}));
const noopLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
mock.module('../../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
}));

const {
  toBigramCodes,
  buildLexicalIndex,
  buildLexicalIndexAsync,
  getLexicalIndex,
  scoreDocument,
  lexicalSearch,
  invalidateLexicalIndex,
  prepareLexicalQuery,
} = await import('./lexical-index');
const { resetRecallConfigCache } = await import('./recall-config');

function row(over: Partial<Row>): Row {
  return {
    id: 1,
    title: '',
    content: '',
    forgettingStage: 'active',
    validationStatus: 'pending',
    themeId: null,
    category: 'general',
    ...over,
  };
}

beforeEach(() => {
  rows = [];
  findManyCalls = 0;
  invalidateLexicalIndex();
  resetRecallConfigCache();
});

test('cooperative building preserves all documents and IDF while allowing I/O', async () => {
  rows = Array.from({ length: 512 }, (_, id) =>
    row({ id, title: `task ${id}`, content: '検索対象文書'.repeat(80) }),
  );
  const expected = buildLexicalIndex(rows);
  let ioRan = false;
  setImmediate(() => {
    ioRan = true;
  });
  const actual = await buildLexicalIndexAsync(rows);
  expect(ioRan).toBe(true);
  expect(actual.docs).toEqual(expected.docs);
  expect(actual.idf).toEqual(expected.idf);
  expect(actual.unseenIdf).toBe(expected.unseenIdf);
});

test('concurrent callers share one complete index across cooperative yields', async () => {
  rows = Array.from({ length: 256 }, (_, id) => row({ id, title: `task ${id}` }));
  const [a, b] = await Promise.all([getLexicalIndex(), getLexicalIndex()]);
  expect(a).toBe(b);
  expect(a.docCount).toBe(256);
  expect(findManyCalls).toBe(1);
});

test('cached corpus search allows I/O without changing deterministic hit order', async () => {
  rows = Array.from({ length: 256 }, (_, id) => row({ id, title: 'matching task' }));
  await getLexicalIndex();
  let ioRan = false;
  setImmediate(() => {
    ioRan = true;
  });
  const hits = await lexicalSearch('matching task', { minScore: 0, limit: 3 });
  expect(ioRan).toBe(true);
  expect(hits.map((hit) => hit.id)).toEqual([0, 1, 2]);
});

describe('toBigramCodes', () => {
  test('正規化後の連続2文字をユニーク・昇順で符号化する', () => {
    const codes = toBigramCodes('abab');
    // "ab","ba" → 2 unique bigrams, sorted ascending.
    expect(codes.length).toBe(2);
    expect(codes[0]).toBeLessThan(codes[1]);
  });

  test('1文字以下は空', () => {
    expect(toBigramCodes('a').length).toBe(0);
    expect(toBigramCodes('').length).toBe(0);
  });
});

describe('buildLexicalIndex / scoreDocument', () => {
  test('全文書に現れる bigram より希少な bigram の idf が高い', () => {
    const index = buildLexicalIndex([
      row({ id: 1, title: 'ワークフロー', content: '' }),
      row({ id: 2, title: 'ワークフロー', content: '' }),
      row({ id: 3, title: '埋め込み', content: '' }),
    ]);
    const common = toBigramCodes('ワー')[0];
    const rare = toBigramCodes('埋め')[0];
    expect(index.idf.get(rare)!).toBeGreaterThan(index.idf.get(common)!);
  });

  test('完全一致文書はスコア 1、無関係文書は 0', () => {
    const index = buildLexicalIndex([row({ id: 1, title: 'PR競合', content: '' })]);
    const q = toBigramCodes('PR競合');
    expect(scoreDocument(q, index.docs[0].codes, index.idf)).toBeCloseTo(1, 10);
    expect(scoreDocument(toBigramCodes('無関係'), index.docs[0].codes, index.idf)).toBe(0);
  });

  test('未出現 bigram を分母に含めるとスコアが下がる', () => {
    const index = buildLexicalIndex([row({ id: 1, title: 'PR競合', content: '' })]);
    const q = toBigramCodes('PR競合と別語');
    const excl = scoreDocument(q, index.docs[0].codes, index.idf, 0);
    const incl = scoreDocument(q, index.docs[0].codes, index.idf, index.unseenIdf);
    expect(incl).toBeLessThan(excl);
  });
});

describe('lexicalSearch', () => {
  test('日本語クエリで関連文書が上位、一般語だけの文書は低スコア', async () => {
    rows = [
      row({
        id: 1,
        title: 'ワークフローの質問待ち状態が消える',
        content: 'question.md 保存後に状態が戻る',
      }),
      row({ id: 2, title: 'することにしている', content: 'することにしている' }),
      row({ id: 3, title: 'Prisma schema migration', content: 'db push' }),
    ];
    const hits = await lexicalSearch('ワークフローの質問待ち状態が消える', { minScore: 0 });
    expect(hits[0].id).toBe(1);
    const general = hits.find((h) => h.id === 2);
    expect(general === undefined || general.score < hits[0].score / 4).toBe(true);
  });

  test('minScore 未満は除外される', async () => {
    rows = [
      row({ id: 1, title: 'ワークフロー', content: '' }),
      row({ id: 2, title: 'ワーク', content: '' }),
    ];
    const hits = await lexicalSearch('ワークフロー', { minScore: 0.99 });
    expect(hits.map((h) => h.id)).toEqual([1]);
  });

  test('stages / themeId / category でフィルタされる', async () => {
    rows = [
      row({ id: 1, title: 'ワークフロー', forgettingStage: 'archived', themeId: 1 }),
      row({ id: 2, title: 'ワークフロー', forgettingStage: 'active', themeId: 2 }),
      row({ id: 3, title: 'ワークフロー', forgettingStage: 'active', themeId: 1, category: 'x' }),
    ];
    expect(
      (await lexicalSearch('ワークフロー', { stages: ['active'], minScore: 0 })).map((h) => h.id),
    ).toEqual([2, 3]);
    // archived id 1 ranks below active id 3 (stage weight), so compare as a set.
    expect(
      (await lexicalSearch('ワークフロー', { themeId: 1, minScore: 0 })).map((h) => h.id).sort(),
    ).toEqual([1, 3]);
    expect(
      (await lexicalSearch('ワークフロー', { category: 'x', minScore: 0 })).map((h) => h.id),
    ).toEqual([3]);
  });

  test('同スコアは stage 重み → id 昇順で順位付け', async () => {
    rows = [
      row({ id: 9, title: 'ワークフロー', forgettingStage: 'archived' }),
      row({ id: 4, title: 'ワークフロー', forgettingStage: 'active' }),
      row({ id: 5, title: 'ワークフロー', forgettingStage: 'active' }),
    ];
    const hits = await lexicalSearch('ワークフロー', { minScore: 0 });
    expect(hits.map((h) => h.id)).toEqual([4, 5, 9]);
    expect(hits[2].rankScore).toBeLessThan(hits[0].rankScore);
  });

  test('TTL 内は DB を再取得せず、invalidate 後に再構築する', async () => {
    rows = [row({ id: 1, title: 'ワークフロー' })];
    await lexicalSearch('ワークフロー', { minScore: 0 });
    await lexicalSearch('ワークフロー', { minScore: 0 });
    expect(findManyCalls).toBe(1);
    invalidateLexicalIndex();
    await lexicalSearch('ワークフロー', { minScore: 0 });
    expect(findManyCalls).toBe(2);
  });

  test('空クエリは索引を読まずに空配列', async () => {
    expect(await lexicalSearch('')).toEqual([]);
    expect(findManyCalls).toBe(0);
  });
});

describe('prepareLexicalQuery', () => {
  test('タイトル全体 + 説明の先頭 600 字に切り詰める', () => {
    const q = prepareLexicalQuery(`title\n${'x'.repeat(1000)}`);
    expect(q.startsWith('title ')).toBe(true);
    expect(q.length).toBe('title '.length + 600);
  });
});
