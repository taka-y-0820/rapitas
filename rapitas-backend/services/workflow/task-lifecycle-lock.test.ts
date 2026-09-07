import { expect, test } from 'bun:test';
import { withTaskLifecycleLock } from './task-lifecycle-lock';

test('same-task answer waits for stop decision; other tasks can progress', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const stop = withTaskLifecycleLock(1, async () => {
    events.push('stop-start');
    await gate;
    events.push('stop-end');
  });
  const answer = withTaskLifecycleLock(1, async () => {
    events.push('answer');
  });
  try {
    await withTaskLifecycleLock(2, async () => {
      events.push('other-task');
    });
    expect(events).toEqual(['stop-start', 'other-task']);
  } finally {
    release();
    await Promise.all([stop, answer]);
  }
  expect(events).toEqual(['stop-start', 'other-task', 'stop-end', 'answer']);
});

test('a failed answer releases the next scheduler decision without masking failure', async () => {
  const failure = new Error('database unavailable');
  const first = withTaskLifecycleLock(3, async () => {
    throw failure;
  });
  const next = withTaskLifecycleLock(3, async () => 'checked');
  await expect(first).rejects.toBe(failure);
  expect(await next).toBe('checked');
});
