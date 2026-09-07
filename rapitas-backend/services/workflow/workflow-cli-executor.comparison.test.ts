/**
 * workflow-cli-executor.comparison.test
 *
 * executeCLIAgent の比較サンプル記録。限定試行の割当を受け取ったフェーズが、
 * 実行終了時に実際の AgentExecution（実行ID・コスト・所要時間・失敗原因）を
 * 比較記録へ追記すること、割当が無ければ何も書かないこと、注入されなかった
 * 介入アームは記録されないことを検証する。配線漏れ（割当が executeCLIAgent
 * まで届かない）を検知するための回帰テスト。
 * Own file — mock.module is process-global.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  wf,
  spies,
  resetWfMockState,
  installWorkflowCliExecutorMocks,
} from '../../tests/helpers/workflow-cli-executor-mock-state';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';
import type { ComparisonAssignment } from '../self-learning/comparison/prompt-comparison-types';

installWorkflowCliExecutorMocks();

const { executeCLIAgent } = await import('./workflow-cli-executor');
const { initComparisonRecordForStaging, readComparisonRecord } =
  await import('../self-learning/comparison/prompt-comparison-store');

const getOrCreateDevConfig = (): Promise<{ id: number }> => Promise.resolve({ id: 42 });
const task = { title: 'Finish the thing', description: 'desc' };
const agentConfig = { id: 1, agentType: 'claude-code', name: 'Agent', modelId: null };
const implementerTransition = (): RoleTransition => ({
  role: 'implementer',
  outputFile: null,
  nextStatus: 'verify_done',
});
const noopAdvance = (): Promise<WorkflowAdvanceResult> =>
  Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' });

function assignment(over: Partial<ComparisonAssignment> = {}): ComparisonAssignment {
  return {
    promptEvolutionId: 55,
    role: 'implementer',
    arm: 'candidate',
    injected: true,
    injectedVersion: 'abc123def456',
    ...over,
  };
}

async function run(assigned: ComparisonAssignment | null): Promise<WorkflowAdvanceResult> {
  return executeCLIAgent(
    1,
    task,
    agentConfig,
    'system prompt',
    'context',
    implementerTransition(),
    'ja',
    noopAdvance,
    getOrCreateDevConfig,
    assigned,
  );
}

let tmpDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  resetWfMockState();
  tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-cli-comparison-'));
  savedDataDir = process.env.RAPITAS_DATA_DIR;
  process.env.RAPITAS_DATA_DIR = tmpDir;
  initComparisonRecordForStaging({
    promptEvolutionId: 55,
    role: 'implementer',
    createdAt: new Date(0).toISOString(),
  });
  spies.agentExecutionFindFirst.mockImplementation(() =>
    Promise.resolve({
      id: 7788,
      status: 'completed',
      errorMessage: null,
      costUsd: 1.25,
      executionTimeMs: 123_000,
    }),
  );
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = savedDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('executeCLIAgent — 限定試行の比較サンプル記録', () => {
  test('割当を受け取ったフェーズは実行ID・コスト・注入版を比較記録に残す', async () => {
    await run(assignment());

    const runs = readComparisonRecord(55)?.arms.find((c) => c.arm === 'candidate')?.runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      taskId: 1,
      executionId: 7788,
      success: true,
      costUsd: 1.25,
      durationMs: 123_000,
      failureCause: null,
      role: 'implementer',
      injected: true,
      injectedVersion: 'abc123def456',
    });
  });

  test('対照アームも同じ経路で記録される', async () => {
    await run(assignment({ arm: 'current', injected: false, injectedVersion: null }));

    const runs = readComparisonRecord(55)?.arms.find((c) => c.arm === 'current')?.runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.injected).toBe(false);
  });

  test('割当が無ければ比較記録には何も書かれない', async () => {
    await run(null);

    expect(readComparisonRecord(55)?.arms).toEqual([]);
  });

  test('注入されなかった介入アームは記録されない(割当だけで介入済みとしない)', async () => {
    await run(assignment({ injected: false, injectedVersion: null }));

    expect(readComparisonRecord(55)?.arms).toEqual([]);
  });

  test('失敗したフェーズは failureCause 付きで記録される', async () => {
    wf.executeTaskImpl = async () => ({
      success: false,
      output: '',
      errorMessage: 'agent crashed',
    });
    spies.agentExecutionFindFirst.mockImplementation(() =>
      Promise.resolve({
        id: 7789,
        status: 'failed',
        errorMessage: 'agent crashed',
        costUsd: 0.5,
        executionTimeMs: 1000,
      }),
    );

    await run(assignment());

    const runs = readComparisonRecord(55)?.arms.find((c) => c.arm === 'candidate')?.runs ?? [];
    expect(runs[0]).toMatchObject({ success: false, failureCause: 'implementation_error' });
  });

  test('比較記録の書き込み失敗はフェーズ結果に影響しない', async () => {
    spies.agentExecutionFindFirst.mockImplementation(() => Promise.reject(new Error('db down')));

    const result = await run(assignment());

    expect(result.success).toBe(true);
  });
});
