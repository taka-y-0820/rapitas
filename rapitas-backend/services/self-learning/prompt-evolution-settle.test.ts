/**
 * prompt-evolution-settle.test
 *
 * The settlement verdict and the approved-row lifecycle (stamp → measure →
 * complete/revert/skip) with an injected evaluator and a fake Prisma.
 */
import { afterEach, beforeEach, describe, test, expect, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ComparisonRecord } from './comparison/prompt-comparison-types';

mock.module('../../config/logger', () => {
  const noop = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
  };
  return {
    createLogger: () => noop,
    logger: noop,
    getBackendLogFilePath: () => '/tmp/backend.log',
  };
});

const { decideSettlement, settleApprovedEvolutions, isPureAddendum } =
  await import('./prompt-evolution-settle');
const { writeComparisonRecord, readComparisonRecord } =
  await import('./comparison/prompt-comparison-store');

describe('decideSettlement', () => {
  test('needs the minimum sample before any verdict', () => {
    expect(decideSettlement(0.5, { totalRuns: 4, successRate: 1 })).toEqual({
      verdict: 'insufficient',
      delta: 0,
    });
  });

  test('completes on improvement or a small dip, reverts on a real regression', () => {
    expect(decideSettlement(0.6, { totalRuns: 5, successRate: 0.8 })).toEqual({
      verdict: 'completed',
      delta: 0.2,
    });
    expect(decideSettlement(0.6, { totalRuns: 5, successRate: 0.58 }).verdict).toBe('completed');
    expect(decideSettlement(0.6, { totalRuns: 5, successRate: 0.5 })).toEqual({
      verdict: 'reverted',
      delta: -0.1,
    });
  });
});

