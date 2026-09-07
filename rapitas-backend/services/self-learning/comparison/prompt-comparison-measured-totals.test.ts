/** Actual logger -> file -> reader -> comparison totals, in an isolated directory. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExecutionFileLogger } from '../../agents/execution-file-logger';
import { readExecutionAttemptMetrics } from '../../agents/execution-file-logger/attempt-metrics-reader';
import { measuredTrialExecutionTotals } from './prompt-comparison-measured-totals';
import { comparisonCohortIssue } from './prompt-comparison-checkpoint';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'attempt-log-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const row = {
  id: 10,
  status: 'completed',
  modelName: 'last-model',
  costUsd: 0,
  executionTimeMs: 0,
};
const first = {
  success: false,
  costUsd: 0.75 as number | null,
  executionTimeMs: 7000,
  modelName: 'first-model',
};
const last = {
  success: true,
  costUsd: 1.25 as number | null,
  executionTimeMs: 123000,
  modelName: 'last-model',
};
async function record(attempts = [first, last], terminal = true) {
  const logger = new ExecutionFileLogger(10, 100, 1, 'test', 'codex', 'agent', undefined, {
    logDir: directory,
    enableConsolePassthrough: false,
  });
  logger.log('INFO', 'recovery', 'execution_attempt_metrics', {
    executionId: 10,
    sessionId: 100,
    attempts,
    settled: true,
  });
  if (terminal) logger.logExecutionEnd('completed', { success: true });
  return (await logger.flush())!;
}
const total = () =>
  measuredTrialExecutionTotals([row], 100, (id, session) =>
    readExecutionAttemptMetrics(id, session, directory),
  );

test('real files override misleading DB zero and retain every model used under one execution ID', async () => {
  await record();
  expect(await total()).toMatchObject({
    costUsd: 2,
    durationMs: 130000,
    executionIds: [10],
    attemptModels: ['first-model', 'last-model'],
  });
  const totals = (await total())!;
  expect(
    comparisonCohortIssue(
      [
        {
          arm: 'current',
          knowledge: 'with',
          runs: [
            {
              ...totals,
              taskId: 1,
              executionId: 10,
              success: true,
              failureCause: null,
              role: 'implementer',
              modelName: 'last-model',
            },
          ],
        },
      ],
      'implementer',
      'v1',
    ),
  ).toBe('mixed_actual_models');
});
test('a measured free attempt is valid, while a missing cost is not free', async () => {
  const path = await record([{ ...first, costUsd: null }, last]);
  expect(await total()).toBeNull();
  rmSync(path);
  await record([{ ...last, costUsd: 0 }]);
  expect((await total())?.costUsd).toBe(0);
});
test('missing and corrupt files are withheld', async () => {
  expect(await total()).toBeNull();
  const path = await record();
  writeFileSync(path, 'broken');
  expect(await total()).toBeNull();
});
test('ambiguous repeated execution logs cannot be picked by arbitrary directory order', async () => {
  const path = await record();
  copyFileSync(path, join(directory, 'exec-10-other.log'));
  expect(await total()).toBeNull();
});
test('nonterminal logs and wrong session identities remain withheld', async () => {
  await record([first, last], false);
  expect(await total()).toBeNull();
  expect(await readExecutionAttemptMetrics(10, 999, directory)).toBeNull();
});
