'use client';
/**
 * SystemStatusPanel
 *
 * Neutral KPI bar surfacing the agent system's live operability signal at the
 * top of the agents dashboard: a status pill plus tiles for running/active/
 * interrupted executions, auto-run queue depth, and process uptime. All of
 * this data already exists — `/health` aggregates getAgentSystemSnapshot()
 * plus process uptime (see rapitas-backend/index.ts) — this panel just gives
 * it a permanent, glanceable home instead of requiring a manual curl.
 * Not responsible for fetching per-agent metrics (see MetricsOverviewCards).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Server,
  Activity,
  PlayCircle,
  AlertTriangle,
  Layers3,
  Clock,
  AppWindow,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { API_BASE_URL } from '@/utils/api';
import { useOnVisible } from '@/hooks/common/useOnVisible';
import { getAppHidden, subscribeAppHidden } from '@/hooks/common/app-visibility-store';
import type { PanelMeta } from './panel-types';

const POLL_INTERVAL_MS = 10000;

interface HealthSnapshot {
  status: string;
  database?: string;
  uptimeSeconds?: number;
  activeExecutions?: number;
  activeExecutionsDegraded?: boolean;
  runningExecutions?: number;
  interruptedExecutions?: number;
  interruptedExecutionsDegraded?: boolean;
  queueDepth?: number;
  activePreviewCount?: number;
}

type PillStatus = 'healthy' | 'busy' | 'shutting_down' | 'interrupted' | 'unhealthy' | 'unknown';

// Icon/color choices are recorded in .claude/ICON_POLICY.md §3 — Server ties
// this pill to the same "backend server" meaning BackendConnectionError uses.
const PILL_STYLES: Record<PillStatus, string> = {
  healthy:
    'bg-green-50 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-600',
  busy: 'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-600',
  shutting_down:
    'bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-600',
  interrupted:
    'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-600',
  unhealthy:
    'bg-red-50 text-red-700 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-600',
  unknown:
    'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-700/40 dark:text-zinc-300 dark:border-zinc-600',
};

/**
 * Derives the display pill state from the raw `/health` payload.
 *
 * NOTE: `/health` itself collapses "busy" into "healthy" for its top-level
 * `status` field (see index.ts) so busy/interrupted are re-derived here from
 * the raw execution counts to give the operator the finer-grained signal.
 *
 * `interruptedExecutionsDegraded` is checked before the interrupted-count
 * signal: if the backend couldn't verify whether interrupted executions are
 * still resumable, that must never render as "healthy" just because the
 * raw-count fallback happens to be 0 (task 913).
 *
 * @param data - Parsed /health JSON, or null on a failed/unparseable fetch / 取得失敗時はnull
 * @returns The pill state to render / 表示するピル状態
 */
function derivePillStatus(data: HealthSnapshot | null): PillStatus {
  if (!data) return 'unhealthy';
  if (data.status === 'unhealthy') return 'unhealthy';
  if (data.activeExecutionsDegraded) return 'unknown';
  if (data.interruptedExecutionsDegraded) return 'unknown';
  if (data.status === 'shutting_down') return 'shutting_down';
  if ((data.interruptedExecutions ?? 0) > 0) return 'interrupted';
  if ((data.activeExecutions ?? 0) > 0) return 'busy';
  return 'healthy';
}

/**
 * Formats an uptime duration in seconds as a compact "Xh Ym" / "Xm" / "Xs" string.
 *
 * @param seconds - Uptime in seconds / 起動継続秒数
 * @returns Compact human-readable duration / 簡潔な人間可読表記
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/** Registered with scripts/generate-agents-panels.mjs — see panel-types.ts. */
export const panelMeta: PanelMeta = { id: 'system-status', order: 0 };

export function SystemStatusPanel() {
  const t = useTranslations('agents');
  const [data, setData] = useState<HealthSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  const poll = useCallback(async () => {
    // Skip the probe while rapitas is backgrounded — useOnVisible below
    // re-polls immediately on return (same pattern as useBackendHealth).
    // getAppHidden() covers minimize, which occlusion-disabled WebView2
    // doesn't report via document.hidden.
    if ((typeof document !== 'undefined' && document.hidden) || getAppHidden()) return;
    try {
      const res = await fetch(`${API_BASE_URL}/health`);
      const json = (await res.json().catch(() => null)) as HealthSnapshot | null;
      setData(json);
    } catch {
      setData(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  useOnVisible(poll);

  // Re-poll immediately on restore from minimize. visibilitychange (behind
  // useOnVisible above) never fires for that transition because occlusion is
  // intentionally disabled, so without this the 10s poll interval would be
  // the only thing to pick it back up.
  useEffect(() => {
    return subscribeAppHidden(() => {
      if (!getAppHidden()) poll();
    });
  }, [poll]);

  // Wait for the first response before rendering — avoids flashing an
  // "unhealthy" pill for the split second before data arrives (same
  // convention as RepairConvergenceCard's loading gate).
  if (!loaded) return null;

  const pill = derivePillStatus(data);

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <Server className="h-4 w-4 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
          {t('systemStatus.title')}
        </h3>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PILL_STYLES[pill]}`}
        >
          {t(`systemStatus.pill.${pill}`)}
        </span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white md:grid-cols-6 md:divide-y-0 dark:divide-zinc-700 dark:border-zinc-700 dark:bg-zinc-800">
        <div className="flex items-center gap-3 px-4 py-3">
          <Activity className="h-5 w-5 shrink-0 text-indigo-500" />
          <div className="min-w-0">
            <div className="text-xl font-bold leading-tight text-zinc-900 dark:text-zinc-50">
              {data?.runningExecutions ?? '—'}
            </div>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {t('systemStatus.running')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-3">
          <PlayCircle className="h-5 w-5 shrink-0 text-blue-500" />
          <div className="min-w-0">
            <div className="text-xl font-bold leading-tight text-zinc-900 dark:text-zinc-50">
              {data?.activeExecutions ?? '—'}
            </div>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {t('systemStatus.active')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <div className="text-xl font-bold leading-tight text-zinc-900 dark:text-zinc-50">
              {data?.interruptedExecutions ?? '—'}
            </div>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {t('systemStatus.interrupted')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-3">
          <Layers3 className="h-5 w-5 shrink-0 text-purple-500" />
          <div className="min-w-0">
            <div className="text-xl font-bold leading-tight text-zinc-900 dark:text-zinc-50">
              {data?.queueDepth ?? '—'}
            </div>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {t('systemStatus.queueDepth')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-3">
          <AppWindow className="h-5 w-5 shrink-0 text-teal-500" />
          <div className="min-w-0">
            <div className="text-xl font-bold leading-tight text-zinc-900 dark:text-zinc-50">
              {data?.activePreviewCount ?? '—'}
            </div>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {t('systemStatus.activePreviews')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-3">
          <Clock className="h-5 w-5 shrink-0 text-zinc-400" />
          <div className="min-w-0">
            <div className="text-xl font-bold leading-tight text-zinc-900 dark:text-zinc-50">
              {data?.uptimeSeconds != null ? formatUptime(data.uptimeSeconds) : '—'}
            </div>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {t('systemStatus.uptime')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SystemStatusPanel;
