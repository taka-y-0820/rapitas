'use client';
/**
 * ExecutionActivityTimeline
 *
 * Lower section of the execution dashboard's simple view: an activity feed
 * of active tasks sorted by most-recently-updated, with a state badge,
 * elapsed time, and stalled / frequently-failing warning badges (task 870).
 * Clicking a row opens the drilldown modal (owned by the parent page). Not
 * responsible for fetching — see useExecutionDashboardData.
 */
import { useTranslations } from 'next-intl';
import type {
  ExecutionDashboardTask,
  ExecutionDashboardTaskState,
} from '../useExecutionDashboardData';

const STATE_BADGE_STYLES: Record<ExecutionDashboardTaskState, string> = {
  queued: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
  running: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  repairing: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  awaiting_judgement: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  completed: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400',
};

interface ExecutionActivityTimelineProps {
  /** Active tasks from the dashboard API, any order (sorted here by updatedAt desc). / ダッシュボードAPIの取得結果 */
  tasks: ExecutionDashboardTask[];
  /** Called when a row is clicked, to open the drilldown modal. / 行クリック時のドリルダウン起動 */
  onSelectTask: (taskId: number) => void;
}

/**
 * Renders the activity feed of active tasks, most-recently-updated first.
 *
 * @param tasks - Active tasks from the dashboard API. / ダッシュボードAPIの取得結果
 * @param onSelectTask - Row-click handler (opens drilldown). / 行クリック時のハンドラ
 */
export function ExecutionActivityTimeline({ tasks, onSelectTask }: ExecutionActivityTimelineProps) {
  const t = useTranslations('agents.executionDashboard');

  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('emptyState')}</p>
      </div>
    );
  }

  const sorted = [...tasks].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800">
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-700">
        {sorted.map((task) => (
          <li key={task.taskId}>
            <button
              type="button"
              onClick={() => onSelectTask(task.taskId)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-700/50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  {task.title}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {t('elapsedMinutes', { minutes: task.elapsedMinutes })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {task.stalled && (
                  <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                    {t('stalledBadge')}
                  </span>
                )}
                {task.frequentFailure && (
                  <span className="inline-flex items-center rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:border-red-600 dark:bg-red-900/30 dark:text-red-400">
                    {t('frequentFailureBadge', { count: task.repairCount })}
                  </span>
                )}
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATE_BADGE_STYLES[task.state]}`}
                >
                  {t(
                    `stage.${task.state === 'awaiting_judgement' ? 'awaitingJudgement' : task.state}`,
                  )}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ExecutionActivityTimeline;
