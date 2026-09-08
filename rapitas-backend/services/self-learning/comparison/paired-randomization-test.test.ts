import { describe, expect, test } from 'bun:test';
import { pairedRandomizationP } from './paired-randomization-test';

describe('fixed-pair randomization under the sharp null', () => {
  test('five discordant wins cannot meet an alpha of .0125', () => {
    expect(
      pairedRandomizationP(Array.from({ length: 5 }, () => ({ candidate: true, control: false }))),
    ).toBe(1 / 32);
    expect(
      pairedRandomizationP(Array.from({ length: 7 }, () => ({ candidate: true, control: false }))),
    ).toBe(1 / 128);
  });

  test('concordant outcomes have no treatment evidence', () => {
    expect(
      pairedRandomizationP([
        { candidate: true, control: true },
        { candidate: false, control: false },
      ]),
    ).toBe(1);
  });

  test('missing results cannot be silently removed', () => {
    expect(pairedRandomizationP([{ candidate: null, control: false }])).toBeNull();
    expect(pairedRandomizationP([])).toBeNull();
    expect(
      pairedRandomizationP(
        Array.from({ length: 513 }, () => ({ candidate: true, control: false })),
      ),
    ).toBeNull();
  });

  test('all 32 equally likely assignments respect the allocated rejection rate', () => {
    const pValues = Array.from(
      { length: 32 },
      (_, mask) =>
        pairedRandomizationP(
          Array.from({ length: 5 }, (_, pair) => ({
            candidate: Boolean(mask & (1 << pair)),
            control: !Boolean(mask & (1 << pair)),
          })),
        )!,
    );
    expect(pValues.filter((p) => p <= 0.0125)).toHaveLength(0);
    for (const alpha of [0.0125, 0.05, 0.1, 0.5, 1]) {
      expect(pValues.filter((p) => p <= alpha).length / 32).toBeLessThanOrEqual(alpha);
    }
  });
});
