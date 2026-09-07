/**
 * prompt-comparison-alpha-spending.simulation テスト
 *
 * 帰無仮説下（両アームとも真の成功率が同一）で、実際の予算台帳と Fisher 検定を
 * 通した疑似候補がどれだけ誤って採用されるかを実測する。数式上の上限は
 * prompt-comparison-alpha-ledger.test.ts が決定論的に検証しており、本試験は
 * 実装チェーンが実際にその上限どおり機能するかのサニティチェック。
 *
 * 乱数は固定シードの決定論的 PRNG（mulberry32）を使う。Math.random を使うと
 * 再実行のたびに結果が変わり、境界付近で偶発的に落ちるテストになる。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { passesSequentialSignificance } from './prompt-comparison-adoption-gate';
import {
  alphaForCandidate,
  assignCandidateBudget,
  resolveEvaluationBudget,
  TOTAL_ALPHA,
} from './prompt-comparison-alpha-ledger';

/** Deterministic 32-bit PRNG so a rerun reproduces the same trial sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let tmpDir: string;
let savedDataDir: string | undefined;

let replication = 0;

/** Each simulated family has independent storage, like a separate deployment. */
function resetLedger(): void {
  process.env.RAPITAS_DATA_DIR = join(tmpDir, `family-${++replication}`);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-alpha-sim-'));
  savedDataDir = process.env.RAPITAS_DATA_DIR;
  process.env.RAPITAS_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = savedDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Draw `n` Bernoulli(p) outcomes and return how many succeeded. */
function drawSuccesses(rng: () => number, n: number, p: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) if (rng() < p) s++;
  return s;
}

/**
 * Run one candidate end-to-end through the real ledger and the real test:
 * several looks at a growing sample.
 *
 * @returns True when the candidate was adopted at some look. / いずれかのlookで採用されたら true
 */
function runCandidate(
  rng: () => number,
  candidateId: number,
  currentRate: number,
  candidateRate: number,
  addedPerLook: number[],
): boolean {
  const budget = assignCandidateBudget(candidateId);
  if (budget.issue) throw new Error(`ledger unusable: ${budget.issue}`);

  const current: number[] = [];
  const candidate: number[] = [];

  for (const added of addedPerLook) {
    for (let i = 0; i < added; i++) current.push(drawSuccesses(rng, 1, currentRate));
    for (let i = 0; i < added; i++) candidate.push(drawSuccesses(rng, 1, candidateRate));
    const look = resolveEvaluationBudget(candidateId, Math.min(current.length, candidate.length));
    if (look.issue) throw new Error(`ledger unusable: ${look.issue}`);
    if (!look.isNewLook) continue;

    const currentTotal = look.sampleSize;
    const candidateTotal = look.sampleSize;
    const currentSuccess = current.slice(0, look.sampleSize).reduce((a, b) => a + b, 0);
    const candidateSuccess = candidate.slice(0, look.sampleSize).reduce((a, b) => a + b, 0);
    const adopted = passesSequentialSignificance(
      {
        currentSuccessCount: currentSuccess,
        currentFailureCount: currentTotal - currentSuccess,
        candidateSuccessCount: candidateSuccess,
        candidateFailureCount: candidateTotal - candidateSuccess,
      },
      look.alphaKj,
    );
    if (adopted) return true;
  }
  return false;
}

describe('誤採用率（帰無仮説下のモンテカルロ）', () => {
  it('固定シードのk=1・3回評価で観測誤採用率が alpha_1 未満', () => {
    // 監督が示した数値例と同じ帰無条件: 両アームとも真の成功率0.7。
    // 各複製は台帳をリセットして k=1 から始める = 予算が最も緩い最悪ケース。
    const rng = mulberry32(0x894a1);
    const REPLICATIONS = 600;
    let falseAdoptions = 0;

    for (let r = 0; r < REPLICATIONS; r++) {
      resetLedger();
      if (runCandidate(rng, 1, 0.7, 0.7, [10, 10, 10])) falseAdoptions++;
    }

    const rate = falseAdoptions / REPLICATIONS;
    // 0.116は旧ゲートの単回の厳密計算値で、反復試験の比較対象ではない。
    // 有限回のシミュレーションは実運用の誤採用率上限の証明ではない。
    console.log(
      JSON.stringify({
        scenario: 'null-3-looks',
        falseAdoptions,
        replications: REPLICATIONS,
        rate,
      }),
    );
    // PRNG が固定シードなので値は再実行しても一致する（フレークしない）。
    expect(rate).toBeLessThan(alphaForCandidate(1));
    expect(rate).toBeLessThan(TOTAL_ALPHA);
  }, 120_000);

  it('固定シードのk=1・10回評価で観測誤採用率が alpha_1 未満', () => {
    const rng = mulberry32(0x894a2);
    const REPLICATIONS = 400;
    const looks = Array.from({ length: 10 }, () => 6);
    let falseAdoptions = 0;

    for (let r = 0; r < REPLICATIONS; r++) {
      resetLedger();
      if (runCandidate(rng, 1, 0.5, 0.5, looks)) falseAdoptions++;
    }

    // 上の試験とは帰無成功率も異なるため、数値差から監視頻度の効果を推定しない。
    console.log(
      JSON.stringify({ scenario: 'null-10-looks', falseAdoptions, replications: REPLICATIONS }),
    );
    expect(falseAdoptions / REPLICATIONS).toBeLessThan(alphaForCandidate(1));
  }, 120_000);

  it('固定シードの10候補・150系列で観測した族誤採用率が5%未満', () => {
    // 1複製 = 「10候補が順に登録され、それぞれ3回評価される」1つの運用系列。
    // そのうち1件でも誤採用されれば族としての失敗と数える（family-wise）。
    const rng = mulberry32(0x894a3);
    const REPLICATIONS = 150;
    const CANDIDATES_PER_FAMILY = 10;
    let familiesWithFalseAdoption = 0;

    for (let r = 0; r < REPLICATIONS; r++) {
      resetLedger();
      let anyAdopted = false;
      for (let i = 1; i <= CANDIDATES_PER_FAMILY; i++) {
        if (runCandidate(rng, i, 0.7, 0.7, [10, 10, 10])) anyAdopted = true;
      }
      if (anyAdopted) familiesWithFalseAdoption++;
    }

    console.log(
      JSON.stringify({
        scenario: 'null-10-candidate-family',
        familiesWithFalseAdoption,
        replications: REPLICATIONS,
      }),
    );
    expect(familiesWithFalseAdoption / REPLICATIONS).toBeLessThan(TOTAL_ALPHA);
  }, 180_000);

  it('本物の大きな改善は十分な標本で採用に到達する（ゲートが厳しすぎない）', () => {
    // 対照0.3 / 候補0.9。ゲートが常時ブロックして「永遠に昇格しない」状態に
    // ならないことを示すのが目的。
    const rng = mulberry32(0x894b1);
    const REPLICATIONS = 150;
    let adopted = 0;

    for (let r = 0; r < REPLICATIONS; r++) {
      resetLedger();
      if (runCandidate(rng, 1, 0.3, 0.9, [10, 10, 10])) adopted++;
    }

    console.log(
      JSON.stringify({ scenario: 'alternative-0.3-vs-0.9', adopted, replications: REPLICATIONS }),
    );
    expect(adopted / REPLICATIONS).toBeGreaterThan(0.9);
  }, 120_000);
});
