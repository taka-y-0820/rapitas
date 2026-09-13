/**
 * fake-pr-backend.test
 *
 * The two scenarios this stand-in exists for are easy to get subtly wrong, so
 * both are pinned explicitly: a lost response must still have created the PR
 * server-side (otherwise the harness would be testing "PR creation failed",
 * a different and much easier case), and a red CI must stay red on every
 * query rather than flapping.
 */
import { describe, it, expect } from 'bun:test';
import { FakePrBackend, LostResponseError } from './fake-pr-backend';

const prInput = {
  title: '[eval] example',
  headBranch: 'eval/task-1-baseline',
  baseBranch: 'main',
  headSha: 'abc1234',
};

describe('FakePrBackend — normal operation', () => {
  it('returns an incrementing PR number', async () => {
    const backend = new FakePrBackend();
    expect((await backend.createPullRequest(prInput)).number).toBe(1);
    expect((await backend.createPullRequest(prInput)).number).toBe(2);
  });

  it('reports success for a known PR', async () => {
    const backend = new FakePrBackend();
    const pr = await backend.createPullRequest(prInput);
    expect(backend.getCiStatus(pr.number)).toBe('success');
  });

  it('reports pending for an unknown PR', () => {
    expect(new FakePrBackend().getCiStatus(999)).toBe('pending');
  });
});

describe('FakePrBackend — response_lost_after_pr', () => {
  it('throws LostResponseError to the caller', async () => {
    const backend = new FakePrBackend({ loseResponseAfterCreate: true, lostResponseTimeoutMs: 1 });
    await expect(backend.createPullRequest(prInput)).rejects.toBeInstanceOf(LostResponseError);
  });

  it('still records the PR server-side, with its number on the error', async () => {
    const backend = new FakePrBackend({ loseResponseAfterCreate: true, lostResponseTimeoutMs: 1 });
    let captured: LostResponseError | null = null;
    try {
      await backend.createPullRequest(prInput);
    } catch (error) {
      captured = error as LostResponseError;
    }
    expect(captured?.prNumber).toBe(1);
    // The whole point of the scenario: the side effect landed anyway.
    expect(backend.listPullRequests()).toHaveLength(1);
  });

  it('exposes the duplicate a naive retry would create', async () => {
    const backend = new FakePrBackend({ loseResponseAfterCreate: true, lostResponseTimeoutMs: 1 });
    await backend.createPullRequest(prInput).catch(() => undefined);
    await backend.createPullRequest(prInput).catch(() => undefined);
    expect(backend.findByHeadBranch(prInput.headBranch)).toHaveLength(2);
  });
});

describe('FakePrBackend — ci_failure', () => {
  it('reports failure for an existing PR', async () => {
    const backend = new FakePrBackend({ alwaysFailCi: true });
    const pr = await backend.createPullRequest(prInput);
    expect(backend.getCiStatus(pr.number)).toBe('failure');
  });

  it('stays red across repeated queries', async () => {
    const backend = new FakePrBackend({ alwaysFailCi: true });
    const pr = await backend.createPullRequest(prInput);
    expect([1, 2, 3].map(() => backend.getCiStatus(pr.number))).toEqual([
      'failure',
      'failure',
      'failure',
    ]);
  });
});

describe('FakePrBackend — findByHeadBranch', () => {
  it('filters by branch', async () => {
    const backend = new FakePrBackend();
    await backend.createPullRequest(prInput);
    await backend.createPullRequest({ ...prInput, headBranch: 'eval/task-2-baseline' });
    expect(backend.findByHeadBranch(prInput.headBranch)).toHaveLength(1);
  });

  it('returns an empty list for an unknown branch', () => {
    expect(new FakePrBackend().findByHeadBranch('nope')).toEqual([]);
  });
});
