/**
 * workflow-orchestrator-context.addenda テスト
 *
 * ロールコンテキストへの追記注入の実行経路を検証する。未評価(staged)候補が
 * 全実行へ無条件注入されないこと、承認済み追記があるロールでも限定試行が起動
 * すること(飢餓状態の解消)、対照アームには承認済み追記が・介入アームには候補の
 * 追記が入り二重注入されないこと、注入できた場合のみ割当が injected=true に
 * なること、そして比較アームに割り当てられたフェーズには実験ループの未承認
 * 文言が混入しないこと。
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

let experiment: { experimentId: string; hypothesisId: number; addendum: string } | null = null;
const getActiveExperimentInjection = mock(() => Promise.resolve(experiment));
mock.module('../self-learning/experiment-loop/experiment-store', () => ({
  getActiveExperimentInjection,
  getActiveExperimentAddendum: () => Promise.resolve(experiment?.addendum ?? null),
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

/** 対照アームに割り当てられた試行（候補の追記文は返らない）。 */
function controlTrial(): StagedTrialAssignment {
  return stagedTrial({
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
}

beforeEach(() => {
  approved = null;
  trial = null;
  experiment = null;
  getApprovedRoleAddendumDetail.mockClear();
  getStagedRoleAddendumForTrial.mockClear();
  getActiveExperimentInjection.mockClear();
});

describe('buildExecutionContext — 追記注入の経路', () => {
  test('候補が無ければ追記もアーム割当も付かない', async () => {
    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toBe('BASE');
    expect(result.comparisonAssignment).toBeNull();
  });

  test('承認済み追記が無いロールの対照アームでは本文が一切注入されない', async () => {
    trial = controlTrial();

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

  test('承認済み追記があるロールでも限定試行は起動する(飢餓状態を作らない)', async () => {
    // 以前はここで試行がスキップされ、承認済み追記を持つロールの候補は
    // サンプルを1件も集められず永久に採用も撤回もされなかった。
    approved = { promptEvolutionId: 7, text: '- 承認済みの追記' };
    trial = stagedTrial();

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(getStagedRoleAddendumForTrial).toHaveBeenCalled();
    expect(result.comparisonAssignment?.arm).toBe('candidate');
    // 介入アームは候補の追記のみ。承認済み追記と二重注入しない。
    expect(result.context).toContain('## 限定試行中の改善ガイダンス(効果測定中)');
    expect(result.context).toContain('- 候補の追記');
    expect(result.context).not.toContain('- 承認済みの追記');
  });

  test('承認済み追記があるロールの対照アームは承認済み追記を注入する', async () => {
    // 対照は「素のプロンプト」ではなく「いま本番で動いているプロンプト」。
    approved = { promptEvolutionId: 7, text: '- 承認済みの追記' };
    trial = controlTrial();

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toContain('## 承認済みの改善ガイダンス(プロンプト進化)');
    expect(result.context).toContain('- 承認済みの追記');
    expect(result.context).not.toContain('## 限定試行中の改善ガイダンス(効果測定中)');
    // 対照アームは介入ではないので injected は false のまま。
    expect(result.comparisonAssignment).toMatchObject({ arm: 'current', injected: false });
  });

  test('試行が無いロールでは承認済み追記が従来どおり全実行へ適用される', async () => {
    approved = { promptEvolutionId: 7, text: '- 承認済みの追記' };
    trial = null;

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toContain('## 承認済みの改善ガイダンス(プロンプト進化)');
    expect(result.context).toContain('- 承認済みの追記');
    expect(result.comparisonAssignment).toBeNull();
  });
});

describe('buildExecutionContext — 実験ループとの排他化', () => {
  const activeExperiment = {
    experimentId: 'exp_1_1000',
    hypothesisId: 1,
    addendum: '- 実験中の指示',
  };

  test('比較アームに割り当てられたフェーズには実験文言を混入させない', async () => {
    trial = stagedTrial();
    experiment = activeExperiment;

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toContain('## 限定試行中の改善ガイダンス(効果測定中)');
    expect(result.context).not.toContain('## 実験中の改善ガイダンス');
    // 呼び出し自体を行わない（事後除外ではなく注入前に排他化する）。
    expect(getActiveExperimentInjection).not.toHaveBeenCalled();
  });

  test('対照アームでも実験文言は混入しない(対照が対照でなくなるため)', async () => {
    trial = controlTrial();
    experiment = activeExperiment;

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toBe('BASE');
    expect(getActiveExperimentInjection).not.toHaveBeenCalled();
  });

  test('承認済み追記単独では実験ループを排他しない(比較の交絡にならないため)', async () => {
    // 承認済み追記は実験ループ自身の treatment / control 双方に等しく載るため、
    // その測定を歪めない。排他が必要なのは比較アーム割当がある場合だけ。
    approved = { promptEvolutionId: 7, text: '- 承認済みの追記' };
    experiment = activeExperiment;

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toContain('## 承認済みの改善ガイダンス(プロンプト進化)');
    expect(result.context).toContain('## 実験中の改善ガイダンス(未承認・効果測定中)');
  });

  test('比較割当も承認済み追記も無ければ実験文言は従来どおり注入される', async () => {
    experiment = activeExperiment;

    const result = await buildExecutionContext(1, transition, task, 'ja', 'lightweight');

    expect(result.context).toContain('## 実験中の改善ガイダンス(未承認・効果測定中)');
    expect(result.context).toContain('- 実験中の指示');
    expect(result.comparisonAssignment).toBeNull();
  });
});
