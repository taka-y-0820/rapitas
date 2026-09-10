import { test, expect, mock } from 'bun:test';
const task = mock(async () => ({ status: 'in-progress', themeId: 1 }));
const run = mock(async () => ({ enabled: true, status: 'running' }));
const stopIntent = mock(async (): Promise<{ createdAt: Date } | null> => null);
// Latest AgentExecution for the task — the durable record of a stop request
// (task 895). Default: a live run, so the pre-existing cases are unaffected.
const latestExecution = mock(
  async (): Promise<{ id: number; status: string } | null> => ({ id: 1, status: 'running' }),
);
mock.module('../../config/database', () => ({
  prisma: {
    task: { findUnique: task },
    themeAutoRun: { findUnique: run },
    agentExecution: { findFirst: latestExecution },
    workflowTransition: { findFirst: stopIntent },
  },
}));
const { canContinueAutoMerge } = await import('./auto-merge-task-guard');
test('honors stopped themes and cancellation, and fails closed on DB failure', async () => {
  expect(await canContinueAutoMerge(1)).toBe(true);
  run.mockResolvedValueOnce({ enabled: false, status: 'idle' });
  expect(await canContinueAutoMerge(1)).toBe(false);
  task.mockResolvedValueOnce({ status: 'cancelled', themeId: 1 });
  expect(await canContinueAutoMerge(1)).toBe(false);
  task.mockRejectedValueOnce(new Error('db unavailable'));
  expect(await canContinueAutoMerge(1)).toBe(false);
});

test('最新実行がcancelledならタスクが進行中に見えてもマージ/完了を止める (task 895)', async () => {
  latestExecution.mockResolvedValueOnce({ id: 9, status: 'cancelled' });
  expect(await canContinueAutoMerge(1)).toBe(false);
});

test('過去のcancelled履歴だけでは、最新が完了済みの正当な実行をブロックしない (task 895)', async () => {
  // The guard reads only the LATEST row; an older cancelled execution is not it.
  latestExecution.mockResolvedValueOnce({ id: 12, status: 'completed' });
  expect(await canContinueAutoMerge(1)).toBe(true);
});

test('実行が1件も無いタスクはキャンセル扱いにしない (task 895)', async () => {
  latestExecution.mockResolvedValueOnce(null);
  expect(await canContinueAutoMerge(1)).toBe(true);
});

test('a durable stop or unreadable stop history withholds merge even while execution looks running', async () => {
  stopIntent.mockResolvedValueOnce({ createdAt: new Date() });
  expect(await canContinueAutoMerge(1)).toBe(false);
  stopIntent.mockRejectedValueOnce(new Error('stop history unavailable'));
  expect(await canContinueAutoMerge(1)).toBe(false);
  expect(await canContinueAutoMerge(1)).toBe(true);
});
