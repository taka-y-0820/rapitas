'use client';
// useWorkflowViewer

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { WorkflowFileType, WorkflowStatus, WorkflowRoleConfig } from '@/types';
import { useWorkflowFiles } from '@/hooks/workflow/useWorkflowFiles';
import { useLocaleStore } from '@/stores/locale-store';
import { useExecutionStateStore } from '@/stores/execution-state-store';
import { API_BASE_URL } from '@/utils/api';
import { sharedEventSource } from '@/lib/sse/shared-event-source';
import { getAppHidden, subscribeAppHidden } from '@/hooks/common/app-visibility-store';
import { useOnVisible } from '@/hooks/common/useOnVisible';
import type { WorkflowMode } from './CompactWorkflowSelector';

const ACTIVE_STATUSES = new Set<WorkflowStatus>([
  'draft',
  'research_done',
  'plan_created',
  'plan_approved',
  'in_progress',
]);

const STATUS_ORDER: Record<string, number> = {
  draft: 0,
  research_done: 1,
  plan_created: 2,
  plan_approved: 3,
  in_progress: 4,
  verify_done: 5,
  completed: 6,
};

// Auto-selection mapping for tabs corresponding to status
const STATUS_TO_TAB: Partial<Record<WorkflowStatus, WorkflowFileType>> = {
  research_done: 'research',
  plan_created: 'plan',
  in_progress: 'plan',
  awaiting_question: 'question',
  verify_done: 'verify',
  completed: 'verify',
};

export interface UseWorkflowViewerOptions {
  taskId: number;
  workflowStatus?: WorkflowStatus | null;
  workflowMode?: WorkflowMode | null;
  onStatusChange?: (newStatus: WorkflowStatus) => void;
  onWorkflowModeChange?: (mode: WorkflowMode, isOverride: boolean) => void;
  workflowModeOverride?: boolean;
}

/**
 * Manages all async state, polling, and derived values for WorkflowViewer.
 *
 * @param options - Configuration options for the workflow viewer state
 * @returns State and handler functions consumed by WorkflowViewer UI
 */
