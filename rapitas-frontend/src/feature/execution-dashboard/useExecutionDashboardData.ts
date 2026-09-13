'use client';
/**
 * useExecutionDashboardData
 *
 * Polls GET /workflow/execution-dashboard on a fixed interval (task 870),
 * following SystemStatusPanel's visibility-aware polling pattern so the
 * dashboard goes quiet while rapitas is backgrounded and refreshes
 * immediately on return from minimize. Not responsible for rendering — see
 * components/ExecutionFlowChart / ExecutionActivityTimeline.
 */
import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL } from '@/utils/api';
import { useOnVisible } from '@/hooks/common/useOnVisible';
import { getAppHidden, subscribeAppHidden } from '@/hooks/common/app-visibility-store';

const POLL_INTERVAL_MS = 10000;

/** Dashboard display state — mirrors ExecutionDashboardState in the backend service. */
export type ExecutionDashboardTaskState =
  | 'queued'
  | 'running'
  | 'repairing'
  | 'awaiting_judgement'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** One task row from GET /workflow/execution-dashboard. */
export interface ExecutionDashboardTask {
  taskId: number;
  title: string;
  state: ExecutionDashboardTaskState;
  repairCount: number;
  frequentFailure: boolean;
  stalled: boolean;
  elapsedMinutes: number;
  currentPhase: string;
  themeId: number | null;
  updatedAt: string;
}

/** Shape of GET /workflow/execution-dashboard. */
export interface ExecutionDashboardData {
  success: boolean;
  stallThresholdMinutes: number;
  totalActiveCount: number;
  truncated: boolean;
  tasks: ExecutionDashboardTask[];
}

/** Return value of {@link useExecutionDashboardData}. */
export interface UseExecutionDashboardDataResult {
  /** Latest fetched payload, or null before the first response / API failure. / 直近の取得結果 */
  data: ExecutionDashboardData | null;
  /** Whether the first response (success or failure) has arrived. / 初回応答の到達有無 */
  loaded: boolean;
  /** Manually trigger an immediate refetch (bypasses the poll interval). / 即時再取得 */
  refresh: () => void;
}

/**
 * Polls the execution dashboard list endpoint and exposes the latest data.
 *
 * @returns Latest data, loaded flag, and a manual refresh trigger. / 直近データ・初回到達フラグ・手動更新
 */
export function useExecutionDashboardData(): UseExecutionDashboardDataResult {
  const [data, setData] = useState<ExecutionDashboardData | null>(null);
  const [loaded, setLoaded] = useState(false);

  const poll = useCallback(async () => {
    // Skip the probe while rapitas is backgrounded — same rationale as
    // SystemStatusPanel: getAppHidden() covers minimize, which
    // occlusion-disabled WebView2 doesn't report via document.hidden.
    if ((typeof document !== 'undefined' && document.hidden) || getAppHidden()) return;
    try {
      const res = await fetch(`${API_BASE_URL}/workflow/execution-dashboard`);
      const json = (await res.json().catch(() => null)) as ExecutionDashboardData | null;
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

  // Re-poll immediately on restore from minimize (see app-visibility-store's
  // module doc for why visibilitychange alone is not enough).
  useEffect(() => {
    return subscribeAppHidden(() => {
      if (!getAppHidden()) poll();
    });
  }, [poll]);

  return { data, loaded, refresh: poll };
}
