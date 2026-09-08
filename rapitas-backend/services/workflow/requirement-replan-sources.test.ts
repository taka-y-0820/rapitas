import { expect, test } from 'bun:test';
import { parseReplanVerdict } from './requirement-replan-verdict';
import { validateReplanEvidence } from './requirement-replan-evidence';
const snapshot = {
  title: 'Preserve completed tasks',
  description:
    'Prior investigation found a stale question.\nDelayed questions must preserve completed status.',
  goals: [],
  constraints: [],
  acceptanceCriteria: [],
  plan: 'Status persistence changes are excluded.',
  verify: 'The late question changed completed to awaiting_question.',
};
const verdict = {
  kind: 'mismatch',
  reason: 'The requested state preservation is excluded by the plan',
  requirementUnmet: true,
  planPreventsRequirement: true,
  preservesRequirements: true,
  requiresOverridingUserConstraint: false,
  requirementIsRequestedOutcome: true,
  criterionSource: 'description',
  criterionIndex: 1,
  planLines: [0, 0],
  failureLines: [0, 0],
};
test('grounds a description requirement without synthesizing acceptance criteria', () => {
  const result = parseReplanVerdict(JSON.stringify(verdict), snapshot);
  expect(result.kind).toBe('mismatch');
  if (result.kind !== 'mismatch') throw new Error('missing evidence');
  expect(result.evidence.criterion).toBe('Delayed questions must preserve completed status.');
  expect(validateReplanEvidence(snapshot, result.evidence)).toBeNull();
  expect(snapshot.acceptanceCriteria).toEqual([]);
});
test('non-criteria text requires explicit requested-outcome assessment', () => {
  expect(
    parseReplanVerdict(
      JSON.stringify({ ...verdict, requirementIsRequestedOutcome: false }),
      snapshot,
    ),
  ).toEqual({ kind: 'unknown', reason: 'unconfirmed_requirement_intent' });
});
test('invalid source and out-of-range references never create evidence', () => {
  expect(
    parseReplanVerdict(JSON.stringify({ ...verdict, criterionSource: 'plan' }), snapshot).kind,
  ).toBe('unknown');
  expect(parseReplanVerdict(JSON.stringify({ ...verdict, criterionIndex: 2 }), snapshot).kind).toBe(
    'unknown',
  );
});
