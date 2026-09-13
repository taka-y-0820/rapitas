'use client';
// useTaskCard
import { useState, useRef, useEffect } from 'react';
import type { Task, Status } from '@/types';
import { getStatusDisplay } from '@/feature/tasks/config/StatusConfig';
import { useToast } from '@/components/ui/toast/ToastContainer';
import { useConfirmDialog } from '@/components/ui/dialog/ConfirmDialogProvider';
import { API_BASE_URL } from '@/utils/api';
import { prefetch } from '@/lib/api-client';
import { useExecutionStateStore } from '@/stores/execution-state-store';
import { useTranslations } from 'next-intl';
import { createLogger } from '@/lib/logger';
import { useElapsedTime } from '@/hooks/common/useElapsedTime';
import { useProgressColors } from '../completion/TaskCompletionAnimation';

const logger = createLogger('TaskCard');

/**
 * CSS class bundle derived from the current agent execution status.
 */
export interface ExecutionClasses {
  borderColor: 'blue' | 'amber';
  badgeClass: string;
  dotClass: string;
  label: string;
}

/**
 * Amber styling config used when a task is waiting for user input.
 */
export interface WaitingAmberConfig {
  color: string;
  bgColor: string;
  borderColor: string;
  label: string;
}

/**
 * All values and handlers returned by useTaskCard.
 */
export interface TaskCardHook {
  cardRef: React.RefObject<HTMLDivElement | null>;
  contextMenuRef: React.RefObject<HTMLDivElement | null>;
  showContextMenu: boolean;
  contextMenuPosition: { x: number; y: number };
  setContextMenuPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setShowContextMenu: React.Dispatch<React.SetStateAction<boolean>>;
  expandedSubtasks: boolean;
  setExpandedSubtasks: React.Dispatch<React.SetStateAction<boolean>>;
  localSubtasks: Task[];
  handleSubtaskStatusChange: (subtaskId: number, newStatus: string) => void;
  currentStatus: ReturnType<typeof getStatusDisplay>;
  executionStatus: string | null;
  /** Live-ticking "M:SS" elapsed time since the agent started, or null when not running. */
  executionElapsed: string | null;
  executionClasses: ExecutionClasses | null;
  isWaitingForInput: boolean;
  waitingAmberConfig: WaitingAmberConfig;
  cardBorderColor: string;
  sweepColors: ReturnType<typeof useProgressColors>;
  handleMouseEnter: () => Promise<void>;
  duplicateTask: () => Promise<void>;
  deleteTask: () => Promise<void>;
}

/**
 * Encapsulates TaskCard state, event handlers, and derived display values.
 *
 * @param task - The task being displayed.
 * @param onStatusChange - Parent callback for status changes.
 * @param onTaskUpdated - Parent callback after task is mutated.
 * @param onTaskClick - Parent callback when the card is clicked.
 * @returns All hooks and helpers needed by the TaskCard render tree.
 */
