/**
 * auto-run-advance-active.question-race.test.ts
 *
 * Verifies advanceActiveTask's scheduler-read and a question save's
 * awaiting_question write are serialized on the same task-lifecycle
 * lock key, regardless of arrival order (task #901).
 */

import { describe, it, expect, mock } from 'bun:test';

const order: string[] = [];
let releaseTick!: () => void;
let tickGate = new Promise<void>((resolve) => {
  releaseTick = resolve;
});

const mockAdvanceActiveTaskLocked = mock(async () => {
  order.push('tick-start');
  await tickGate;
  order.push('tick-end');
});

mock.module('./auto-run-active-decision', () => ({
  advanceActiveTaskLocked: mockAdvanceActiveTaskLocked,
}));

const { advanceActiveTask } = await import('./auto-run-advance-active');
const { withTaskLifecycleLock } = await import('../task-lifecycle-lock');

describe('advanceActiveTask serialization with question saves', () => {
  it('スケジューラtick進行中は質問保存の書き込みがロック解放まで待たされる', async () => {
    order.length = 0;
    tickGate = new Promise((resolve) => {
      releaseTick = resolve;
    });

    // biome-ignore lint: test double for PrismaClient param, unused by the mocked implementation
    const tick = advanceActiveTask({} as any, 1, 901, 'priority', 0, null, new Map());
    await Promise.resolve();
    expect(order).toEqual(['tick-start']);

    const write = withTaskLifecycleLock(901, async () => {
      order.push('write');
    });
    await Promise.resolve();
    expect(order).toEqual(['tick-start']);

    releaseTick();
    await Promise.all([tick, write]);
    expect(order).toEqual(['tick-start', 'tick-end', 'write']);
  });

  it('質問保存の書き込み中はスケジューラtickの読み取りがロック解放まで待たされる', async () => {
    order.length = 0;
    tickGate = new Promise((resolve) => {
      releaseTick = resolve;
    });

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = withTaskLifecycleLock(902, async () => {
      order.push('write-start');
      await writeGate;
      order.push('write-end');
    });
    await Promise.resolve();

    // biome-ignore lint: test double for PrismaClient param, unused by the mocked implementation
    const tick = advanceActiveTask({} as any, 1, 902, 'priority', 0, null, new Map());
    await Promise.resolve();
    expect(order).toEqual(['write-start']);

    releaseWrite();
    releaseTick();
    await Promise.all([write, tick]);
    expect(order).toEqual(['write-start', 'write-end', 'tick-start', 'tick-end']);
  });
});
