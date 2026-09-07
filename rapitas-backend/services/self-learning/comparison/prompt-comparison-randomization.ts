/** Reproducible permuted blocks; a block always assigns one task to each arm. */
import { createHash } from 'crypto';
import type { ComparisonArm } from './prompt-comparison-types';

export function assignArm(seed: string, index: number): ComparisonArm {
  const digest = createHash('sha256')
    .update(`${seed}:${Math.floor(index / 2)}`)
    .digest();
  const candidateSlot = (digest[digest.length - 1] & 1) === 1 ? 0 : 1;
  return index % 2 === candidateSlot ? 'candidate' : 'current';
}
