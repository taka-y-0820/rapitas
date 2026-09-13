import { afterEach, expect, test, mock } from 'bun:test';
import {
  acquireTaskExecutionLock,
  getTaskExecutionLockOwner,
  releaseTaskExecutionLock,
} from '../../../../services/agents/task-execution-lock';
import { prepareManualExecution, settleManualExecution } from './manual-execution-settlement';

const taskId = 991915;
afterEach(() => releaseTaskExecutionLock(taskId));

test('preparation failure releases its lease and preserves the original error', async () => {
  acquireTaskExecutionLock(taskId);
  const owner = getTaskExecutionLockOwner(taskId)!;
  const error = new Error('preparation failed');
  await expect(
    prepareManualExecution(taskId, owner, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(getTaskExecutionLockOwner(taskId)).toBeUndefined();
});

test('preparation failure after stop preserves the replacement lease', async () => {
  acquireTaskExecutionLock(taskId);
  const owner = getTaskExecutionLockOwner(taskId)!;
  let replacement: symbol | undefined;
  await expect(
    prepareManualExecution(taskId, owner, async () => {
      releaseTaskExecutionLock(taskId);
      acquireTaskExecutionLock(taskId);
      replacement = getTaskExecutionLockOwner(taskId);
      throw new Error('stale preparation');
    }),
  ).rejects.toThrow('stale preparation');
  expect(getTaskExecutionLockOwner(taskId)).toBe(replacement);
});

test('successful preparation retains ownership for the running execution', async () => {
  acquireTaskExecutionLock(taskId);
  const owner = getTaskExecutionLockOwner(taskId)!;
  expect(await prepareManualExecution(taskId, owner, async () => 'started')).toBe('started');
  expect(getTaskExecutionLockOwner(taskId)).toBe(owner);
});

for (const rejected of [false, true]) {
  test(`a stopped ${rejected ? 'rejection' : 'result'} cannot mutate state or release its replacement`, async () => {
    acquireTaskExecutionLock(taskId);
    const owner = getTaskExecutionLockOwner(taskId)!;
    let resolve!: (value: { success: boolean }) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<{ success: boolean }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const onResult = mock(async () => {}),
      onError = mock(async () => {});
    const settled = settleManualExecution(promise, { taskId, owner, onResult, onError });
    releaseTaskExecutionLock(taskId);
    acquireTaskExecutionLock(taskId);
    const replacement = getTaskExecutionLockOwner(taskId);
    if (rejected) reject(new Error('late IPC failure'));
    else resolve({ success: false });
    await settled;
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(getTaskExecutionLockOwner(taskId)).toBe(replacement);
  });
}

test('normal completion retains its result handling and releases its own lease', async () => {
  acquireTaskExecutionLock(taskId);
  const owner = getTaskExecutionLockOwner(taskId)!;
  const onResult = mock(async () => {}),
    onError = mock(async () => {});
  await settleManualExecution(Promise.resolve({ success: true }), {
    taskId,
    owner,
    onResult,
    onError,
  });
  expect(onResult).toHaveBeenCalledWith({ success: true });
  expect(onError).not.toHaveBeenCalled();
  expect(getTaskExecutionLockOwner(taskId)).toBeUndefined();
});

test('a genuine worker rejection still reaches failure reconciliation', async () => {
  acquireTaskExecutionLock(taskId);
  const owner = getTaskExecutionLockOwner(taskId)!;
  const error = new Error('worker transport failed');
  const onResult = mock(async () => {});
  const onError = mock(async () => {});
  await settleManualExecution(Promise.reject(error), { taskId, owner, onResult, onError });
  expect(onError).toHaveBeenCalledWith(error);
  expect(onResult).not.toHaveBeenCalled();
  expect(getTaskExecutionLockOwner(taskId)).toBeUndefined();
});

test('an error after cancellation during result handling cannot fail a replacement run', async () => {
  acquireTaskExecutionLock(taskId);
  const owner = getTaskExecutionLockOwner(taskId)!;
  let replacement: symbol | undefined;
  const onError = mock(async () => {});
  await settleManualExecution(Promise.resolve({ success: true }), {
    taskId,
    owner,
    onError,
    onResult: async () => {
      releaseTaskExecutionLock(taskId);
      acquireTaskExecutionLock(taskId);
      replacement = getTaskExecutionLockOwner(taskId);
      throw new Error('post-processing stopped');
    },
  });
  expect(onError).not.toHaveBeenCalled();
  expect(getTaskExecutionLockOwner(taskId)).toBe(replacement);
});
