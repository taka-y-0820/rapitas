/**
 * agent-core ユニットテスト（execute() オーケストレーション）
 *
 * execute() の作業ディレクトリ検証・CLI 疎通チェック・runClaudeExecution への委譲、
 * および private buildResolveAfterParse ラッパー（checkPlanCreated クロージャの
 * plan_created/plan_approved/research_done/サブタスク分割判定を含む）を対象とする。
 *
 * 実 CLI プロセスは spawn しない — runClaudeExecution 自体を丸ごとモックし、
 * 呼び出し引数だけを検証する。execution-resolver.buildResolveAfterParse も丸ごと
 * モックし、agent-core.ts が組み立てる ResolverContext / checkPlanCreated を検証する。
 */
import { describe, expect, mock, test } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentExecutionResult, AgentTask } from '../base-agent';
import {
  createPrismaMock,
  databaseModuleFactory,
  prismaModelMock,
} from '../../../tests/helpers/mock-database';

// --- モックセットアップ（動的 import より先に定義すること） ---

mock.module('../../../config/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) },
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getBackendLogFilePath: () => '/tmp/backend-test.log',
}));

const findUniqueMock = mock(() => Promise.resolve(null));
const countMock = mock(() => Promise.resolve(0));
const mockPrisma = createPrismaMock({
  task: prismaModelMock({ findUnique: findUniqueMock, count: countMock }),
});
mock.module('../../../config/database', () => databaseModuleFactory(mockPrisma));

let mockClaudeAvailable = true;
mock.module('./cli-utils', () => ({
  resolveCliPath: (name: string) => name,
  getClaudePath: () => 'claude.cmd',
  checkClaudeAvailable: () => Promise.resolve(mockClaudeAvailable),
  buildSpawnCommand: (path: string, args: string[]) => [path, args] as [string, string[]],
}));

/** 直近の runClaudeExecution 呼び出し引数を捕捉する。 */
interface CapturedRunArgs {
  workDir: string;
  timeout: number;
  resolve: (result: AgentExecutionResult) => void;
  buildResolveAfterParse: (
    code: number | null,
    workDir: string,
    startTime: number,
    resolve: (result: AgentExecutionResult) => void,
  ) => () => void;
}
let capturedRunArgs: CapturedRunArgs | null = null;
const runClaudeExecutionSpy = mock(
  (
    _agent: unknown,
    _task: unknown,
    workDir: string,
    _startTime: number,
    timeout: number,
    resolve: (result: AgentExecutionResult) => void,
    buildResolveAfterParse: CapturedRunArgs['buildResolveAfterParse'],
  ) => {
    capturedRunArgs = { workDir, timeout, resolve, buildResolveAfterParse };
  },
);
mock.module('./claude-execution-runner', () => ({
  buildClaudeArgs: () => ({ args: [], logExtras: [] }),
  buildSpawnEnv: () => ({}),
  runClaudeExecution: runClaudeExecutionSpy,
}));

mock.module('./worker-message-handler', () => ({
  handleWorkerMessage: mock(() => {}),
}));

/** 直近の execution-resolver.buildResolveAfterParse 呼び出し引数を捕捉する。 */
interface CapturedResolverArgs {
  code: number | null;
  investigationMode: boolean | undefined;
  checkPlanCreated?: () => Promise<boolean>;
}
let capturedResolverArgs: CapturedResolverArgs | null = null;
const buildResolveAfterParseSpy = mock(
  (
    _ctx: unknown,
    code: number | null,
    _workDir: string,
    _startTime: number,
    resolve: (result: AgentExecutionResult) => void,
    _getArtifacts: () => unknown,
    _getCommits: () => unknown,
    checkPlanCreated?: () => Promise<boolean>,
    investigationMode?: boolean,
  ) => {
    capturedResolverArgs = { code, investigationMode, checkPlanCreated };
    return () => resolve({ success: true, output: 'resolved-via-mock', executionTimeMs: 1 });
  },
);
mock.module('./execution-resolver', () => ({
  buildResolveAfterParse: buildResolveAfterParseSpy,
}));

