import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '../../../generated/prisma-sqlite';
import { createLogChunkManager } from './log-chunk-manager';
import { getOutputWriter } from './output-persistence';
import type { OutputHandlerContext } from './execution-helpers-types';

test('real SQLite protects terminal output even if the local state still says running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rapitas-output-test-'));
  const db = new PrismaClient({
    datasources: { db: { url: `file:${join(dir, 'test.db').replaceAll('\\', '/')}` } },
  });
  const ctx = {
    executionId: 1,
    state: { status: 'running', output: 'stale snapshot' },
    prisma: db,
  } as unknown as OutputHandlerContext;
  const manager = createLogChunkManager({
    prisma: ctx.prisma,
    executionId: 1,
    initialSequenceNumber: 0,
  });
  try {
    await db.$executeRawUnsafe(
      'CREATE TABLE AgentExecution (id INTEGER PRIMARY KEY, status TEXT, output TEXT, errorMessage TEXT)',
    );
    await db.$executeRawUnsafe(
      "INSERT INTO AgentExecution VALUES (1, 'cancelled', 'terminal result', NULL)",
    );
    const write = getOutputWriter(ctx, manager);
    await write('late error');
    expect(
      await db.$queryRawUnsafe('SELECT status, output, errorMessage FROM AgentExecution'),
    ).toEqual([{ status: 'cancelled', output: 'terminal result', errorMessage: null }]);
    await db.$executeRawUnsafe("UPDATE AgentExecution SET status = 'running'");
    ctx.state.output = 'resumed output';
    await write();
    await manager.cleanup();
    expect(await db.$queryRawUnsafe('SELECT output FROM AgentExecution')).toEqual([
      { output: 'resumed output' },
    ]);
  } finally {
    await manager.cleanup();
    await db.$disconnect();
    const target = resolve(dir);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('rapitas-output-test-')
    ) {
      throw Error('Unexpected temporary test path');
    }
    await rm(target, { recursive: true, force: true });
  }
});
