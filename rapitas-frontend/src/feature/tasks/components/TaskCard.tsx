'use client';
// TaskCard
import React, { useState, memo } from 'react';
import type { Task, Status } from '@/types';
import TaskStatusChange from '@/feature/tasks/components/status/TaskStatusChange';
import PriorityIcon from '@/feature/tasks/components/priority/PriorityIcon';
import { getStatusDisplay, renderStatusIcon } from '@/feature/tasks/config/StatusConfig';
import { ExternalLink, Tag, Repeat, RefreshCw, Lock, Clock, History } from 'lucide-react';
import { API_BASE_URL } from '@/utils/api';
import { useToast } from '@/components/ui/toast/ToastContainer';
import { getLabelsArray, hasLabels } from '@/utils/labels';
import { getIconComponent } from '@/components/category/icon-data';
import { ModernCheckbox } from '@/components/ui/ModernCheckbox';
import { resolveBlockedCauseLabel } from '@/components/workflow/workflow-blocked-cause';
import { useTranslations } from 'next-intl';
import { formatDate } from '@/utils/date';
import { useTaskCard } from './task-card/useTaskCard';
import TaskCardContextMenu from './task-card/TaskCardContextMenu';
import TaskCardSubtaskPanel from './task-card/TaskCardSubtaskPanel';
import TaskCardSubtaskProgress from './task-card/TaskCardSubtaskProgress';
import styles from './TaskCard.module.css';

interface TaskCardProps {
  task: Task;
  isSelected?: boolean;
  isSelectionMode?: boolean;
  onTaskClick: (taskId: number) => void;
  onStatusChange: (taskId: number, status: Status, cardElement?: HTMLElement) => void;
  onToggleSelect?: (taskId: number) => void;
  onTaskUpdated?: () => void;
  onOpenInPage?: (taskId: number) => void;
}

