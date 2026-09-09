/**
 * workflow-cli-executor.worktree.test
 *
 * executeCLIAgent's per-task git worktree resolution: reuse a still-existing
 * recorded worktree, recreate one when the recorded path is missing/phantom,
 * fall back to the cwd's git root when the theme has no workingDirectory, and
 * the worktree-or-hard-fail invariant: a mutating role NEVER runs in any
 * repo's PRIMARY checkout — worktree creation failure is fatal, and the
 * repo-agnostic isPrimaryWorkTree pre-spawn guard refuses the leftovers.
 * Researchers use the theme checkout; planners may reuse existing work but
 * never create a replacement worktree.
 *
 * Uses `role: 'verifier'` with `outputFile: null` as a synthetic "mutating
 * role" fixture so worktree assertions stay isolated from the (separately
 * tested) verify-phase completion logic and the implementer's 1s
 * auto-advance `setTimeout`.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  wf,
  spies,
  resetWfMockState,
  installWorkflowCliExecutorMocks,
  type AgentTaskLike,
  type ExecutionOptionsLike,
} from '../../tests/helpers/workflow-cli-executor-mock-state';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';

// executeCLIAgent unconditionally `mkdir`s the workflow dir — fs/promises is
// intentionally left un-mocked (see mock-state helper), so this must be a
// real, writable path.

installWorkflowCliExecutorMocks();
const { executeCLIAgent } = await import('./workflow-cli-executor');

const advanceWorkflow = (): Promise<WorkflowAdvanceResult> =>
  Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' });
const getOrCreateDevConfig = (): Promise<{ id: number }> => Promise.resolve({ id: 42 });

const task = { title: 'Do the thing', description: 'desc' };
const agentConfig = { id: 1, agentType: 'claude-code', name: 'Agent', modelId: null };

function mutatingTransition(): RoleTransition {
  return { role: 'verifier', outputFile: null, nextStatus: 'completed' };
}
function autoVerifierTransition(): RoleTransition {
  return { role: 'auto_verifier', outputFile: null, nextStatus: 'completed' };
}
function nonMutatingTransition(): RoleTransition {
  return { role: 'researcher', outputFile: null, nextStatus: 'research_done' };
}

async function run(transition: RoleTransition, taskId = 1): Promise<WorkflowAdvanceResult> {
  return executeCLIAgent(
    taskId,
    task,
    agentConfig,
    'system prompt',
    'context',
    transition,
    'ja',
    advanceWorkflow,
    getOrCreateDevConfig,
  );
}

function lastExecuteTaskCall(): [AgentTaskLike, ExecutionOptionsLike] {
  const calls = spies.executeTask.mock.calls;
  return calls[calls.length - 1] as [AgentTaskLike, ExecutionOptionsLike];
}

describe('executeCLIAgent — worktree resolution', () => {
  test('planner does not recreate a missing worktree', async () => {
    wf.latestSessionWorktree = {
      worktreePath: '/fake/worktree/missing',
      branchName: 'feature/existing',
    };
    wf.canReuseWorktree = false;
    await run({ ...nonMutatingTransition(), role: 'planner' });
    expect(lastExecuteTaskCall()[1].workingDirectory).toBe('/fake/project');
    expect(spies.createWorktree).not.toHaveBeenCalled();
  });

  test('planner inherits existing implementation work without creating a replacement', async () => {
    resetWfMockState();
    wf.latestSessionWorktree = {
      worktreePath: '/fake/worktree/existing',
      branchName: 'feature/existing',
    };
    wf.canReuseWorktree = true;
    await run({ ...nonMutatingTransition(), role: 'planner' });
    expect(lastExecuteTaskCall()[1].workingDirectory).toBe('/fake/worktree/existing');
    expect(spies.createWorktree).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    resetWfMockState();
  });

  test('investigation role runs in the THEME directory without touching worktree machinery', async () => {
    await run(nonMutatingTransition());

    // Read-only phases need no isolation (investigationMode blocks
    // Bash/Edit/Write), so none of the worktree machinery runs...
    expect(spies.resolveLatestSessionWorktree).not.toHaveBeenCalled();
    expect(spies.createWorktree).not.toHaveBeenCalled();
    expect(spies.isPrimaryWorkTree).not.toHaveBeenCalled();
    // ...but they MUST read the theme's project, not the backend's own cwd.
    // Running at process.cwd() made every non-rapitas theme investigate the
    // rapitas codebase: task 580 (theme コンバーター) reported that the files
    // it was sent to analyse "do not exist" because it grepped this repo.
    const [, options] = lastExecuteTaskCall();
    expect(options.workingDirectory).toBe('/fake/project');
  });

  test('investigation role falls back to cwd when the theme has no workingDirectory', async () => {
    wf.taskWithTheme = { id: 1, themeId: 1, workflowStatus: 'draft', theme: null };

    await run(nonMutatingTransition());

    const [, options] = lastExecuteTaskCall();
    expect(options.workingDirectory).toBe(process.cwd());
  });

  test('reuses a recorded worktree that still exists on disk', async () => {
    wf.latestSessionWorktree = {
      worktreePath: '/fake/worktree/existing',
      branchName: 'feature/existing',
    };
    wf.canReuseWorktree = true;

    await run(mutatingTransition());

    expect(spies.createWorktree).not.toHaveBeenCalled();
    const [, options] = lastExecuteTaskCall();
    expect(options.workingDirectory).toBe('/fake/worktree/existing');
    const sessionCall = spies.agentSessionCreate.mock.calls[0][0] as {
      data: { worktreePath?: string; branchName?: string };
    };
    expect(sessionCall.data.worktreePath).toBe('/fake/worktree/existing');
    expect(sessionCall.data.branchName).toBe('feature/existing');
  });

  test('recreates a worktree when the recorded path is a phantom (gone from disk)', async () => {
    wf.latestSessionWorktree = { worktreePath: '/fake/worktree/phantom', branchName: null };
    wf.canReuseWorktree = false;

    await run(mutatingTransition());

    expect(spies.createWorktree).toHaveBeenCalledTimes(1);
    const [base, branch, taskId, repo] = spies.createWorktree.mock.calls[0] as [
      string,
      string,
      number,
      string | null,
    ];
    expect(base).toBe('/fake/project');
    // No prior branch recorded — generateBranchName produces a taskId-tagged
    // name (marker embedded internally) so unrelated tasks never collide on
    // one shared branch name.
    expect(branch).toBe('feature/fallback-branch-t1');
    expect(taskId).toBe(1);
    expect(repo).toBeNull();
    const [, options] = lastExecuteTaskCall();
    expect(options.workingDirectory).toBe('/fake/worktree/new');
  });

  test('reuses the EXACT prior branch name when recreating (keeps it mapped to its open PR)', async () => {
    wf.latestSessionWorktree = {
      worktreePath: '/fake/worktree/phantom',
      branchName: 'feature/prior-branch',
    };
    wf.canReuseWorktree = false;

    await run(mutatingTransition());

    const [, branch] = spies.createWorktree.mock.calls[0] as [string, string];
    expect(branch).toBe('feature/prior-branch');
  });

  test('falls back to the cwd git root when the theme has no workingDirectory', async () => {
    wf.taskWithTheme = {
      ...wf.taskWithTheme!,
      theme: { workingDirectory: null, name: 'No Dir Theme' },
    };
    wf.latestSessionWorktree = null;
    wf.gitRevParseImpl = async () => ({ stdout: '/fake/git/root\n', stderr: '' });

    await run(mutatingTransition());

    const [base] = spies.createWorktree.mock.calls[0] as [string];
    expect(base).toBe('/fake/git/root');
  });

  test('refuses a mutating role when there is no themeWorkDir, no git root, and cwd is a primary checkout', async () => {
    wf.taskWithTheme = {
      ...wf.taskWithTheme!,
      theme: { workingDirectory: null, name: 'No Dir Theme' },
    };
    wf.latestSessionWorktree = null;
    // wf.gitRevParseImpl defaults to rejecting ("not a git repository").
    // In production process.cwd() is the backend's own primary checkout —
    // isPrimaryWorkTree also fails safe to true for non-git dirs.
    wf.isPrimaryWorkTree = true;

    const result = await run(mutatingTransition());

    expect(spies.createWorktree).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('primary チェックアウト');
    expect(spies.executeTask).not.toHaveBeenCalled();
  });

  test('a createWorktree failure is FATAL for a mutating role (no un-isolated fallback)', async () => {
    wf.latestSessionWorktree = null;
    wf.createWorktreeImpl = async () => {
      throw new Error('git worktree add failed');
    };

    const result = await run(mutatingTransition());

    expect(spies.createWorktree).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('worktree の作成に失敗');
    expect(spies.executeTask).not.toHaveBeenCalled();
    expect(spies.agentSessionCreate).not.toHaveBeenCalled();
  });

  test('refuses to run a mutating role in ANY primary checkout (repo-agnostic)', async () => {
    wf.latestSessionWorktree = { worktreePath: '/fake/worktree/existing', branchName: 'x' };
    wf.canReuseWorktree = true;
    wf.isPrimaryWorkTree = true;
    wf.taskWithTheme = { ...wf.taskWithTheme!, workflowStatus: 'plan_approved' };

    const result = await run(mutatingTransition());

    expect(result.success).toBe(false);
    expect(result.status).toBe('plan_approved');
    expect(result.error).toContain('primary チェックアウト');
    expect(spies.executeTask).not.toHaveBeenCalled();
    expect(spies.agentSessionCreate).not.toHaveBeenCalled();
  });

  test('the primary-checkout refusal also applies to auto_verifier', async () => {
    wf.latestSessionWorktree = { worktreePath: '/fake/worktree/existing', branchName: 'x' };
    wf.canReuseWorktree = true;
    wf.isPrimaryWorkTree = true;

    const result = await run(autoVerifierTransition());

    expect(result.success).toBe(false);
    expect(spies.executeTask).not.toHaveBeenCalled();
  });

  test('RAPITAS_ALLOW_PRIMARY_EXEC=1 escape hatch restores the old fallback behavior', async () => {
    wf.latestSessionWorktree = { worktreePath: '/fake/worktree/existing', branchName: 'x' };
    wf.canReuseWorktree = true;
    wf.isPrimaryWorkTree = true;
    process.env.RAPITAS_ALLOW_PRIMARY_EXEC = '1';
    try {
      const result = await run(mutatingTransition());
      expect(result.success).toBe(true);
      expect(spies.executeTask).toHaveBeenCalled();
    } finally {
      delete process.env.RAPITAS_ALLOW_PRIMARY_EXEC;
    }
  });

  test('the primary guard is never even consulted for a non-mutating role', async () => {
    wf.isPrimaryWorkTree = true;

    const result = await run(nonMutatingTransition());

    expect(spies.isPrimaryWorkTree).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
