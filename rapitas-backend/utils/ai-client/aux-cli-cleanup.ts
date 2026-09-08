/** Keep timed-out auxiliary CLI trees visible until their observed processes exit. */
import type { ChildProcess } from 'child_process';
import { captureDescendants } from '../../services/agents/process-tree-kill';
import {
  killProcessTreeSafely,
  registerProcess,
  unregisterProcess,
} from '../../services/agents/agent-process-tracker';

type CleanupDependencies = {
  capture: (pid: number) => Set<number>;
  kill: (pid: number, targets: Set<number>) => void;
  alive: (pid: number) => boolean;
  track: (pid: number) => void;
  untrack: (pid: number) => void;
};

/** Retain failed cleanup across calls; a new request must not overlap survivors. */
export function createAuxCliCleanup(deps: CleanupDependencies) {
  const pending = new Set<number>();
  const survivors = () => {
    for (const pid of pending) {
      if (!deps.alive(pid)) {
        deps.untrack(pid);
        pending.delete(pid);
      }
    }
    return [...pending];
  };
  return {
    assertReady() {
      const live = survivors();
      if (live.length)
        throw new Error(`Auxiliary CLI cleanup pending for PIDs: ${live.join(', ')}`);
    },
    stop(child: Pick<ChildProcess, 'pid' | 'kill'>): boolean {
      if (typeof child.pid !== 'number') {
        child.kill();
        return true;
      }
      // Capture before killing the shell, while descendant parent links exist.
      pending.add(child.pid);
      deps.track(child.pid);
      const targets = deps.capture(child.pid);
      targets.add(child.pid);
      for (const pid of targets) {
        pending.add(pid);
        deps.track(pid);
      }
      deps.kill(child.pid, targets);
      return survivors().length === 0;
    },
  };
}

export const auxCliCleanup = createAuxCliCleanup({
  capture: captureDescendants,
  kill: (pid, targets) => {
    killProcessTreeSafely(pid, { knownTargets: targets });
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
  track: (pid) =>
    registerProcess({
      pid,
      role: 'cli-agent',
      parentPid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  untrack: unregisterProcess,
});