const TaskCard = memo(function TaskCard({
  task,
  isSelected = false,
  isSelectionMode = false,
  onTaskClick,
  onStatusChange,
  onToggleSelect,
  onTaskUpdated,
  onOpenInPage,
}: TaskCardProps) {
  const t = useTranslations('task');
  const tHome = useTranslations('home');
  const tWorkflow = useTranslations('workflow');
  const { showToast } = useToast();

  const tc = useTaskCard(task, onStatusChange, onTaskUpdated, onTaskClick);

  // NOTE: The frontend Status type only covers todo/in-progress/done, but the
  // backend also parks tasks as 'blocked' (auto-run skip) / 'failed' — compare
  // as string until the type catches up.
  const isRetryable = (task.status as string) === 'blocked' || (task.status as string) === 'failed';
  const [isRetrying, setIsRetrying] = useState(false);
  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      const res = await fetch(`${API_BASE_URL}/tasks/${task.id}/retry`, { method: 'POST' });
      if (res.ok) {
        await onTaskUpdated?.();
      } else {
        showToast(t('taskCard.retryFailed'), 'error');
      }
    } catch {
      showToast(t('taskCard.retryFailed'), 'error');
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div
      ref={tc.cardRef}
      data-task-card
      onMouseEnter={tc.handleMouseEnter}
      className={`${styles.card} group relative z-0 w-full min-w-0 rounded-lg border-l-4 border-t border-r border-b ${
        isSelected
          ? 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-400 dark:border-indigo-600 ring-1 ring-indigo-500/40 dark:ring-indigo-400/40'
          : `${tc.cardBorderColor} border-zinc-200 dark:border-zinc-800 ${tc.currentStatus.bgColor} dark:bg-indigo-dark-900 shadow-[0_2px_0_0_#e4e4e7] dark:shadow-[0_2px_0_0_#27272a]`
      } ${!isSelected ? styles.interactive : ''} ${
        tc.executionClasses?.borderColor === 'blue'
          ? 'ai-glow-blue'
          : tc.executionClasses?.borderColor === 'amber'
            ? 'ai-glow-amber'
            : ''
      }`}
    >
      {/* Main row */}
      <div
        className="relative z-10 flex items-center gap-3 px-3 py-2.5 min-w-0 cursor-pointer hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20 rounded-t-lg"
        onClick={() => {
          if (isSelectionMode && onToggleSelect) {
            // Auto-executing tasks are excluded from bulk selection — an
            // unintended bulk status change mid-execution could cause the
            // agent to misbehave (see ModernCheckbox's disabled state below).
            if (tc.executionStatus) return;
            onToggleSelect(task.id);
          } else {
            onTaskClick(task.id);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!isSelectionMode) {
            tc.setContextMenuPosition({ x: e.clientX, y: e.clientY });
            tc.setShowContextMenu(true);
          }
        }}
      >
        {/* Status icon / checkbox */}
        {isSelectionMode ? (
          <ModernCheckbox
            checked={isSelected || false}
            onChange={() => onToggleSelect?.(task.id)}
            onClick={(e) => e.stopPropagation()}
            className="mr-1"
            aria-label={`${t('select')} ${task.title}`}
            disabled={Boolean(tc.executionStatus)}
            title={t('taskCard.executingCannotSelect')}
          />
        ) : (
          <div
            className={`relative flex items-center justify-center w-7 h-7 rounded-md ${
              tc.isWaitingForInput ? tc.waitingAmberConfig.color : tc.currentStatus.color
            } ${tc.isWaitingForInput ? tc.waitingAmberConfig.bgColor : tc.currentStatus.bgColor} ${
              tc.executionStatus
                ? ''
                : `border-2 ${(tc.isWaitingForInput
                    ? tc.waitingAmberConfig.borderColor
                    : tc.currentStatus.borderColor
                  ).replace('border-l-', 'border-')}`
            } shrink-0`}
            aria-label={tc.isWaitingForInput ? tc.waitingAmberConfig.label : tc.currentStatus.label}
            // The list endpoint batches the latest WorkflowTransition.cause onto
            // `task.blockedCause` for blocked tasks (one query for the whole
            // list — see attachBlockedCauses on the backend). Fall back to the
            // generic hint when the cause is absent/unrecognized.
            title={
              (task.status as string) === 'blocked'
                ? (resolveBlockedCauseLabel(tWorkflow, task.blockedCause) ??
                  tWorkflow('statusIndicator.blockedGenericHint'))
                : undefined
            }
          >
            {(tc.executionStatus === 'running' || tc.executionStatus === 'waiting_for_input') && (
              <svg
                className="absolute -inset-0.5 w-[calc(100%+4px)] h-[calc(100%+4px)] pointer-events-none"
                viewBox="0 0 32 32"
                fill="none"
              >
                <rect
                  x="1"
                  y="1"
                  width="30"
                  height="30"
                  rx="7"
                  stroke={tc.executionStatus === 'waiting_for_input' ? '#f59e0b' : '#3b82f6'}
                  strokeWidth="2"
                  strokeDasharray="20 87.96"
                  strokeLinecap="round"
                  fill="none"
                  style={{
                    animation: 'icon-outer-border-spin 1.5s linear infinite',
                    willChange: 'stroke-dashoffset',
                    transform: 'translateZ(0)',
                  }}
                  aria-hidden="true"
                />
              </svg>
            )}
            {renderStatusIcon(tc.isWaitingForInput ? 'in-progress' : task.status)}
          </div>
        )}

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 min-w-0">
            <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
              <h3
                className="font-medium text-zinc-900 dark:text-zinc-50 truncate text-sm min-w-0"
                title={task.title}
              >
                {task.title}
              </h3>
              <PriorityIcon priority={task.priority} size="md" />

              {task.isProtected && (
                <span title={t('taskCard.protectedBadge')}>
                  <Lock size={14} className="text-amber-500 dark:text-amber-400 shrink-0" />
                </span>
              )}

              {task.isRecurring && (
                <span title={t('taskCard.recurringBadge')}>
                  <Repeat size={14} className="text-indigo-500 dark:text-indigo-400 shrink-0" />
                </span>
              )}

              {task.sourceTaskId && (
                <span
                  className="text-zinc-500 dark:text-zinc-500 shrink-0"
                  title={t('taskCard.generatedFromRecurrenceBadge')}
                >
                  <History size={14} aria-hidden="true" />
                </span>
              )}
            </div>
          </div>

          {/* Subtask progress + meta badges
              NOTE: flex-wrap + min-w-0 で狭幅時にバッジを折返し、横スクロールを防ぐ */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 min-w-0">
            {/* Elapsed time for a running/waiting agent — the #1 operator blind
                spot: a spinner alone doesn't say whether an agent has been
                stuck for 30s or 30min. */}
            {tc.executionElapsed && (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">•</span>
                <span
                  className={`inline-flex items-center gap-0.5 shrink-0 font-medium ${
                    tc.isWaitingForInput
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-blue-600 dark:text-blue-400'
                  }`}
                  title={t('taskCard.elapsedTimeTooltip')}
                >
                  <Clock className="w-3 h-3" aria-hidden="true" />
                  {tc.executionElapsed}
                </span>
              </>
            )}
            {tc.localSubtasks.length > 0 && (
              <TaskCardSubtaskProgress
                subtasks={tc.localSubtasks}
                expanded={tc.expandedSubtasks}
                onToggle={() => tc.setExpandedSubtasks(!tc.expandedSubtasks)}
                label={t('subtasks')}
              />
            )}

            {/* 工数バッジ — サブタスク行と同じオレンジのピル (Clock + Xh)。 */}
            {task.estimatedHours != null && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300 shrink-0"
                title={t('compactTaskDetailCard.workloadLabel')}
              >
                <Clock className="w-2.5 h-2.5" aria-hidden="true" />
                {task.estimatedHours}h
              </span>
            )}

            {task.createdAt && (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">•</span>
                <span className="shrink-0">{formatDate(task.createdAt)}</span>
              </>
            )}

            {task.taskLabels && task.taskLabels.length > 0 ? (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">•</span>
                <span className="flex items-center gap-1 shrink-0 flex-wrap">
                  {task.taskLabels.slice(0, 3).map((tl) => {
                    if (!tl.label) return null;
                    const IconComponent = getIconComponent(tl.label.icon || '') || Tag;
                    return (
                      <span
                        key={tl.id}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium"
                        style={{
                          backgroundColor: `${tl.label.color}20`,
                          color: tl.label.color,
                        }}
                        title={tl.label.name}
                      >
                        <IconComponent className="w-2.5 h-2.5" />
                        {tl.label.name}
                      </span>
                    );
                  })}
                  {task.taskLabels.length > 3 && (
                    <span className="text-zinc-500 dark:text-zinc-400 text-[10px]">
                      +{task.taskLabels.length - 3}
                    </span>
                  )}
                </span>
              </>
            ) : hasLabels(task.labels) ? (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">•</span>
                <span className="inline-flex items-center gap-0.5 shrink-0">
                  <Tag className="w-3 h-3" />
                  {getLabelsArray(task.labels).length}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {/* Status change buttons
            NOTE: shrink-0 でタイトル列に侵食されないよう固定領域として確保 */}
        {!isSelectionMode && (
          <div
            className="flex items-center gap-1 pl-3 self-stretch shrink-0"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            {/* Blocked/failed recovery: one click returns the task to 'todo' so
                auto-run selection picks it up again — previously the only way
                out was manually editing the status. */}
            {isRetryable && (
              <button
                onClick={handleRetry}
                disabled={isRetrying}
                title={t('taskCard.retryTooltip')}
                aria-label={t('taskCard.retryAriaLabel')}
                className="w-7 h-7 rounded-md flex items-center justify-center text-rose-500 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-all duration-200 ease-out hover:scale-110 disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-4 h-4 ${isRetrying ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            )}
            {['todo', 'in-progress', 'done'].map((status) => {
              // NOTE: Amber override applied to in-progress button when task is waiting_for_input
              const baseConfig = getStatusDisplay(t, status);
              const config =
                tc.isWaitingForInput && status === 'in-progress'
                  ? { ...baseConfig, ...tc.waitingAmberConfig }
                  : baseConfig;
              return (
                <TaskStatusChange
                  key={status}
                  status={status}
                  currentStatus={task.status}
                  config={config}
                  renderIcon={renderStatusIcon}
                  onClick={(s: string) =>
                    onStatusChange(task.id, s as Status, tc.cardRef.current || undefined)
                  }
                  size="md"
                />
              );
            })}
            {onOpenInPage && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInPage(task.id);
                }}
                className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-all duration-200 ease-out hover:scale-110"
                aria-label={tHome('openInPage')}
              >
                <ExternalLink className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {tc.showContextMenu && (
        <TaskCardContextMenu
          menuRef={tc.contextMenuRef}
          position={tc.contextMenuPosition}
          onEdit={() => {
            onTaskClick(task.id);
            tc.setShowContextMenu(false);
          }}
          onDuplicate={tc.duplicateTask}
          onDelete={tc.deleteTask}
        />
      )}

      {/* Expanded subtask panel */}
      {tc.expandedSubtasks && tc.localSubtasks.length > 0 && (
        <TaskCardSubtaskPanel
          subtasks={tc.localSubtasks}
          onTaskUpdated={onTaskUpdated}
          onStatusChange={tc.handleSubtaskStatusChange}
        />
      )}
    </div>
  );
});

export default TaskCard;
