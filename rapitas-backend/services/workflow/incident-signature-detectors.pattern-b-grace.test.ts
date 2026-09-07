/**
 * incident-signature-detectors.pattern-b-grace.test
 *
 * Pattern B (`todo_status_workflow_advanced`) recovery-grace boundary tests,
 * split out of incident-signature-detectors.test.ts (task 709) to keep that
 * file from growing past the component size limit. Covers every
 * RECOVERY_REQUEUE_CAUSES member: the deliberate `status='todo'` × advanced
 * `workflowStatus` shape must NOT be reported as an anomaly within the grace
 * window after any of them.
 */
import { describe, it, expect } from 'bun:test';
import {
  detectTriStateDesync,
  DESYNC_RECOVERY_SETTLE_MS,
  type TriStateDesyncInput,
} from './incident-signature-detectors';

const NOW = 1_000_000_000_000;

// #636 repro: requeueOrphanTasks deliberately resets status to 'todo' while
// keeping workflowStatus (plan_approved) so auto-run can resume mid-workflow.
// The watcher fired Pattern B 59s later and filed a high-severity bug for a
// state the reconciler had just created on purpose.
describe('pattern B recovery grace (#636)', () => {
  const requeued: TriStateDesyncInput = {
    taskStatus: 'todo',
    workflowStatus: 'plan_approved',
    latestSessionStatus: 'cancelled',
    latestExecutionStatus: 'completed',
    latestTransitionCause: 'reconciler_requeue',
    latestTransitionAtMs: NOW - 59_000,
    nowMs: NOW,
  };

  it('does NOT detect pattern B 59s after a reconciler_requeue recovery (#636 repro)', () => {
    expect(detectTriStateDesync(requeued)).toBeNull();
  });

  it('does NOT detect pattern B shortly after an artifact_reuse_fastforward', () => {
    expect(
      detectTriStateDesync({
        ...requeued,
        workflowStatus: 'plan_created',
        latestTransitionCause: 'artifact_reuse_fastforward',
      }),
    ).toBeNull();
  });

  // #680 repro: task #672 retried via task-retry-handler (cause=task_retried),
  // which resets status to 'todo' while rolling workflowStatus back to
  // research_done. The watcher's next pass fired Pattern B ~139s later.
  it('does NOT detect pattern B 139s after a task_retried recovery (#680/#672 repro)', () => {
    expect(
      detectTriStateDesync({
        ...requeued,
        workflowStatus: 'research_done',
        latestTransitionCause: 'task_retried',
        latestTransitionAtMs: NOW - 139_000,
      }),
    ).toBeNull();
  });

  it('detects again once a task_retried recovery settled past the threshold', () => {
    const result = detectTriStateDesync({
      ...requeued,
      workflowStatus: 'research_done',
      latestTransitionCause: 'task_retried',
      latestTransitionAtMs: NOW - DESYNC_RECOVERY_SETTLE_MS,
    });
    expect(result?.kind).toBe('todo_status_workflow_advanced');
  });

  it('detects again once the recovery transition settled past the threshold (>= boundary)', () => {
    const settled = {
      ...requeued,
      latestTransitionAtMs: NOW - DESYNC_RECOVERY_SETTLE_MS,
    };
    const result = detectTriStateDesync(settled);
    expect(result?.kind).toBe('todo_status_workflow_advanced');
    // 1ms inside the grace window → still skipped.
    expect(
      detectTriStateDesync({
        ...settled,
        latestTransitionAtMs: NOW - DESYNC_RECOVERY_SETTLE_MS + 1,
      }),
    ).toBeNull();
  });

  it('honors a custom settleMs override', () => {
    const custom = { ...requeued, latestTransitionAtMs: NOW - 5_000, settleMs: 4_000 };
    expect(detectTriStateDesync(custom)?.kind).toBe('todo_status_workflow_advanced');
    expect(detectTriStateDesync({ ...custom, settleMs: 6_000 })).toBeNull();
  });

  it('still detects when the latest transition cause is not a recovery cause', () => {
    const result = detectTriStateDesync({
      ...requeued,
      latestTransitionCause: 'file_saved:plan',
    });
    expect(result?.kind).toBe('todo_status_workflow_advanced');
  });

  it('still detects a recovery cause whose transition time is unknown (conservative)', () => {
    expect(detectTriStateDesync({ ...requeued, latestTransitionAtMs: null })?.kind).toBe(
      'todo_status_workflow_advanced',
    );
  });

  it('still detects a recovery cause when nowMs is not supplied (conservative)', () => {
    const { nowMs: _omitted, ...withoutNow } = requeued;
    expect(detectTriStateDesync(withoutNow)?.kind).toBe('todo_status_workflow_advanced');
  });

  it('does NOT let the grace window suppress pattern A', () => {
    const result = detectTriStateDesync({
      ...requeued,
      latestSessionStatus: 'failed',
      latestExecutionStatus: 'running',
    });
    expect(result?.kind).toBe('session_failed_execution_active');
  });
});

