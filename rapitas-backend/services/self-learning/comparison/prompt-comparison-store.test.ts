/**
 * prompt-comparison-store.test
 *
 * Verifies same-candidate lock rejection, different-candidate concurrent
 * writes, in_progress records degrading to null on read, the live-trial
 * append path (staging init, arm cells, injection proof, dedup by executionId),
 * and that staging distinguishes missing / corrupt / in-progress / unreadable
 * records instead of overwriting measured evidence with an empty one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireComparisonLock,
  addendumVersionHash,
  initComparisonRecordForStaging,
  readComparisonRecord,
  readComparisonRecordStatus,
  recordComparisonRun,
  releaseComparisonLock,
  writeComparisonRecord,
  updateComparisonScope,
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

function stage(id: number) {
  return initComparisonRecordForStaging({
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

/** Absolute path of a candidate's record file inside the test's data dir. */
function recordPath(id: number): string {
  return join(tmpDir, '.prompt-comparisons', `${id}.json`);
}

function writeRaw(id: number, contents: string): void {
  const file = recordPath(id);
  mkdirSync(join(tmpDir, '.prompt-comparisons'), { recursive: true });
  writeFileSync(file, contents);
}

describe('readComparisonRecordStatus', () => {
  it('reports ok with the record for a completed file', () => {
    writeComparisonRecord(baseRecord(80));
    const status = readComparisonRecordStatus(80);
    expect(status.kind).toBe('ok');
    expect(status.kind === 'ok' && status.record.promptEvolutionId).toBe(80);
  });

  it('reports not_found only when the file genuinely does not exist', () => {
    expect(readComparisonRecordStatus(81).kind).toBe('not_found');
  });

  it('reports corrupted for unparseable JSON', () => {
    writeRaw(82, '{ this is not json');
    expect(readComparisonRecordStatus(82).kind).toBe('corrupted');
  });

  it('reports corrupted for valid JSON of the wrong shape', () => {
    writeRaw(83, JSON.stringify({ hello: 'world' }));
    expect(readComparisonRecordStatus(83).kind).toBe('corrupted');
  });

  it('reports io_error when the record path cannot be read as a file', () => {
    // ディレクトリを record パスに作ると readFileSync は EISDIR で失敗する。
    mkdirSync(recordPath(84), { recursive: true });
    const status = readComparisonRecordStatus(84);
    expect(status.kind).toBe('io_error');
  });

  it('reports in_progress and still surfaces the record', () => {
    writeComparisonRecord(baseRecord(85, 'in_progress'));
    const status = readComparisonRecordStatus(85);
    expect(status.kind).toBe('in_progress');
    expect(status.kind === 'in_progress' && status.record.promptEvolutionId).toBe(85);
  });
});

describe('initComparisonRecordForStaging — 既存記録の保護', () => {
  it('creates a record and reports no issue when none exists', () => {
    const result = stage(90);
    expect(result.issue).toBeNull();
    expect(result.record?.arms).toEqual([]);
  });

  it('does not overwrite a corrupt record and reports the issue', () => {
    writeRaw(91, '{ broken');
    const before = readFileSync(recordPath(91), 'utf8');

    const result = stage(91);

    expect(result.issue).toBe('corrupted');
    expect(result.record).toBeNull();
    expect(readFileSync(recordPath(91), 'utf8')).toBe(before);
  });

  it('does not overwrite an in_progress record and reports the issue', () => {
    writeComparisonRecord(baseRecord(92, 'in_progress'));
    const before = readFileSync(recordPath(92), 'utf8');

    const result = stage(92);

    expect(result.issue).toBe('in_progress');
    expect(result.record).toBeNull();
    expect(readFileSync(recordPath(92), 'utf8')).toBe(before);
  });

  it('does not treat an unreadable path as a fresh candidate', () => {
    mkdirSync(recordPath(93), { recursive: true });

    const result = stage(93);

    expect(result.issue).toBe('io_error');
    expect(result.record).toBeNull();
  });

  it('keeps the runs an already-staged candidate collected', () => {
    stage(94);
    recordComparisonRun(94, 'current', trialRun({ executionId: 41 }));

    const result = stage(94);

    expect(result.issue).toBeNull();
    expect(result.record?.arms[0]?.runs).toHaveLength(1);
  });
});

describe('updateComparisonScope', () => {
  it('preserves measurements appended after the caller read the record', () => {
    stage(501);
    const stale = readComparisonRecord(501)!;
    expect(recordComparisonRun(501, 'current', trialRun())).toBe(true);
    const measured = readComparisonRecord(501)!;
    expect(updateComparisonScope(501, stale.stagedTaskIds, null)).toBe(true);
    expect(readComparisonRecord(501)).toEqual({ ...measured, stagedTaskIds: null });
  });
  it('rejects conflicting scope changes and preserves the newer record', () => {
    stage(502);
    expect(updateComparisonScope(502, [], [9])).toBe(true);
    const newer = readComparisonRecord(502);
    expect(updateComparisonScope(502, [], null)).toBe(false);
    expect(readComparisonRecord(502)).toEqual(newer);
  });
  it('does not replace incomplete or missing evidence', () => {
    writeComparisonRecord(baseRecord(503, 'in_progress'));
    expect(updateComparisonScope(503, null, [])).toBe(false);
    expect(readComparisonRecordStatus(503).kind).toBe('in_progress');
    expect(updateComparisonScope(504, null, [])).toBe(false);
    expect(readComparisonRecordStatus(504).kind).toBe('not_found');
  });
});

it('holds staging when a previously initialized evidence file disappears', () => {
  expect(stage(601).issue).toBeNull();
  expect(recordComparisonRun(601, 'current', trialRun())).toBe(true);
  unlinkSync(join(tmpDir, '.prompt-comparisons', '601.json'));
  expect(stage(601)).toEqual({ record: null, issue: 'corrupted' });
  expect(readComparisonRecordStatus(601).kind).toBe('not_found');
});

it('concurrent processes initialize once and retain all measured outcomes', async () => {
  const store = join(import.meta.dir, 'prompt-comparison-store.ts');
  const children = Array.from({ length: 4 }, (_, worker) =>
    Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      const {initComparisonRecordForStaging, recordComparisonRun} = await import(${JSON.stringify(store)});
      const seed = {promptEvolutionId:602,role:'implementer',createdAt:new Date(0).toISOString()};
      for(let n=0;n<10;n++) {
        const initialized=initComparisonRecordForStaging(seed);
        if(initialized.issue) throw new Error(initialized.issue);
        const run=${JSON.stringify(trialRun())};
        run.executionId=${worker}*10+n+1;
        run.taskId=run.executionId;
        if(!recordComparisonRun(602,'current',run)) throw new Error('append failed');
      }
    `,
      ],
      { env: { ...process.env, RAPITAS_DATA_DIR: tmpDir }, stdout: 'pipe', stderr: 'pipe' },
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
    const runs = readComparisonRecord(602)!.arms.flatMap((cell) => cell.runs);
    expect(runs).toHaveLength(40);
    expect(new Set(runs.map((run) => run.executionId)).size).toBe(40);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}, 20000);
