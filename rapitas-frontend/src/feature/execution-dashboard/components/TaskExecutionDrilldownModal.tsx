'use client';
/**
 * TaskExecutionDrilldownModal
 *
 * Detail drilldown for one task on the execution dashboard (task 870):
 * fetches GET /workflow/execution-dashboard/:taskId and renders the derived
 * state, repair-bounce count, stall status, and the full chronological
 * transition history as a vertical timeline. The export button downloads
 * this task's full transition history as CSV. Not responsible for the
 * simple-view list — see ExecutionActivityTimeline.
 */
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { API_BASE_URL } from '@/utils/api';
import { Modal } from '@/components/ui/modal/Modal';
import type { ExecutionDashboardTaskState } from '../useExecutionDashboardData';

interface DrilldownTransition {
  id: number;
  fromStatus: string | null;
  toStatus: string;
  cause: string;
  phase: string | null;
  actor: string;
  createdAt: string;
}

interface DrilldownData {
  success: boolean;
  taskId: number;
  title: string;
  state: ExecutionDashboardTaskState;
  repairCount: number;
  frequentFailure: boolean;
  stalled: boolean;
  elapsedMinutes: number;
  currentPhase: string;
  transitions: DrilldownTransition[];
}

interface TaskExecutionDrilldownModalProps {
  /** taskId to load, or null to keep the modal closed. / 表示対象taskId(nullで非表示) */
  taskId: number | null;
  onClose: () => void;
}

/**
 * Fetches and renders one task's execution drilldown.
 *
 * @param taskId - taskId to load, or null to keep the modal closed. / 表示対象taskId
 * @param onClose - Called to close the modal. / 閉じる要求
 */
export function TaskExecutionDrilldownModal({ taskId, onClose }: TaskExecutionDrilldownModalProps) {
  const t = useTranslations('agents.executionDashboard');
  const [data, setData] = useState<DrilldownData | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (taskId === null) {
      setData(null);
      setLoadError(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/workflow/execution-dashboard/${taskId}`);
        const json = (await res.json().catch(() => null)) as DrilldownData | null;
        if (cancelled) return;
        if (!res.ok || !json?.success) {
          setLoadError(true);
          setData(null);
          return;
        }
        setData(json);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          setData(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return (
    <Modal
      open={taskId !== null}
      onClose={onClose}
      title={data?.title ?? t('drilldownTitle')}
      maxWidthClass="max-w-2xl"
    >
      {loadError && (
        <p className="text-sm text-red-600 dark:text-red-400">{t('drilldownLoadFailed')}</p>
      )}
      {!loadError && !data && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('drilldownLoading')}</p>
      )}
      {data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-700 dark:text-zinc-300">
            <span>
              {t('drilldownState')}:{' '}
              {t(`stage.${data.state === 'awaiting_judgement' ? 'awaitingJudgement' : data.state}`)}
              {data.state === 'awaiting_judgement' && ` (${data.currentPhase})`}
            </span>
            <span>
              {t('drilldownRepairCount')}: {data.repairCount}
            </span>
            <span>
              {t('drilldownElapsed')}: {t('elapsedMinutes', { minutes: data.elapsedMinutes })}
            </span>
            {data.stalled && (
              <span className="font-medium text-amber-600 dark:text-amber-400">
                {t('stalledBadge')}
              </span>
            )}
            {data.frequentFailure && (
              <span className="font-medium text-red-600 dark:text-red-400">
                {t('frequentFailureBadge', { count: data.repairCount })}
              </span>
            )}
          </div>

          <ol className="max-h-96 space-y-3 overflow-y-auto border-l border-zinc-200 pl-4 dark:border-zinc-700">
            {data.transitions.map((transition) => (
              <li key={transition.id} className="relative">
                <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-indigo-400" />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {new Date(transition.createdAt).toLocaleString()}
                </p>
                <p className="text-sm text-zinc-900 dark:text-zinc-50">
                  {transition.fromStatus ?? '—'} → {transition.toStatus}
                  <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                    ({transition.cause})
                  </span>
                </p>
              </li>
            ))}
          </ol>

          <div className="flex items-center gap-2">
            <a
              href={`${API_BASE_URL}/workflow/execution-dashboard/export?taskId=${data.taskId}`}
              download
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Download className="h-4 w-4" />
              {t('exportCsvButton')}
            </a>
            <a
              href={`${API_BASE_URL}/workflow/execution-dashboard/export?taskId=${data.taskId}&format=json`}
              download
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Download className="h-4 w-4" />
              {t('exportJsonButton')}
            </a>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default TaskExecutionDrilldownModal;