// モック確定後に動的 import
const { ClaudeCodeAgent } = await import('./agent-core');

// --- テストヘルパー ---

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 1,
    title: 'test task',
    ...overrides,
  };
}

/**
 * execute() awaits real fs.stat + checkClaudeAvailable() before calling
 * runClaudeExecution — those are real I/O ticks, not just microtasks, so a
 * fixed number of `await Promise.resolve()` is not reliably enough ticks.
 * Poll with real timers until the spy has been invoked (or time out).
 */
async function waitForRunClaudeExecutionCall(): Promise<void> {
  for (let i = 0; i < 100 && capturedRunArgs === null; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (capturedRunArgs === null) {
    throw new Error('runClaudeExecution was not invoked within the polling window');
  }
}

// --- テストスイート ---

describe('ClaudeCodeAgent.execute — 作業ディレクトリ検証', () => {
  test('存在しないディレクトリ → 即座に失敗し status が failed になる', async () => {
    const agent = new ClaudeCodeAgent('e1', 'agent-e1');
    const nonExistent = join(tmpdir(), `agent-core-execute-missing-${Date.now()}`);

    const result = await agent.execute(makeTask({ workingDirectory: nonExistent }));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('does not exist');
    expect(agent.getStatus()).toBe('failed');
    expect(runClaudeExecutionSpy).not.toHaveBeenCalled();
  });

  test('ディレクトリではなくファイル → 即座に失敗する', async () => {
    const fs = await import('fs');
    const filePath = join(tmpdir(), `agent-core-execute-file-${Date.now()}.txt`);
    fs.writeFileSync(filePath, 'not a dir');
    try {
      const agent = new ClaudeCodeAgent('e2', 'agent-e2');
      const result = await agent.execute(makeTask({ workingDirectory: filePath }));

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('is not a directory');
      expect(agent.getStatus()).toBe('failed');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  test('task.workingDirectory > config.workingDirectory の優先順位で解決される', async () => {
    mockClaudeAvailable = true;
    capturedRunArgs = null;
    const fs = await import('fs');
    const configDir = tmpdir();
    // task 側は config 側と別物であることを検証するため、実在する別ディレクトリを用意する
    const taskDir = join(tmpdir(), `agent-core-execute-taskdir-${Date.now()}`);
    fs.mkdirSync(taskDir);
    try {
      const agent = new ClaudeCodeAgent('e3', 'agent-e3', { workingDirectory: configDir });

      void agent.execute(makeTask({ workingDirectory: taskDir }));
      await waitForRunClaudeExecutionCall();

      expect(capturedRunArgs?.workDir).toBe(taskDir);
      expect(capturedRunArgs?.workDir).not.toBe(configDir);
      capturedRunArgs?.resolve({ success: true, output: '', executionTimeMs: 0 });
    } finally {
      fs.rmdirSync(taskDir);
    }
  });

  test('workingDirectory を何も指定しない場合 getProjectRoot() が使われる', async () => {
    mockClaudeAvailable = true;
    capturedRunArgs = null;
    const path = await import('path');
    const agent = new ClaudeCodeAgent('e3b', 'agent-e3b');

    void agent.execute(makeTask());
    await waitForRunClaudeExecutionCall();

    expect(capturedRunArgs?.workDir).toBe(path.resolve(process.cwd(), '..'));
    capturedRunArgs?.resolve({ success: true, output: '', executionTimeMs: 0 });
  });
});

describe('ClaudeCodeAgent.execute — CLI 疎通チェック', () => {
  test('CLI が利用不可の場合、runClaudeExecution を呼ばずに失敗を返す', async () => {
    mockClaudeAvailable = false;
    runClaudeExecutionSpy.mockClear();
    const agent = new ClaudeCodeAgent('e4', 'agent-e4', { workingDirectory: tmpdir() });

    const result = await agent.execute(makeTask());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Claude Code CLI not found');
    expect(agent.getStatus()).toBe('failed');
    expect(runClaudeExecutionSpy).not.toHaveBeenCalled();
    mockClaudeAvailable = true;
  });
});

describe('ClaudeCodeAgent.execute — runClaudeExecution への委譲と状態リセット', () => {
  test('実行前に status=running となり、前回実行の残留状態がリセットされる', async () => {
    mockClaudeAvailable = true;
    capturedRunArgs = null;
    const agent = new ClaudeCodeAgent('e5', 'agent-e5', { workingDirectory: tmpdir() });
    // 前回実行の残留状態を模擬する
    agent.outputBuffer = 'stale output';
    agent.errorBuffer = 'stale error';
    agent.hasFileModifyingToolCalls = true;
    agent.idleTimeoutForceKilled = true;
    agent.claudeSessionId = 'stale-session';
    agent.workerArtifacts = [{ type: 'file', name: 'x', content: 'y' }];
    agent.activeTools.set('tool-1', { name: 'Bash', startTime: 0, info: '' });

    const resultPromise = agent.execute(makeTask());
    // execute() は同期的に状態リセット・status='running' を行ってから runClaudeExecution を呼ぶ
    expect(agent.getStatus()).toBe('running');
    expect(agent.outputBuffer).toBe('');
    expect(agent.errorBuffer).toBe('');
    expect(agent.hasFileModifyingToolCalls).toBe(false);
    expect(agent.idleTimeoutForceKilled).toBe(false);
    expect(agent.claudeSessionId).toBeNull();
    expect(agent.workerArtifacts).toEqual([]);
    expect(agent.activeTools.size).toBe(0);

    await waitForRunClaudeExecutionCall();
    capturedRunArgs?.resolve({ success: true, output: 'done', executionTimeMs: 5 });
    const result = await resultPromise;
    expect(result.output).toBe('done');
  });

  test('runClaudeExecution が resolve した結果がそのまま execute() の戻り値になる', async () => {
    mockClaudeAvailable = true;
    capturedRunArgs = null;
    const agent = new ClaudeCodeAgent('e6', 'agent-e6', { workingDirectory: tmpdir() });

    const resultPromise = agent.execute(makeTask());
    await waitForRunClaudeExecutionCall();

    const expected: AgentExecutionResult = {
      success: true,
      output: 'agent output text',
      executionTimeMs: 42,
      claudeSessionId: 'sess-xyz',
    };
    capturedRunArgs?.resolve(expected);

    const result = await resultPromise;
    expect(result).toEqual(expected);
  });

  test('timeout は config.timeout を優先し、指定した値が runClaudeExecution に渡る', async () => {
    mockClaudeAvailable = true;
    capturedRunArgs = null;
    const agent = new ClaudeCodeAgent('e7', 'agent-e7', {
      workingDirectory: tmpdir(),
      timeout: 99999,
    });

    void agent.execute(makeTask());
    await waitForRunClaudeExecutionCall();

    expect(capturedRunArgs?.timeout).toBe(99999);
    capturedRunArgs?.resolve({ success: true, output: '', executionTimeMs: 0 });
  });
});

describe('ClaudeCodeAgent — private buildResolveAfterParse ラッパー（checkPlanCreated）', () => {
  /** execute() を起動し、runClaudeExecution 経由で渡される buildResolveAfterParse を取得する。 */
  async function captureBuildResolveAfterParse(taskId?: number): Promise<CapturedRunArgs> {
    mockClaudeAvailable = true;
    capturedRunArgs = null;
    const agent = new ClaudeCodeAgent(`e-bra-${taskId ?? 'none'}`, 'agent-bra', {
      workingDirectory: tmpdir(),
    });
    void agent.execute(makeTask(taskId !== undefined ? { id: taskId } : {}));
    await waitForRunClaudeExecutionCall();
    if (!capturedRunArgs) throw new Error('runClaudeExecution was not invoked');
    return capturedRunArgs;
  }

  test('checkPlanCreated: workflowStatus=plan_created → true（承認待ちとして扱う）', async () => {
    findUniqueMock.mockClear();
    findUniqueMock.mockImplementation(() => Promise.resolve({ workflowStatus: 'plan_created' }));
    const run = await captureBuildResolveAfterParse(101);
    run.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});

    expect(capturedResolverArgs?.checkPlanCreated).toBeDefined();
    const created = await capturedResolverArgs!.checkPlanCreated!();
    expect(created).toBe(true);
  });

  test('checkPlanCreated: workflowStatus=plan_approved → true', async () => {
    findUniqueMock.mockClear();
    findUniqueMock.mockImplementation(() => Promise.resolve({ workflowStatus: 'plan_approved' }));
    const run = await captureBuildResolveAfterParse(102);
    run.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});

    const created = await capturedResolverArgs!.checkPlanCreated!();
    expect(created).toBe(true);
  });

  test('checkPlanCreated: workflowStatus=research_done → true（意図的な一時停止）', async () => {
    findUniqueMock.mockClear();
    findUniqueMock.mockImplementation(() => Promise.resolve({ workflowStatus: 'research_done' }));
    const run = await captureBuildResolveAfterParse(103);
    run.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});

    const created = await capturedResolverArgs!.checkPlanCreated!();
    expect(created).toBe(true);
  });

  test('checkPlanCreated: 他の workflowStatus かつ subtaskCount=0 → false', async () => {
    findUniqueMock.mockClear();
    countMock.mockClear();
    findUniqueMock.mockImplementation(() => Promise.resolve({ workflowStatus: 'draft' }));
    countMock.mockImplementation(() => Promise.resolve(0));
    const run = await captureBuildResolveAfterParse(104);
    run.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});

    const created = await capturedResolverArgs!.checkPlanCreated!();
    expect(created).toBe(false);
  });

  test('checkPlanCreated: 他の workflowStatus だが subtaskCount>0 → true（分割済みタスク）', async () => {
    findUniqueMock.mockClear();
    countMock.mockClear();
    findUniqueMock.mockImplementation(() => Promise.resolve({ workflowStatus: 'in_progress' }));
    countMock.mockImplementation(() => Promise.resolve(3));
    const run = await captureBuildResolveAfterParse(105);
    run.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});

    const created = await capturedResolverArgs!.checkPlanCreated!();
    expect(created).toBe(true);
  });

  test('checkPlanCreated: taskId が falsy（0）→ prisma を呼ばずに false', async () => {
    // NOTE: AgentTask.id is typed as a required number, but the guard is a
    // falsy check (`if (!taskId) return false`), so id=0 is the realistic
    // way to exercise that branch — `undefined` never reaches it because
    // makeTask() always defaults id to 1.
    findUniqueMock.mockClear();
    const run = await captureBuildResolveAfterParse(0);
    run.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});

    const created = await capturedResolverArgs!.checkPlanCreated!();
    expect(created).toBe(false);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('checkPlanCreated: prisma がエラーを投げた場合 → catch して false', async () => {
    findUniqueMock.mockClear();
    findUniqueMock.mockImplementation(() => Promise.reject(new Error('db down')));
    const run = await captureBuildResolveAfterParse(106);
    run.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});

    const created = await capturedResolverArgs!.checkPlanCreated!();
    expect(created).toBe(false);
  });

  test('investigationMode が config から resolver へ引き継がれる', async () => {
    mockClaudeAvailable = true;
    capturedRunArgs = null;
    const agent = new ClaudeCodeAgent('e-inv', 'agent-inv', {
      workingDirectory: tmpdir(),
      investigationMode: true,
    });
    void agent.execute(makeTask({ id: 200 }));
    await waitForRunClaudeExecutionCall();
    capturedRunArgs!.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});

    expect(capturedResolverArgs?.investigationMode).toBe(true);
  });

  test('verifier accepts evidence without enabling read-only tool restrictions', async () => {
    mockClaudeAvailable = true;
    capturedRunArgs = null;
    const agent = new ClaudeCodeAgent('verify', 'verifier', {
      workingDirectory: tmpdir(),
      investigationMode: false,
      investigationOutputType: 'verify',
    });
    void agent.execute(makeTask({ id: 201 }));
    await waitForRunClaudeExecutionCall();
    capturedRunArgs!.buildResolveAfterParse(0, tmpdir(), Date.now(), () => {});
    expect(capturedResolverArgs?.investigationMode).toBe(true);
    expect(agent.config.investigationMode).toBe(false);
  });
});
