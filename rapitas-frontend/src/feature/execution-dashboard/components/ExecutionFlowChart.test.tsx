/**
 * ExecutionFlowChart.test
 *
 * Covers the pure Mermaid-source builder (task 870): fixed five-node labels
 * plus counts, the optional frequent-failure warning node, and that task
 * titles never influence the generated source (structural safety — see
 * plan.md §リスク評価と対策).
 */
import { render, screen } from '@testing-library/react';
import { ExecutionFlowChart, countTasksByStage, buildFlowChartSource } from './ExecutionFlowChart';
import type { ExecutionDashboardTask } from '../useExecutionDashboardData';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock('@/components/markdown/mermaid-block', () => ({
  MermaidBlock: ({ source }: { source: string }) => (
    <pre data-testid="mermaid-source">{source}</pre>
  ),
}));

const LABELS = {
  queued: 'キュー待ち',
  running: '実行中',
  repairing: '修復中',
  awaitingJudgement: '判定待ち',
  completed: '完了',
  frequentFailureWarning: '頻繁に失敗中',
};

function task(overrides: Partial<ExecutionDashboardTask>): ExecutionDashboardTask {
  return {
    taskId: 1,
    title: 'task',
    state: 'queued',
    repairCount: 0,
    frequentFailure: false,
    stalled: false,
    elapsedMinutes: 0,
    currentPhase: 'draft',
    themeId: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('countTasksByStage', () => {
  it('buckets tasks by state and counts frequentFailure separately', () => {
    const tasks = [
      task({ state: 'queued' }),
      task({ state: 'running' }),
      task({ state: 'running' }),
      task({ state: 'repairing', frequentFailure: true }),
      task({ state: 'awaiting_judgement' }),
      task({ state: 'completed' }),
      task({ state: 'failed' }),
      task({ state: 'cancelled' }),
    ];
    const { counts, frequentFailureCount } = countTasksByStage(tasks);
    expect(counts).toEqual({
      queued: 1,
      running: 2,
      repairing: 1,
      awaitingJudgement: 1,
      completed: 1,
    });
    expect(frequentFailureCount).toBe(1);
  });
});

describe('buildFlowChartSource', () => {
  it('generates the fixed five-node chain with counts', () => {
    const source = buildFlowChartSource(
      { queued: 3, running: 2, repairing: 1, awaitingJudgement: 0, completed: 5 },
      0,
      LABELS,
    );
    expect(source).toBe(
      [
        'flowchart LR',
        '  Q["キュー待ち (3)"] --> R["実行中 (2)"]',
        '  R --> P["修復中 (1)"]',
        '  P --> J["判定待ち (0)"]',
        '  J --> C["完了 (5)"]',
      ].join('\n'),
    );
  });

  it('appends the frequent-failure warning node only when count > 0', () => {
    const source = buildFlowChartSource(
      { queued: 0, running: 0, repairing: 2, awaitingJudgement: 0, completed: 0 },
      2,
      LABELS,
    );
    expect(source).toContain('  P -.-> W["頻繁に失敗中 (2)"]');
  });

  it('never embeds task-specific text — only the five fixed labels and counts', () => {
    const source = buildFlowChartSource(
      { queued: 1, running: 0, repairing: 0, awaitingJudgement: 0, completed: 0 },
      0,
      LABELS,
    );
    expect(source).not.toContain('task');
  });
});

describe('ExecutionFlowChart component', () => {
  it('renders a Mermaid source derived from the task list', () => {
    render(<ExecutionFlowChart tasks={[task({ state: 'running' })]} />);
    const rendered = screen.getByTestId('mermaid-source').textContent ?? '';
    expect(rendered).toContain('flowchart LR');
    expect(rendered).toContain('(1)');
  });
});
