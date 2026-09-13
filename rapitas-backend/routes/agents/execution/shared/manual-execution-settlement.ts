/** A late manual-execution reply must not undo a stop or release a replacement run. */
import {
  getTaskExecutionLockOwner,
  releaseTaskExecutionLock,
} from '../../../../services/agents/task-execution-lock';
import { createLogger } from '../../../../config/logger';

const log = createLogger('manual-execution-settlement');

/** Preparation failures release only their own lease; successful handoff keeps it for settlement. */
export async function prepareManualExecution<T>(
  taskId: number,
  owner: symbol,
  prepare: () => Promise<T>,
): Promise<T> {
  try {
    return await prepare();
  } catch (error) {
    releaseTaskExecutionLock(taskId, owner);
    throw error;
  }
}

export async function settleManualExecution<T>(
  execution: Promise<T>,
  options: {
    taskId: number;
    owner: symbol;
    onResult: (result: T) => Promise<void>;
    onError: (error: unknown) => Promise<void>;
  },
): Promise<void> {
  const { taskId, owner, onResult, onError } = options;
  const current = () => getTaskExecutionLockOwner(taskId) === owner;
  try {
    const result = await execution;
    if (!current()) {
      log.info({ taskId }, 'Ignoring result after manual execution ownership was revoked');
      return;
    }
    await onResult(result);
  } catch (error) {
    if (!current() || (error instanceof Error && error.name === 'ExecutionCancelledError')) {
      log.info({ taskId }, 'Ignoring error after manual execution cancellation');
      return;
    }
    await onError(error);
  } finally {
    releaseTaskExecutionLock(taskId, owner);
  }
}
