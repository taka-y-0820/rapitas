/**
 * prompt-evolution-runner テスト
 *
 * 評価母集団は AgentExecution（session.mode=workflow-{role}）。未終端・取消・
 * 未知の状態値を分母から除外しつつ、その内訳を excluded として監査可能に
 * 返すこと、ゲート差し戻し補正が維持されることを検証する。
 */
import { describe, expect, mock, test } from 'bun:test';
import type { PrismaClient } from '../../generated/prisma-postgres';

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
}));
mock.module('../workflow/role-evidence', () => ({
  ROLE_TROUBLE_CAUSES: { implementer: ['verify_repair'] },
}));
const { runPromptEvolution, evaluateRole } = await import('./prompt-evolution-runner');

interface ExecutionWhere {
  where: {
    session: { mode: string; config?: { taskId: { in: number[] } } };
    createdAt?: { gte: Date };
  };
}

function fixture(statuses: string[], evidenceFails = false) {
  const create = mock(async (_args: unknown) => ({}));
  const findMany = mock(async (args: ExecutionWhere) => {
    if (args.where.session.mode !== 'workflow-implementer') return [];
    return statuses.map((status) => ({ status, session: { config: { taskId: 42 } } }));
  });
  const db = {
    agentExecution: { findMany },
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
    // 母集団は AgentSession ではなく AgentExecution（session 越しに mode を絞る）。
    const modes = f.findMany.mock.calls.map((c) => c[0].where.session.mode);
    expect(modes).toContain('workflow-implementer');
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
    // 分母の根拠を後から監査できるよう、除外内訳も証跡に残す。
    const args = f.create.mock.calls[0][0] as { data: { evidenceJson: string } };
    expect(JSON.parse(args.data.evidenceJson).excluded).toEqual({
      inProgress: 0,
      cancelled: 0,
      unknownStatus: 0,
    });
  });

  test('missing gate evidence skips evaluation instead of inventing outcomes', async () => {
    const f = fixture(['completed', 'completed', 'failed', 'failed', 'failed'], true);
    const rows = await runPromptEvolution(f.db);
    expect(rows.some((row) => row.role === 'implementer')).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
  });

  test('gate-rejected completions are not counted as successes', async () => {
    const f = fixture(['completed', 'completed', 'completed', 'completed', 'completed']);
    (f.db as unknown as { workflowTransition: { findMany: unknown } }).workflowTransition.findMany =
      mock(async () => [{ taskId: 42 }]);
    const ev = await evaluateRole(f.db, 'implementer', new Date(0));
    expect(ev).toMatchObject({ totalRuns: 5, successRuns: 0, successRate: 0 });
  });
});

describe('evaluateRole denominator exclusions', () => {
  test('未終端の4状態はすべて分母から除外される', async () => {
    const f = fixture(['completed', 'running', 'pending', 'waiting_for_input', 'post_processing']);
    const ev = await evaluateRole(f.db, 'implementer', new Date(0));
    expect(ev.totalRuns).toBe(1);
    expect(ev.excluded.inProgress).toBe(4);
  });

  test('取消と未知の状態値は別々に集計される', async () => {
    const f = fixture(['completed', 'failed', 'cancelled', 'cancelled', 'canceled', 'zombie']);
    const ev = await evaluateRole(f.db, 'implementer', new Date(0));
    expect(ev.totalRuns).toBe(2);
    expect(ev.excluded).toEqual({ inProgress: 0, cancelled: 2, unknownStatus: 2 });
  });
});

describe('evaluateRole scopeTaskIds', () => {
  test('passes a session.config.taskId filter through to agentExecution.findMany when scopeTaskIds is given', async () => {
    const f = fixture(['completed', 'completed']);
    await evaluateRole(f.db, 'implementer', new Date(0), [810, 812]);
    expect(f.findMany.mock.calls[0][0].where.session.config).toEqual({
      taskId: { in: [810, 812] },
    });
  });

  test('omits the config filter when scopeTaskIds is undefined (unchanged behavior)', async () => {
    const f = fixture(['completed', 'completed']);
    await evaluateRole(f.db, 'implementer', new Date(0));
    expect(f.findMany.mock.calls[0][0].where.session.config).toBeUndefined();
  });
});
