import { expect, mock, test } from 'bun:test';

let finishRead!: (value: { status: string; workflowStatus: string }) => void;
const read = mock(
  () =>
    new Promise<{ status: string; workflowStatus: string }>((resolve) => {
      finishRead = resolve;
    }),
);
const research = mock(async () => {});
const success = mock(async () => {});
const failure = mock(async () => {});
mock.module('../../../../config/database', () => ({ prisma: { task: { findUnique: read } } }));
mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
}));
mock.module('../research/research-phase-handler', () => ({ handleResearchResult: research }));
mock.module('./success-execution-handler', () => ({ handleSuccessfulExecution: success }));
mock.module('./hard-failure-reconciler', () => ({ reconcileHardFailure: failure }));
mock.module('./dev-mode-planning-advance', () => ({ advanceManagedPlanningPhase: async () => {} }));
const { handleExecuteResult } = await import('./execute-post-handler');

test('a stop during the terminal-state read prevents the research failure pipeline', async () => {
  let current = true;
  const pending = handleExecuteResult({
    result: { success: false, output: '', errorMessage: 'Execution cancelled' },
    taskIdNum: 919,
    sessionId: 4075,
    configId: 1,
    taskTitle: 'Cancellation probe',
    workDir: '/test',
    executionDir: '/test/worktree',
    mode: 'research',
    isExecutionCurrent: () => current,
  });
  current = false;
  finishRead({ status: 'todo', workflowStatus: 'draft' });
  await pending;
  expect(research).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
});
