/** Serialize a current-task scheduler decision with accepted question answers. */
import { withTaskLifecycleLock } from '../task-lifecycle-lock';
import { advanceActiveTaskLocked } from './auto-run-active-decision';

export function advanceActiveTask(
  ...args: Parameters<typeof advanceActiveTaskLocked>
): Promise<void> {
  return withTaskLifecycleLock(args[2], () => advanceActiveTaskLocked(...args));
}
