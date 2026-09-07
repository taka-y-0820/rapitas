/**
 * providers/cli-utils ユニットテスト
 *
 * resolveCliPath は utils/common/cli-path-resolver への再エクスポートで
 * あることのみ検証する（実際のWindowsパス解決ロジックは
 * utils/common/cli-path-resolver.test.ts でカバー済み）。buildPrompt の
 * フォールバック連鎖、buildStructuredPrompt のセクション構築も検証する。
 */
import { describe, test, expect, mock } from 'bun:test';
import type { AgentTaskDefinition } from '../abstraction/types';

const mockResolveCliPathAsync = mock((cliName: string) => Promise.resolve(`resolved:${cliName}`));

mock.module('../../../utils/common/cli-path-resolver', () => ({
  resolveCliPathAsync: mockResolveCliPathAsync,
}));

const { resolveCliPath, buildPrompt, buildStructuredPrompt } = await import('./cli-utils');

function makeTask(overrides: Partial<AgentTaskDefinition> = {}): AgentTaskDefinition {
  return { title: 'Title', ...overrides } as AgentTaskDefinition;
}

describe('resolveCliPath', () => {
  test('delegates to the shared cli-path-resolver', async () => {
    const result = await resolveCliPath('claude');
    expect(result).toBe('resolved:claude');
    expect(mockResolveCliPathAsync).toHaveBeenCalledWith('claude');
  });
});

describe('buildPrompt', () => {
  test('prefers optimizedPrompt over everything else', () => {
    const task = makeTask({ optimizedPrompt: 'opt', analysis: {} as never, prompt: 'p' });
    expect(buildPrompt(task)).toBe('opt');
  });

  test('builds a structured prompt when analysis is present (no optimizedPrompt)', () => {
    const task = makeTask({ analysis: { summary: 's', complexity: 'low' } as never });
    expect(buildPrompt(task)).toContain('# タスク実装指示');
  });

  test('falls back to prompt when no analysis or optimizedPrompt', () => {
    const task = makeTask({ prompt: 'raw prompt' });
    expect(buildPrompt(task)).toBe('raw prompt');
  });

  test('falls back to description when no prompt or analysis', () => {
    const task = makeTask({ description: 'desc' });
    expect(buildPrompt(task)).toBe('desc');
  });

  test('falls back to title as the last resort', () => {
    const task = makeTask({ title: 'just the title' });
    expect(buildPrompt(task)).toBe('just the title');
  });
});

describe('buildStructuredPrompt', () => {
  test('includes title, summary, and complexity', () => {
    const task = makeTask({
      title: 'My Task',
      analysis: { summary: 'summary text', complexity: 'medium' } as never,
    });
    const result = buildStructuredPrompt(task);
    expect(result).toContain('**タスク名:** My Task');
    expect(result).toContain('**分析サマリー:** summary text');
    expect(result).toContain('**複雑度:** medium');
  });

  test('includes estimatedDuration only when present', () => {
    const withDuration = buildStructuredPrompt(
      makeTask({ analysis: { summary: 's', complexity: 'low', estimatedDuration: 30 } as never }),
    );
    expect(withDuration).toContain('**推定時間:** 30分');

    const withoutDuration = buildStructuredPrompt(
      makeTask({ analysis: { summary: 's', complexity: 'low' } as never }),
    );
    expect(withoutDuration).not.toContain('推定時間');
  });

  test('includes task description under タスク詳細 when present', () => {
    const result = buildStructuredPrompt(
      makeTask({
        description: 'full description',
        analysis: { summary: 's', complexity: 'low' } as never,
      }),
    );
    expect(result).toContain('## タスク詳細');
    expect(result).toContain('full description');
  });

  test('lists subtasks with order, description, and priority', () => {
    const result = buildStructuredPrompt(
      makeTask({
        analysis: {
          summary: 's',
          complexity: 'low',
          subtasks: [{ order: 1, title: 'Step A', description: 'do A', priority: 'high' }],
        } as never,
      }),
    );
    expect(result).toContain('### 1. Step A');
    expect(result).toContain('- **説明:** do A');
    expect(result).toContain('- **優先度:** high');
  });

  test('lists tips under 実装のヒント when present', () => {
    const result = buildStructuredPrompt(
      makeTask({
        analysis: { summary: 's', complexity: 'low', tips: ['tip one', 'tip two'] } as never,
      }),
    );
    expect(result).toContain('## 実装のヒント');
    expect(result).toContain('- tip one');
    expect(result).toContain('- tip two');
  });

  test('omits subtasks and tips sections when both are absent', () => {
    const result = buildStructuredPrompt(
      makeTask({ analysis: { summary: 's', complexity: 'low' } as never }),
    );
    expect(result).not.toContain('実装手順');
    expect(result).not.toContain('実装のヒント');
  });
});