// task #715: a retry against a theme with auto-run disabled resets status to
// 'todo' while leaving workflowStatus mid-phase, exactly like the recovery
// causes above — but since a paused theme never dispatches, the shape never
// settles and Pattern B fired forever (tasks #602/#646/#647, themeId=25).
describe('pattern B suppressed by a disabled theme auto-run (#715)', () => {
  const pausedThemeTask: TriStateDesyncInput = {
    taskStatus: 'todo',
    workflowStatus: 'in_progress',
    latestSessionStatus: null,
    latestExecutionStatus: null,
    latestTransitionCause: 'verify_validation_failed',
    latestTransitionAtMs: NOW - 4 * 24 * 60 * 60 * 1000,
    nowMs: NOW,
    themeAutoRunEnabled: false,
  };

  it('does NOT detect pattern B when the theme auto-run is disabled, however long it has waited', () => {
    expect(detectTriStateDesync(pausedThemeTask)).toBeNull();
  });

  it('still detects pattern B when the theme auto-run is enabled', () => {
    const result = detectTriStateDesync({ ...pausedThemeTask, themeAutoRunEnabled: true });
    expect(result?.kind).toBe('todo_status_workflow_advanced');
  });

  it('still detects pattern B when the theme auto-run state is unresolved (fail open)', () => {
    const result = detectTriStateDesync({ ...pausedThemeTask, themeAutoRunEnabled: null });
    expect(result?.kind).toBe('todo_status_workflow_advanced');
  });

  it('still detects pattern B when themeAutoRunEnabled is simply omitted (fail open)', () => {
    const { themeAutoRunEnabled: _omitted, ...withoutThemeState } = pausedThemeTask;
    expect(detectTriStateDesync(withoutThemeState)?.kind).toBe('todo_status_workflow_advanced');
  });

  it('does NOT let a disabled theme auto-run suppress pattern A', () => {
    const result = detectTriStateDesync({
      ...pausedThemeTask,
      latestSessionStatus: 'failed',
      latestExecutionStatus: 'running',
    });
    expect(result?.kind).toBe('session_failed_execution_active');
  });
});

// task 709 / task #602: three more code paths revert status to 'todo' without
// changing workflowStatus (backend shutdown, manual stop, stale-execution
// recovery). Before task 709 none recorded a transition, so the grace guard
// had no row to find and Pattern B fired immediately on the shape those
// paths create on purpose.
describe.each([
  ['agent_lifecycle_shutdown_revert', 'backend shutdown (lifecycle-manager.ts)'],
  ['manual_execution_stop_revert', 'manual stop (stop-route.ts)'],
  ['stale_execution_recovery_revert', 'stale-execution recovery (stale-recovery-helpers.ts)'],
  ['workflow_queue_enqueue_failed', 'post-repair re-enqueue failure (ci-self-repair.ts, task 786)'],
  ['auto_run_stop_revert', 'theme auto-run stop (auto-run-lifecycle.ts, task 830)'],
])('pattern B recovery grace for %s — %s', (cause) => {
  const reverted: TriStateDesyncInput = {
    taskStatus: 'todo',
    workflowStatus: 'in_progress',
    latestSessionStatus: null,
    latestExecutionStatus: null,
    latestTransitionCause: cause,
    latestTransitionAtMs: NOW - 60_000,
    nowMs: NOW,
  };

  it('does NOT detect pattern B shortly after the revert', () => {
    expect(detectTriStateDesync(reverted)).toBeNull();
  });

  it('detects again once the revert settled past the threshold', () => {
    const result = detectTriStateDesync({
      ...reverted,
      latestTransitionAtMs: NOW - DESYNC_RECOVERY_SETTLE_MS,
    });
    expect(result?.kind).toBe('todo_status_workflow_advanced');
  });
});

