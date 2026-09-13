'use client';
/**
 * ExecutionDashboardPage
 *
 * Route entry for /agents/execution-dashboard (task 870): the workflow
 * execution visualization dashboard. Simple view (flowchart + activity
 * timeline) up top; clicking a task row opens the detail drilldown modal.
 * All state/API wiring lives in useExecutionDashboardData; this file only
 * composes the view.
 */
import { useState } from 'react';
import { Download, Workflow } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { API_BASE_URL } from '@/utils/api';
import { useExecutionDashboardData } from '@/feature/execution-dashboard/useExecutionDashboardData';
import { ExecutionFlowChart } from '@/feature/execution-dashboard/components/ExecutionFlowChart';
import { ExecutionActivityTimeline } from '@/feature/execution-dashboard/components/ExecutionActivityTimeline';
import { TaskExecutionDrilldownModal } from '@/feature/execution-dashboard/components/TaskExecutionDrilldownModal';

export default function ExecutionDashboardPage() {
  const t = useTranslations('agents.executionDashboard');
  const { data, loaded } = useExecutionDashboardData();
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);

  return (
    <div className="h-[calc(100vh-5rem)] overflow-auto bg-[var(--background)] scrollbar-thin">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Workflow className="h-6 w-6 text-violet-500" />
            <div>
              <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{t('title')}</h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('subtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={`${API_BASE_URL}/workflow/execution-dashboard/export`}
              download
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Download className="h-4 w-4" />
              {t('exportCsvButton')}
            </a>
            <a
              href={`${API_BASE_URL}/workflow/execution-dashboard/export?format=json`}
              download
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Download className="h-4 w-4" />
              {t('exportJsonButton')}
            </a>
          </div>
        </div>

        {!loaded && <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('loading')}</p>}

        {loaded && (!data || !data.success) && (
          <p className="text-sm text-red-600 dark:text-red-400">{t('loadFailed')}</p>
        )}

        {loaded && data?.success && (
          <div className="space-y-6">
            {data.truncated && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                {t('truncatedNotice', {
                  shown: data.tasks.length,
                  total: data.totalActiveCount,
                })}
              </p>
            )}
            <ExecutionFlowChart tasks={data.tasks} />
            <ExecutionActivityTimeline tasks={data.tasks} onSelectTask={setSelectedTaskId} />
          </div>
        )}
      </div>

      <TaskExecutionDrilldownModal
        taskId={selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
      />
    </div>
  );
}
