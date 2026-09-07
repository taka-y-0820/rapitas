/**
 * theme-auto-run-types.test
 *
 * Unit tests for the pure pause-reason helpers (task 883): status-string
 * granularity ↔ public pause reason mapping, with no DB/mocking involved.
 */
import { describe, it, expect } from 'bun:test';
import {
  isPausedAutoRunStatus,
  isAutoResumablePauseStatus,
  toPauseReason,
  toPublicAutoRunState,
  type AutoRunStatus,
  type ThemeAutoRunState,
} from './theme-auto-run-types';

const ALL_STATUSES: AutoRunStatus[] = [
  'idle',
  'running',
  'paused',
  'paused_user',
  'paused_approval',
  'stopping',
];

function makeState(overrides: Partial<ThemeAutoRunState> = {}): ThemeAutoRunState {
  return {
    id: 1,
    themeId: 42,
    enabled: true,
    status: 'running',
    order: 'priority',
    currentTaskId: null,
    processedCount: 0,
    lastError: null,
    lastRunAt: null,
    startedAt: null,
    idleSince: null,
    idleStoppedAt: null,
    lastSelfRefillAt: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('isPausedAutoRunStatus', () => {
  it('is true for paused, paused_user, and paused_approval', () => {
    expect(isPausedAutoRunStatus('paused')).toBe(true);
    expect(isPausedAutoRunStatus('paused_user')).toBe(true);
    expect(isPausedAutoRunStatus('paused_approval')).toBe(true);
  });

  it('is false for idle, running, and stopping', () => {
    expect(isPausedAutoRunStatus('idle')).toBe(false);
    expect(isPausedAutoRunStatus('running')).toBe(false);
    expect(isPausedAutoRunStatus('stopping')).toBe(false);
  });
});

describe('isAutoResumablePauseStatus', () => {
  it('is true only for paused_approval', () => {
    for (const status of ALL_STATUSES) {
      expect(isAutoResumablePauseStatus(status)).toBe(status === 'paused_approval');
    }
  });
});

describe('toPauseReason', () => {
  it('maps each AutoRunStatus to the expected public reason', () => {
    expect(toPauseReason('paused_user')).toBe('user');
    expect(toPauseReason('paused_approval')).toBe('awaiting_approval');
    expect(toPauseReason('paused')).toBe('unknown');
    expect(toPauseReason('idle')).toBeNull();
    expect(toPauseReason('running')).toBeNull();
    expect(toPauseReason('stopping')).toBeNull();
  });
});

describe('toPublicAutoRunState', () => {
  it('collapses paused_user to status=paused, pauseReason=user', () => {
    const result = toPublicAutoRunState(makeState({ status: 'paused_user' }));
    expect(result.status).toBe('paused');
    expect(result.pauseReason).toBe('user');
  });

  it('collapses paused_approval to status=paused, pauseReason=awaiting_approval', () => {
    const result = toPublicAutoRunState(makeState({ status: 'paused_approval' }));
    expect(result.status).toBe('paused');
    expect(result.pauseReason).toBe('awaiting_approval');
  });

  it('collapses legacy paused to status=paused, pauseReason=unknown', () => {
    const result = toPublicAutoRunState(makeState({ status: 'paused' }));
    expect(result.status).toBe('paused');
    expect(result.pauseReason).toBe('unknown');
  });

  it('leaves running as-is with pauseReason=null', () => {
    const result = toPublicAutoRunState(makeState({ status: 'running' }));
    expect(result.status).toBe('running');
    expect(result.pauseReason).toBeNull();
  });
});
