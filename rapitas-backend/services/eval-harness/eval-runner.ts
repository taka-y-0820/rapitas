/**
 * EvalRunner
 *
 * Executes exactly one (corpus task x scenario) pair and writes the single
 * `EvalRun` row every metric is later aggregated from. Owns the wiring of the
 * throwaway remote, the agent provider, the injected fault, and the acceptance
 * guard.
 *
 * Owns no aggregation: `metrics-calculator.ts` reads the rows this produces.
 */
import { createLogger } from '../../config/logger';
import type { IAgentProvider } from '../agents/abstraction/interfaces';
import type { AgentProviderConfig } from '../agents/abstraction/types';
import {
  ACCEPTANCE_TEST_MODIFIED_REASON,
  checkAcceptanceTestsUntouched,
  parseProtectedTestFiles,
} from './acceptance-test-guard';
import { injectDbWriteFault } from './db-write-fault-injector';
import type { EvalCorpusTaskRow, EvalPrismaClient, EvalRunRow } from './eval-prisma-client';
import { createFakeRemote, destroyFakeRemote, git, type FakeGitRemote } from './fake-git-remote';
import { FakePrBackend } from './fake-pr-backend';
import { gradeRun, persistRun } from './eval-run-grading';
import { EVAL_STUB_PROVIDER_ID, StubAgentProvider } from './stub-agent-provider';
import type { FaultScenario } from './stub-agent-cli';

const log = createLogger('eval-runner');

/**
 * Port reserved for any backend the harness starts.
 *
 * NOTE: 3001 hosts the live agent connection and 3000 the frontend; binding
 * either would sever a running session (see CLAUDE.md CRITICAL CONSTRAINTS).
 * `assertNotLivePort` makes that a startup abort rather than an incident.
 */
export const EVAL_BACKEND_PORT = 3220;

/** Outcome vocabulary stored in `EvalRun.outcome`. */
export type EvalOutcome = 'pass' | 'fail' | 'false_complete' | 'error';

/** Environment variable marking the process as an evaluation run. */
export const EVAL_MODE_ENV = 'RAPITAS_EVAL_MODE';

/**
 * Marks this process as an evaluation run.
 *
 * NOTE: Currently INERT — nothing reads this flag yet. It is set here, at the
 * only place that launches an agent against a corpus task, so that the future
 * suppression of knowledge-base / episodic recall has a single hook to key
 * off. Recall is not blocked today, so baseline accuracy may still be inflated
 * by the agent remembering the original fix (see docs/eval-private-set.md,
 * "Known limitations"). Do not read this as memory isolation being implemented.
 */
export function markEvalModeActive(): void {
  process.env[EVAL_MODE_ENV] = '1';
}

/** Milliseconds the stub stays alive so a mid-run stop can land. */
const STOPPABLE_HOLD_MS = 400;

/**
 * Aborts when a port that must never be bound by the harness is requested.
 *
 * @param port - Port about to be bound / これからバインドしようとするポート
 * @throws {Error} When the port belongs to the live dev servers / ライブ開発サーバーのポートの場合
 */
export function assertNotLivePort(port: number): void {
  if (port === 3001 || port === 3000) {
    throw new Error(
      `[eval-harness] FATAL: port ${port} is the live dev server. The eval harness must use ` +
        `${EVAL_BACKEND_PORT} or another free port.`,
    );
  }
}

/** Runs the graded test suites for a corpus task inside a worktree. */
export interface EvalTestRunner {
  /** True when the acceptance tests pass (the fail-to-pass target). */
  runAcceptanceTests(workdir: string, corpusTask: EvalCorpusTaskRow): Promise<boolean>;
  /** True when the previously-green suite is still green (pass-to-pass). */
  runRegressionTests(workdir: string, corpusTask: EvalCorpusTaskRow): Promise<boolean>;
}

/** Everything a run needs, injected so tests stay hermetic. */
export interface EvalRunnerDeps {
  prisma: EvalPrismaClient;
  /** Provider used for `baseline`; the stub is built internally otherwise. */
  baselineProvider?: IAgentProvider;
  testRunner: EvalTestRunner;
}

/** Parameters of a single run. */
export interface EvalRunRequest {
  corpusTask: EvalCorpusTaskRow;
  scenario: FaultScenario;
  runBatchId: string;
  attemptNumber?: number;
}

/** Scenario-specific behaviour, derived once so the flow below stays flat. */
export interface ScenarioPlan {
  losePrResponse: boolean;
  failCi: boolean;
  faultDbWrites: boolean;
  stopMidRun: boolean;
  restartProcess: boolean;
  duplicateCallback: boolean;
}

/**
 * Maps a scenario onto the switches the run flow reads.
 *
 * @param scenario - Scenario being executed / 実行するシナリオ
 * @returns The behaviour switches for that scenario / そのシナリオの挙動スイッチ
 */
export function planForScenario(scenario: FaultScenario): ScenarioPlan {
  return {
    losePrResponse: scenario === 'response_lost_after_pr',
    failCi: scenario === 'ci_failure',
    faultDbWrites: scenario === 'db_write_failure',
    stopMidRun: scenario === 'stop_during_verification',
    restartProcess: scenario === 'process_restart',
    duplicateCallback: scenario === 'duplicate_callback',
  };
}

/** Provider config handed to the stub for a scenario. */
function stubConfigFor(scenario: FaultScenario, plan: ScenarioPlan): AgentProviderConfig {
  return {
    providerId: EVAL_STUB_PROVIDER_ID,
    enabled: true,
    customConfig: {
      fault: scenario,
      holdMs: plan.stopMidRun || plan.restartProcess ? STOPPABLE_HOLD_MS : 0,
    },
  } as AgentProviderConfig;
}

