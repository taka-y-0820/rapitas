import { beforeEach, expect, mock, test } from 'bun:test';
let workerStop = mock(async (_options?: unknown) => {});
let mainStop = mock(async (_options?: unknown) => {});
mock.module('../../config/database', () => ({ prisma: {} }));
mock.module('../core/orchestrator-instance', () => ({
  orchestrator: { gracefulShutdown: (options: unknown) => workerStop(options) },
}));
mock.module('../agents/agent-orchestrator', () => ({
  AgentOrchestrator: {
    getInstance: () => ({ gracefulShutdown: (options: unknown) => mainStop(options) }),
  },
}));
const { shutdownExecutionOwners } = await import('./shutdown-execution-owners');
beforeEach(() => {
  workerStop = mock(async (_options?: unknown) => {});
  mainStop = mock(async (_options?: unknown) => {});
});
test('drains manual and workflow owners', async () => {
  await shutdownExecutionOwners();
  expect(workerStop).toHaveBeenCalledWith({ skipServerStop: true });
  expect(mainStop).toHaveBeenCalledWith({ skipServerStop: true });
});
test('worker failure still waits for the main owner before rejecting', async () => {
  workerStop.mockRejectedValueOnce(new Error('IPC unavailable'));
  let finish!: () => void;
  mainStop.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let settled = false;
  const outcome = shutdownExecutionOwners().catch((error) => {
    settled = true;
    return error;
  });
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  expect(mainStop).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  finish();
  expect(await outcome).toMatchObject({
    name: 'ExecutionOwnersShutdownError',
    errors: [expect.objectContaining({ message: 'IPC unavailable' })],
  });
});
