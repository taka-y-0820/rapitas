import { beforeEach, expect, mock, test } from 'bun:test';

let workflowStatus = 'in_progress';
let status = 'in-progress';
let updatedAt = new Date(0);
let readError = false;
let userCause: string | null = null;
let historyError = false;
let race: (() => void) | undefined;
const recordTransition = mock(async (_args: unknown) => {});
const updateMany = mock(
  async ({
    where,
    data,
  }: {
    where: { status: string; workflowStatus: string; updatedAt: Date };
    data: { workflowStatus: string };
  }) => {
    race?.();
    if (
      where.status !== status ||
      where.workflowStatus !== workflowStatus ||
      where.updatedAt.getTime() !== updatedAt.getTime()
    )
      return { count: 0 };
    workflowStatus = data.workflowStatus;
    return { count: 1 };
  },
);
beforeEach(() => {
  workflowStatus = 'in_progress';
  status = 'in-progress';
  updatedAt = new Date(0);
  readError = false;
  userCause = null;
  historyError = false;
  race = undefined;
  updateMany.mockClear();
  recordTransition.mockClear();
});
mock.module('../../../../config', () => ({
  prisma: {
    workflowTransition: {
      findFirst: async () => {
        if (historyError) throw new Error('history unavailable');
        return userCause ? { cause: userCause } : null;
      },
    },
    task: {
      findUnique: async () => {
        if (readError) throw new Error('DB unavailable');
        return { workflowStatus, status, updatedAt };
      },
      updateMany,
      update: async ({ data }: { data: { workflowStatus?: string } }) => {
        if (data.workflowStatus) workflowStatus = data.workflowStatus;
        return { workflowStatus };
      },
    },
  },
}));
mock.module('../../../../config/logger', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
  }),
}));
mock.module('../../../../services/workflow/completion-gate', () => ({
  researchConcludesNoChange: () => false,
}));
mock.module('../../../../services/workflow/transition-recorder', () => ({ recordTransition }));
mock.module('../../../../services/workflow/workflow-invariants', () => ({
  checkWorkflowInvariants: async () => [],
}));
mock.module('../../../../services/workflow/verify-invariant-repair', () => ({
  attemptInvariantCutoff: async () => false,
}));
mock.module('./shared', () => ({
  markLatestExecutionFailed: async () => {},
  wasNonConvergenceCutoffJustRecorded: async () => false,
}));

const { computeAndApplyStatusTransition } = await import('./status-transition');
const { withTaskLifecycleLock } = await import('../../../../services/workflow/task-lifecycle-lock');

test('question with pre-lock snapshot must preserve completion while waiting', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completing = withTaskLifecycleLock(901, async () => {
    entered();
    await gate;
    workflowStatus = 'completed';
  });
  await started;
  const currentStatus = workflowStatus;
  // Exact callback shape added by task901: snapshot is captured before lock.
  const saving = withTaskLifecycleLock(901, () =>
    computeAndApplyStatusTransition({
      taskId: 901,
      fileType: 'question',
      currentStatus,
      savedContent: 'Q',
    }),
  );
  release();
  await Promise.all([completing, saving]);
  expect(workflowStatus).toBe('completed');
  expect(recordTransition).not.toHaveBeenCalled();
});

const save = () =>
  computeAndApplyStatusTransition({
    taskId: 901,
    fileType: 'question',
    currentStatus: 'draft',
    savedContent: 'Q',
  });
test('normal question uses fresh previous status and records one transition', async () => {
  expect((await save()).newStatus).toBe('awaiting_question');
  expect(workflowStatus).toBe('awaiting_question');
  expect(recordTransition).toHaveBeenCalledTimes(1);
  expect(recordTransition).toHaveBeenCalledWith(
    expect.objectContaining({
      fromStatus: 'in_progress',
      metadata: expect.objectContaining({ previousStatus: 'in_progress' }),
    }),
  );
});
for (const terminal of [
  'done',
  'blocked',
  'canceling',
  'canceled',
  'cancelled',
  'failed',
  'archived',
]) {
  test(`preserves ${terminal} task without writing a question transition`, async () => {
    status = terminal;
    expect((await save()).newStatus).toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
  });
}
for (const change of ['completion', 'stop', 'manual-stop-todo', 'version']) {
  test(`CAS rejects concurrent ${change} after the read`, async () => {
    race = () => {
      if (change === 'completion') workflowStatus = 'completed';
      if (change === 'stop') status = 'cancelled';
      if (change === 'manual-stop-todo') status = 'todo';
      if (change === 'version') updatedAt = new Date(1);
    };
    expect((await save()).newStatus).toBeUndefined();
    expect(workflowStatus).not.toBe('awaiting_question');
    expect(recordTransition).not.toHaveBeenCalled();
  });
}
test('DB read failure propagates without mutation or transition', async () => {
  readError = true;
  await expect(save()).rejects.toThrow('DB unavailable');
  expect(updateMany).not.toHaveBeenCalled();
  expect(recordTransition).not.toHaveBeenCalled();
});

for (const cause of [
  'manual_execution_stop_revert',
  'manual_execution_stop_withdraw',
  'auto_run_stop_revert',
]) {
  test(`stopped todo with ${cause} remains unchanged; running resume can save`, async () => {
    status = 'todo';
    userCause = cause;
    expect((await save()).newStatus).toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
    status = 'in-progress';
    expect((await save()).newStatus).toBe('awaiting_question');
  });
}
test('ordinary todo without stop history can save a question', async () => {
  status = 'todo';
  expect((await save()).newStatus).toBe('awaiting_question');
});
test('stop history read failure fails closed', async () => {
  status = 'todo';
  historyError = true;
  await expect(save()).rejects.toThrow('history unavailable');
  expect(updateMany).not.toHaveBeenCalled();
  expect(recordTransition).not.toHaveBeenCalled();
});
