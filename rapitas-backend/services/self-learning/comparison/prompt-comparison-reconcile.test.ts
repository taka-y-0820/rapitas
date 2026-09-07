/** Real manifest/record I/O, with authoritative DB snapshots supplied by a query mock. */
import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TrialSessionSnapshot } from './prompt-comparison-reconcile';
let sessions: TrialSessionSnapshot[] = [];
const findMany = mock(async (args: { where: { id: { in: number[] } } }) =>
  sessions.filter((s) => args.where.id.in.includes(s.id)),
);
mock.module('../../../config/database', () => ({
  ensureDatabaseConnection: async () => {},
  prisma: { agentSession: { findMany } },
}));
mock.module('../../agents/execution-file-logger/attempt-metrics-reader', () => ({
  readExecutionAttemptMetrics: async (id: number) => {
    const e = sessions.flatMap((s) => s.agentExecutions).find((e) => e.id === id);
    return e
      ? [
          {
            success: e.status === 'completed',
            costUsd: e.costUsd == null ? null : Number(e.costUsd),
            executionTimeMs: e.executionTimeMs,
            modelName: e.modelName,
          },
        ]
      : null;
  },
}));
const { reconcileTrialOutcomes } = await import('./prompt-comparison-reconcile');
const { initComparisonRecordForStaging, readComparisonRecord, recordComparisonRun } =
  await import('./prompt-comparison-store');
