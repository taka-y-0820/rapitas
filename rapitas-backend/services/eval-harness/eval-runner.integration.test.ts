/**
 * eval-runner.integration.test
 *
 * Runs the harness end to end with REAL side effects — a real bare git
 * repository on disk as `origin`, and a real child process for the agent — so
 * the fault scenarios are exercised as actual process exits and actual pushes
 * rather than as mocked return values. Only the database is substituted, by an
 * in-memory client, because the guard in db-guard.ts deliberately refuses to
 * connect anywhere without an explicit `*_eval` URL.
 *
 * Deleting stub-agent-provider.ts turns these cases red: the runner has no
 * other way to produce an agent.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { assertNotLivePort, EVAL_MODE_ENV, executeEvalRun, planForScenario } from './eval-runner';
import type { EvalTestRunner } from './eval-runner';
import type { EvalCorpusTaskRow, EvalPrismaClient, EvalRunRow } from './eval-prisma-client';
import { FAULT_SCENARIOS, STUB_MARKER_FILE } from './stub-agent-cli';
import { existsSync } from 'fs';
import { join } from 'path';

/** Rows captured by the in-memory client, for assertions. */
interface MemoryDb {
  client: EvalPrismaClient;
  runs: EvalRunRow[];
}

/** Builds an in-memory stand-in for the eval Prisma client. */
function createMemoryClient(): MemoryDb {
  const runs: EvalRunRow[] = [];
  const delegate = (sink: Record<string, unknown>[]) => ({
    async create({ data }: { data: Record<string, unknown> }) {
      const row = { id: sink.length + 1, ...data };
      sink.push(row);
      return row;
    },
    async findMany() {
      return sink;
    },
    async update({ data }: { data: Record<string, unknown> }) {
      return data;
    },
    async upsert({ create }: { create: Record<string, unknown> }) {
      sink.push(create);
      return create;
    },
    async count() {
      return sink.length;
    },
    async deleteMany() {
      const count = sink.length;
      sink.length = 0;
      return { count };
    },
  });

  const client = {
    evalCorpusTask: delegate([]),
    evalRun: delegate(runs as unknown as Record<string, unknown>[]),
    evalMetricSnapshot: delegate([]),
    async $disconnect() {},
  } as unknown as EvalPrismaClient;

  return { client, runs };
}

const corpusTask: EvalCorpusTaskRow = {
  id: 1,
  sourceTaskId: 4242,
  category: 'bug_fix',
  split: 'eval',
  classificationConfidence: 0.9,
  classificationMethod: 'title_prefix_bug',
  baseCommitSha: 'aaaaaaa',
  fixCommitSha: 'bbbbbbb',
  protectedTestFiles: JSON.stringify(['services/foo/foo.test.ts']),
  problemStatement: '[Bug] example problem',
  title: '[Bug] example problem',
};

// executeEvalRun sets RAPITAS_EVAL_MODE on purpose, so every case in this file
// mutates process.env. Restore it so the leak does not reach other test files
// (tests/setup/global-state-guard.ts warns on exactly this).
const originalEvalMode = process.env[EVAL_MODE_ENV];
afterEach(() => {
  if (originalEvalMode === undefined) delete process.env[EVAL_MODE_ENV];
  else process.env[EVAL_MODE_ENV] = originalEvalMode;
});

/** Grades a run by whether the stub produced its marker file. */
const markerRunner: EvalTestRunner = {
  async runAcceptanceTests(workdir) {
    return existsSync(join(workdir, STUB_MARKER_FILE));
  },
  async runRegressionTests(workdir) {
    return existsSync(join(workdir, STUB_MARKER_FILE));
  },
};

describe('assertNotLivePort', () => {
  it('rejects the live backend port', () => {
    expect(() => assertNotLivePort(3001)).toThrow(/live dev server/);
  });

  it('rejects the frontend port', () => {
    expect(() => assertNotLivePort(3000)).toThrow(/live dev server/);
  });

  it('accepts the harness port', () => {
    expect(() => assertNotLivePort(3220)).not.toThrow();
  });
});

describe('planForScenario', () => {
  it('turns on exactly one switch per fault scenario', () => {
    expect(planForScenario('ci_failure').failCi).toBe(true);
    expect(planForScenario('ci_failure').faultDbWrites).toBe(false);
    expect(planForScenario('db_write_failure').faultDbWrites).toBe(true);
  });

  it('turns on no switch for baseline', () => {
    expect(Object.values(planForScenario('baseline')).every((flag) => flag === false)).toBe(true);
  });
});

