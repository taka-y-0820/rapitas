/** Real SQLite regression for stop/result races; never connects to the application DB. */
import { test, expect, mock } from 'bun:test';
import { PrismaClient } from '../../../generated/prisma-sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { handleExecutionError } from './execution-persistence';
import type { ExecutionState } from './types';
import type { ExecutionFileLogger } from '../execution-file-logger';

test.each(['cancelled', 'canceling', 'completed', 'running'])(
  'late error respects persisted %s in SQLite',
  async (persisted) => {
    const dir = await mkdtemp(join(tmpdir(), 'rapitas-stop-persistence-'));
    const db = new PrismaClient({
      datasources: { db: { url: `file:${join(dir, 'test.db').replaceAll('\\', '/')}` } },
    });
    const state: ExecutionState = {
      executionId: 1,
      sessionId: 2,
      taskId: 3,
      agentId: 'probe',
      status: 'running',
      startedAt: new Date(),
      output: 'evidence',
    };
    const logger = {
      logError: mock(() => {}),
      logExecutionEnd: mock(() => {}),
    } as unknown as ExecutionFileLogger;
    const emit = mock(() => {});
    try {
      await db.$executeRawUnsafe(
        'CREATE TABLE AgentExecution (id INTEGER PRIMARY KEY, status TEXT, startedAt DATETIME, executionTimeMs INTEGER, output TEXT, completedAt DATETIME, errorMessage TEXT)',
      );
      await db.$executeRawUnsafe('INSERT INTO AgentExecution (id,status) VALUES (1,?)', persisted);
      await handleExecutionError(
        db as never,
        1,
        2,
        3,
        state,
        new Error('late persistence error'),
        logger,
        emit,
        'Execution',
      );
      const row = await db.agentExecution.findUnique({
        where: { id: 1 },
        select: { status: true },
      });
      expect(row?.status).toBe(persisted === 'running' ? 'failed' : persisted);
      if (persisted === 'completed') expect(emit).not.toHaveBeenCalled();
      else
        expect(emit).toHaveBeenCalledWith(
          expect.objectContaining({
            type: persisted === 'running' ? 'execution_failed' : 'execution_cancelled',
          }),
        );
    } finally {
      await db.$disconnect();
      const target = resolve(dir);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('rapitas-stop-persistence-')
      )
        throw new Error('Invalid isolated test cleanup target');
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
