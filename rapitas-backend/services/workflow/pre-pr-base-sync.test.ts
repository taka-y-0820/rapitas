/**
 * pre-pr-base-sync.test.ts
 *
 * Unit tests for syncBaseIntoBranch (task 573, requirement A). All side effects
 * (git, conflict resolver, re-verification) are injected stubs — no real git,
 * gh, or DB is touched (acceptance: git operations are mocked).
 */
import { describe, it, expect, mock } from 'bun:test';
import { syncBaseIntoBranch, type BaseSyncDeps } from './pre-pr-base-sync';

type GitCall = string[];
type GitCallWithOpts = { args: string[]; opts?: { skipLog?: boolean } };

/**
 * Scripted git stub: responds per subcommand; records every call (args plus opts).
 * `failOn` makes the matching subcommand reject (simulates non-zero exit).
 */
function makeGit(opts: {
  failOn?: string[];
  mergeStdout?: string;
  conflictFiles?: string[];
  diffFiles?: string[];
}): { runGit: BaseSyncDeps['runGit']; calls: GitCall[]; callsWithOpts: GitCallWithOpts[] } {
  const calls: GitCall[] = [];
  const callsWithOpts: GitCallWithOpts[] = [];
  const runGit: BaseSyncDeps['runGit'] = async (args, _cwd, runOpts) => {
    calls.push(args);
    callsWithOpts.push({ args, opts: runOpts });
    const sub = args.includes('merge')
      ? args.includes('--abort')
        ? 'merge-abort'
        : 'merge'
      : args[0];
    if (opts.failOn?.includes(sub)) throw new Error(`${sub} failed`);
    if (sub === 'merge') return opts.mergeStdout ?? 'Merge made by the ort strategy.';
    if (sub === 'diff' && args.includes('--diff-filter=U')) {
      return (opts.conflictFiles ?? []).join('\n');
    }
    if (sub === 'diff') return (opts.diffFiles ?? []).join('\n');
    return '';
  };
  return { runGit, calls, callsWithOpts };
}

function deps(overrides: Partial<BaseSyncDeps> & { runGit: BaseSyncDeps['runGit'] }): BaseSyncDeps {
  return {
    resolveConflicts: mock().mockResolvedValue(false),
    runVerify: mock().mockResolvedValue({ ok: true, verdict: 'pass' }),
    ...overrides,
  };
}

