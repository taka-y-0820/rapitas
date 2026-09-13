/**
 * EvalRunGrading
 *
 * Decides what a completed eval run is WORTH: pushes the result to the
 * throwaway remote, walks it through the fake PR/CI backend, runs the graded
 * suites, and re-checks for regression after merging. Also owns the run row's
 * write, because the injected-DB-failure count is only knowable once that
 * write has been attempted.
 *
 * Split out of `eval-runner.ts`, which owns the execution half (worktree
 * setup, provider selection, fault timing).
 */
import { createLogger } from '../../config/logger';
import { InjectedDbWriteError, type FaultInjectedClient } from './db-write-fault-injector';
import type { EvalCorpusTaskRow, EvalPrismaClient, EvalRunRow } from './eval-prisma-client';
import { commitAndPush, mergeIntoDefault, type FakeGitRemote } from './fake-git-remote';
import { FakePrBackend, LostResponseError } from './fake-pr-backend';
import type { EvalOutcome, EvalRunnerDeps, ScenarioPlan } from './eval-runner';

const log = createLogger('eval-run-grading');

/** Grading result for a run whose agent finished successfully. */
export interface GradeResult {
  outcome: EvalOutcome;
  reason: string | null;
  failToPass: boolean | null;
  passToPass: boolean | null;
  ciResult: string | null;
  mergeAttempted: boolean;
  mergedRegressionDetected: boolean;
  repairAttempts: number;
  humanInterventionCount: number;
  faultInjectedAt: Date | null;
  metadata: Record<string, unknown>;
}

/**
 * Grades a completed run: PR creation, CI, test suites, and post-merge check.
 *
 * @param deps - Injected collaborators / 注入された協調オブジェクト
 * @param remote - The throwaway remote / 使い捨てリモート
 * @param corpusTask - Corpus row being run / 実行中のコーパス行
 * @param isBaseline - Whether accuracy is being measured / 精度測定対象かどうか
 * @param prBackend - Fake PR/CI backend / 疑似PR/CIバックエンド
 * @param plan - Scenario switches / シナリオのスイッチ
 * @param branch - Branch the run pushed / 実行がpushしたブランチ
 * @returns The grading outcome / 判定結果
 */
export async function gradeRun(
  deps: EvalRunnerDeps,
  remote: FakeGitRemote,
  corpusTask: EvalCorpusTaskRow,
  isBaseline: boolean,
  prBackend: FakePrBackend,
  plan: ScenarioPlan,
  branch: string,
): Promise<GradeResult> {
  const metadata: Record<string, unknown> = {};
  let faultInjectedAt: Date | null = null;
  let humanInterventionCount = 0;
  let repairAttempts = 0;

  const headSha = await commitAndPush(remote, branch, `feat(eval): run ${corpusTask.sourceTaskId}`);
  if (headSha === null) {
    // Nothing was written — an empty diff cannot be a pass, and calling it one
    // is precisely the false-completion this harness exists to count.
    return {
      outcome: 'false_complete',
      reason: 'empty_diff',
      failToPass: isBaseline ? false : null,
      passToPass: null,
      ciResult: null,
      mergeAttempted: false,
      mergedRegressionDetected: false,
      repairAttempts,
      humanInterventionCount,
      faultInjectedAt,
      metadata,
    };
  }

  let prNumber: number | null = null;
  try {
    const pr = await prBackend.createPullRequest({
      title: `[eval] ${corpusTask.title}`,
      headBranch: branch,
      baseBranch: remote.defaultBranch,
      headSha,
    });
    prNumber = pr.number;
  } catch (error) {
    if (error instanceof LostResponseError) {
      faultInjectedAt = new Date();
      prNumber = error.prNumber;
      // Recovering by LOOKING UP the branch rather than retrying creation is
      // the behaviour under test; a retry here would open a duplicate PR.
      const existing = prBackend.findByHeadBranch(branch);
      metadata.prsOnBranch = existing.length;
      humanInterventionCount = existing.length > 1 ? 1 : 0;
      repairAttempts = 1;
    } else {
      throw error;
    }
  }

  if (plan.duplicateCallback) {
    faultInjectedAt = new Date();
    // The same completion callback arriving twice must not produce two PRs.
    const before = prBackend.findByHeadBranch(branch).length;
    metadata.duplicateCallbackPrCount = before;
    repairAttempts = 1;
  }

  const ci = prNumber !== null ? prBackend.getCiStatus(prNumber) : 'pending';
  if (plan.failCi) faultInjectedAt = faultInjectedAt ?? new Date();

  const acceptanceOk = await deps.testRunner.runAcceptanceTests(remote.workdirPath, corpusTask);
  const regressionOk = await deps.testRunner.runRegressionTests(remote.workdirPath, corpusTask);

  let mergedRegressionDetected = false;
  const mergeAttempted = ci === 'success' && acceptanceOk && regressionOk;
  if (mergeAttempted) {
    const merged = await mergeIntoDefault(remote, branch);
    metadata.merged = merged;
    if (merged) {
      // Re-run AFTER merging: a regression that only appears once the change
      // meets the default branch is invisible to the pre-merge run.
      mergedRegressionDetected = !(await deps.testRunner.runRegressionTests(
        remote.workdirPath,
        corpusTask,
      ));
    }
  }

  const passed = ci === 'success' && acceptanceOk && regressionOk && !mergedRegressionDetected;
  return {
    outcome: passed ? 'pass' : 'fail',
    reason: passed ? null : ci !== 'success' ? `ci_${ci}` : 'tests_failed',
    // Accuracy is only meaningful when a real agent wrote the code.
    failToPass: isBaseline ? acceptanceOk : null,
    passToPass: isBaseline ? regressionOk : null,
    ciResult: ci,
    mergeAttempted,
    mergedRegressionDetected,
    repairAttempts,
    humanInterventionCount,
    faultInjectedAt,
    metadata,
  };
}

/**
 * Writes the run row, tolerating an injected write failure by retrying on the
 * unwrapped client.
 *
 * Metadata is serialized HERE, not by the caller: the number of injected
 * failures is only known once the faulted write has actually been attempted,
 * and a count captured beforehand would always read zero.
 *
 * @param prisma - Unwrapped eval client / ラップされていない評価クライアント
 * @param fault - Fault-injecting wrapper, when the scenario uses one / 故障注入ラッパー
 * @param metadata - Mutable metadata bag serialized into the row / 行に格納するメタデータ
 * @param data - Remaining row columns / 残りのカラム
 * @returns The persisted row / 永続化された行
 */
export async function persistRun(
  prisma: EvalPrismaClient,
  fault: FaultInjectedClient | null,
  metadata: Record<string, unknown>,
  data: Record<string, unknown>,
): Promise<EvalRunRow> {
  if (fault) {
    try {
      return await fault.client.evalRun.create({
        data: { ...data, metadata: JSON.stringify({ ...metadata, injectedDbFailures: 0 }) },
      });
    } catch (error) {
      if (!(error instanceof InjectedDbWriteError)) throw error;
      // Surviving the injected failure IS the measurement: the row must still
      // land, so the recovery path writes through the unwrapped client.
      log.info({ err: error.message }, 'Recovered from injected DB write failure');
      metadata.injectedDbFailures = fault.injectedFailureCount();
    }
  }
  return prisma.evalRun.create({ data: { ...data, metadata: JSON.stringify(metadata) } });
}
