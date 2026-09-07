/**
 * workflow-orchestrator-context.addenda テスト
 *
 * ロールコンテキストへの追記注入の実行経路を検証する。未評価(staged)候補が
 * 全実行へ無条件注入されず、対照アームでは本文が一切入らないこと、承認済み
 * 追記がある場合は限定試行が起動せず二重注入されないこと、注入できた場合のみ
 * 割当が injected=true になり呼び出し側へ返ること。
 * Own file — mock.module is process-global.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { RoleTransition } from './workflow-types';
import type { ResolvedTask } from './workflow-orchestrator-preflight';
import type { StagedTrialAssignment } from '../self-learning/prompt-evolution-staged-trial';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '',
}));
mock.module('../../config', () => ({
  prisma: {},
  createLogger: () => noopLogger,
}));
mock.module('./workflow-context-builder', () => ({
  buildRoleContext: () => Promise.resolve('BASE'),
}));
mock.module('./role-route-inputs', () => ({
  routeModelForRole: () => Promise.resolve({ modelId: null, details: {} }),
  shouldAutoSelectModel: () => false,
}));

let approved: { promptEvolutionId: number; text: string } | null = null;
const getApprovedRoleAddendumDetail = mock(() => Promise.resolve(approved));
mock.module('../self-learning/prompt-evolution-worker', () => ({
  getApprovedRoleAddendumDetail,
  getApprovedRoleAddendum: () => Promise.resolve(approved?.text ?? null),
}));

let trial: StagedTrialAssignment | null = null;
const getStagedRoleAddendumForTrial = mock(() => Promise.resolve(trial));
mock.module('../self-learning/prompt-evolution-staged-trial', () => ({
  getStagedRoleAddendumForTrial,
}));

mock.module('../self-learning/experiment-loop/experiment-store', () => ({
  getActiveExperimentInjection: () => Promise.resolve(null),
  getActiveExperimentAddendum: () => Promise.resolve(null),
}));

const { buildExecutionContext } = await import('./workflow-orchestrator-context');

const transition: RoleTransition = {
  role: 'implementer',
  outputFile: null,
  nextStatus: 'verify_done',
};
const task = { id: 1, title: 't', description: null } as unknown as ResolvedTask;

function stagedTrial(over: Partial<StagedTrialAssignment> = {}): StagedTrialAssignment {
  return {
    assignment: {
      promptEvolutionId: 55,
      role: 'implementer',
      arm: 'candidate',
      injected: false,
      injectedVersion: null,
    },
    addendum: '- 候補の追記',
    version: 'v-abc',
    ...over,
  };
}

beforeEach(() => {
  approved = null;
  trial = null;
  getApprovedRoleAddendumDetail.mockClear();
  getStagedRoleAddendumForTrial.mockClear();
});

describe('buildExecutionContext — 追記注入の経路', () => {
  test('候補が無ければ追記もアーム割当も付かない', async () => {
    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toBe('BASE');
    expect(result.comparisonAssignment).toBeNull();
  });

  test('未評価候補の対照アームでは本文が一切注入されない', async () => {
    trial = stagedTrial({
      assignment: {
        promptEvolutionId: 55,
        role: 'implementer',
        arm: 'current',
        injected: false,
        injectedVersion: null,
      },
      addendum: null,
      version: null,
    });

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toBe('BASE');
    expect(result.comparisonAssignment?.arm).toBe('current');
    // 割当だけで介入済みとしない。
    expect(result.comparisonAssignment?.injected).toBe(false);
  });

  test('介入アームでのみ本文が注入され、注入できたときだけ injected=true になる', async () => {
    trial = stagedTrial();

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toContain('## 限定試行中の改善ガイダンス(効果測定中)');
    expect(result.context).toContain('- 候補の追記');
    expect(result.comparisonAssignment).toMatchObject({
      promptEvolutionId: 55,
      arm: 'candidate',
      injected: true,
      injectedVersion: 'v-abc',
    });
  });

  test('承認済み追記があるロールでは限定試行を起動せず二重注入しない', async () => {
    approved = { promptEvolutionId: 7, text: '- 承認済みの追記' };
    trial = stagedTrial();

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toContain('## 承認済みの改善ガイダンス(プロンプト進化)');
    expect(result.context).not.toContain('## 限定試行中の改善ガイダンス(効果測定中)');
    expect(getStagedRoleAddendumForTrial).not.toHaveBeenCalled();
    expect(result.comparisonAssignment).toBeNull();
  });
});
