/**
 * Phase Critic Eval Results Snapshot テスト
 *
 * Mirrors eval-judge-results.test.ts: path resolution under RAPITAS_DATA_DIR,
 * the write/read round-trip, and that reads never throw on a missing or
 * corrupt snapshot file.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getPhaseCriticEvalResultPath,
  writePhaseCriticEvalResult,
  readPhaseCriticEvalResult,
  type PhaseCriticEvalResult,
} from '../../services/observability/eval-phase-critic-results';

describe('eval-phase-critic-results', () => {
  let dir: string;
  const origDataDir = process.env.RAPITAS_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phase-critic-eval-'));
    process.env.RAPITAS_DATA_DIR = dir;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.RAPITAS_DATA_DIR;
    else process.env.RAPITAS_DATA_DIR = origDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test('getPhaseCriticEvalResultPath places the snapshot under <DATA_DIR>/logs', () => {
    expect(getPhaseCriticEvalResultPath()).toBe(join(dir, 'logs', 'eval-phase-critic-latest.json'));
  });

  test('readPhaseCriticEvalResult returns null when the eval has never run', () => {
    expect(readPhaseCriticEvalResult()).toBeNull();
  });

  test('writePhaseCriticEvalResult then readPhaseCriticEvalResult round-trips the snapshot', () => {
    const result: PhaseCriticEvalResult = {
      timestamp: '2026-09-09T00:00:00.000Z',
      provider: 'claude',
      cases: [
        {
          name: 'narrow-task909',
          expectedVerdict: 'fail',
          gotVerdict: 'fail',
          ok: true,
          severity: 80,
          inputTruncated: false,
          elapsedMs: 1200,
        },
      ],
      detectionRate: 1,
      falseBounceRate: 0,
    };

    writePhaseCriticEvalResult(result);

    expect(readPhaseCriticEvalResult()).toEqual(result);
  });

  test('readPhaseCriticEvalResult returns null (never throws) on a corrupt snapshot file', () => {
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(getPhaseCriticEvalResultPath(), '{ not valid json', 'utf-8');

    expect(() => readPhaseCriticEvalResult()).not.toThrow();
    expect(readPhaseCriticEvalResult()).toBeNull();
  });

  test('writePhaseCriticEvalResult never throws even if the data dir cannot be created', () => {
    const blocked = join(dir, 'blocked-file');
    writeFileSync(blocked, 'x');
    process.env.RAPITAS_DATA_DIR = blocked;

    expect(() =>
      writePhaseCriticEvalResult({
        timestamp: new Date().toISOString(),
        provider: 'claude',
        cases: [],
        detectionRate: 0,
        falseBounceRate: 0,
      }),
    ).not.toThrow();
  });
});
