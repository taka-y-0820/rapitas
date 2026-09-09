import { describe, it, expect } from 'bun:test';
import { isTaskTerminal, isResumableInterrupted } from './resumable-execution-policy';

describe('isTaskTerminal', () => {
  it('returns true when Task.status is terminal', () => {
    expect(isTaskTerminal({ status: 'done' })).toBe(true);
    expect(isTaskTerminal({ status: 'completed' })).toBe(true);
    expect(isTaskTerminal({ status: 'cancelled' })).toBe(true);
    expect(isTaskTerminal({ status: 'failed' })).toBe(true);
    expect(isTaskTerminal({ status: 'archived' })).toBe(true);
  });

  it('returns true when Task.workflowStatus is completed', () => {
    expect(isTaskTerminal({ status: 'todo', workflowStatus: 'completed' })).toBe(true);
  });

  it('returns false when neither status nor workflowStatus is terminal', () => {
    expect(isTaskTerminal({ status: 'todo', workflowStatus: 'in_progress' })).toBe(false);
    expect(isTaskTerminal({ status: 'in-progress', workflowStatus: 'verify_done' })).toBe(false);
  });

  it('returns false when task is null or undefined', () => {
    expect(isTaskTerminal(null)).toBe(false);
    expect(isTaskTerminal(undefined)).toBe(false);
  });

  it('returns false when task has no status fields at all', () => {
    expect(isTaskTerminal({})).toBe(false);
  });
});

describe('isResumableInterrupted', () => {
  it('is true for an interrupted execution under a non-terminal task', () => {
    expect(isResumableInterrupted({ status: 'interrupted' }, { status: 'todo' })).toBe(true);
  });

  it('is false for an interrupted execution under a terminal task (task658/execution2806 case)', () => {
    expect(isResumableInterrupted({ status: 'interrupted' }, { status: 'done' })).toBe(false);
  });

  it('is false for a non-interrupted execution regardless of task state', () => {
    expect(isResumableInterrupted({ status: 'running' }, { status: 'todo' })).toBe(false);
  });

  it('is false when the task already has a live execution elsewhere (liveTaskIds)', () => {
    expect(
      isResumableInterrupted(
        { status: 'interrupted' },
        { id: 913, status: 'in-progress' },
        new Set([913]),
      ),
    ).toBe(false);
  });

  it('is true for a non-terminal task not present in liveTaskIds', () => {
    expect(
      isResumableInterrupted(
        { status: 'interrupted' },
        { id: 913, status: 'in-progress' },
        new Set([1]),
      ),
    ).toBe(true);
  });
});