export function useTaskCard(
  task: Task,
  onStatusChange: (taskId: number, status: Status, cardElement?: HTMLElement) => void,
  onTaskUpdated?: () => void,
  _onTaskClick?: (taskId: number) => void,
): TaskCardHook {
  const t = useTranslations('task');
  const tc = useTranslations('common');
  const tHome = useTranslations('home');

  const cardRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const prefetchedRef = useRef(false);

  const [expandedSubtasks, setExpandedSubtasks] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({
    x: 0,
    y: 0,
  });
  const [localSubtasks, setLocalSubtasks] = useState(task.subtasks || []);

  const { showToast } = useToast();
  const confirm = useConfirmDialog();

  const storeExecutionStatus = useExecutionStateStore((state) =>
    state.getExecutingTaskStatus(task.id),
  );
  const storeExecutionStartedAt = useExecutionStateStore((state) =>
    state.getExecutingTaskStartedAt(task.id),
  );
  const storeExecutionActiveMs = useExecutionStateStore((state) =>
    state.getExecutingTaskActiveMs(task.id),
  );

  // Sync localSubtasks when the prop changes
  useEffect(() => {
    setLocalSubtasks(task.subtasks || []);
  }, [task.subtasks]);

  // The card's running animation reflects ACTUAL agent execution only — never a
  // manually-set in-progress status. useExecutingTasksPolling reflects a running
  // subtask onto its parent's id, so storeExecutionStatus already means "an agent
  // is executing this task or one of its subtasks". (Previously this fell back to
  // "any subtask has in-progress STATUS", which spun the loader even for tasks a
  // user had manually marked in-progress.)
  const executionStatus = storeExecutionStatus;
  // Cumulative finished active time as the base + live tick of the current
  // execution row — the display accumulates across phase / re-run boundaries
  // instead of resetting to 0 on each new phase's row (task #560).
  const executionElapsed = useElapsedTime(
    storeExecutionStartedAt,
    executionStatus === 'running' || executionStatus === 'waiting_for_input',
    storeExecutionActiveMs,
  );

  // Close context menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };
    if (showContextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showContextMenu]);

  const handleSubtaskStatusChange = (subtaskId: number, newStatus: string) => {
    // Optimistic update
    setLocalSubtasks((prev) =>
      prev.map((s) => (s.id === subtaskId ? { ...s, status: newStatus as Status } : s)),
    );
    onStatusChange(subtaskId, newStatus as Status);
  };

  const currentStatus = getStatusDisplay(t, task.status);

  // NOTE: Removed completionRate/getProgressBarColor — subtask progress
  // aggregation now lives in TaskCardSubtaskProgress (segmented status-hue bar).
  const getExecutionClasses = (): ExecutionClasses | null => {
    switch (executionStatus) {
      case 'running':
        return {
          borderColor: 'blue',
          badgeClass: 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300',
          dotClass: 'bg-blue-500',
          label: t('running'),
        };
      case 'waiting_for_input':
        return {
          borderColor: 'amber',
          badgeClass: 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300',
          dotClass: 'bg-amber-500',
          label: t('waitingForInput'),
        };
      default:
        return null;
    }
  };

  // A workflow paused on question.md (`awaiting_question`) has NO live
  // execution row — the agent exited after writing the question — so the
  // execution-store status alone never turned the card amber for the current
  // file-based question flow (only the legacy in-CLI AskUserQuestion did).
  // Treat both as "waiting for the user" so the card reads amber either way.
  const isAwaitingQuestion =
    task.workflowStatus === 'awaiting_question' && task.status !== 'done' && !executionStatus;
  const executionClasses: ExecutionClasses | null = isAwaitingQuestion
    ? {
        borderColor: 'amber',
        badgeClass: 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300',
        dotClass: 'bg-amber-500',
        label: t('waitingForInput'),
      }
    : getExecutionClasses();
  const isWaitingForInput = executionStatus === 'waiting_for_input' || isAwaitingQuestion;

  const waitingAmberConfig: WaitingAmberConfig = {
    color: 'text-amber-700 dark:text-amber-300',
    bgColor: 'bg-amber-50 dark:bg-amber-900/40',
    borderColor: 'border-l-amber-500 dark:border-l-amber-400',
    label: t('waitingForInput'),
  };

  const cardBorderColor = isWaitingForInput
    ? waitingAmberConfig.borderColor
    : currentStatus.borderColor;

  const sweepColors = useProgressColors(1, 2);

  const handleMouseEnter = async () => {
    if (!prefetchedRef.current) {
      prefetchedRef.current = true;
      await prefetch([`/tasks/${task.id}`], 24 * 60 * 60 * 1000);
      if (task.subtasks && task.subtasks.length > 0) {
        const subtaskPaths = task.subtasks.map((s) => `/tasks/${s.id}`);
        await prefetch(subtaskPaths, 24 * 60 * 60 * 1000);
      }
    }
  };

  const duplicateTask = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `${task.title} ${tc('copySuffix')}`,
          status: task.status,
          priority: task.priority,
          themeId: task.themeId,
          description: task.description,
          estimatedHours: task.estimatedHours,
        }),
      });
      if (!res.ok) throw new Error(tHome('duplicateFailed'));
      showToast(tHome('duplicated'), 'success');
      onTaskUpdated?.();
      setShowContextMenu(false);
    } catch (e) {
      logger.error(e);
      showToast(tHome('duplicateFailed'), 'error');
    }
  };

  const deleteTask = async () => {
    // Protected tasks can't be deleted; surface a toast before the confirm so
    // the user understands why (backend also enforces this with a 409).
    if (task.isProtected) {
      showToast(t('taskCard.protectedDeleteError'), 'error');
      setShowContextMenu(false);
      return;
    }
    if (!(await confirm({ message: tHome('deleteConfirm'), variant: 'destructive' }))) return;
    try {
      const res = await fetch(`${API_BASE_URL}/tasks/${task.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(tHome('deleteFailed'));
      showToast(tHome('taskDeleted'), 'success');
      onTaskUpdated?.();
      setShowContextMenu(false);
    } catch (e) {
      logger.error(e);
      showToast(tHome('deleteFailed'), 'error');
    }
  };

  return {
    cardRef,
    contextMenuRef,
    showContextMenu,
    contextMenuPosition,
    setContextMenuPosition,
    setShowContextMenu,
    expandedSubtasks,
    setExpandedSubtasks,
    localSubtasks,
    handleSubtaskStatusChange,
    currentStatus,
    executionStatus,
    executionElapsed,
    executionClasses,
    isWaitingForInput,
    waitingAmberConfig,
    cardBorderColor,
    sweepColors,
    handleMouseEnter,
    duplicateTask,
    deleteTask,
  };
}
