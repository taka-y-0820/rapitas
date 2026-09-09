import { test, expect, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { VerificationCheck } from './automated-verifier';

let result: VerificationCheck | null = null;
const runtime = mock(async () => result);
mock.module('./runtime-verification-stage', () => ({ runRuntimeVerificationStage: runtime }));
const { runAutomatedVerification } = await import('./automated-verifier');

test('an empty diff still runs configured runtime verification and preserves its verdict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empty-runtime-'));
  try {
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
    for (const verdict of [
      null,
      { name: 'runtime', ran: true, ok: true, errorCount: 0, details: 'browser passed' },
      {
        name: 'runtime',
        ran: false,
        ok: false,
        unverifiable: true,
        errorCount: 0,
        details: 'browser unavailable',
      },
      { name: 'runtime', ran: true, ok: false, errorCount: 1, details: 'HTTP 500' },
    ] as Array<VerificationCheck | null>) {
      result = verdict;
      runtime.mockClear();
      const actual = await runAutomatedVerification(root, { taskId: 906 });
      expect(runtime).toHaveBeenCalledWith(root, 906);
      expect(actual.changedFiles).toEqual([]);
      expect(actual.ok).toBe(verdict?.ok ?? true);
      expect(actual.unverifiable).toBe(verdict?.unverifiable ?? false);
      expect(actual.checks.filter((c) => c.name === 'runtime')).toEqual(verdict ? [verdict] : []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
