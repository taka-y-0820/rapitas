/**
 * Exact sharp-null counterexample for the current unblocked Fisher gate.
 * Run: bun scripts/audit-blocked-adoption.ts
 * Each pre-fixed pair contains one always-successful and one always-failing task.
 * Neither task is affected by treatment. Enumerate all 2^5 equally likely block flips.
 * This audits the significance gate, not the whole operational adoption pipeline.
 */
import {
  alphaForCandidate,
  alphaForLook,
} from '../services/self-learning/comparison/prompt-comparison-alpha-ledger';
import {
  fisherExactOneSidedGreater,
  passesSequentialSignificance,
} from '../services/self-learning/comparison/prompt-comparison-adoption-gate';

const pairs = 5;
const assignments = 2 ** pairs;
const alpha = alphaForLook(alphaForCandidate(1), 1);
let rejected = 0;
for (let mask = 0; mask < assignments; mask++) {
  let candidateSuccessCount = 0;
  for (let pair = 0; pair < pairs; pair++) candidateSuccessCount += (mask >> pair) & 1;
  if (
    passesSequentialSignificance(
      {
        candidateSuccessCount,
        candidateFailureCount: pairs - candidateSuccessCount,
        currentSuccessCount: pairs - candidateSuccessCount,
        currentFailureCount: candidateSuccessCount,
      },
      alpha,
    )
  )
    rejected++;
}
console.log(
  JSON.stringify(
    {
      scenario: 'fixed discordant task pairs; no treatment effect',
      pairs,
      assignments,
      rejected,
      allocatedAlpha: alpha,
      exactFalseRejectionProbability: rejected / assignments,
      inflationOverAllocatedAlpha: rejected / assignments / alpha,
      extremeFisherP: fisherExactOneSidedGreater(pairs, 0, 0, pairs),
      extremeBlockRandomizationP: 1 / assignments,
      scope: 'significance gate only; not a production false-adoption rate',
      reference: 'https://pubmed.ncbi.nlm.nih.gov/3203524/',
    },
    null,
    2,
  ),
);