export function useWorkflowViewer({
  taskId,
  workflowStatus,
  workflowMode: _workflowMode,
  onStatusChange,
  onWorkflowModeChange,
  workflowModeOverride,
}: UseWorkflowViewerOptions) {
  const t = useTranslations('workflow');
  const tc = useTranslations('common');
  const [activeTab, setActiveTab] = useState<WorkflowFileType>('research');
  const locale = useLocaleStore((s) => s.locale);
  // Live agent-execution flag for this task. While the agent runs it writes the
  // md files, so the viewer must poll regardless of the workflow status (which
  // may be null at the start, or a transient `blocked`/`awaiting_question` that
  // is NOT in ACTIVE_STATUSES). Keys off execution so files reflect live.
  const isExecuting = useExecutionStateStore((s) =>
    taskId != null ? s.isTaskExecuting(taskId) : false,
  );
  const {
    files,
    isLoading,
    error,
    refetch,
    workflowPath,
    workflowStatus: fetchedStatus,
  } = useWorkflowFiles(taskId);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [roles, setRoles] = useState<WorkflowRoleConfig[]>([]);
  const [autoComplexityAnalysis, setAutoComplexityAnalysis] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStatusRef = useRef<WorkflowStatus | null>(null);
  const prevWorkflowStatusPropRef = useRef<WorkflowStatus | null | undefined>(workflowStatus);
  const prevFetchedStatusRef = useRef<WorkflowStatus | null>(null);

  // A confirmed answer can move backwards. Once fetching catches up, ignore
  // the pre-answer parent prop until it also changes; otherwise unpinning
  // immediately resurrects the stale higher-ranked state (task 902).
  const [questionResolution, setQuestionResolution] = useState<{
    taskId: number;
    status: WorkflowStatus;
    fetchedBefore: WorkflowStatus | null;
    propBefore: WorkflowStatus | null | undefined;
    pendingFetch: boolean;
  } | null>(null);

  const applyResolvedQuestionStatus = useCallback(
    (toStatus: WorkflowStatus) => {
      setQuestionResolution({
        taskId,
        status: toStatus,
        fetchedBefore: fetchedStatus ?? null,
        propBefore: workflowStatus,
        pendingFetch: true,
      });
    },
    [taskId, fetchedStatus, workflowStatus],
  );

  useEffect(() => {
    if (!questionResolution) return;
    if (questionResolution.taskId !== taskId) {
      setQuestionResolution(null);
    } else if (
      questionResolution.pendingFetch &&
      fetchedStatus &&
      (fetchedStatus === questionResolution.status ||
        fetchedStatus !== questionResolution.fetchedBefore)
    ) {
      setQuestionResolution({ ...questionResolution, pendingFetch: false });
    } else if (
      !questionResolution.pendingFetch &&
      workflowStatus !== questionResolution.propBefore
    ) {
      setQuestionResolution(null);
    }
  }, [taskId, fetchedStatus, workflowStatus, questionResolution]);

  // Effective status: reflects prop updates immediately without waiting for fetch to catch up
  // Uses prop when it's ahead based on StatusOrder comparison
  const effectiveStatus = (() => {
    if (questionResolution?.taskId === taskId) {
      if (questionResolution.pendingFetch) return questionResolution.status;
      if (workflowStatus === questionResolution.propBefore) {
        return fetchedStatus ?? questionResolution.status;
      }
    }
    if (!fetchedStatus && !workflowStatus) return null;
    if (!fetchedStatus) return workflowStatus || null;
    if (!workflowStatus) return fetchedStatus;
    const propOrder = STATUS_ORDER[workflowStatus] ?? -1;
    const fetchOrder = STATUS_ORDER[fetchedStatus] ?? -1;
    return propOrder >= fetchOrder ? workflowStatus : fetchedStatus;
  })();

  // Notify parent when fetchedStatus changes
  useEffect(() => {
    if (fetchedStatus && fetchedStatus !== prevStatusRef.current) {
      prevStatusRef.current = fetchedStatus;
      if (onStatusChange && fetchedStatus !== workflowStatus) {
        onStatusChange(fetchedStatus);
      }
    }
  }, [fetchedStatus, workflowStatus, onStatusChange]);

  // Refetch when parent workflowStatus prop is updated
  useEffect(() => {
    if (workflowStatus && workflowStatus !== prevWorkflowStatusPropRef.current) {
      prevWorkflowStatusPropRef.current = workflowStatus;
      refetch();
    }
  }, [workflowStatus, refetch]);

  // Auto-switch tabs on status change
  useEffect(() => {
    if (effectiveStatus) {
      const tab = STATUS_TO_TAB[effectiveStatus];
      if (tab) {
        setActiveTab(tab);
      }
    }
  }, [effectiveStatus]);

  // Fetch role configuration
  useEffect(() => {
    const fetchRoles = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/workflow-roles`);
        if (res.ok) {
          setRoles(await res.json());
        }
      } catch {
        // ignore
      }
    };
    fetchRoles();
  }, []);

  // Fetch auto-complexity analysis settings
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/settings`);
        if (res.ok) {
          const data = await res.json();
          setAutoComplexityAnalysis(data.autoComplexityAnalysis ?? false);
        }
      } catch {
        // ignore
      }
    };
    fetchSettings();
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (intervalMs: number = 3000) => {
      stopPolling();
      pollingRef.current = setInterval(() => {
        refetch();
      }, intervalMs);
    },
    [refetch, stopPolling],
  );

  // Stop polling on component unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // Keep the viewer live during an ACTIVE workflow so md files saved by the
  // agent (research/plan/verify) reflect without a manual reload. Primary
  // signal is the shared SSE connection (`phase_transition`/`item_update`,
  // filtered to this task); 3s polling is only a fallback for whenever SSE is
  // disconnected while the window is visible — never while hidden, since
  // sharedEventSource itself closes the connection on hide and reopening a
  // poller there would defeat the point of this effect (backend visibility
  // hardening).
  const status = (effectiveStatus ?? fetchedStatus ?? workflowStatus) as WorkflowStatus | null;
  const isTerminal = status === 'completed' || status === 'verify_done';
  const shouldTrack = !isTerminal && (isExecuting || (!!status && ACTIVE_STATUSES.has(status)));

  useEffect(() => {
    if (!shouldTrack) {
      stopPolling();
      return;
    }

    const isHidden = () => (typeof document !== 'undefined' && document.hidden) || getAppHidden();

    const handleTaskEvent = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { taskId?: number };
        if (data?.taskId === taskId) refetch();
      } catch {
        // Malformed payload — ignore; the next event or fallback polling catches up.
      }
    };
    const unsubPhase = sharedEventSource.subscribe('phase_transition', handleTaskEvent);
    const unsubItem = sharedEventSource.subscribe('item_update', handleTaskEvent);

    const syncFallbackPolling = (connected: boolean) => {
      if (!connected && !isHidden()) startPolling(3000);
      else stopPolling();
    };
    const unsubConn = sharedEventSource.onConnectionChange(syncFallbackPolling);
    const handleVisibilityChange = () => syncFallbackPolling(sharedEventSource.isConnected());
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const unsubAppHidden = subscribeAppHidden(() =>
      syncFallbackPolling(sharedEventSource.isConnected()),
    );

    return () => {
      unsubPhase();
      unsubItem();
      unsubConn();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubAppHidden();
      stopPolling();
    };
  }, [shouldTrack, taskId, refetch, startPolling, stopPolling]);

  useOnVisible(() => {
    if (shouldTrack) refetch();
  });

  const handleAdvance = useCallback(async () => {
    setIsAdvancing(true);
    setAdvanceError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/workflow/tasks/${taskId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: locale }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setAdvanceError(data.error || t('viewer.advanceFailed'));
      } else if (data.async) {
        // Async execution: monitor state with polling
        startPolling(3000);
      } else {
        // Sync completion: refetch immediately
        await refetch();
      }
    } catch (err) {
      setAdvanceError(err instanceof Error ? err.message : tc('errorOccurred'));
    } finally {
      setIsAdvancing(false);
    }
  }, [taskId, locale, refetch, startPolling, t, tc]);

  // Stop polling and refetch when status reaches final state
  useEffect(() => {
    if (fetchedStatus && fetchedStatus !== prevFetchedStatusRef.current && pollingRef.current) {
      prevFetchedStatusRef.current = fetchedStatus;
      // Stop polling when reaching final states (completed, verify_done)
      if (fetchedStatus === 'completed' || fetchedStatus === 'verify_done') {
        stopPolling();
      }
      refetch();
    }
    if (fetchedStatus && !prevFetchedStatusRef.current) {
      prevFetchedStatusRef.current = fetchedStatus;
    }
  }, [fetchedStatus, stopPolling, refetch]);

  const activeFile = useMemo(() => {
    if (!files) return null;
    return files[activeTab];
  }, [files, activeTab]);

  const tabStatus = useMemo(() => {
    if (!files) return { research: false, question: false, plan: false, verify: false };
    return {
      research: files.research.exists,
      question: files.question.exists,
      plan: files.plan.exists,
      verify: files.verify.exists,
    };
  }, [files]);

  // `shouldTrack` covers SSE-driven tracking (the common case, no JS interval);
  // `pollingRef.current !== null` covers the fallback/one-shot polling windows
  // (SSE disconnected, or handleAdvance's transient post-advance poll) where
  // shouldTrack may still be false. Consumers (WorkflowViewer's next-phase
  // button) read this as "is the workflow being auto-tracked right now" —
  // narrowing it to the JS-timer-only definition would make the button
  // reappear during SSE-driven ACTIVE tracking (see plan.md §isPollingの意味論保持).
  const isPolling = shouldTrack || pollingRef.current !== null;

  /**
   * Callback passed to CompactWorkflowSelector when complexity analysis completes.
   * Notifies parent only when mode is not manually overridden.
   *
   * @param analysis - The completed analysis result containing recommendedMode
   */
  const handleAnalysisComplete = useCallback(
    (analysis: { recommendedMode: WorkflowMode }) => {
      if (onWorkflowModeChange && !workflowModeOverride) {
        onWorkflowModeChange(analysis.recommendedMode, false);
      }
    },
    [onWorkflowModeChange, workflowModeOverride],
  );

  return {
    activeTab,
    setActiveTab,
    files,
    isLoading,
    error,
    refetch,
    workflowPath,
    effectiveStatus,
    applyResolvedQuestionStatus,
    isAdvancing,
    advanceError,
    setAdvanceError,
    roles,
    autoComplexityAnalysis,
    isPolling,
    activeFile,
    tabStatus,
    handleAdvance,
    handleAnalysisComplete,
  };
}
