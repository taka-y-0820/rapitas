/**
 * workflow-cli-executor.completion.test
 *
 * executeCLIAgent's tail-end bookkeeping: cleanup is best-effort (a failure
 * never fails the phase), the AgentExecution `post_processing → completed`
 * flip + deferred timeline event only fire for investigation phases and are
 * themselves best-effort, the no-outputFile (implementer) status-advance
 * branch, and the two 1s-delayed `setTimeout` auto-advance chains
 * (implementer → verifier, and plan-auto-approved-within-this-run →
 * implementer). Worktree resolution, non-verify output parsing, and the
 * verify-phase completion gate are covered in the sibling split files.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  wf,
  spies,
  resetWfMockState,
  installWorkflowCliExecutorMocks,
} from '../../tests/helpers/workflow-cli-executor-mock-state';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';

installWorkflowCliExecutorMocks();

// The flip is where an investigation phase actually terminates, so it is also
// where its learning-ledger row is written. Stubbed here to observe that call.
const recordExecutionOutcome = mock(() => Promise.resolve());
mock.module('../self-learning/workflow-learning-recorder', () => ({ recordExecutionOutcome }));

const { executeCLIAgent } = await import('./workflow-cli-executor');

const getOrCreateDevConfig = (): Promise<{ id: number }> => Promise.resolve({ id: 42 });
const task = { title: 'Finish the thing', description: 'desc' };
const agentConfig = { id: 1, agentType: 'claude-code', name: 'Agent', modelId: null };

function implementerTransition(): RoleTransition {
  return { role: 'implementer', outputFile: null, nextStatus: 'verify_done' };
}
function researchTransition(): RoleTransition {
  return { role: 'researcher', outputFile: 'research', nextStatus: 'research_done' };
}

async function run(
  transition: RoleTransition,
  advanceWorkflow: (taskId: number, language: 'ja' | 'en') => Promise<WorkflowAdvanceResult>,
): Promise<WorkflowAdvanceResult> {
  return executeCLIAgent(
    1,
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

const noopAdvance = (): Promise<WorkflowAdvanceResult> =>
  Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' });

describe('executeCLIAgent — cleanup + AgentExecution completion flip', () => {
  beforeEach(() => {
    resetWfMockState();
    // AgentExecution flip only runs when the phase actually succeeded — give
    // the research transition a saved file so it does.
    wf.readWorkflowFileImpl = async () => '# Research\n...';
  });

  test('a cleanupRootWorkflowFiles failure is swallowed, not thrown', async () => {
    spies.cleanupRootWorkflowFiles.mockImplementationOnce(() =>
      Promise.reject(new Error('fs error')),
    );

    const result = await run(researchTransition(), noopAdvance);

    expect(result).toBeDefined();
  });

  test('finalizes the successful phase session so recovery does not mark it interrupted', async () => {
    await run(researchTransition(), noopAdvance);
    expect(spies.agentSessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 100 }),
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  test('flips AgentExecution post_processing -> completed only for investigation phases', async () => {
    await run(researchTransition(), noopAdvance);
    expect(spies.agentExecutionUpdateMany).toHaveBeenCalledTimes(1);
    const [call] = spies.agentExecutionUpdateMany.mock.calls[0] as [
      { where: { status: string }; data: { status: string; completedAt?: Date } },
    ];
    expect(call.where.status).toBe('post_processing');
    expect(call.data.status).toBe('completed');
    // NOTE: completedAt は CLI 終了時に saveExecutionResult が既に記録済み。
    // フリップでの再スタンプはエピローグ（批評ゲート等）の時間を wall に
    // 混入させ実行時間を歪めるため、上書きしないこと（task #560）。
    expect(call.data.completedAt).toBeUndefined();
  });

  test('does NOT flip AgentExecution for a non-investigation role (implementer)', async () => {
    await run(implementerTransition(), noopAdvance);
    expect(spies.agentExecutionUpdateMany).not.toHaveBeenCalled();
  });

  test('an AgentExecution flip failure is swallowed, not thrown', async () => {
    spies.agentExecutionUpdateMany.mockImplementationOnce(() =>
      Promise.reject(new Error('db down')),
    );

    const result = await run(researchTransition(), noopAdvance);

    expect(result.success).toBe(true);
  });

  test('emits a deferred timeline event when a matching AgentExecution row exists', async () => {
    spies.agentExecutionFindFirst.mockImplementationOnce(() =>
      Promise.resolve({ id: 55, agentConfig: { agentType: 'claude-code' } }),
    );

    await run(researchTransition(), noopAdvance);

    expect(spies.appendEvent).toHaveBeenCalledTimes(1);
    const [event] = spies.appendEvent.mock.calls[0] as [
      { eventType: string; payload: { executionId: number; taskId: number } },
    ];
    expect(event.eventType).toBe('agent_execution_completed');
    expect(event.payload.executionId).toBe(55);
    expect(event.payload.taskId).toBe(1);
  });

  test('skips the timeline event when no AgentExecution row is found', async () => {
    // Default agentExecutionFindFirst already resolves null.
    await run(researchTransition(), noopAdvance);

    expect(spies.appendEvent).not.toHaveBeenCalled();
  });

  test('a rejecting timeline import/append never fails the phase', async () => {
    spies.agentExecutionFindFirst.mockImplementationOnce(() =>
      Promise.resolve({ id: 1, agentConfig: { agentType: 'claude-code' } }),
    );
    spies.appendEvent.mockImplementationOnce(() => Promise.reject(new Error('timeline down')));

    const result = await run(researchTransition(), noopAdvance);

    expect(result.success).toBe(true);
  });
});

describe('executeCLIAgent — no-outputFile status advance (implementer)', () => {
  beforeEach(() => {
    resetWfMockState();
  });

  test('advances workflowStatus + records a phase_completed transition on success', async () => {
    wf.taskWorkflowState = { ...wf.taskWorkflowState!, workflowStatus: 'plan_approved' };

    const result = await run(implementerTransition(), noopAdvance);

    expect(result.status).toBe('verify_done');
    const updateCall = spies.taskUpdate.mock.calls.find(
      (c) => (c[0] as { data: { workflowStatus?: string } }).data.workflowStatus === 'verify_done',
    );
    expect(updateCall).toBeDefined();
    const cause = spies.recordTransition.mock.calls[0][0] as { cause: string };
    expect(cause.cause).toBe('phase_completed:implementer');
  });

  test('conditionally flips task.status off todo alongside the workflowStatus advance (#706)', async () => {
    wf.taskWorkflowState = { ...wf.taskWorkflowState!, workflowStatus: 'plan_approved' };

    await run(implementerTransition(), noopAdvance);

    expect(spies.taskUpdateMany).toHaveBeenCalledTimes(1);
    const [call] = spies.taskUpdateMany.mock.calls[0] as [
      { where: { id: number; status: string }; data: { status: string } },
    ];
    expect(call.where).toEqual({ id: 1, status: 'todo' });
    expect(call.data).toEqual({ status: 'in-progress' });
  });

  test('skips the update entirely when already at the target status', async () => {
    wf.taskWorkflowState = { ...wf.taskWorkflowState!, workflowStatus: 'verify_done' };

    await run(implementerTransition(), noopAdvance);

    expect(spies.taskUpdate).not.toHaveBeenCalled();
    expect(spies.taskUpdateMany).not.toHaveBeenCalled();
    expect(spies.recordTransition).not.toHaveBeenCalled();
  });

  test('an orchestrator failure surfaces errorMessage and never advances the status', async () => {
    wf.executeTaskImpl = async () => ({
      success: false,
      output: '',
      errorMessage: 'agent crashed',
    });

    const result = await run(implementerTransition(), noopAdvance);

    expect(result.success).toBe(false);
    expect(result.error).toBe('agent crashed');
    expect(spies.taskUpdate).not.toHaveBeenCalled();
  });
});

describe('executeCLIAgent — 1s-delayed auto-advance chains', () => {
  beforeEach(() => {
    resetWfMockState();
  });

  test('implementer success schedules an auto-advance to the next phase', async () => {
    const advanceWorkflow = mock(
      (): Promise<WorkflowAdvanceResult> =>
        Promise.resolve({ success: true, role: 'verifier', status: 'verify_done' }),
    );

    await run(implementerTransition(), advanceWorkflow);
    expect(advanceWorkflow).not.toHaveBeenCalled();

    // The chain fires via a real (un-mocked) 1s setTimeout — wait past it to
    // observe the actual scheduled call, not just infer it from state.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(advanceWorkflow).toHaveBeenCalledTimes(1);
    expect(advanceWorkflow.mock.calls[0]).toEqual([1, 'ja']);
  });
});

describe('executeCLIAgent — learning ledger on the completion flip', () => {
  beforeEach(() => {
    resetWfMockState();
    wf.readWorkflowFileImpl = async () => '# Research\n...';
    recordExecutionOutcome.mockReset().mockResolvedValue(undefined);
    spies.agentExecutionFindMany.mockReset().mockResolvedValue([{ id: 2857 }]);
  });

  test('records the investigation phase that only ever reached post_processing', async () => {
    await run(researchTransition(), noopAdvance);

    expect(recordExecutionOutcome.mock.calls.length).toBe(1);
    const call = recordExecutionOutcome.mock.calls[0] as unknown as [unknown, number, string];
    expect(call[1]).toBe(2857);
    expect(call[2]).toBe('completed');
  });

  test('records nothing when this call flipped nothing', async () => {
    spies.agentExecutionFindMany.mockResolvedValue([]);

    await run(researchTransition(), noopAdvance);

    expect(recordExecutionOutcome).not.toHaveBeenCalled();
  });

  test('a failed id lookup costs the ledger row, never the flip', async () => {
    spies.agentExecutionFindMany.mockImplementationOnce(() =>
      Promise.reject(new Error('db hiccup')),
    );

    await run(researchTransition(), noopAdvance);

    expect(spies.agentExecutionUpdateMany).toHaveBeenCalledTimes(1);
    expect(recordExecutionOutcome).not.toHaveBeenCalled();
  });
});
