/**
 * verification-job-store.test
 *
 * Unit tests for the TimelineEvent-backed job store: running/completed/
 * failed/interrupted (processInstanceId mismatch and stale-timeout) status
 * derivation, missing runId, and latest-job selection across multiple runs.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

interface StoredEvent {
  id: number;
  eventType: string;
  actorType?: string;
  correlationId?: string;
  payload: unknown;
  createdAt: Date;
}

let store: StoredEvent[] = [];
let nextId = 1;

const appendEventMock = mock(
  async (event: {
    eventType: string;
    actorType?: string;
    correlationId?: string;
    payload?: Record<string, unknown>;
  }) => {
    const created: StoredEvent = {
      id: nextId++,
      eventType: event.eventType,
      actorType: event.actorType,
      correlationId: event.correlationId,
      payload: event.payload ?? {},
      createdAt: new Date(),
    };
    store.push(created);
    return { id: created.id };
  },
);

const queryEventsMock = mock(async (options: { correlationId?: string; limit?: number }) => {
  const filtered = store
    .filter((e) => !options.correlationId || e.correlationId === options.correlationId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, options.limit ?? 50);
  return { events: filtered, total: filtered.length, limit: options.limit ?? 50, offset: 0 };
});

mock.module('../memory/timeline', () => ({
  appendEvent: appendEventMock,
  queryEvents: queryEventsMock,
}));

const {
  recordJobStart,
  recordJobFinish,
  getJobByRunId,
  getLatestJob,
  PROCESS_INSTANCE_ID,
  STALE_RUNNING_MS,
} = await import('./verification-job-store');

beforeEach(() => {
  store = [];
  nextId = 1;
  appendEventMock.mockClear();
  queryEventsMock.mockClear();
});

/** Push a raw start-event row, bypassing recordJobStart, to control fields the real function always fixes (processInstanceId, startedAt). */
function pushRawStart(
  taskId: number,
  runId: string,
  overrides: Partial<{ processInstanceId: string; startedAtMs: number }> = {},
) {
  store.push({
    id: nextId++,
    eventType: 'verification_job_started',
    correlationId: `verify-job-${taskId}`,
    payload: {
      runId,
      taskId,
      fingerprint: 'fp',
      processInstanceId: overrides.processInstanceId ?? PROCESS_INSTANCE_ID,
      executionCodeVersion: overrides.processInstanceId ?? PROCESS_INSTANCE_ID,
      startedAt: new Date(overrides.startedAtMs ?? Date.now()).toISOString(),
    },
    createdAt: new Date(overrides.startedAtMs ?? Date.now()),
  });
}

describe('getJobByRunId', () => {
  it('running: 開始イベントのみ・同一プロセス・stale未満', async () => {
    await recordJobStart(1, 'run-1', 'fp-1');
    const record = await getJobByRunId(1, 'run-1');
    expect(record).toMatchObject({ status: 'running', runId: 'run-1', taskId: 1 });
    expect(record?.startedAt).toBeTruthy();
  });

  it('interrupted: processInstanceId が現在のプロセスと不一致', async () => {
    pushRawStart(2, 'run-2', { processInstanceId: 'other-process-id' });
    const record = await getJobByRunId(2, 'run-2');
    expect(record).toMatchObject({ status: 'interrupted', runId: 'run-2' });
  });

  it('interrupted: 同一プロセスでも STALE_RUNNING_MS を超過', async () => {
    pushRawStart(3, 'run-3', { startedAtMs: Date.now() - STALE_RUNNING_MS - 1_000 });
    const record = await getJobByRunId(3, 'run-3');
    expect(record).toMatchObject({ status: 'interrupted', runId: 'run-3' });
  });

  it('completed: 開始＋完了イベントで checks/ok/unverifiable を含めて返す', async () => {
    await recordJobStart(4, 'run-4', 'fp-4');
    await recordJobFinish(4, 'run-4', {
      status: 'completed',
      ok: true,
      unverifiable: false,
      checks: [{ name: 'lint', ran: true, ok: true, errorCount: 0, details: 'no issues' }],
      summary: 'all green',
    });
    const record = await getJobByRunId(4, 'run-4');
    expect(record).toMatchObject({
      status: 'completed',
      ok: true,
      unverifiable: false,
      summary: 'all green',
    });
    expect(record?.checks).toHaveLength(1);
    expect(record?.finishedAt).toBeTruthy();
  });

  it('failed: 開始＋失敗イベントで error を含めて返す', async () => {
    await recordJobStart(5, 'run-5', 'fp-5');
    await recordJobFinish(5, 'run-5', { status: 'failed', error: 'gate threw' });
    const record = await getJobByRunId(5, 'run-5');
    expect(record).toMatchObject({ status: 'failed', error: 'gate threw' });
  });

  it('存在しない runId は null を返す', async () => {
    await recordJobStart(6, 'run-6', 'fp-6');
    const record = await getJobByRunId(6, 'run-does-not-exist');
    expect(record).toBeNull();
  });
});

describe('getLatestJob', () => {
  it('複数ジョブの中から最新の runId を選ぶ', async () => {
    pushRawStart(7, 'run-old', { startedAtMs: Date.now() - 10_000 });
    pushRawStart(7, 'run-new', { startedAtMs: Date.now() });
    const record = await getLatestJob(7);
    expect(record?.runId).toBe('run-new');
  });

  it('ジョブが無いタスクは null を返す', async () => {
    const record = await getLatestJob(999);
    expect(record).toBeNull();
  });

  it('他タスクのジョブを誤って返さない（correlationId のタスクID部分の分離確認）', async () => {
    pushRawStart(8, 'run-task8', { startedAtMs: Date.now() });
    pushRawStart(18, 'run-task18', { startedAtMs: Date.now() + 5_000 });
    const record = await getLatestJob(8);
    expect(record?.runId).toBe('run-task8');
  });
});
