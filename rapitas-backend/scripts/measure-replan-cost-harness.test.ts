import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCliMeasurement, sumMeasurements } from './measure-replan-cost-harness';

const receipt = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.02,
  usage: { input_tokens: 12, output_tokens: 25 },
  modelUsage: { 'test-model': {} },
  result: JSON.stringify({
    implementation:
      'Persist the server-confirmed status until fetched state catches up and ignore stale parent props.',
    verification:
      'Exercise server-first and parent-first refreshes, task switches, and late responses for previous tasks.',
  }),
};
const parse = (value: unknown, exit = 0) => parseCliMeasurement(JSON.stringify(value), 10, exit);

test('a single JSON code fence is accepted, surrounding prose is rejected', () => {
  expect(parse({ ...receipt, result: '```json\n' + receipt.result + '\n```' }).ok).toBe(true);
  expect(
    parse({
      ...receipt,
      result: 'Please inspect files first.\n```json\n' + receipt.result + '\n```',
    }).ok,
  ).toBe(false);
});

test.each([undefined, null, -1, '0.02'])(
  'missing/invalid cost %s cannot pass or total as zero',
  (cost) => {
    const result = parse({ ...receipt, total_cost_usd: cost });
    expect(result.ok).toBe(false);
    expect(sumMeasurements([result], 1).totalCostUsd).toBeNull();
  },
);
test('explicit measured zero is distinct from missing cost', () => {
  const result = parse({ ...receipt, total_cost_usd: 0 });
  expect(result.ok).toBe(true);
  expect(sumMeasurements([result], 1).totalCostUsd).toBe(0);
});

test.each([
  undefined,
  '研究メモを確認します。 Tool: glob',
  '{}',
  '{"implementation":"short","verification":"short"}',
])('successful CLI without a complete plan is rejected: %s', (result) => {
  const measurement = parse({ ...receipt, result });
  expect(measurement.ok).toBe(false);
  expect(measurement.totalCostUsd).toBe(0.02);
  expect(sumMeasurements([measurement], 1).complete).toBe(false);
});
test('CLI semantic failure and nonzero exit cannot produce successful comparison', () => {
  for (const result of [parse({ ...receipt, is_error: true }), parse(receipt, 1)]) {
    expect(result.ok).toBe(false);
    expect(result.totalCostUsd).toBe(0.02); // Preserve any actually reported expense.
    expect(sumMeasurements([result], 1).complete).toBe(false);
  }
});
test('incomplete counters, models, JSON and invocation groups remain unmeasured', () => {
  expect(parse({ ...receipt, usage: {} }).ok).toBe(false);
  expect(parse({ ...receipt, modelUsage: {} }).ok).toBe(false);
  expect(parseCliMeasurement('not-json', 1, 0).ok).toBe(false);
  expect(sumMeasurements([parse(receipt)], 3).totalCostUsd).toBeNull();
  expect(sumMeasurements([], 1).complete).toBe(false);
});
test('complete group totals come from actual reported measurements', () => {
  expect(sumMeasurements([parse(receipt), parse(receipt)], 2)).toMatchObject({
    complete: true,
    totalCostUsd: 0.04,
    totalInputTokens: 24,
    totalOutputTokens: 50,
  });
});
test('default does no measurement; explicitly requested unavailable CLI writes failed receipt and exits nonzero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rapitas-cost-harness-test-'));
  try {
    const command = [process.execPath, join(import.meta.dir, 'measure-replan-cost-harness.ts')];
    const env = {
      ...process.env,
      PATH: '',
      Path: '',
      RAPITAS_REPLAN_COST_OUTPUT_DIR: dir,
      RAPITAS_RUN_REPLAN_COST_HARNESS: '0',
    };
    const skipped = Bun.spawnSync(command, { env });
    expect(skipped.exitCode).toBe(0);
    const report = join(dir, 'task902-cli-replan-cost-audit.json');
    expect(existsSync(report)).toBe(false);
    const failed = Bun.spawnSync(command, {
      env: { ...env, RAPITAS_RUN_REPLAN_COST_HARNESS: '1' },
    });
    expect(failed.exitCode).not.toBe(0);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      status: 'failed',
      legacyAlwaysReplan: { complete: false, totalCostUsd: null },
    });
  } finally {
    const target = resolve(dir);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('rapitas-cost-harness-test-')
    ) {
      throw Error('Unsafe test cleanup path');
    }
    rmSync(target, { recursive: true, force: true });
  }
});
