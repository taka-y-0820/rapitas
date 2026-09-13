/**
 * FakePrBackend
 *
 * Stands in for GitHub during an eval run: it records PR creation and reports
 * CI status, and it can misbehave in the two ways the harness needs to
 * measure.
 *
 * The point is NOT to emulate GitHub's API. It is to put the orchestrator into
 * the two states that are hard to produce on demand against the real thing:
 *   - `response_lost_after_pr` — the PR really was created, but the caller
 *     never learns it. A caller that retries here creates a duplicate PR.
 *   - `ci_failure` — checks come back red forever.
 *
 * Never performs network I/O.
 */

/** Terminal CI verdicts the fake reports. */
export type FakeCiStatus = 'success' | 'failure' | 'pending';

/** A PR recorded by the fake backend. */
export interface FakePullRequest {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  /** Commit SHA the PR was opened against. */
  headSha: string;
  createdAt: Date;
}

/** Behaviour switches driven by the scenario under test. */
export interface FakePrBackendOptions {
  /** Confirm the PR internally but never return it to the caller. */
  loseResponseAfterCreate?: boolean;
  /** Report `failure` for every CI query. */
  alwaysFailCi?: boolean;
  /** Milliseconds a lost response hangs before rejecting. */
  lostResponseTimeoutMs?: number;
}

/** Error surfaced to a caller whose PR-creation response was dropped. */
export class LostResponseError extends Error {
  constructor(public readonly prNumber: number) {
    super(
      `Connection reset after the pull request was created (PR #${prNumber} exists server-side)`,
    );
    this.name = 'LostResponseError';
  }
}

/** Default hang before a dropped response rejects. */
export const DEFAULT_LOST_RESPONSE_TIMEOUT_MS = 50;

/**
 * In-memory stand-in for the GitHub PR + checks API.
 */
export class FakePrBackend {
  private readonly prs: FakePullRequest[] = [];
  private nextNumber = 1;

  constructor(private readonly options: FakePrBackendOptions = {}) {}

  /**
   * Creates a pull request.
   *
   * @param input - PR fields / PRのフィールド
   * @returns The created PR / 作成されたPR
   * @throws {LostResponseError} When configured to drop the response — the PR is still recorded / 応答喪失設定時（PRは記録済み）
   */
  async createPullRequest(input: {
    title: string;
    headBranch: string;
    baseBranch: string;
    headSha: string;
  }): Promise<FakePullRequest> {
    const pr: FakePullRequest = {
      number: this.nextNumber++,
      title: input.title,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      headSha: input.headSha,
      createdAt: new Date(),
    };
    // Commit the side effect BEFORE deciding whether to answer. That ordering
    // is the whole scenario: server state advanced, caller was not told.
    this.prs.push(pr);

    if (this.options.loseResponseAfterCreate) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.lostResponseTimeoutMs ?? DEFAULT_LOST_RESPONSE_TIMEOUT_MS),
      );
      throw new LostResponseError(pr.number);
    }

    return pr;
  }

  /**
   * Returns the CI verdict for a PR.
   *
   * @param prNumber - PR number / PR番号
   * @returns The CI status / CIの状態
   */
  getCiStatus(prNumber: number): FakeCiStatus {
    if (this.options.alwaysFailCi) return 'failure';
    return this.prs.some((pr) => pr.number === prNumber) ? 'success' : 'pending';
  }

  /**
   * Returns every PR recorded so far, including ones whose response was lost.
   *
   * @returns Recorded pull requests / 記録済みのPR一覧
   */
  listPullRequests(): FakePullRequest[] {
    return [...this.prs];
  }

  /**
   * Returns PRs opened for the same head branch.
   *
   * Lets a run detect the duplicate-PR damage that retrying a lost response
   * causes.
   *
   * @param headBranch - Branch to inspect / 対象ブランチ
   * @returns PRs on that branch / そのブランチのPR一覧
   */
  findByHeadBranch(headBranch: string): FakePullRequest[] {
    return this.prs.filter((pr) => pr.headBranch === headBranch);
  }
}
