/**
 * theme-saturation ユニットテスト
 *
 * lcsLen と findSaturatedTheme（idea/concern 共通の anti-monoculture ゲート）を検証。
 */
import { describe, expect, mock, test } from 'bun:test';

let pool: Array<{ id: number; title: string; forgettingStage?: string }> = [];
let lastWhere: Record<string, unknown> | null = null;
mock.module('../../config/database', () => ({
  prisma: {
    knowledgeEntry: {
      findMany: ({ where }: { where: Record<string, unknown> }) => {
        lastWhere = where;
        return Promise.resolve(
          pool.filter(
            (row) =>
              !where.forgettingStage || (row.forgettingStage ?? 'active') === where.forgettingStage,
          ),
        );
      },
    },
  },
}));

const {
  lcsLen,
  findSaturatedTheme,
  charBigrams,
  bigramJaccard,
  findNearDuplicate,
  stripTitleMarkers,
} = await import('./theme-saturation');

describe('lcsLen', () => {
  test('共通部分文字列の最長長を返す', () => {
    expect(
      lcsLen('gen:type-guards の Prettier 同期', 'gen:type-guards が Prettier 非互換'),
    ).toBeGreaterThanOrEqual(8);
    expect(lcsLen('freee OCR 仕訳', '通知音の設定')).toBeLessThan(4);
  });
});

describe('bigramJaccard / charBigrams', () => {
  test('正規化で空白・区切りを無視する', () => {
    expect([...charBigrams('a b-c')]).toEqual(['ab', 'bc']);
  });
  test('同一タイトルは 1.0', () => {
    expect(bigramJaccard('型ガード生成のCI組み込み', '型ガード生成のCI組み込み')).toBe(1);
  });
  test('カタカナ揺れのクローンは高スコア（≥0.45）', () => {
    // The exact near-clone the extractor keeps re-filing — caught at 0.45.
    const s = bigramJaccard(
      'コマンド型ゲートの実体取り込み（SSOT/型ガード/クリティカルガード）',
      'コマンド型ゲートの実装（SSOT/型ガード/クリティカルガード）',
    );
    expect(s).toBeGreaterThanOrEqual(0.45);
  });
  test('同一テーマの別ファセットは低スコア（<0.45・過剰拒否しない）', () => {
    const s = bigramJaccard(
      'Jaccard閾値の動的調整・学習機構',
      'ドキュメント構造ガイドの自動生成・保守',
    );
    expect(s).toBeLessThan(0.45);
  });
  test('空文字は 0', () => {
    expect(bigramJaccard('', 'abc')).toBe(0);
  });
});

describe('findNearDuplicate', () => {
  test('archived concern cannot swallow a new filing, but an active duplicate still can', async () => {
    pool = [
      { id: 77, title: 'Codex command execution output is missing', forgettingStage: 'archived' },
    ];
    const options = { sourceType: 'concern', openConcernOnly: true };
    expect(await findNearDuplicate(pool[0].title, options, 0.45)).toBeNull();
    pool[0].forgettingStage = 'active';
    expect(await findNearDuplicate(pool[0].title, options, 0.45)).toBe(77);
  });
  test('閾値以上の近重複が存在 → その id を返す', async () => {
    pool = [
      { id: 21, title: 'ゲート登録APIの宣言的・汎用フレームワーク化' },
      { id: 22, title: 'コマンド型ゲートの実体取り込み（SSOT/型ガード/クリティカルガード）' },
    ];
    const r = await findNearDuplicate(
      'コマンド型ゲートの実装（SSOT/型ガード/クリティカルガード）',
      { sourceType: 'idea_box' },
      0.45,
    );
    expect(r).toBe(22);
  });
  test('近重複が無ければ null（別ファセットは通す）', async () => {
    pool = [
      { id: 31, title: 'Jaccard閾値の動的調整・学習機構' },
      { id: 32, title: 'docs/ 健全性ゲートを ci-gates.ts に組み込み定期検証化' },
    ];
    const r = await findNearDuplicate(
      'ドキュメント構造ガイドの自動生成・保守',
      { sourceType: 'idea_box' },
      0.45,
    );
    expect(r).toBeNull();
  });
});