describe('settleApprovedEvolutions', () => {
  const makePrisma = (
    rows: Array<{
      id: number;
      basePromptKey: string;
      evidenceJson: string | null;
      afterPrompt?: string;
    }>,
  ) => {
    const updates: Array<{ where: { id: number }; data: Record<string, unknown> }> = [];
    return {
      updates,
      prisma: {
        promptEvolution: {
          findMany: () => Promise.resolve(rows),
          update: (args: { where: { id: number }; data: Record<string, unknown> }) => {
            updates.push(args);
            return Promise.resolve(args);
          },
        },
      },
    };
  };
  const now = () => new Date('2026-09-06T05:00:00.000Z');

  test('stamps approvedAt on legacy rows instead of judging pre-approval sessions', async () => {
    const { prisma, updates } = makePrisma([
      { id: 1, basePromptKey: 'workflow_role_verifier', evidenceJson: '{"successRate":0.5}' },
    ]);
    const evaluate = mock(() => Promise.resolve({ totalRuns: 10, successRate: 0.9 }));
    const settled = await settleApprovedEvolutions(prisma, evaluate, now);
    expect(settled).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].data.evidenceJson as string).approvedAt).toBe(
      '2026-09-06T05:00:00.000Z',
    );
  });

  test('completes an addendum that improved the role and records the evidence', async () => {
    const { prisma, updates } = makePrisma([
      {
        id: 2,
        basePromptKey: 'workflow_role_implementer',
        evidenceJson: '{"successRate":0.6,"approvedAt":"2026-09-01T00:00:00.000Z"}',
      },
    ]);
    const evaluate = mock((_p: unknown, role: string, since: Date) => {
      expect(role).toBe('implementer');
      expect(since.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      return Promise.resolve({ totalRuns: 6, successRate: 0.8333 });
    });
    expect(await settleApprovedEvolutions(prisma, evaluate, now)).toBe(1);
    expect(updates[0].data.status).toBe('completed');
    expect(updates[0].data.performanceDelta).toBeCloseTo(0.2333, 3);
    const evidence = JSON.parse(updates[0].data.evidenceJson as string);
    expect(evidence.afterRuns).toBe(6);
    expect(evidence.beforeRate).toBe(0.6);
  });

  test('reverts an addendum that made the role worse', async () => {
    const { prisma, updates } = makePrisma([
      {
        id: 3,
        basePromptKey: 'workflow_role_planner',
        evidenceJson: '{"successRate":0.7,"approvedAt":"2026-09-01T00:00:00.000Z"}',
      },
    ]);
    await settleApprovedEvolutions(
      prisma,
      () => Promise.resolve({ totalRuns: 8, successRate: 0.5 }),
      now,
    );
    expect(updates[0].data.status).toBe('reverted');
  });

  test('leaves a row untouched while the sample is too small or evaluation fails', async () => {
    const { prisma, updates } = makePrisma([
      {
        id: 4,
        basePromptKey: 'workflow_role_researcher',
        evidenceJson: '{"successRate":0.5,"approvedAt":"2026-09-01T00:00:00.000Z"}',
      },
      {
        id: 5,
        basePromptKey: 'workflow_role_verifier',
        evidenceJson: '{"successRate":0.5,"approvedAt":"2026-09-01T00:00:00.000Z"}',
      },
    ]);
    const evaluate = (_p: unknown, role: string) =>
      role === 'researcher'
        ? Promise.resolve({ totalRuns: 2, successRate: 1 })
        : Promise.reject(new Error('db down'));
    expect(await settleApprovedEvolutions(prisma, evaluate, now)).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

describe('isPureAddendum', () => {
  test('true for an addendum with no deletion-signal keywords', () => {
    expect(isPureAddendum('提出前にlintを実行する。型チェックも通す。')).toBe(true);
  });

  test('false when the addendum instructs removing existing behavior', () => {
    expect(isPureAddendum('既存のエラーハンドリングを削除して簡潔にする')).toBe(false);
    expect(isPureAddendum('remove the retry logic before submitting')).toBe(false);
  });
});

describe('settleApprovedEvolutions — staged scope + auto-promote', () => {
  let tmpDir: string;
  let savedDataDir: string | undefined;
  let savedAutoPromote: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-prompt-evolution-settle-'));
    savedDataDir = process.env.RAPITAS_DATA_DIR;
    savedAutoPromote = process.env.RAPITAS_PROMPT_AUTO_PROMOTE;
    process.env.RAPITAS_DATA_DIR = tmpDir;
    delete process.env.RAPITAS_PROMPT_AUTO_PROMOTE;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.RAPITAS_DATA_DIR;
    else process.env.RAPITAS_DATA_DIR = savedDataDir;
    if (savedAutoPromote === undefined) delete process.env.RAPITAS_PROMPT_AUTO_PROMOTE;
    else process.env.RAPITAS_PROMPT_AUTO_PROMOTE = savedAutoPromote;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makePrisma = (
    rows: Array<{
      id: number;
      basePromptKey: string;
      evidenceJson: string | null;
      afterPrompt?: string;
    }>,
  ) => {
    const updates: Array<{ where: { id: number }; data: Record<string, unknown> }> = [];
    return {
      updates,
      prisma: {
        promptEvolution: {
          findMany: () => Promise.resolve(rows),
          update: (args: { where: { id: number }; data: Record<string, unknown> }) => {
            updates.push(args);
            return Promise.resolve(args);
          },
        },
      },
    };
  };
  const now = () => new Date('2026-09-06T05:00:00.000Z');

  function comparisonRecord(overrides: Partial<ComparisonRecord> = {}): ComparisonRecord {
    return {
      promptEvolutionId: 10,
      role: 'implementer',
      modelName: 'claude-sonnet-5',
      budgetUsd: 2.5,
      createdAt: new Date(0).toISOString(),
      status: 'done',
      sampleTaskIds: [810, 812],
      arms: [],
      summary: {
        successRateDelta: 0.2,
        costDelta: 0,
        durationDeltaMs: 0,
        baselineDurationMs: 1000,
        sampleSize: 5,
        excludedForInfraFailure: 0,
        verdict: 'improved',
        uncertainty: 'low',
      },
      knowledgeSnapshotHash: null,
      stagedTaskIds: [810, 812],
      ...overrides,
    };
  }

  test('evaluates only the staged task ids when a comparison record is present', async () => {
    writeComparisonRecord(comparisonRecord({ promptEvolutionId: 10 }));
    const { prisma } = makePrisma([
      {
        id: 10,
        basePromptKey: 'workflow_role_implementer',
        evidenceJson: '{"successRate":0.6,"approvedAt":"2026-09-01T00:00:00.000Z"}',
        afterPrompt: '提出前にlintを実行する',
      },
    ]);
    const evaluate = mock((_p: unknown, _role: string, _since: Date, scopeTaskIds?: number[]) => {
      expect(scopeTaskIds).toEqual([810, 812]);
      return Promise.resolve({ totalRuns: 6, successRate: 0.8 });
    });
    await settleApprovedEvolutions(prisma, evaluate, now);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  test('RAPITAS_PROMPT_AUTO_PROMOTE unset (default): stagedTaskIds is never cleared', async () => {
    writeComparisonRecord(comparisonRecord({ promptEvolutionId: 11 }));
    const { prisma } = makePrisma([
      {
        id: 11,
        basePromptKey: 'workflow_role_implementer',
        evidenceJson: '{"successRate":0.6,"approvedAt":"2026-09-01T00:00:00.000Z"}',
        afterPrompt: '提出前にlintを実行する',
      },
    ]);
    await settleApprovedEvolutions(
      prisma,
      () => Promise.resolve({ totalRuns: 6, successRate: 0.9 }),
      now,
    );
    expect(readComparisonRecord(11)?.stagedTaskIds).toEqual([810, 812]);
  });

  test('RAPITAS_PROMPT_AUTO_PROMOTE=true + completed + improved + pure addendum: stagedTaskIds is cleared', async () => {
    process.env.RAPITAS_PROMPT_AUTO_PROMOTE = 'true';
    writeComparisonRecord(comparisonRecord({ promptEvolutionId: 12 }));
    const { prisma } = makePrisma([
      {
        id: 12,
        basePromptKey: 'workflow_role_implementer',
        evidenceJson: '{"successRate":0.6,"approvedAt":"2026-09-01T00:00:00.000Z"}',
        afterPrompt: '提出前にlintを実行する',
      },
    ]);
    await settleApprovedEvolutions(
      prisma,
      () => Promise.resolve({ totalRuns: 6, successRate: 0.9 }),
      now,
    );
    expect(readComparisonRecord(12)?.stagedTaskIds).toBeNull();
  });

  test('RAPITAS_PROMPT_AUTO_PROMOTE=true but verdict=reverted: stagedTaskIds stays set', async () => {
    process.env.RAPITAS_PROMPT_AUTO_PROMOTE = 'true';
    writeComparisonRecord(comparisonRecord({ promptEvolutionId: 13 }));
    const { prisma } = makePrisma([
      {
        id: 13,
        basePromptKey: 'workflow_role_implementer',
        evidenceJson: '{"successRate":0.9,"approvedAt":"2026-09-01T00:00:00.000Z"}',
        afterPrompt: '提出前にlintを実行する',
      },
    ]);
    await settleApprovedEvolutions(
      prisma,
      () => Promise.resolve({ totalRuns: 6, successRate: 0.5 }),
      now,
    );
    expect(readComparisonRecord(13)?.stagedTaskIds).toEqual([810, 812]);
  });

  test('RAPITAS_PROMPT_AUTO_PROMOTE=true but addendum instructs deletion: stagedTaskIds stays set', async () => {
    process.env.RAPITAS_PROMPT_AUTO_PROMOTE = 'true';
    writeComparisonRecord(comparisonRecord({ promptEvolutionId: 14 }));
    const { prisma } = makePrisma([
      {
        id: 14,
        basePromptKey: 'workflow_role_implementer',
        evidenceJson: '{"successRate":0.6,"approvedAt":"2026-09-01T00:00:00.000Z"}',
        afterPrompt: '既存のリトライ処理を削除する',
      },
    ]);
    await settleApprovedEvolutions(
      prisma,
      () => Promise.resolve({ totalRuns: 6, successRate: 0.9 }),
      now,
    );
    expect(readComparisonRecord(14)?.stagedTaskIds).toEqual([810, 812]);
  });
});

describe('settleApprovedEvolutions — staged 行との相互排他', () => {
  test('status=staged の行は問い合わせ対象に入らず、昇格判定も発火しない', async () => {
    // 限定試行中(staged)と承認済み(approved)を混在させ、where を実際に評価する。
    const all = [
      {
        id: 1,
        status: 'staged',
        basePromptKey: 'workflow_role_implementer',
        evidenceJson: '{"successRate":0.5,"approvedAt":"2026-08-01T00:00:00.000Z"}',
        afterPrompt: '- lintを実行する',
      },
      {
        id: 2,
        status: 'approved',
        basePromptKey: 'workflow_role_verifier',
        evidenceJson: '{"successRate":0.5,"approvedAt":"2026-08-01T00:00:00.000Z"}',
        afterPrompt: '- 型チェックを通す',
      },
    ];
    const updates: Array<{ where: { id: number } }> = [];
    const prisma = {
      promptEvolution: {
        findMany: (args: { where: { status: string } }) =>
          Promise.resolve(all.filter((r) => r.status === args.where.status)),
        update: (args: { where: { id: number } }) => {
          updates.push(args);
          return Promise.resolve(args);
        },
      },
    };
    const evaluate = mock(() => Promise.resolve({ totalRuns: 10, successRate: 0.9 }));

    const settled = await settleApprovedEvolutions(prisma, evaluate, () => new Date());

    expect(settled).toBe(1);
    // staged 行(id:1)には一切触れない = auto-approve 側の昇格判定と二重発火しない。
    expect(updates.map((u) => u.where.id)).toEqual([2]);
  });
});
