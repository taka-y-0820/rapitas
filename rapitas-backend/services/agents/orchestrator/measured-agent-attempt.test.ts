/** Real file boundaries and a killed child process, never the running backend. */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExecutionFileLogger } from '../execution-file-logger';
import { readExecutionAttemptMetrics } from '../execution-file-logger/attempt-metrics-reader';
import { runMeasuredAgentAttempt } from './measured-agent-attempt';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'measured-call-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function logger() {
  return new ExecutionFileLogger(10, 100, 1, 'test', 'codex', 'agent', undefined, {
    logDir: directory,
    enableConsolePassthrough: false,
  });
}
const result = {
  success: true,
  output: 'ok',
  costUsd: 0.25,
  executionTimeMs: 100,
  modelName: 'actual-model',
};

test('start is on disk before dispatch and complete calls recover before final result saving', async () => {
  const log = logger();
  const returned = await runMeasuredAgentAttempt(
    async () => {
      const content = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8');
      expect(content).toContain('execution_attempt_boundary');
      expect(await readExecutionAttemptMetrics(10, 100, directory)).toBeNull();
      return result;
    },
    log,
    () => true,
  );
  expect(returned).toBe(result);
  expect(await readExecutionAttemptMetrics(10, 100, directory)).toEqual([
    { success: true, costUsd: 0.25, executionTimeMs: 100, modelName: 'actual-model' },
  ]);
  log.logExecutionEnd('completed', { success: true });
  log.log('INFO', 'recovery', 'execution_attempt_metrics', {
    executionId: 10,
    sessionId: 100,
    settled: true,
    attempts: [{ success: true, costUsd: 0.25, executionTimeMs: 100, modelName: 'actual-model' }],
  });
  await runMeasuredAgentAttempt(
    async () => {
      // A stale successful summary must not hide the next unfinished attempt.
      expect(await readExecutionAttemptMetrics(10, 100, directory)).toBeNull();
      return result;
    },
    log,
    () => true,
  );
  expect(await readExecutionAttemptMetrics(10, 100, directory)).toHaveLength(2);
});

test('a stop during start flush prevents dispatch', async () => {
  let allowed = true;
  const execute = mock(async () => result);
  const log = {
    log: () => {},
    flush: async () => {
      allowed = false;
      return null;
    },
  } as unknown as ExecutionFileLogger;
  expect(await runMeasuredAgentAttempt(execute, log, () => allowed)).toMatchObject({
    success: false,
    failureType: 'cancelled',
  });
  expect(execute).not.toHaveBeenCalled();
});

test('a thrown CLI preserves unknown measurements and the original exception', async () => {
  const error = new Error('CLI crashed');
  await expect(
    runMeasuredAgentAttempt(
      async () => {
        throw error;
      },
      logger(),
      () => true,
    ),
  ).rejects.toBe(error);
  expect(await readExecutionAttemptMetrics(10, 100, directory)).toEqual([
    { success: false, costUsd: null, executionTimeMs: null, modelName: null },
  ]);
});

test('killing an executing child leaves a persisted pending attempt', async () => {
  const ready = join(directory, 'ready');
  const helper = join(import.meta.dir, 'measured-agent-attempt.ts');
  const loggerPath = join(import.meta.dir, '../execution-file-logger/index.ts');
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
    const {runMeasuredAgentAttempt} = await import(${JSON.stringify(helper)});
    const {ExecutionFileLogger} = await import(${JSON.stringify(loggerPath)});
    const {writeFileSync} = await import('fs');
    const logger = new ExecutionFileLogger(10,100,1,'test','codex','agent',undefined,{logDir:${JSON.stringify(directory)},enableConsolePassthrough:false});
    await runMeasuredAgentAttempt(async () => {
      writeFileSync(${JSON.stringify(ready)}, 'running');
      await Bun.sleep(60000);
      return {success:true,output:'never'};
    }, logger, () => true);
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error('child failed to enter execution');
      await Bun.sleep(10);
    }
    expect(child.exitCode).toBeNull();
    child.kill();
    await child.exited;
    const path = join(directory, readdirSync(directory).find((name) => name.endsWith('.log'))!);
    expect(readFileSync(path, 'utf8')).toContain('"kind": "start"');
    expect(await readExecutionAttemptMetrics(10, 100, directory)).toBeNull();
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 10000);