describe('syncBaseIntoBranch', () => {
  it('clean merge with changes → re-verifies → clean (PR proceeds)', async () => {
    const { runGit } = makeGit({ diffFiles: ['a.ts', 'b.ts'] });
    const runVerify = mock().mockResolvedValue({ ok: true, verdict: 'pass' });
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      deps: deps({ runGit, runVerify }),
    });
    expect(result.status).toBe('clean');
    expect(result.changedFiles).toBe(2);
    expect(result.verdict).toBe('pass');
    expect(runVerify).toHaveBeenCalledTimes(1);
  });

  it('already up to date → clean with 0 changes and NO re-verification', async () => {
    const { runGit } = makeGit({ mergeStdout: 'Already up to date.' });
    const runVerify = mock().mockResolvedValue({ ok: true, verdict: 'pass' });
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      deps: deps({ runGit, runVerify }),
    });
    expect(result.status).toBe('clean');
    expect(result.changedFiles).toBe(0);
    expect(runVerify).not.toHaveBeenCalled();
  });

  it('fetch failure → skipped (fail-open: PR creation must continue)', async () => {
    const { runGit, calls } = makeGit({ failOn: ['fetch'] });
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      deps: deps({ runGit }),
    });
    expect(result.status).toBe('skipped');
    // No merge may be attempted after a failed fetch.
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
  });

  it('conflict → resolver succeeds → re-verify OK → resolved (push continues)', async () => {
    const { runGit } = makeGit({
      failOn: ['merge'],
      conflictFiles: ['src/x.ts', 'src/y.ts'],
      diffFiles: ['src/x.ts', 'src/y.ts', 'src/z.ts'],
    });
    const resolveConflicts = mock().mockResolvedValue(true);
    const runVerify = mock().mockResolvedValue({ ok: true, verdict: 'pass' });
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      sessionId: 42,
      deps: deps({ runGit, resolveConflicts, runVerify }),
    });
    expect(result.status).toBe('resolved');
    expect(result.verdict).toBe('pass');
    expect(result.conflicts).toEqual(['src/x.ts', 'src/y.ts']);
    expect(resolveConflicts).toHaveBeenCalledWith({
      gitCwd: '/wt',
      taskId: 573,
      baseBranch: 'develop',
      conflicts: ['src/x.ts', 'src/y.ts'],
    });
    expect(runVerify).toHaveBeenCalledWith(573, '/wt', 42);
  });

  it('conflict → resolver fails → merge --abort → conflict_unresolved (no PR)', async () => {
    const { runGit, calls, callsWithOpts } = makeGit({
      failOn: ['merge'],
      conflictFiles: ['src/x.ts'],
    });
    const resolveConflicts = mock().mockResolvedValue(false);
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      deps: deps({ runGit, resolveConflicts }),
    });
    expect(result.status).toBe('conflict_unresolved');
    expect(result.conflicts).toEqual(['src/x.ts']);
    expect(calls.some((c) => c.includes('merge') && c.includes('--abort'))).toBe(true);
    // skipLog suppresses the spurious ERROR log for this best-effort, ignored-result abort.
    const abortCall = callsWithOpts.find(
      (c) => c.args.includes('merge') && c.args.includes('--abort'),
    );
    expect(abortCall?.opts?.skipLog).toBe(true);
    // The initial merge failure is also fully handled here — skipLog suppresses
    // the generic git-exec ERROR log for it too (task 737).
    const initialMergeCall = callsWithOpts.find(
      (c) => c.args.includes('merge') && !c.args.includes('--abort'),
    );
    expect(initialMergeCall?.opts?.skipLog).toBe(true);
  });

  it('merge fails WITHOUT content conflicts (infra) → skipped (fail-open)', async () => {
    const { runGit, calls, callsWithOpts } = makeGit({ failOn: ['merge'], conflictFiles: [] });
    const resolveConflicts = mock().mockResolvedValue(true);
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      deps: deps({ runGit, resolveConflicts }),
    });
    expect(result.status).toBe('skipped');
    expect(resolveConflicts).not.toHaveBeenCalled();
    expect(calls.some((c) => c.includes('merge') && c.includes('--abort'))).toBe(true);
    const abortCall = callsWithOpts.find(
      (c) => c.args.includes('merge') && c.args.includes('--abort'),
    );
    expect(abortCall?.opts?.skipLog).toBe(true);
    const initialMergeCall = callsWithOpts.find(
      (c) => c.args.includes('merge') && !c.args.includes('--abort'),
    );
    expect(initialMergeCall?.opts?.skipLog).toBe(true);
  });

  it('clean merge but re-verification NG → reverify_failed (PR withheld)', async () => {
    const { runGit } = makeGit({ diffFiles: ['a.ts'] });
    const runVerify = mock().mockResolvedValue({ ok: false, verdict: 'fail' });
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      deps: deps({ runGit, runVerify }),
    });
    expect(result.status).toBe('reverify_failed');
    expect(result.changedFiles).toBe(1);
    expect(result.verdict).toBe('fail');
  });

  it('conflict resolved but re-verification NG → reverify_failed', async () => {
    const { runGit } = makeGit({
      failOn: ['merge'],
      conflictFiles: ['src/x.ts'],
      diffFiles: ['src/x.ts'],
    });
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      deps: deps({
        runGit,
        resolveConflicts: mock().mockResolvedValue(true),
        runVerify: mock().mockResolvedValue({ ok: false, verdict: 'fail' }),
      }),
    });
    expect(result.status).toBe('reverify_failed');
    expect(result.verdict).toBe('fail');
  });

  it('a throwing resolver is treated as failure, not an exception', async () => {
    const { runGit } = makeGit({ failOn: ['merge'], conflictFiles: ['src/x.ts'] });
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 573,
      deps: deps({ runGit, resolveConflicts: mock().mockRejectedValue(new Error('boom')) }),
    });
    expect(result.status).toBe('conflict_unresolved');
  });

  it('conflict → resolver rejects with ClaudeCliUnavailableError → skipped (fail-open, not conflict_unresolved)', async () => {
    const { runGit, calls, callsWithOpts } = makeGit({
      failOn: ['merge'],
      conflictFiles: ['src/x.ts'],
    });
    const cliErr = Object.assign(new Error('Claude CLI timed out after 120000ms'), {
      name: 'ClaudeCliUnavailableError',
    });
    const resolveConflicts = mock().mockRejectedValue(cliErr);
    const result = await syncBaseIntoBranch({
      gitCwd: '/wt',
      baseBranch: 'develop',
      taskId: 705,
      deps: deps({ runGit, resolveConflicts }),
    });
    expect(result.status).toBe('skipped');
    expect(result.conflicts).toEqual(['src/x.ts']);
    expect(calls.some((c) => c.includes('merge') && c.includes('--abort'))).toBe(true);
    const abortCall = callsWithOpts.find(
      (c) => c.args.includes('merge') && c.args.includes('--abort'),
    );
    expect(abortCall?.opts?.skipLog).toBe(true);
  });
});
