/**
 * prompt-comparison-adoption-gate テスト
 *
 * Fisher 片側正確検定の値を公表された基準値で検算し、逐次有意性ゲートが
 * 与えられた予算 alphaKj に対して正しく判定することを確認する。
 */
import { describe, expect, it } from 'bun:test';
import {
  fisherExactOneSidedGreater,
  logChoose,
  passesSequentialSignificance,
} from './prompt-comparison-adoption-gate';

describe('logChoose', () => {
  it('matches exact binomial coefficients', () => {
    expect(Math.exp(logChoose(8, 4))).toBeCloseTo(70, 9);
    expect(Math.exp(logChoose(10, 5))).toBeCloseTo(252, 8);
    expect(Math.exp(logChoose(5, 0))).toBeCloseTo(1, 12);
  });

  it('returns -Infinity outside the valid range', () => {
    expect(logChoose(5, 6)).toBe(-Infinity);
    expect(logChoose(5, -1)).toBe(-Infinity);
  });
});

describe('fisherExactOneSidedGreater', () => {
  it("reproduces Fisher's tea-tasting reference value (17/70)", () => {
    // 2x2 = [[3,1],[1,3]] の片側p。公表された検算可能な基準値。
    expect(fisherExactOneSidedGreater(3, 1, 1, 3)).toBeCloseTo(17 / 70, 12);
  });

  it('gives 1/252 for a complete separation at n=5 per arm', () => {
    // candidate 5/5 vs current 0/5。
    expect(fisherExactOneSidedGreater(5, 0, 0, 5)).toBeCloseTo(1 / 252, 12);
  });

  it('gives 6/252 for candidate 5/5 vs current 1/5', () => {
    expect(fisherExactOneSidedGreater(5, 0, 1, 4)).toBeCloseTo(6 / 252, 12);
  });

  it("gives 0.5 for the supervisor's reference case (candidate 5/5 vs current 4/5)", () => {
    expect(fisherExactOneSidedGreater(5, 0, 4, 1)).toBeCloseTo(0.5, 12);
  });

  it('gives 0.5 for a single run per arm (no evidence either way)', () => {
    expect(fisherExactOneSidedGreater(1, 0, 0, 1)).toBeCloseTo(0.5, 12);
  });

  it('returns 1 when the two arms are identical', () => {
    expect(fisherExactOneSidedGreater(0, 5, 0, 5)).toBeCloseTo(1, 12);
  });

  it('returns 1 when either arm has no runs', () => {
    expect(fisherExactOneSidedGreater(0, 0, 5, 0)).toBe(1);
    expect(fisherExactOneSidedGreater(5, 0, 0, 0)).toBe(1);
  });

  it('stays finite and in [0,1] for a long-running trial', () => {
    // 対数空間で計算していないと階乗がオーバーフローして NaN になる規模。
    const p = fisherExactOneSidedGreater(180, 20, 150, 50);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});

describe('passesSequentialSignificance', () => {
  /** 候補1件目・評価1回目の予算: 0.05/(1*2)/(1*2) = 0.0125。 */
  const ALPHA_11 = 0.0125;

  it("holds the supervisor's 4/5 vs 5/5 case back at the first look", () => {
    const passes = passesSequentialSignificance(
      {
        currentSuccessCount: 4,
        currentFailureCount: 1,
        candidateSuccessCount: 5,
        candidateFailureCount: 0,
      },
      ALPHA_11,
    );
    expect(passes).toBe(false);
  });

  it('adopts a complete separation at the first look (p=1/252 < 0.0125)', () => {
    const passes = passesSequentialSignificance(
      {
        currentSuccessCount: 0,
        currentFailureCount: 5,
        candidateSuccessCount: 5,
        candidateFailureCount: 0,
      },
      ALPHA_11,
    );
    expect(passes).toBe(true);
  });

  it('holds 1/5 vs 5/5 back at the first look (p=6/252 > 0.0125)', () => {
    const passes = passesSequentialSignificance(
      {
        currentSuccessCount: 1,
        currentFailureCount: 4,
        candidateSuccessCount: 5,
        candidateFailureCount: 0,
      },
      ALPHA_11,
    );
    expect(passes).toBe(false);
  });

  it('refuses a non-positive budget outright', () => {
    const counts = {
      currentSuccessCount: 0,
      currentFailureCount: 5,
      candidateSuccessCount: 5,
      candidateFailureCount: 0,
    };
    expect(passesSequentialSignificance(counts, 0)).toBe(false);
    expect(passesSequentialSignificance(counts, -1)).toBe(false);
  });

  it('does not treat a zero-variance arm as certainty on its own', () => {
    // 両アームとも分散0(0/2 vs 2/2)。正規近似ではSE=0で「確実」に見えるが、
    // 正確検定では p=1/6≈0.167 で採用に届かない。
    const passes = passesSequentialSignificance(
      {
        currentSuccessCount: 0,
        currentFailureCount: 2,
        candidateSuccessCount: 2,
        candidateFailureCount: 0,
      },
      ALPHA_11,
    );
    expect(fisherExactOneSidedGreater(2, 0, 0, 2)).toBeCloseTo(1 / 6, 12);
    expect(passes).toBe(false);
  });
});
