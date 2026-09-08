import { beforeEach, expect, mock, test } from 'bun:test';
import {
  wf,
  spies,
  resetWfMockState,
  installWorkflowCliExecutorMocks,
} from '../../tests/helpers/workflow-cli-executor-mock-state';

installWorkflowCliExecutorMocks();
const replanned = mock(() => Promise.resolve(true));
mock.module('./requirement-replan-guard', () => ({ requirementReplannedSince: replanned }));
const { executeCLIAgent } = await import('./workflow-cli-executor');
const advance = mock(async () => ({
  success: true,
  role: 'planner' as const,
  status: 'plan_created' as const,
}));

beforeEach(() => {
  resetWfMockState();
  replanned.mockReset().mockResolvedValue(true);
  advance.mockClear();
  wf.taskWorkflowState.workflowStatus = 'research_done';
});

const run = () =>
  executeCLIAgent(
    1,
    { title: 'test', description: '' },
    { id: 1, agentType: 'claude-code', name: 'Agent', modelId: null },
    'system',
    'context',
    { role: 'verifier', outputFile: 'verify', nextStatus: 'completed' },
    'ja',
    advance,
    async () => ({ id: 42 }),
  );

test('superseded verifier cannot harvest, complete, create a PR or advance another phase', async () => {
  const result = await run();
  expect(result.superseded).toBe(true);
  expect(result.success).toBe(false);
  expect(result.status).toBe('research_done');
  expect(spies.writeWorkflowFile).not.toHaveBeenCalled();
  expect(spies.taskUpdate).not.toHaveBeenCalled();
  expect(spies.taskUpdateMany).not.toHaveBeenCalled();
  expect(spies.performAutoCommitAndPR).not.toHaveBeenCalled();
  expect(spies.agentExecutionUpdateMany).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});

test('unreadable replan audit never authorizes completion', async () => {
  replanned.mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(run()).rejects.toThrow('audit unavailable');
  expect(spies.taskUpdate).not.toHaveBeenCalled();
  expect(spies.performAutoCommitAndPR).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});
