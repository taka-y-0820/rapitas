import { expect, mock, test } from 'bun:test';
mock.module('./runtime-smoke', () => ({
  runRuntimeSmokeCheck: async () => {
    throw new Error('config/launch failed before harness try');
  },
}));
const { runRuntimeVerificationStage } = await import('./runtime-verification-stage');
test('outer runtime failure cannot disappear from verification evidence', async () => {
  expect(await runRuntimeVerificationStage('/worktree', 895)).toMatchObject({
    name: 'runtime',
    ran: false,
    ok: false,
    unverifiable: true,
    details: 'Runtime verification unavailable: config/launch failed before harness try',
  });
});
