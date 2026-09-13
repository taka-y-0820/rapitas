'use client';
/**
 * ExecutionFlowChart
 *
 * Upper section of the execution dashboard's simple view: a Mermaid
 * flowchart showing how many active tasks sit in each of the five pipeline
 * stages (task 870). Node labels are always one of five fixed strings plus a
 * count — no task-specific text ever reaches the Mermaid source — so a
 * pathological task title can never break the diagram's syntax (see plan.md
 * §リスク評価と対策). Not responsible for the per-task list — see
 * ExecutionActivityTimeline.
 */
import { useTranslations } from 'next-intl';
import { MermaidBlock } from '@/components/markdown/mermaid-block';
import type { ExecutionDashboardTask } from '../useExecutionDashboardData';

/** Per-stage active-task counts feeding the flowchart. */
export interface ExecutionFlowChartCounts {
  queued: number;
  running: number;
  repairing: number;
  awaitingJudgement: number;
  completed: number;
}

/**
 * Reduces the task list into the five flowchart-stage counts plus how many
 * tasks are flagged "frequently failing" (repairCount >= 3).
 *
 * @param tasks - Active tasks from the dashboard API. / ダッシュボードAPIの取得結果
 * @returns Stage counts and frequent-failure count. / 各段階の件数と頻発失敗件数
 */
export function countTasksByStage(tasks: ExecutionDashboardTask[]): {
  counts: ExecutionFlowChartCounts;
  frequentFailureCount: number;
} {
  const counts: ExecutionFlowChartCounts = {
    queued: 0,
    running: 0,
    repairing: 0,
    awaitingJudgement: 0,
    completed: 0,
  };
  let frequentFailureCount = 0;
  for (const task of tasks) {
    if (task.state === 'queued') counts.queued += 1;
    else if (task.state === 'running') counts.running += 1;
    else if (task.state === 'repairing') counts.repairing += 1;
    else if (task.state === 'awaiting_judgement') counts.awaitingJudgement += 1;
    else if (task.state === 'completed') counts.completed += 1;
    if (task.frequentFailure) frequentFailureCount += 1;
  }
  return { counts, frequentFailureCount };
}

/**
 * Builds the Mermaid `flowchart LR` source for the five pipeline stages.
 * Labels are the caller-supplied fixed strings (already localized) plus the
 * count in parentheses — never task-specific text.
 *
 * @param counts - Per-stage active-task counts. / 各段階の件数
 * @param frequentFailureCount - Tasks with repairCount >= 3. / 頻発失敗タスク数
 * @param labels - Localized labels for the five stages plus the warning. / 各段階・警告のラベル
 * @returns Mermaid diagram source. / Mermaidソース文字列
 */
export function buildFlowChartSource(
  counts: ExecutionFlowChartCounts,
  frequentFailureCount: number,
  labels: {
    queued: string;
    running: string;
    repairing: string;
    awaitingJudgement: string;
    completed: string;
    frequentFailureWarning: string;
  },
): string {
  const lines = [
    'flowchart LR',
    `  Q["${labels.queued} (${counts.queued})"] --> R["${labels.running} (${counts.running})"]`,
    `  R --> P["${labels.repairing} (${counts.repairing})"]`,
    `  P --> J["${labels.awaitingJudgement} (${counts.awaitingJudgement})"]`,
    `  J --> C["${labels.completed} (${counts.completed})"]`,
  ];
  if (frequentFailureCount > 0) {
    lines.push(`  P -.-> W["${labels.frequentFailureWarning} (${frequentFailureCount})"]`);
  }
  return lines.join('\n');
}

interface ExecutionFlowChartProps {
  /** Active tasks from the dashboard API. / ダッシュボードAPIの取得結果 */
  tasks: ExecutionDashboardTask[];
}

/**
 * Renders the five-stage pipeline flowchart for the current active tasks.
 *
 * @param tasks - Active tasks from the dashboard API. / ダッシュボードAPIの取得結果
 */
export function ExecutionFlowChart({ tasks }: ExecutionFlowChartProps) {
  const t = useTranslations('agents.executionDashboard');
  const { counts, frequentFailureCount } = countTasksByStage(tasks);
  const source = buildFlowChartSource(counts, frequentFailureCount, {
    queued: t('stage.queued'),
    running: t('stage.running'),
    repairing: t('stage.repairing'),
    awaitingJudgement: t('stage.awaitingJudgement'),
    completed: t('stage.completed'),
    frequentFailureWarning: t('frequentFailureWarning'),
  });

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800">
      <h3 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
        {t('flowChartTitle')}
      </h3>
      <MermaidBlock source={source} />
    </div>
  );
}

export default ExecutionFlowChart;
