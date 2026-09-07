/**
 * prompt-comparison-store.test
 *
 * Verifies same-candidate lock rejection, different-candidate concurrent
 * writes, and in_progress records degrading to null on read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireComparisonLock,
  readComparisonRecord,
  releaseComparisonLock,
  writeComparisonRecord,
} from './prompt-comparison-store';
import type { ComparisonRecord } from './prompt-comparison-types';

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
