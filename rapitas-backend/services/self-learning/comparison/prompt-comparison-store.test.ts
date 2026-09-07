/**
 * prompt-comparison-store.test
 *
 * Verifies same-candidate lock rejection, different-candidate concurrent
 * writes, in_progress records degrading to null on read, and the live-trial
 * append path (staging init, arm cells, injection proof, dedup by executionId).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireComparisonLock,
  addendumVersionHash,
  initComparisonRecordForStaging,
  readComparisonRecord,
  recordComparisonRun,
  releaseComparisonLock,
  writeComparisonRecord,
} from './prompt-comparison-store';
import type { ComparisonRecord, ComparisonRun } from './prompt-comparison-types';

let tmpDir: string;
let savedDataDir: string | undefined;

function baseRecord(id: number, status: ComparisonRecord['status'] = 'done'): ComparisonRecord {
  return {
    promptEvolutionId: id,
    role: 'implementer',
    modelName: 'claude-sonnet-5',
    budgetUsd: 2.5,
    createdAt: new Date(0).toISOString(),
    status,
    sampleTaskIds: [1, 2, 3],
    arms: [],
    summary: null,
    knowledgeSnapshotHash: null,
    stagedTaskIds: null,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-prompt-comparison-'));
  savedDataDir = process.env.RAPITAS_DATA_DIR;
  process.env.RAPITAS_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = savedDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeComparisonRecord / readComparisonRecord', () => {
  it('round-trips a done record', () => {
    expect(writeComparisonRecord(baseRecord(42))).toBe(true);
    const read = readComparisonRecord(42);
    expect(read?.promptEvolutionId).toBe(42);
    expect(read?.status).toBe('done');
  });

  it('treats an in_progress record as absent (partial data never surfaces)', () => {
    writeComparisonRecord(baseRecord(43, 'in_progress'));
    expect(readComparisonRecord(43)).toBeNull();
  });

  it('returns null for a candidate with no file', () => {
    expect(readComparisonRecord(999)).toBeNull();
  });
});

describe('acquireComparisonLock / releaseComparisonLock', () => {
  it('rejects a second lock for the same candidate while held', () => {
    expect(acquireComparisonLock(1)).toBe(true);
    expect(acquireComparisonLock(1)).toBe(false);
    releaseComparisonLock(1);
    expect(acquireComparisonLock(1)).toBe(true);
  });

  it('allows concurrent locks for different candidates', () => {
    expect(acquireComparisonLock(1)).toBe(true);
    expect(acquireComparisonLock(2)).toBe(true);
  });

  it('release is a no-op when no lock was held', () => {
    expect(() => releaseComparisonLock(777)).not.toThrow();
  });
});

function trialRun(over: Partial<ComparisonRun> = {}): ComparisonRun {
  return {
    taskId: 900,
    executionId: 1,
    success: true,
    costUsd: 0.5,
    durationMs: 60_000,
    failureCause: null,
    role: 'implementer',
    injected: false,
    injectedVersion: null,
    ...over,
  };
}

function stage(id: number): void {
  initComparisonRecordForStaging({
    promptEvolutionId: id,
    role: 'implementer',
    modelName: 'claude-sonnet-5',
    budgetUsd: 0,
    createdAt: new Date(0).toISOString(),
  });
}

describe('initComparisonRecordForStaging', () => {
  it('creates a readable empty record so the trial has somewhere to append', () => {
    stage(70);
    const read = readComparisonRecord(70);
    expect(read?.arms).toEqual([]);
    expect(read?.stagedTaskIds).toEqual([]);
    expect(read?.status).toBe('done');
  });

  it('keeps the runs an already-staged candidate collected', () => {
    stage(71);
    recordComparisonRun(71, 'current', trialRun({ executionId: 11 }));
    stage(71);
    expect(readComparisonRecord(71)?.arms[0]?.runs).toHaveLength(1);
  });
});

describe('recordComparisonRun', () => {
  it('appends both arms into with-knowledge cells and recomputes the summary', () => {
    stage(72);
    expect(recordComparisonRun(72, 'current', trialRun({ executionId: 21, taskId: 801 }))).toBe(
      true,
    );
    expect(
      recordComparisonRun(
        72,
        'candidate',
        trialRun({ executionId: 22, taskId: 802, injected: true, injectedVersion: 'abc123' }),
      ),
    ).toBe(true);

    const read = readComparisonRecord(72);
    expect(read?.arms).toHaveLength(2);
    expect(read?.arms.every((c) => c.knowledge === 'with')).toBe(true);
    // 5サンプル未満なので verdict は insufficient_data だが、summary 自体は算出される。
    expect(read?.summary?.verdict).toBe('insufficient_data');
    // 介入アームで実際に走ったタスクだけが限定試行の対象として記録される。
    expect(read?.stagedTaskIds).toEqual([802]);
    expect(read?.sampleTaskIds).toEqual([801, 802]);
  });

  it('refuses a candidate-arm run that was never actually injected', () => {
    stage(73);
    expect(
      recordComparisonRun(73, 'candidate', trialRun({ executionId: 31, injected: false })),
    ).toBe(false);
    expect(readComparisonRecord(73)?.arms).toEqual([]);
  });

  it('refuses a duplicate executionId so a provider-fallback retry cannot double-count', () => {
    stage(74);
    expect(recordComparisonRun(74, 'current', trialRun({ executionId: 41 }))).toBe(true);
    expect(recordComparisonRun(74, 'current', trialRun({ executionId: 41 }))).toBe(false);
    expect(readComparisonRecord(74)?.arms[0]?.runs).toHaveLength(1);
  });

  it('drops a run for a candidate that was never staged', () => {
    expect(recordComparisonRun(75, 'current', trialRun({ executionId: 51 }))).toBe(false);
  });
});

describe('addendumVersionHash', () => {
  it('is stable per text and differs across versions', () => {
    expect(addendumVersionHash('- lintを実行する')).toBe(addendumVersionHash('- lintを実行する'));
    expect(addendumVersionHash('- lintを実行する')).not.toBe(addendumVersionHash('- 型を通す'));
    expect(addendumVersionHash('x')).toHaveLength(12);
  });
});
