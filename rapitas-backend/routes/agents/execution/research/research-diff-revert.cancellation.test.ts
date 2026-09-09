import { beforeEach, expect, mock, test } from 'bun:test';
import { releaseTaskExecutionLock } from '../../../../services/agents/task-execution-lock';

const taskId = 991916;
let stopAt = '';
const commands: string[] = [];
mock.module('node:child_process', () => ({
  exec: (
    command: string,
    _options: unknown,
    callback: (error: Error | null, output: { stdout: string; stderr: string }) => void,
  ) => {
    commands.push(command);
    if (command.includes(stopAt)) releaseTaskExecutionLock(taskId);
    callback(command.includes('diff --quiet') ? new Error('dirty') : null, {
      stdout: '',
      stderr: '',
    });
  },
}));
mock.module('./research-output-utils', () => ({ isIsolatedWorktree: () => true }));
const { revertResearchDiffIfDirty } = await import('./research-diff-revert');
beforeEach(() => {
  commands.length = 0;
});

test('stop during inspection prevents reset and clean', async () => {
  stopAt = 'diff --quiet';
  await revertResearchDiffIfDirty('/isolated/probe', taskId);
  expect(commands).toEqual(['git diff --quiet HEAD']);
});

test('stop while reset finishes prevents the subsequent clean', async () => {
  stopAt = 'reset --hard';
  await revertResearchDiffIfDirty('/isolated/probe', taskId);
  expect(commands).toEqual([
    'git diff --quiet HEAD',
    'git ls-files --others --exclude-standard',
    'git reset --hard HEAD',
  ]);
});
