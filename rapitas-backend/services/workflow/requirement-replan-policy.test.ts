import { expect, test } from 'bun:test';
import { rejectReplanLifecycle, type ReplanLifecycleSnapshot } from './requirement-replan-policy';

const now = new Date('2026-09-08T00:00:00Z');
const current: ReplanLifecycleSnapshot = {
  status: 'in-progress',
  workflowStatus: 'plan_approved',
  updatedAt: now,
  latestExecutionStatus: 'completed',
  latestStopCause: null,
  themeStatus: 'running',
  priorReplans: 0,
};

test('only admits the current active task with remaining budget', () => {
  expect(rejectReplanLifecycle(current, now)).toBeNull();
  expect(rejectReplanLifecycle({ ...current, updatedAt: new Date(now.getTime() + 1) }, now)).toBe(
    'stale_task',
  );
  for (const status of ['done', 'todo', 'blocked', 'cancelled', 'archived', 'failed']) {
    expect(rejectReplanLifecycle({ ...current, status }, now)).toBe('protected_task_status');
  }
  for (const workflowStatus of [null, 'completed', 'awaiting_question', 'draft']) {
    expect(rejectReplanLifecycle({ ...current, workflowStatus }, now)).toBe(
      'protected_workflow_status',
    );
  }
});

test('cancelled execution blocks even when task status was not reset (task912)', () => {
  expect(rejectReplanLifecycle({ ...current, latestExecutionStatus: 'cancelled' }, now)).toBe(
    'execution_stopped',
  );
  expect(rejectReplanLifecycle({ ...current, latestStopCause: 'auto_run_stop_revert' }, now)).toBe(
    'stop_not_resumed',
  );
  for (const themeStatus of ['stopping', 'paused', 'paused_approval']) {
    expect(rejectReplanLifecycle({ ...current, themeStatus }, now)).toBe('theme_paused');
  }
});

test('invalid or exhausted persistent budgets never admit another replan', () => {
  for (const priorReplans of [-1, NaN, Infinity, 1.5]) {
    expect(rejectReplanLifecycle({ ...current, priorReplans }, now)).toBe('invalid_budget');
  }
  expect(rejectReplanLifecycle({ ...current, priorReplans: 3 }, now)).toBe('budget_exhausted');
});
