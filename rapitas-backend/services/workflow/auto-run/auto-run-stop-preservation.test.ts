import { expect, test } from 'bun:test';
import {
  ThemeAutoRunScheduler,
  internal,
  resetAllMocks,
  resetSchedulerSingleton,
  makeState,
  mockResolveTaskWorkingDirectory,
  mockRevertChanges,
  mockStopThemeAgents,
  mockQueueItemUpdateMany,
  mockFinalizeStop,
} from './theme-auto-run-scheduler.test-support';

test('user auto-run stop cancels work and finalizes without reverting shared files', async () => {
  resetAllMocks();
  resetSchedulerSingleton();
  mockResolveTaskWorkingDirectory.mockResolvedValue({ workingDirectory: 'C:/Projects/rapitas' });
  await internal(ThemeAutoRunScheduler.getInstance()).processStoppingThemes([
    makeState({ themeId: 10, status: 'stopping', currentTaskId: 100 }),
  ]);
  expect(mockQueueItemUpdateMany).toHaveBeenCalled();
  expect(mockStopThemeAgents).toHaveBeenCalled();
  expect(mockFinalizeStop).toHaveBeenCalledWith(10);
  expect(mockRevertChanges).not.toHaveBeenCalled();
});
