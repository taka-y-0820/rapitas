/**
 * prompt-comparison-alpha-ledger テスト
 *
 * 事前登録アルファ予算の性質を検証する。k の割当が冪等で再起動を跨いで保存され
 * ること、同一標本の再読み取りが評価回を消費しないこと、破損台帳を空の新規台帳
 * で上書きしないこと、そして数式そのものが総予算 5% を超えないこと。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  alphaForCandidate,
  alphaForLook,
  assignCandidateBudget,
  resolveEvaluationBudget,
  TOTAL_ALPHA,
} from './prompt-comparison-alpha-ledger';

let tmpDir: string;
let savedDataDir: string | undefined;

function ledgerPath(): string {
  return join(tmpDir, '.prompt-comparisons', '_alpha-ledger.json');
}

function writeRawLedger(contents: string): void {
  mkdirSync(join(tmpDir, '.prompt-comparisons'), { recursive: true });
  writeFileSync(ledgerPath(), contents);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-alpha-ledger-'));
  savedDataDir = process.env.RAPITAS_DATA_DIR;
  process.env.RAPITAS_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = savedDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('アルファ配分の数式（決定論的な予算上限）', () => {
  it('候補予算の総和は候補が何件増えても TOTAL_ALPHA を超えない', () => {
    let sum = 0;
    for (let k = 1; k <= 500; k++) sum += alphaForCandidate(k);
    expect(sum).toBeLessThan(TOTAL_ALPHA);
    // 望遠鏡和: sum_{k=1..N} 1/(k(k+1)) = 1 - 1/(N+1)。
    expect(sum).toBeCloseTo(TOTAL_ALPHA * (1 - 1 / 501), 12);
  });

  it('1候補の評価回予算の総和は alpha_k を超えない', () => {
    for (const k of [1, 2, 7, 50]) {
      const alphaK = alphaForCandidate(k);
      let sum = 0;
      for (let j = 1; j <= 500; j++) sum += alphaForLook(alphaK, j);
      expect(sum).toBeLessThan(alphaK);
    }
  });

  it('全候補・全評価回を合算しても TOTAL_ALPHA を超えない', () => {
    let sum = 0;
    for (let k = 1; k <= 200; k++) {
      const alphaK = alphaForCandidate(k);
      for (let j = 1; j <= 200; j++) sum += alphaForLook(alphaK, j);
    }
    expect(sum).toBeLessThan(TOTAL_ALPHA);
  });

  it('1件目・1回目の予算は 0.0125', () => {
    expect(alphaForLook(alphaForCandidate(1), 1)).toBeCloseTo(0.0125, 12);
  });
});

describe('assignCandidateBudget', () => {
  it.each([
    { nextK: 2, entries: { '10': { k: 0, lastLookJ: 0, lastLookSampleSize: 0 } } },
    { nextK: 2.5, entries: {} },
    { nextK: 2, entries: [] },
    { nextK: 2, entries: { '10': { k: 1, lastLookJ: -1, lastLookSampleSize: 0 } } },
    { nextK: 2, entries: { '10': { k: 1, lastLookJ: 1, lastLookSampleSize: 0 } } },
    { nextK: 1, entries: { '10': { k: 1, lastLookJ: 0, lastLookSampleSize: 0 } } },
    {
      nextK: 3,
      entries: {
        '10': { k: 1, lastLookJ: 0, lastLookSampleSize: 0 },
        '11': { k: 1, lastLookJ: 0, lastLookSampleSize: 0 },
      },
    },
  ])('不正な予算台帳を拒否して保存する: %j', (ledger) => {
    const raw = JSON.stringify(ledger);
    writeRawLedger(raw);
    expect(assignCandidateBudget(10)).toEqual({ issue: 'corrupted' });
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(raw);
  });

  it('初期化後に台帳が消えても予算を再発行しない', () => {
    assignCandidateBudget(10);
    rmSync(ledgerPath());
    expect(assignCandidateBudget(11)).toEqual({ issue: 'corrupted' });
  });

  it('候補ごとに単調増加する k を割り当てる', () => {
    const first = assignCandidateBudget(10);
    const second = assignCandidateBudget(11);
    expect(first).toMatchObject({ k: 1, issue: null });
    expect(second).toMatchObject({ k: 2, issue: null });
    expect((first as { alphaK: number }).alphaK).toBeCloseTo(0.025, 12);
    expect((second as { alphaK: number }).alphaK).toBeCloseTo(TOTAL_ALPHA / 6, 12);
  });

  it('再呼び出しでは k を再採番しない（再起動・再ステージングでも冪等）', () => {
    const first = assignCandidateBudget(10);
    assignCandidateBudget(11);
    // 再起動を模して、同じ永続ファイルに対してもう一度問い合わせる。
    const again = assignCandidateBudget(10);

    expect(again).toEqual(first);
    // 予算を「取り直す」ことで別のkが増えていないこと。
    const ledger = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as { nextK: number };
    expect(ledger.nextK).toBe(3);
  });

  it('破損した台帳を空の新規台帳で上書きしない', () => {
    writeRawLedger('{ broken json');
    const before = readFileSync(ledgerPath(), 'utf8');

    const result = assignCandidateBudget(10);

    expect(result).toEqual({ issue: 'corrupted' });
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(before);
  });

  it('形は JSON でも中身が台帳でなければ corrupted として保持する', () => {
    writeRawLedger(JSON.stringify({ hello: 'world' }));
    const before = readFileSync(ledgerPath(), 'utf8');

    expect(assignCandidateBudget(10)).toEqual({ issue: 'corrupted' });
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(before);
  });

  it('台帳パスが読めない場合は io_error を返す', () => {
    mkdirSync(ledgerPath(), { recursive: true });
    expect(assignCandidateBudget(10)).toEqual({ issue: 'io_error' });
  });
});

describe('resolveEvaluationBudget', () => {
  it('polling skipped checkpoints cannot enlarge the budget at n=20', () => {
    assignCandidateBudget(10);
    assignCandidateBudget(11);
    const skipped = resolveEvaluationBudget(10, 20);
    for (const n of [5, 10, 15]) resolveEvaluationBudget(11, n);
    const observed = resolveEvaluationBudget(11, 20);
    expect(skipped).toMatchObject({ j: 4, isNewLook: true });
    expect(observed).toMatchObject({ j: 4, isNewLook: true });
    expect(skipped).toMatchObject({ alphaKj: alphaForLook(alphaForCandidate(1), 4) });
    expect(observed).toMatchObject({ alphaKj: alphaForLook(alphaForCandidate(2), 4) });
  });
  it('未登録候補には予算を貸さない', () => {
    expect(resolveEvaluationBudget(999, 5)).toEqual({ issue: 'not_registered' });
  });

  it('新規標本があるときだけ評価回を進める', () => {
    assignCandidateBudget(10);

    const look1 = resolveEvaluationBudget(10, 5);
    expect(look1).toMatchObject({ isNewLook: true, j: 1, issue: null });
    expect((look1 as { alphaKj: number }).alphaKj).toBeCloseTo(0.0125, 12);

    const look2 = resolveEvaluationBudget(10, 20);
    expect(look2).toMatchObject({ isNewLook: true, j: 4 });
    expect((look2 as { alphaKj: number }).alphaKj).toBeCloseTo(0.025 / 20, 12);
  });

  it('同じ標本集合の再評価は評価回を消費しない', () => {
    assignCandidateBudget(10);
    resolveEvaluationBudget(10, 5);

    const repeat = resolveEvaluationBudget(10, 5);
    const shrunk = resolveEvaluationBudget(10, 4);

    expect(repeat).toMatchObject({ isNewLook: false, j: 1 });
    expect(shrunk).toMatchObject({ isNewLook: false, j: 1 });
    // 次に標本が増えたときは j=2 から再開する（無駄消費していない）。
    expect(resolveEvaluationBudget(10, 10)).toMatchObject({ isNewLook: true, j: 2 });
  });

  it('複数候補の j は互いに独立して進む', () => {
    assignCandidateBudget(10);
    assignCandidateBudget(11);

    resolveEvaluationBudget(10, 5);
    resolveEvaluationBudget(10, 9);
    const other = resolveEvaluationBudget(11, 5);

    expect(other).toMatchObject({ isNewLook: true, j: 1 });
    expect(resolveEvaluationBudget(10, 15)).toMatchObject({ j: 3 });
  });

  it('評価回の消費は再起動後も保持される', () => {
    assignCandidateBudget(10);
    resolveEvaluationBudget(10, 5);

    // 再起動を模して永続ファイルから読み直す。
    const ledger = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as {
      entries: Record<string, { lastLookJ: number; lastLookSampleSize: number }>;
    };
    expect(ledger.entries['10']).toMatchObject({ lastLookJ: 1, lastLookSampleSize: 5 });
    expect(resolveEvaluationBudget(10, 5)).toMatchObject({ isNewLook: false });
  });

  it('破損した台帳では評価回を進めない', () => {
    assignCandidateBudget(10);
    writeRawLedger('{ broken');
    expect(resolveEvaluationBudget(10, 5)).toEqual({ issue: 'corrupted' });
  });
});
