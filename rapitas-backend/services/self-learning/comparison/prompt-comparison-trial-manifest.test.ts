/** Prospective order, incomplete cohorts, and real process contention. */
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readTrialManifest,
  reserveTrialSlot,
  trialPrefix,
  type TrialSlot,
} from './prompt-comparison-trial-manifest';
import {
  initComparisonRecordForStaging,
  readComparisonRecord,
  recordComparisonRun,
} from './prompt-comparison-store';
import type { ComparisonRun } from './prompt-comparison-types';

let directory: string;
let previous: string | undefined;
const seed = {
  promptEvolutionId: 1,
  role: 'implementer',
  candidateVersion: 'version1',
  controlVersion: null,
  seed: 'random-seed',
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rapitas-prospective-'));
  previous = process.env.RAPITAS_DATA_DIR;
  process.env.RAPITAS_DATA_DIR = directory;
  initComparisonRecordForStaging({
    promptEvolutionId: 1,
    role: 'implementer',
    createdAt: new Date(0).toISOString(),
  });
});
afterEach(() => {
  if (previous === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

function reserve(taskId: number) {
  const r = reserveTrialSlot(seed, taskId, () => true);
  if (r.issue !== null) throw new Error(r.issue);
  return r;
}
function outcome(slot: TrialSlot, success = true): ComparisonRun {
  return {
    assignmentId: slot.id,
    controlVersion: null,
    taskId: slot.taskId,
    executionId: slot.taskId + 1000,
    success,
    costUsd: 1,
    durationMs: 100,
    failureCause: success ? null : 'implementation_error',
    role: 'implementer',
    modelName: 'actual-model',
    injected: slot.arm === 'candidate',
    injectedVersion: slot.arm === 'candidate' ? seed.candidateVersion : null,
  };
}

it('retries reuse the persisted slot even if the caller has reset its old counter or seed', () => {
  const first = reserve(10);
  reserve(11);
  const repeated = reserveTrialSlot({ ...seed, seed: 'different-input-seed' }, 10, () => false);
  expect(repeated).toMatchObject({ slot: first.slot, index: 0, issue: null });
  expect(readTrialManifest(1)!.slots).toHaveLength(2);
});

it('candidate and control versions cannot be changed after registration', () => {
  reserve(10);
  expect(reserveTrialSlot({ ...seed, candidateVersion: 'changed' }, 11, () => true)).toEqual({
    issue: 'trial_version_changed',
  });
  expect(reserveTrialSlot({ ...seed, controlVersion: 'changed' }, 11, () => true)).toEqual({
    issue: 'trial_version_changed',
  });
  expect(readTrialManifest(1)!.slots).toHaveLength(1);
});

it('historical outcomes cannot initialize a prospective manifest', () => {
  expect(reserveTrialSlot(seed, 10, () => false)).toEqual({
    issue: 'prospective_registration_required',
  });
  expect(readTrialManifest(1)).toBeNull();
});

it('a corrupt manifest is retained instead of drawing a new assignment', () => {
  reserve(10);
  writeFileSync(join(directory, '.prompt-comparisons', '1.trial.json'), '{broken');
  expect(reserveTrialSlot(seed, 11, () => true)).toEqual({ issue: 'corrupted' });
});

it('later successes cannot skip an unfinished earlier assignment; its failure is counted when it arrives', () => {
  for (let i = 1; i <= 12; i++) reserve(i);
  const manifest = readTrialManifest(1)!;
  for (const slot of manifest.slots.slice(1).reverse()) {
    expect(recordComparisonRun(1, slot.arm, outcome(slot))).toBe(true);
  }
  expect(trialPrefix(manifest, readComparisonRecord(1)!)).toMatchObject({
    completeSlots: 0,
    issue: null,
  });
  const first = manifest.slots[0];
  expect(recordComparisonRun(1, first.arm, outcome(first, false))).toBe(true);
  const prefix = trialPrefix(manifest, readComparisonRecord(1)!);
  if (prefix.issue !== null) throw new Error(prefix.issue);
  expect(prefix.completeSlots).toBe(10);
  expect(prefix.cells.map((c) => c.runs.length)).toEqual([5, 5]);
  expect(prefix.cells.flatMap((c) => c.runs).filter((r) => !r.success)).toHaveLength(1);
  expect(readComparisonRecord(1)!.arms.flatMap((c) => c.runs)).toHaveLength(12);
});

it('misattributed or repeated outcomes cannot settle a different prospective slot', () => {
  const { slot } = reserve(10);
  expect(recordComparisonRun(1, slot.arm, { ...outcome(slot), taskId: 11 })).toBe(false);
  expect(recordComparisonRun(1, slot.arm, { ...outcome(slot), controlVersion: 'wrong' })).toBe(
    false,
  );
  expect(recordComparisonRun(1, slot.arm, outcome(slot))).toBe(true);
  expect(recordComparisonRun(1, slot.arm, { ...outcome(slot), executionId: 9999 })).toBe(false);
});

it('four actual processes preserve every assignment and outcome without duplicate retry samples', async () => {
  const manifestPath = join(import.meta.dir, 'prompt-comparison-trial-manifest.ts');
  const storePath = join(import.meta.dir, 'prompt-comparison-store.ts');
  const children = Array.from({ length: 4 }, (_, worker) =>
    Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
    const { reserveTrialSlot } = await import(${JSON.stringify(manifestPath)});
    const { recordComparisonRun } = await import(${JSON.stringify(storePath)});
    const seed = ${JSON.stringify(seed)};
    for (const taskId of [${Array.from({ length: 10 }, (_, i) => worker * 10 + i + 1).join(',')},999]) {
      let r;
      for (let retry=0; retry<20; retry++) {
        r = reserveTrialSlot(seed, taskId, () => true);
        if(r.issue === null) break;
        if(r.issue !== 'io_error') throw new Error(r.issue);
        await Bun.sleep(10);
      }
      if(r.issue !== null) throw new Error(r.issue);
      const slot = r.slot;
      const run = { assignmentId: slot.id, taskId, executionId: taskId + 1000,
        controlVersion: null, success: true, costUsd: 1, durationMs: 100, failureCause: null,
        role: 'implementer', modelName: 'actual-model', injected: slot.arm === 'candidate',
        injectedVersion: slot.arm === 'candidate' ? 'version1' : null };
      const saved = recordComparisonRun(1, slot.arm, run);
      if (!saved && taskId !== 999) throw new Error('outcome lost');
    }
  `,
      ],
      { env: { ...process.env, RAPITAS_DATA_DIR: directory }, stdout: 'pipe', stderr: 'pipe' },
    ),
  );
  try {
    const results = await Promise.all(
      children.map(async (child) => ({
        exit: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ exit: 0, stderr: '' })));
    expect(readTrialManifest(1)!.slots).toHaveLength(41);
    expect(readComparisonRecord(1)!.arms.flatMap((c) => c.runs)).toHaveLength(41);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}, 20000);
