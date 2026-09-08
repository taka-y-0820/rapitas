import { expect, mock, test } from 'bun:test';
import type { ProcessRunnerState } from './process-runner';
import type { AgentExecutionResult } from '../base-agent';
import type { ChildProcess } from 'node:child_process';
const childProcess = await import('node:child_process');
const killTree = mock(() => Buffer.from(''));
mock.module('child_process', () => ({ ...childProcess, execSync: killTree }));
let state: ProcessRunnerState;
let finish: (result: AgentExecutionResult) => void;
let ready: () => void;
const spawned = new Promise<void>((resolve) => {
  ready = resolve;
});
const child = {
  pid: 12345,
  killed: false,
  kill: mock(() => {
    child.killed = true;
    return true;
  }),
};
mock.module('./process-runner', () => ({
  spawnCodexProcess: async (
    _config: unknown,
    _dir: string,
    _prompt: string,
    runnerState: ProcessRunnerState,
  ) => {
    state = runnerState;
    state.process = child as unknown as ChildProcess;
    ready();
    return new Promise<AgentExecutionResult>((resolve) => {
      finish = resolve;
    });
  },
}));
const { CodexCliAgent } = await import('./index');
test('stop sees the running child before execute resolves', async () => {
  const agent = new CodexCliAgent('stop-regression', 'stop regression');
  Object.defineProperty(agent, 'getAvailabilityError', { value: async () => null });
  const execution = agent.execute({
    id: 1,
    title: 'stop regression',
    optimizedPrompt: 'test',
    workingDirectory: process.cwd(),
  });
  await spawned;
  await agent.stop();
  expect(state!.cancelRequested).toBe(true);
  if (process.platform === 'win32')
    expect(killTree).toHaveBeenCalledWith('taskkill /PID 12345 /T /F', { stdio: 'ignore' });
  else expect(child.kill).toHaveBeenCalledWith('SIGINT');
  finish!({ success: false, output: '', failureType: 'cancelled' });
  expect((await execution).failureType).toBe('cancelled');
});
