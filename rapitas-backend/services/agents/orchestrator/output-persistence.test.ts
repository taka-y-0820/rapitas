import { test, expect, mock } from 'bun:test';
import { getOutputWriter } from './output-persistence';
import { createLogChunkManager } from './log-chunk-manager';
import type { OutputHandlerContext } from './execution-helpers-types';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(updateMany = mock(async (_args: unknown) => ({ count: 1 }))) {
  const ctx = {
    executionId: 7,
    state: { status: 'running', output: '' },
    prisma: { agentExecution: { updateMany } },
  } as unknown as OutputHandlerContext;
  const manager = createLogChunkManager({
    prisma: ctx.prisma,
    executionId: 7,
    initialSequenceNumber: 0,
  });
  const cleanup = manager.cleanup;
  return { ctx, manager, cleanup, write: getOutputWriter(ctx, manager), updateMany };
}

test('cleanup waits for an in-flight write and saves output received during it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const update = mock(async (_args: unknown) => {
    await gate;
    return { count: 1 };
  });
  const f = fixture(update);
  try {
    f.ctx.state.output = 'first';
    await f.write();
    await delay(250);
    expect(update).toHaveBeenCalledTimes(1);
    f.ctx.state.output += ' last';
    await f.write();
    let cleaned = false;
    const cleaning = f.cleanup().then(() => {
      cleaned = true;
    });
    await delay(20);
    expect(cleaned).toBe(false);
    release();
    await cleaning;
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0]).toMatchObject({ data: { output: 'first last' } });
    await f.write();
    await delay(250);
    expect(update).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await f.cleanup();
  }
});

test('cancelled memory state drops a scheduled snapshot', async () => {
  const f = fixture();
  try {
    f.ctx.state.output = 'late';
    await f.write();
    f.ctx.state.status = 'cancelled';
    await delay(250);
    await f.cleanup();
    expect(f.updateMany).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test('fallback shares the writer and stderr is serialized behind the pending write', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const update = mock(async (_args: unknown) => {
    await gate;
    return { count: 1 };
  });
  const f = fixture(update);
  try {
    expect(getOutputWriter(f.ctx, f.manager)).toBe(f.write);
    f.ctx.state.output = 'startup';
    await f.write();
    await delay(250);
    f.ctx.state.output += ' stderr';
    const errorWrite = f.write('stderr');
    await delay(20);
    expect(update).toHaveBeenCalledTimes(1);
    release();
    await errorWrite;
    expect(update.mock.calls[1][0]).toMatchObject({
      where: { id: 7, status: { in: ['running', 'waiting_for_input'] } },
      data: { output: 'startup stderr', errorMessage: 'stderr' },
    });
  } finally {
    release();
    await f.cleanup();
  }
});

test('failed persistence does not create a background retry loop', async () => {
  const update = mock(async (_args: unknown): Promise<{ count: number }> => {
    throw Error('offline');
  });
  const f = fixture(update);
  try {
    await f.write();
    await delay(650);
    expect(update).toHaveBeenCalledTimes(1);
    await f.cleanup();
    expect(update).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});