// task #775: execution-lease-sweep reverted task #774 to 'todo' via
// stale_execution_recovery_revert, but the execution it declared dead was
// still alive and later saved verify.md itself — a newer, non-recovery
// `file_saved:verify` transition. The single-latest-cause check only ever
// looked at that newest cause and missed the still-fresh (220s old) recovery
// transition sitting one row behind it, filing Pattern B on a state the
// recovery path had just created on purpose.
describe('pattern B recovery grace scans the transition window, not just the latest cause (#775)', () => {
  const revertThenVerifySave: TriStateDesyncInput = {
    taskStatus: 'todo',
    workflowStatus: 'verify_done',
    latestSessionStatus: null,
    latestExecutionStatus: null,
    recentTransitions: [
      { cause: 'stale_execution_recovery_revert', createdAtMs: NOW - 220_000 },
      { cause: 'file_saved:verify', createdAtMs: NOW - 1_000 },
    ],
    nowMs: NOW,
  };

  it('does NOT detect pattern B when a recovery cause is 220s old even though the newest cause is not (#774 repro)', () => {
    expect(detectTriStateDesync(revertThenVerifySave)).toBeNull();
  });

  it('detects again once every recovery cause in the window has settled past the threshold', () => {
    const result = detectTriStateDesync({
      ...revertThenVerifySave,
      recentTransitions: [
        { cause: 'stale_execution_recovery_revert', createdAtMs: NOW - DESYNC_RECOVERY_SETTLE_MS },
        { cause: 'file_saved:verify', createdAtMs: NOW - 1_000 },
      ],
    });
    expect(result?.kind).toBe('todo_status_workflow_advanced');
  });

  it('suppresses 1ms inside the grace window via the windowed scan', () => {
    const result = detectTriStateDesync({
      ...revertThenVerifySave,
      recentTransitions: [
        {
          cause: 'stale_execution_recovery_revert',
          createdAtMs: NOW - DESYNC_RECOVERY_SETTLE_MS + 1,
        },
        { cause: 'file_saved:verify', createdAtMs: NOW - 1_000 },
      ],
    });
    expect(result).toBeNull();
  });

  it('suppresses when multiple recovery causes are present in the window', () => {
    expect(
      detectTriStateDesync({
        ...revertThenVerifySave,
        recentTransitions: [
          { cause: 'stale_execution_recovery_revert', createdAtMs: NOW - 220_000 },
          { cause: 'reconciler_requeue', createdAtMs: NOW - 100_000 },
          { cause: 'file_saved:verify', createdAtMs: NOW - 1_000 },
        ],
      }),
    ).toBeNull();
  });

  it('falls back to latestTransitionCause/latestTransitionAtMs when recentTransitions is empty', () => {
    expect(
      detectTriStateDesync({
        ...revertThenVerifySave,
        recentTransitions: [],
        latestTransitionCause: 'stale_execution_recovery_revert',
        latestTransitionAtMs: NOW - 220_000,
      }),
    ).toBeNull();
  });

  it('still detects when recentTransitions is empty and the fallback cause is not a recovery cause', () => {
    const result = detectTriStateDesync({
      ...revertThenVerifySave,
      recentTransitions: [],
      latestTransitionCause: 'file_saved:verify',
      latestTransitionAtMs: NOW - 1_000,
    });
    expect(result?.kind).toBe('todo_status_workflow_advanced');
  });
});

// #875: stop-execution({withdraw:true}) records `manual_execution_stop_withdraw`.
// Unlike the other RECOVERY_REQUEUE_CAUSES members (which only grant a
// temporary settle window), a withdrawn task is ALSO permanently excluded via
// manuallyWithdrawn once the grace window passes — the operator has already
// decided not to resume it, so it must never re-fire.
describe('pattern B recovery grace + permanent exclusion for manual_execution_stop_withdraw (#875)', () => {
  const withdrawn: TriStateDesyncInput = {
    taskStatus: 'todo',
    workflowStatus: 'in_progress',
    latestSessionStatus: null,
    latestExecutionStatus: null,
    latestTransitionCause: 'manual_execution_stop_withdraw',
    latestTransitionAtMs: NOW - 60_000,
    nowMs: NOW,
  };

  it('does NOT detect pattern B shortly after the withdraw (recovery grace)', () => {
    expect(detectTriStateDesync(withdrawn)).toBeNull();
  });

  it('does NOT detect pattern B once the grace window passes, when manuallyWithdrawn is also set (permanent exclusion)', () => {
    const result = detectTriStateDesync({
      ...withdrawn,
      latestTransitionAtMs: NOW - DESYNC_RECOVERY_SETTLE_MS,
      manuallyWithdrawn: true,
    });
    expect(result).toBeNull();
  });

  it('detects again once the grace window passes, when manuallyWithdrawn is NOT set (regression guard)', () => {
    const result = detectTriStateDesync({
      ...withdrawn,
      latestTransitionAtMs: NOW - DESYNC_RECOVERY_SETTLE_MS,
    });
    expect(result?.kind).toBe('todo_status_workflow_advanced');
  });
});