/** Files the run changed in the throwaway clone, relative to its first commit. */
async function changedFilesIn(remote: FakeGitRemote): Promise<string[]> {
  const out = await git(remote.workdirPath, ['status', '--porcelain']);
  return out
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
}

/**
 * Executes one corpus task under one scenario and persists the result.
 *
 * @param deps - Injected collaborators / 注入された協調オブジェクト
 * @param request - Which corpus task and scenario to run / 実行対象のコーパスタスクとシナリオ
 * @returns The persisted `EvalRun` row / 永続化されたEvalRun行
 */
export async function executeEvalRun(
  deps: EvalRunnerDeps,
  request: EvalRunRequest,
): Promise<EvalRunRow> {
  assertNotLivePort(EVAL_BACKEND_PORT);

  const { corpusTask, scenario, runBatchId } = request;
  const isBaseline = scenario === 'baseline';
  const plan = planForScenario(scenario);
  const startedAt = new Date();

  const prBackend = new FakePrBackend({
    loseResponseAfterCreate: plan.losePrResponse,
    alwaysFailCi: plan.failCi,
  });
  const dbFault = plan.faultDbWrites
    ? injectDbWriteFault(deps.prisma, { failOnWriteNumber: 1 })
    : null;

  let outcome: EvalOutcome = 'error';
  let outcomeReason: string | null = null;
  let failToPass: boolean | null = null;
  let passToPass: boolean | null = null;
  let repairAttempts = 0;
  let humanInterventionCount = 0;
  let ciResult: string | null = null;
  let mergeAttempted = false;
  let mergedRegressionDetected = false;
  let faultInjectedAt: Date | null = null;
  const metadata: Record<string, unknown> = { scenario };

  const remote = await createFakeRemote(`eval-${corpusTask.sourceTaskId}`);
  try {
    // Set before the agent is created: a real provider may consult recall
    // during construction, not only during execute().
    markEvalModeActive();

    const provider =
      isBaseline && deps.baselineProvider ? deps.baselineProvider : new StubAgentProvider();
    const agent = provider.createAgent(stubConfigFor(scenario, plan));
    const branch = `eval/task-${corpusTask.sourceTaskId}-${scenario}`;

    const execution = agent.execute(
      { id: corpusTask.sourceTaskId, title: corpusTask.title, prompt: corpusTask.problemStatement },
      {
        executionId: `${runBatchId}-${corpusTask.id}-${scenario}`,
        workingDirectory: remote.workdirPath,
        branch,
      },
    );

    if (plan.stopMidRun || plan.restartProcess) {
      faultInjectedAt = new Date();
      // Signal a genuinely running child, mid-flight, rather than cancelling a
      // promise — the orchestrator must cope with a real dead process.
      await new Promise((resolve) => setTimeout(resolve, STOPPABLE_HOLD_MS / 4));
      await agent.stop();
    }

    const result = await execution;
    metadata.agentState = result.state;
    metadata.exitCode = result.debugInfo?.processInfo?.exitCode ?? null;

    if (!result.success) {
      outcome = 'fail';
      outcomeReason = result.errorMessage ?? 'agent_reported_failure';
    } else {
      const changed = await changedFilesIn(remote);
      metadata.changedFiles = changed;

      // Acceptance-test integrity is checked BEFORE grading: a run that edited
      // its own graders is a false completion no matter what the suite says.
      if (isBaseline) {
        const guard = checkAcceptanceTestsUntouched(
          parseProtectedTestFiles(corpusTask.protectedTestFiles),
          changed,
        );
        if (!guard.ok) {
          outcome = 'false_complete';
          outcomeReason = ACCEPTANCE_TEST_MODIFIED_REASON;
          metadata.violatedFiles = guard.violatedFiles;
        }
      }

      if (outcome !== 'false_complete') {
        const graded = await gradeRun(
          deps,
          remote,
          corpusTask,
          isBaseline,
          prBackend,
          plan,
          branch,
        );
        outcome = graded.outcome;
        outcomeReason = graded.reason;
        failToPass = graded.failToPass;
        passToPass = graded.passToPass;
        ciResult = graded.ciResult;
        mergeAttempted = graded.mergeAttempted;
        mergedRegressionDetected = graded.mergedRegressionDetected;
        repairAttempts = graded.repairAttempts;
        humanInterventionCount = graded.humanInterventionCount;
        Object.assign(metadata, graded.metadata);
        if (graded.faultInjectedAt) faultInjectedAt = graded.faultInjectedAt;
      }
    }

    await agent.dispose();
  } catch (error) {
    outcome = 'error';
    outcomeReason = error instanceof Error ? error.message : String(error);
    log.warn({ scenario, corpusTaskId: corpusTask.id, err: outcomeReason }, 'Eval run errored');
  } finally {
    destroyFakeRemote(remote);
  }

  const completedAt = new Date();
  if (dbFault) faultInjectedAt = faultInjectedAt ?? startedAt;

  return persistRun(deps.prisma, dbFault, metadata, {
    runBatchId,
    corpusTaskId: corpusTask.id,
    scenario,
    attemptNumber: request.attemptNumber ?? 1,
    outcome,
    outcomeReason,
    failToPass,
    passToPass,
    humanInterventionCount,
    repairAttempts,
    faultInjectedAt,
    stopToCompletionMs: faultInjectedAt ? completedAt.getTime() - faultInjectedAt.getTime() : null,
    costUsd: 0,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    ciResult,
    mergeAttempted,
    mergedRegressionDetected,
    startedAt,
    completedAt,
  });
}