describe('executeEvalRun — through a real bare remote and child process', () => {
  it('grades the no-fault control as a pass', async () => {
    const db = createMemoryClient();
    const run = await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'baseline', runBatchId: 'batch-it' },
    );
    expect(run.outcome).toBe('pass');
    expect(run.failToPass).toBe(true);
    expect(run.passToPass).toBe(true);
    expect(db.runs).toHaveLength(1);
  }, 60000);

  it('treats a CLI that dies right after being stopped as a failure', async () => {
    const db = createMemoryClient();
    const run = await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'cli_exit_after_stop', runBatchId: 'batch-it' },
    );
    expect(run.outcome).toBe('fail');
    // Accuracy is not measured on fault scenarios.
    expect(run.failToPass).toBeNull();
    expect(JSON.parse(run.metadata).exitCode).toBe(1);
  }, 60000);

  it('leaves a red-CI run unmerged', async () => {
    const db = createMemoryClient();
    const run = await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'ci_failure', runBatchId: 'batch-it' },
    );
    expect(run.outcome).toBe('fail');
    expect(run.ciResult).toBe('failure');
    expect(run.mergeAttempted).toBe(false);
    expect(run.stopToCompletionMs).not.toBeNull();
  }, 60000);

  it('recovers from a lost PR-creation response without opening a duplicate', async () => {
    const db = createMemoryClient();
    const run = await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'response_lost_after_pr', runBatchId: 'batch-it' },
    );
    expect(run.repairAttempts).toBe(1);
    expect(JSON.parse(run.metadata).prsOnBranch).toBe(1);
    expect(run.humanInterventionCount).toBe(0);
  }, 60000);

  it('still persists the run row after an injected DB write failure', async () => {
    const db = createMemoryClient();
    const run = await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'db_write_failure', runBatchId: 'batch-it' },
    );
    expect(db.runs).toHaveLength(1);
    expect(JSON.parse(run.metadata).injectedDbFailures).toBe(1);
    expect(run.faultInjectedAt).not.toBeNull();
  }, 60000);

  it('measures stop-to-completion when stopped mid-run', async () => {
    const db = createMemoryClient();
    const run = await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'stop_during_verification', runBatchId: 'batch-it' },
    );
    expect(run.faultInjectedAt).not.toBeNull();
    expect(typeof run.stopToCompletionMs).toBe('number');
  }, 60000);

  it('does not open a second PR when the completion callback arrives twice', async () => {
    const db = createMemoryClient();
    const run = await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'duplicate_callback', runBatchId: 'batch-it' },
    );
    // The duplicate delivery must leave exactly one PR on the branch; two would
    // mean the callback path is not idempotent.
    expect(JSON.parse(run.metadata).duplicateCallbackPrCount).toBe(1);
    expect(run.faultInjectedAt).not.toBeNull();
    expect(db.runs).toHaveLength(1);
  }, 60000);

  it('survives the agent process being killed mid-run', async () => {
    const db = createMemoryClient();
    const run = await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'process_restart', runBatchId: 'batch-it' },
    );
    // The row must still land after the process dies — that persistence is the
    // whole point of the restart scenario.
    expect(db.runs).toHaveLength(1);
    expect(run.faultInjectedAt).not.toBeNull();
    expect(typeof run.stopToCompletionMs).toBe('number');
  }, 60000);

  it('marks the process as an evaluation run before launching the agent', async () => {
    delete process.env[EVAL_MODE_ENV];
    const db = createMemoryClient();
    await executeEvalRun(
      { prisma: db.client, testRunner: markerRunner },
      { corpusTask, scenario: 'baseline', runBatchId: 'batch-it' },
    );
    expect(process.env[EVAL_MODE_ENV]).toBe('1');
  }, 60000);
});

describe('every fault scenario is exercised end to end', () => {
  it('covers all eight scenarios across this file', () => {
    // Guards against a scenario being added to FAULT_SCENARIOS without a
    // matching through-run above — the silent coverage gap this file exists
    // to prevent.
    const covered = new Set([
      'baseline',
      'cli_exit_after_stop',
      'ci_failure',
      'response_lost_after_pr',
      'db_write_failure',
      'stop_during_verification',
      'duplicate_callback',
      'process_restart',
    ]);
    expect([...FAULT_SCENARIOS].filter((s) => !covered.has(s))).toEqual([]);
    expect(covered.size).toBe(FAULT_SCENARIOS.length);
  });
});