describe('findSaturatedTheme', () => {
  test('hidden concerns do not saturate the visible backlog', async () => {
    pool = Array.from({ length: 3 }, (_, id) => ({
      id,
      title: `Codex process runner repair ${id}`,
      forgettingStage: 'archived',
    }));
    pool.push({ id: 100, title: 'Codex process runner output', forgettingStage: 'active' });
    const options = { sourceType: 'concern', openConcernOnly: true, cap: 3, salient: 8 };
    expect(await findSaturatedTheme('Codex process runner events', options)).toBeNull();
    pool.push({ id: 101, title: 'Codex process runner timing', forgettingStage: 'active' });
    pool.push({ id: 102, title: 'Codex process runner errors', forgettingStage: 'active' });
    expect(await findSaturatedTheme('Codex process runner events', options)).toBe(100);
  });
  test('CAP件以上が salient 部分文字列を共有 → anchor id を返す（飽和）', async () => {
    pool = Array.from({ length: 3 }, (_, i) => ({
      id: 10 + i,
      title: `gen:type-guards の Prettier 整形 ${i}`,
    }));
    const r = await findSaturatedTheme('gen:type-guards の Prettier 同期メカニズム', {
      sourceType: 'concern',
      cap: 3,
      salient: 8,
      openConcernOnly: true,
    });
    expect(r).toBe(10);
    expect(lastWhere).toEqual({
      sourceType: 'concern',
      sourceId: 'open',
      forgettingStage: 'active',
    });
  });

  test('新規テーマ（共有なし）→ null（許可）', async () => {
    pool = Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, title: `gen:type-guards ${i}` }));
    const r = await findSaturatedTheme('freeeレシートOCRの自動仕訳プレビュー機能', {
      sourceType: 'idea_box',
      cap: 8,
      salient: 4,
    });
    expect(r).toBeNull();
  });

  test('CAP未満なら許可', async () => {
    pool = [
      { id: 10, title: 'gen:type-guards の Prettier 整形 A' },
      { id: 11, title: 'gen:type-guards の Prettier 整形 B' },
    ];
    const r = await findSaturatedTheme('gen:type-guards の Prettier 同期', {
      sourceType: 'concern',
      cap: 3,
      salient: 8,
    });
    expect(r).toBeNull(); // only 2 < cap 3
  });
});

describe('書式マーカーは同一テーマとみなさない', () => {
  test('角括弧のマーカーを除去する', () => {
    expect(stripTitleMarkers('[Bug] 登録ポイントが競合する')).toBe('登録ポイントが競合する');
    expect(stripTitleMarkers('[ログ:ERROR] git command failed')).toBe('git command failed');
    expect(stripTitleMarkers('[自己検出] 停滞: 放置される')).toBe('停滞: 放置される');
  });

  test('[Bug] を共有するだけでは飽和と判定しない', async () => {
    // 実測 2026-08-27: [Bug] はちょうど5文字（懸念の salient 長）で、開いている
    // 懸念23件が保持していた。そのため新しい [Bug] 懸念はマーカーだけで cap=3 を
    // 越え、呼び出し側には success を返しながら無言で捨てられていた。
    pool = [
      { id: 1, title: '[Bug] まったく別の話題A' },
      { id: 2, title: '[Bug] まったく別の話題B' },
      { id: 3, title: '[Bug] まったく別の話題C' },
      { id: 4, title: '[Bug] まったく別の話題D' },
    ];

    const anchor = await findSaturatedTheme('[Bug] 登録ポイントが必ず競合する', {
      sourceType: 'concern',
      cap: 3,
      salient: 5,
      openConcernOnly: true,
    });

    expect(anchor).toBeNull();
  });

  test('本文が本当に重なっていれば従来どおり飽和と判定する', async () => {
    pool = [
      { id: 11, title: '[Bug] 境界値テスト自動生成が壊れる' },
      { id: 12, title: '[Idea] 境界値テスト自動生成の改善' },
      { id: 13, title: '[改善] 境界値テスト自動生成の整理' },
    ];

    const anchor = await findSaturatedTheme('[Bug] 境界値テスト自動生成をやり直す', {
      sourceType: 'concern',
      cap: 3,
      salient: 5,
      openConcernOnly: true,
    });

    expect(anchor).toBe(11);
  });
});
