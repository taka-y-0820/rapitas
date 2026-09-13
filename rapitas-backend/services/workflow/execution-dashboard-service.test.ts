import { describe, it, expect } from 'bun:test';
import {
  countRepairBounces,
  deriveExecutionState,
  evaluateStall,
} from './execution-dashboard-service';

describe('countRepairBounces', () => {
  it('returns 0 for an empty transition list', () => {
    expect(countRepairBounces([])).toBe(0);
  });

  it('counts only verify_repair/ci_repair causes, ignoring others', () => {
    const transitions = [
      { cause: 'verify_repair' },
      { cause: 'ci_repair' },
      { cause: 'phase_completed:implementer' },
    ];
    expect(countRepairBounces(transitions)).toBe(2);
  });

  it('counts all repeated bounces with no window limit', () => {
    const transitions = [
      { cause: 'verify_repair' },
      { cause: 'verify_repair' },
      { cause: 'verify_repair' },
      { cause: 'ci_repair' },
    ];
    expect(countRepairBounces(transitions)).toBe(4);
  });
});

describe('deriveExecutionState', () => {
  it('maps queued -> queued', () => {
    expect(deriveExecutionState('queued', null)).toBe('queued');
  });

  it.each([
    [null, 'running'],
    ['verify_repair', 'repairing'],
    ['ci_repair', 'repairing'],
    ['phase_completed:implementer', 'running'],
  ] as const)('maps running with latest cause %s -> %s', (cause, expected) => {
    expect(deriveExecutionState('running', cause)).toBe(expected);
  });

  it('maps waiting_approval -> awaiting_judgement', () => {
    expect(deriveExecutionState('waiting_approval', null)).toBe('awaiting_judgement');
  });

  it('maps completed -> completed', () => {
    expect(deriveExecutionState('completed', null)).toBe('completed');
  });

  it('maps failed -> failed', () => {
    expect(deriveExecutionState('failed', null)).toBe('failed');
  });

  it('maps cancelled -> cancelled', () => {
    expect(deriveExecutionState('cancelled', null)).toBe('cancelled');
  });
});

describe('evaluateStall', () => {
  const nowMs = new Date('2026-09-07T12:00:00.000Z').getTime();

  it('is not stalled just under the threshold', () => {
    const startedAt = new Date(nowMs - 4 * 60 * 1000); // 4 minutes ago
    const result = evaluateStall({
      status: 'running',
      queuedAt: startedAt,
      startedAt,
      nowMs,
      thresholdMinutes: 5,
    });
    expect(result.stalled).toBe(false);
    expect(result.elapsedMinutes).toBe(4);
  });

  it('is stalled exactly at the threshold', () => {
    const startedAt = new Date(nowMs - 5 * 60 * 1000); // exactly 5 minutes ago
    const result = evaluateStall({
      status: 'running',
      queuedAt: startedAt,
      startedAt,
      nowMs,
      thresholdMinutes: 5,
    });
    expect(result.stalled).toBe(true);
    expect(result.elapsedMinutes).toBe(5);
  });

  it('is stalled beyond the threshold', () => {
    const startedAt = new Date(nowMs - 30 * 60 * 1000); // 30 minutes ago
    const result = evaluateStall({
      status: 'running',
      queuedAt: startedAt,
      startedAt,
      nowMs,
      thresholdMinutes: 5,
    });
    expect(result.stalled).toBe(true);
    expect(result.elapsedMinutes).toBe(30);
  });

  it('is never stalled for a terminal status even far past the threshold', () => {
    const startedAt = new Date(nowMs - 120 * 60 * 1000);
    for (const status of ['completed', 'failed', 'cancelled']) {
      const result = evaluateStall({
        status,
        queuedAt: startedAt,
        startedAt,
        nowMs,
        thresholdMinutes: 5,
      });
      expect(result.stalled).toBe(false);
    }
  });

  it('falls back to queuedAt when startedAt is null (not yet started)', () => {
    const queuedAt = new Date(nowMs - 10 * 60 * 1000);
    const result = evaluateStall({
      status: 'queued',
      queuedAt,
      startedAt: null,
      nowMs,
      thresholdMinutes: 5,
    });
    expect(result.stalled).toBe(true);
    expect(result.elapsedMinutes).toBe(10);
  });
});
