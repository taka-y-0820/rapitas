/**
 * Exact upper-tail randomization test for binary outcomes in fixed task pairs.
 * Assumes both tasks were fixed before an independent fair treatment swap per
 * pair. Under the sharp null (no treatment effect on any task), each discordant
 * pair contributes +1 or -1 with equal probability; concordant pairs contribute 0.
 * This does not validate assignment provenance or establish a weak-null guarantee.
 * A caller must retain failed runs as false and must not drop unobserved outcomes.
 */
export function pairedRandomizationP(
  pairs: ReadonlyArray<{ candidate: boolean | null; control: boolean | null }>,
): number | null {
  if (pairs.length === 0 || pairs.length > 512) return null;
  let discordant = 0;
  let candidateWins = 0;
  for (const pair of pairs) {
    if (typeof pair.candidate !== 'boolean' || typeof pair.control !== 'boolean') return null;
    if (pair.candidate !== pair.control) {
      discordant++;
      if (pair.candidate) candidateWins++;
    }
  }
  // Dynamic programming counts fair swaps in probability space, avoiding
  // factorial overflow and enumeration of 2^n assignments.
  let probabilities = [1];
  for (let n = 0; n < discordant; n++) {
    const next = new Array<number>(n + 2).fill(0);
    for (let wins = 0; wins <= n; wins++) {
      next[wins] += probabilities[wins] / 2;
      next[wins + 1] += probabilities[wins] / 2;
    }
    probabilities = next;
  }
  return Math.min(
    1,
    probabilities.slice(candidateWins).reduce((sum, p) => sum + p, 0),
  );
}
