import { describe, expect, test } from 'bun:test';
import { buildStructuredPrompt } from './prompt-builder';
import type { AgentTask } from '../base-agent';

describe('workflow upload transport isolation', () => {
  for (const analysisInfo of [
    undefined,
    {
      summary: 'Verify current changes',
      complexity: 'medium' as const,
      estimatedTotalHours: 1,
      subtasks: [],
      reasoning: 'Regression check',
    },
  ]) {
    test(`fresh paths for repeated runs (${analysisInfo ? 'analysis' : 'simple'})`, () => {
      const task: AgentTask = { id: 911, title: 'Verify repair', analysisInfo };
      const first = buildStructuredPrompt(task, 'C:/work/task-911', '[test]');
      const second = buildStructuredPrompt(task, 'C:/work/task-911', '[test]');
      const paths = (prompt: string) =>
        [...prompt.matchAll(/C:\/work\/task-911\/\.wf-[0-9a-f-]+\.md/g)].map((m) => m[0]);
      expect(paths(first).length).toBeGreaterThanOrEqual(2);
      expect(new Set(paths(first)).size).toBe(1);
      expect(new Set(paths(second)).size).toBe(1);
      expect(paths(first)[0]).not.toBe(paths(second)[0]);
      expect(first).not.toContain('.wf-tmp.md');
      expect(first).toContain('current code and current task requirements');
      expect(first).toContain('interrupted or rejected reports are stale evidence');
    });
  }
});