const { reserveTrialSlot, bindTrialSession } = await import('./prompt-comparison-trial-manifest');
const { assignArm } = await import('./prompt-comparison-randomization');
const seed = Array.from({ length: 100 }, (_, i) => `seed-${i}`).find(
  (s) => assignArm(s, 0) === 'candidate',
)!;
let directory: string;
let previous: string | undefined;
beforeEach(() => {
  sessions = [];
  findMany.mockClear();
  directory = mkdtempSync(join(tmpdir(), 'rapitas-replay-'));
  previous = process.env.RAPITAS_DATA_DIR;
  process.env.RAPITAS_DATA_DIR = directory;
  initComparisonRecordForStaging({
    promptEvolutionId: 1,
    role: 'implementer',
    createdAt: new Date(0).toISOString(),
  });
});
afterEach(() => {
  if (previous === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});
function prepare(proof = true) {
  const reservation = reserveTrialSlot(
    {
      promptEvolutionId: 1,
      role: 'implementer',
      candidateVersion: 'candidate-v1',
      controlVersion: null,
      seed,
    },
    10,
    () => true,
  );
  if (reservation.issue !== null) throw new Error(reservation.issue);
  bindTrialSession(
    1,
    reservation.slot.id,
    100,
    proof
      ? {
          injected: true,
          injectedVersion: 'candidate-v1',
          controlVersion: null,
        }
      : undefined,
  );
  return reservation.slot;
}
function snapshot(): TrialSessionSnapshot {
  return {
    id: 100,
    status: 'completed',
    mode: 'workflow-implementer',
    config: { taskId: 10 },
    agentExecutions: [
      {
        id: 1000,
        status: 'completed',
        modelName: 'reported-model',
        costUsd: '0.2',
        executionTimeMs: 5000,
        startedAt: new Date(0),
        completedAt: new Date(5000),
        errorMessage: null,
      },
    ],
  };
}
function outcomes() {
  return readComparisonRecord(1)!.arms.flatMap((c) => c.runs);
}

it('recovery includes failed fallback costs and durations with execution provenance', async () => {
  prepare();
  const session = snapshot();
  session.agentExecutions.push({
    ...session.agentExecutions[0],
    id: 999,
    status: 'failed',
    costUsd: '0.4',
    executionTimeMs: 3000,
    modelName: 'fallback-source',
  });
  sessions = [session];
  expect((await reconcileTrialOutcomes(1)).recovered).toBe(1);
  expect(outcomes()[0].costUsd).toBeCloseTo(0.6, 12);
  expect(outcomes()[0]).toMatchObject({
    durationMs: 8000,
    executionIds: [1000, 999],
    executionModels: ['reported-model', 'fallback-source'],
  });
});

it('an unknown earlier cost cannot become a zero-cost fallback', async () => {
  prepare();
  const session = snapshot();
  session.agentExecutions.push({
    ...session.agentExecutions[0],
    id: 999,
    status: 'failed',
    costUsd: null,
  });
  sessions = [session];
  expect((await reconcileTrialOutcomes(1)).issues[0].reason).toBe('execution_metadata_incomplete');
  expect(outcomes()).toHaveLength(0);
});

it('replays a missed terminal outcome once with real cost, model, and injection provenance', async () => {
  const slot = prepare();
  sessions = [snapshot()];
  expect(await reconcileTrialOutcomes(1)).toEqual({ recovered: 1, pending: 0, issues: [] });
  expect(outcomes()[0]).toMatchObject({
    assignmentId: slot.id,
    recoveredFromSessionId: 100,
    executionId: 1000,
    success: true,
    costUsd: 0.2,
    durationMs: 5000,
    modelName: 'reported-model',
    injectedVersion: 'candidate-v1',
  });
  expect(await reconcileTrialOutcomes(1)).toEqual({ recovered: 0, pending: 0, issues: [] });
  expect(findMany).toHaveBeenCalledTimes(1);
  expect(outcomes()).toHaveLength(1);
});

it.each(['active', 'running', 'post_processing', 'canceling', 'waiting_for_input'])(
  'waits on %s and recovers after terminalization',
  async (status) => {
    prepare();
    sessions = [{ ...snapshot(), status }];
    expect((await reconcileTrialOutcomes(1)).pending).toBe(1);
    expect(outcomes()).toHaveLength(0);
    sessions[0].status = 'completed';
    expect((await reconcileTrialOutcomes(1)).recovered).toBe(1);
  },
);

it('a completed session with a running child is still pending', async () => {
  prepare();
  sessions = [snapshot()];
  sessions[0].agentExecutions[0].status = 'running';
  expect((await reconcileTrialOutcomes(1)).pending).toBe(1);
  expect(outcomes()).toHaveLength(0);
});

it.each(['failed', 'cancelled'])(
  'a %s phase cannot be credited with the CLI completed status',
  async (status) => {
    prepare();
    sessions = [{ ...snapshot(), status }];
    expect((await reconcileTrialOutcomes(1)).recovered).toBe(1);
    expect(outcomes()[0].success).toBe(false);
  },
);

it('an arm assignment without persisted injection proof never becomes an intervention outcome', async () => {
  const slot = prepare(false);
  sessions = [snapshot()];
  expect(
    bindTrialSession(1, slot.id, 100, {
      injected: true,
      injectedVersion: 'candidate-v1',
      controlVersion: null,
    }),
  ).toBe(false);
  expect((await reconcileTrialOutcomes(1)).issues[0].reason).toBe(
    'injection_proof_missing_or_mismatched',
  );
  expect(outcomes()).toHaveLength(0);
});

it('a mismatched task or role is not replayed', async () => {
  prepare();
  sessions = [snapshot()];
  sessions[0].config.taskId = 11;
  expect((await reconcileTrialOutcomes(1)).issues[0].reason).toBe('session_identity_mismatch');
  sessions[0] = { ...snapshot(), mode: 'workflow-planner' };
  expect((await reconcileTrialOutcomes(1)).issues[0].reason).toBe('session_identity_mismatch');
  expect(outcomes()).toHaveLength(0);
});

it('a successful retry does not replace the original failed attempt', async () => {
  const slot = prepare();
  bindTrialSession(1, slot.id, 101, {
    injected: true,
    injectedVersion: 'candidate-v1',
    controlVersion: null,
  });
  sessions = [
    { ...snapshot(), status: 'failed' },
    { ...snapshot(), id: 101 },
  ];
  await reconcileTrialOutcomes(1);
  expect(outcomes()[0]).toMatchObject({ recoveredFromSessionId: 100, success: false });
});

it('query failures leave state unchanged for the next cycle', async () => {
  prepare();
  const result = await reconcileTrialOutcomes(1, async () => {
    throw new Error('db unavailable');
  });
  expect(result.pending).toBe(1);
  expect(result.issues[0].reason).toBe('session_read_failed');
  expect(outcomes()).toHaveLength(0);
});

it('duration recovery uses fixed execution timestamps, never the recovery clock', async () => {
  prepare();
  sessions = [snapshot()];
  sessions[0].agentExecutions[0].executionTimeMs = null;
  await reconcileTrialOutcomes(1);
  expect(outcomes()[0].durationMs).toBe(5000);
});

it('unknown model or absent execution remains diagnosable and is not fabricated', async () => {
  prepare();
  sessions = [snapshot()];
  sessions[0].agentExecutions[0].modelName = null;
  expect((await reconcileTrialOutcomes(1)).issues[0].reason).toBe('execution_metadata_incomplete');
  sessions[0].agentExecutions = [];
  expect((await reconcileTrialOutcomes(1)).issues[0].reason).toBe('execution_missing');
  expect(outcomes()).toHaveLength(0);
});

it('a concurrent live append wins without being overwritten or counted again', async () => {
  const slot = prepare();
  const result = await reconcileTrialOutcomes(1, async () => {
    recordComparisonRun(1, slot.arm, {
      assignmentId: slot.id,
      taskId: 10,
      executionId: 1000,
      success: true,
      costUsd: 0.3,
      durationMs: 5000,
      modelName: 'reported-model',
      role: 'implementer',
      injected: true,
      injectedVersion: 'candidate-v1',
      controlVersion: null,
      failureCause: null,
    });
    return [snapshot()];
  });
  expect(result).toEqual({ recovered: 0, pending: 0, issues: [] });
  expect(outcomes()).toHaveLength(1);
  expect(outcomes()[0].costUsd).toBe(0.3);
});
