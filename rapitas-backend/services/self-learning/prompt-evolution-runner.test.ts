import { describe, expect, mock, test } from 'bun:test';
import type { PrismaClient } from '../../generated/prisma-postgres';

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
}));
mock.module('../workflow/role-evidence', () => ({
  ROLE_TROUBLE_CAUSES: { implementer: ['verify_repair'] },
}));
const { runPromptEvolution, evaluateRole } = await import('./prompt-evolution-runner');

function fixture(statuses: string[], evidenceFails = false) {
  const create = mock(async (_args: unknown) => ({}));
  const findMany = mock(async (args: { where: { mode: string; status?: { in: string[] } } }) => {
    if (args.where.mode !== 'workflow-implementer') return [];
    return statuses
      .filter((status) => !args.where.status || args.where.status.in.includes(status))
      .map((status) => ({ status, config: { taskId: 42 } }));
  });
  const db = {
    agentSession: { findMany },
    workflowTransition: {
      findMany: mock(async () => {
        if (evidenceFails) throw new Error('evidence unavailable');
        return [];
      }),
    },
    promptEvolution: { create },
  };
  return { db: db as unknown as PrismaClient, create, findMany };
}

describe('prompt evolution outcome eligibility', () => {
  test('unfinished and canceled runs do not lower the success rate', async () => {
    const f = fixture([
      'completed',
      'completed',
      'completed',
      'running',
      'pending',
      'cancelled',
      'canceled',
    ]);
    const rows = await runPromptEvolution(f.db);
    expect(rows.find((row) => row.role === 'implementer')).toMatchObject({
      totalRuns: 3,
      successRuns: 3,
      successRate: 1,
      shouldEvolve: false,
    });
    expect(f.findMany.mock.calls[0][0].where.status).toEqual({ in: ['completed', 'failed'] });
    expect(f.create).not.toHaveBeenCalled();
  });

  test('completed failures still trigger a candidate with enough evidence', async () => {
    const f = fixture(['completed', 'completed', 'failed', 'failed', 'failed']);
    const rows = await runPromptEvolution(f.db);
    expect(rows.find((row) => row.role === 'implementer')).toMatchObject({
      totalRuns: 5,
      successRuns: 2,
      successRate: 0.4,
      shouldEvolve: true,
    });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  test('missing gate evidence skips evaluation instead of inventing outcomes', async () => {
    const f = fixture(['completed', 'completed', 'failed', 'failed', 'failed'], true);
    const rows = await runPromptEvolution(f.db);
    expect(rows.some((row) => row.role === 'implementer')).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
  });
});

describe('evaluateRole scopeTaskIds', () => {
  test('passes a config.taskId filter through to agentSession.findMany when scopeTaskIds is given', async () => {
    const f = fixture(['completed', 'completed']);
    await evaluateRole(f.db, 'implementer', new Date(0), [810, 812]);
    expect(f.findMany.mock.calls[0][0].where.config).toEqual({ taskId: { in: [810, 812] } });
  });

  test('omits the config filter when scopeTaskIds is undefined (unchanged behavior)', async () => {
    const f = fixture(['completed', 'completed']);
    await evaluateRole(f.db, 'implementer', new Date(0));
    expect(f.findMany.mock.calls[0][0].where.config).toBeUndefined();
  });
});
