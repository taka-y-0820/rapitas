/**
 * Private Eval Set Runner
 *
 * Runs every corpus task in the `eval` split through the baseline scenario and
 * all seven fault injections, then aggregates the nine reported metrics.
 *
 * Complements, and does not replace, `eval-gates.ts`: that harness scores the
 * deterministic gate FUNCTIONS on a golden set; this one scores whole task
 * executions and the orchestrator's behaviour when things break around it.
 *
 * Long-running and DB-backed, so it is never wired into the PR-blocking CI
 * gate — see .github/workflows/eval-private-set.yml.
 *
 * Run: RAPITAS_EVAL_DATABASE_URL=postgresql://.../rapitas_eval \
 *        bun run scripts/eval-private-set.ts [--sampleSize 5] [--split eval]
 */
import {
  createEvalPrismaClient,
  disposeEvalPrismaClient,
  type EvalCorpusTaskRow,
  type EvalRunRow,
} from '../services/eval-harness/eval-prisma-client';
import { executeEvalRun, type EvalTestRunner } from '../services/eval-harness/eval-runner';
import {
  computeMetrics,
  formatMetrics,
  saveMetricSnapshot,
} from '../services/eval-harness/metrics-calculator';
import { FAULT_SCENARIOS, STUB_MARKER_FILE } from '../services/eval-harness/stub-agent-cli';
import { existsSync } from 'fs';
import { join } from 'path';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const sampleSize = Number.parseInt(flag('--sampleSize') ?? '0', 10);
const split = flag('--split') ?? 'eval';

/** Batch id derived from the wall clock so snapshots stay comparable. */
const runBatchId = `batch-${new Date().toISOString().replace(/[:.]/g, '-')}`;

/**
 * The default grader.
 *
 * NOTE: With the stub provider there is no real code change to grade, so the
 * suites are reduced to "did the run produce its expected artifact". Wiring a
 * real per-corpus-task suite requires checking out `baseCommitSha` of the real
 * repository, which the baseline scenario supplies its own runner for.
 */
const markerTestRunner: EvalTestRunner = {
  async runAcceptanceTests(workdir) {
    return existsSync(join(workdir, STUB_MARKER_FILE));
  },
  async runRegressionTests(workdir) {
    return existsSync(join(workdir, STUB_MARKER_FILE));
  },
};

/** Runs the whole batch and reports metrics. */
async function main(): Promise<void> {
  const prisma = createEvalPrismaClient();

  const corpus = (await prisma.evalCorpusTask.findMany({
    where: { split },
    orderBy: { sourceTaskId: 'asc' },
    ...(sampleSize > 0 ? { take: sampleSize } : {}),
  })) as EvalCorpusTaskRow[];

  if (corpus.length === 0) {
    console.error(
      `[eval-set] FAILED: no corpus rows with split="${split}". ` +
        'Run scripts/eval-corpus-seed.ts first.',
    );
    process.exit(1);
  }

  console.log(
    `[eval-set] batch=${runBatchId} corpus=${corpus.length} scenarios=${FAULT_SCENARIOS.length}`,
  );
  // No baselineProvider is injected below, so the baseline scenario also runs on
  // the stub. Its failToPass/passToPass therefore measure the harness, not an
  // agent's coding ability. Stated loudly because a reader who mistook these for
  // real accuracy would draw the opposite conclusion from the truth.
  console.warn(
    '[eval-set] WARNING: baseline runs on the stub provider — fail-to-pass / pass-to-pass in ' +
      'this batch do NOT measure real agent accuracy. Inject a real provider to measure it.',
  );

  const runs: EvalRunRow[] = [];
  for (const corpusTask of corpus) {
    for (const scenario of FAULT_SCENARIOS) {
      const run = await executeEvalRun(
        { prisma, testRunner: markerTestRunner },
        { corpusTask, scenario, runBatchId },
      );
      runs.push(run);
      console.log(
        `[eval-set]   #${corpusTask.sourceTaskId} ${scenario}: ${run.outcome}` +
          (run.outcomeReason ? ` (${run.outcomeReason})` : ''),
      );
    }
  }

  // Overall slice first, then one per scenario so a single bad fault mode is
  // visible instead of being averaged away.
  await saveMetricSnapshot(prisma, runBatchId, runs);
  for (const scenario of FAULT_SCENARIOS) {
    const slice = runs.filter((run) => run.scenario === scenario);
    if (slice.length > 0) await saveMetricSnapshot(prisma, runBatchId, slice, { scenario });
  }

  console.log('');
  for (const line of formatMetrics('Overall', computeMetrics(runs))) console.log(line);

  const errored = runs.filter((run) => run.outcome === 'error');
  const falseCompletions = runs.filter((run) => run.outcome === 'false_complete');
  console.log(
    `\n[eval-set] runs=${runs.length} errored=${errored.length} false_complete=${falseCompletions.length}`,
  );

  await disposeEvalPrismaClient();

  if (errored.length > 0) {
    // An errored run means the HARNESS broke, not the agent — that invalidates
    // the batch and must fail loudly rather than be reported as a low score.
    console.error(
      `[eval-set] FAILED: ${errored.length} run(s) errored:\n` +
        errored.map((run) => `  - ${run.scenario}: ${run.outcomeReason}`).join('\n'),
    );
    process.exit(1);
  }
  // NOTE: Explicit exit — mirrors eval-gates.ts, where Prisma's connection-pool
  // keep-alive was observed holding the process open after all work finished.
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`[eval-set] FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
