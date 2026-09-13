'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { WorkflowFile, WorkflowStatus, WorkflowPathInfo } from '@/types';
import { API_BASE_URL } from '@/utils/api';
import { sharedEventSource } from '@/lib/sse/shared-event-source';

/**
 * SSE events that mean this task's workflow files or status may have changed:
 * runner phase changes, queue-item updates, and plain task updates (status /
 * workflowStatus writes outside the runner). All arrive on the app's single
 * `*` subscription.
 */
const WORKFLOW_CHANGE_EVENTS = ['phase_transition', 'item_update', 'task_updated'] as const;

export type WorkflowFilesData = {
  research: WorkflowFile;
  question: WorkflowFile;
  plan: WorkflowFile;
  verify: WorkflowFile;
};

function fileContentEqual(a: WorkflowFile, b: WorkflowFile): boolean {
  return (
    a.exists === b.exists &&
    a.content === b.content &&
    a.lastModified === b.lastModified &&
    a.size === b.size
  );
}

/**
 * True when every file type is byte-identical between two poll results.
 * Lets the 3s poll skip `setFiles` entirely when nothing changed, so
 * downstream consumers (MarkdownView, mermaid diagrams) don't re-render on a
 * new-but-equal object reference every tick.
 */
function filesDataEqual(a: WorkflowFilesData, b: WorkflowFilesData): boolean {
  return (
    fileContentEqual(a.research, b.research) &&
    fileContentEqual(a.question, b.question) &&
    fileContentEqual(a.plan, b.plan) &&
    fileContentEqual(a.verify, b.verify)
  );
}

export function useWorkflowFiles(taskId: number | null) {
  const t = useTranslations('common');
  const [files, setFiles] = useState<WorkflowFilesData | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus | null>(null);
  const [workflowPath, setWorkflowPath] = useState<WorkflowPathInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isInitialFetch = useRef(true);

  const fetchFiles = useCallback(async () => {
    if (!taskId) return;

    // NOTE: Show loading only on initial fetch (keep previous data during refetch)
    if (isInitialFetch.current) {
      setIsLoading(true);
    }
    setError(null);

    try {
      // no-store so polled refetches always get the agent's latest md writes
      // (never a cached response).
      const res = await fetch(`${API_BASE_URL}/workflow/tasks/${taskId}/files`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const nextFiles: WorkflowFilesData = {
        research: data.research,
        question: data.question,
        plan: data.plan,
        verify: data.verify,
      };
      setFiles((prev) => (prev && filesDataEqual(prev, nextFiles) ? prev : nextFiles));
      setWorkflowStatus(data.workflowStatus || null);
      setWorkflowPath(data.path || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('useWorkflowFiles.fetchFailed'));
    } finally {
      setIsLoading(false);
      isInitialFetch.current = false;
    }
  }, [taskId, t]);

  // Reset to initial fetch when taskId changes
  useEffect(() => {
    isInitialFetch.current = true;
    setFiles(null);
    setWorkflowStatus(null);
    setWorkflowPath(null);
    fetchFiles();
  }, [fetchFiles]);

  // Live status: the header badge and approval flow read `workflowStatus` from
  // this hook, but until now it was fetched once per taskId, so a phase change
  // made by the agent only showed after the page was reopened. Refetch on the
  // task-scoped SSE events instead of adding another poller (the viewer and
  // the task loader already poll as fallbacks while SSE is down).
  useEffect(() => {
    if (!taskId) return;
    const onTaskEvent = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { taskId?: number };
        if (data?.taskId === taskId) void fetchFiles();
      } catch {
        // Malformed payload — ignore; the next event or fallback poll catches up.
      }
    };
    const unsubscribes = WORKFLOW_CHANGE_EVENTS.map((type) =>
      sharedEventSource.subscribe(type, onTaskEvent),
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [taskId, fetchFiles]);

  const hasAnyFile = useMemo(() => {
    if (!files) return false;
    return (
      files.research.exists || files.question.exists || files.plan.exists || files.verify.exists
    );
  }, [files]);

  return {
    files,
    workflowStatus,
    workflowPath,
    isLoading,
    error,
    refetch: fetchFiles,
    hasAnyFile,
  };
}
