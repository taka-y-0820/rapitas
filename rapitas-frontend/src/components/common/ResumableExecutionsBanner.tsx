'use client';
// ResumableExecutionsBanner

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bot, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTaskDetailVisibilityStore } from '@/stores/task-detail-visibility-store';
import { useServerRestartStore } from '@/stores/server-restart-store';
import { useResumableExecutions } from '../resumable-executions/useResumableExecutions';
import { ExecutionItem } from '../resumable-executions/ExecutionItem';
import { QuickActions } from '../resumable-executions/QuickActions';

export function ResumableExecutionsBanner() {
  const t = useTranslations('banner');
  const pathname = usePathname();
  const [isExpanded, setIsExpanded] = useState(false);

  const isTaskDetailVisible = useTaskDetailVisibilityStore((state) => state.isTaskDetailVisible);
  const isServerRestarting = useServerRestartStore((state) => state.isRestarting);

  const {
    executions,
    isLoading,
    isDismissed,
    resumingIds,
    dismissingIds,
    connectionError,
    isConnected,
    isIntentionalRestart,
    runningCount,
    interruptedCount,
    setConnectionError,
    fetchResumableExecutions,
    handleResume,
    handleDismiss,
    handleDismissAll,
    handleResumeAll,
    formatTimeAgo,
  } = useResumableExecutions();

  // Detect task detail page (/tasks/[id] pattern)
  const isTaskDetailPage = /^\/tasks\/\d+/.test(pathname);

  if (isLoading || isDismissed || isTaskDetailPage || isTaskDetailVisible) {
    return null;
  }

  // Connection error state (suppress during intentional backend restart)
  if (connectionError && !isConnected) {
    if (isIntentionalRestart || isServerRestarting) return null;

    return (
      <div className="fixed bottom-6 right-6 z-[60] max-w-sm w-full animate-in slide-in-from-right-4 duration-300">
        <div className="border rounded-2xl shadow-xl overflow-hidden bg-red-50 dark:bg-red-950/95 border-red-200/80 dark:border-red-700/60">
          <div className="px-4 py-3.5">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-red-500 shadow-lg">
                <X className="w-4 h-4 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-sm text-red-900 dark:text-red-100">
                  {t('connectionError')}
                </h3>
                <p className="text-xs text-red-600 dark:text-red-400">{t('backendUnreachable')}</p>
              </div>
              <button
                onClick={() => {
                  setConnectionError(null);
                  fetchResumableExecutions();
                }}
                className="p-1.5 rounded-lg hover:bg-red-200/60 dark:hover:bg-red-800/40"
              >
                <RotateCcw className="w-4 h-4 text-red-600 dark:text-red-400" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // A stale `connectionError` while the backend IS connected (a single
  // resumable-executions probe timed out or returned 503 during warm-up) used
  // to fall through here and paint the "中断された作業" card with a count of 0.
  // With nothing to show there is nothing to render, whatever the error state.
  if (executions.length === 0) return null;

  const hasRunning = runningCount > 0;

  const bannerBg = hasRunning
    ? 'bg-linear-to-br from-blue-50 to-blue-50 dark:from-blue-950/95 dark:to-blue-950/95 border-blue-200/80 dark:border-blue-700/60 shadow-blue-500/10 dark:shadow-blue-900/20'
    : 'bg-linear-to-br from-amber-50 to-orange-50 dark:from-amber-950/95 dark:to-orange-950/95 border-amber-200/80 dark:border-amber-700/60 shadow-amber-500/10 dark:shadow-amber-900/20';

  const headerHoverBg = hasRunning
    ? 'hover:bg-blue-100/50 dark:hover:bg-blue-900/30'
    : 'hover:bg-amber-100/50 dark:hover:bg-amber-900/30';

  const iconBg = hasRunning
    ? 'bg-linear-to-br from-blue-400 to-blue-500 shadow-blue-500/30'
    : 'bg-linear-to-br from-amber-400 to-orange-500 shadow-amber-500/30';

  const pingColor = hasRunning ? 'bg-blue-400' : 'bg-amber-400';
  const badgeColor = hasRunning ? 'bg-blue-500' : 'bg-amber-500';

  const titleColor = hasRunning
    ? 'text-blue-900 dark:text-blue-100'
    : 'text-amber-900 dark:text-amber-100';

  const subtitleColor = hasRunning
    ? 'text-blue-600 dark:text-blue-400/80'
    : 'text-amber-600 dark:text-amber-400/80';

  const closeIconColor = hasRunning
    ? 'text-blue-600 dark:text-blue-400'
    : 'text-amber-600 dark:text-amber-400';

  const closeBtnHover = hasRunning
    ? 'hover:bg-blue-200/60 dark:hover:bg-blue-800/40'
    : 'hover:bg-amber-200/60 dark:hover:bg-amber-800/40';

  return (
    // bottom-6: the former bottom-20 reserved space for the floating AI icon,
    // which no longer exists.
    <div className="fixed bottom-6 right-6 z-[60] max-w-sm w-full animate-in slide-in-from-right-4 duration-300">
      <div className={`border rounded-2xl shadow-xl ${bannerBg}`}>
        {/* Collapsible header */}
        <div
          className={`px-4 py-3.5 flex items-center justify-between cursor-pointer transition-colors ${headerHoverBg}`}
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className={`p-2 rounded-xl shadow-lg ${iconBg}`}>
                {hasRunning ? (
                  <Bot className="w-4 h-4 text-white" />
                ) : (
                  <RotateCcw className="w-4 h-4 text-white" />
                )}
              </div>
              {/* Animated count badge */}
              <span className="absolute -top-1 -right-1 flex h-4 w-4">
                <span
                  className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pingColor}`}
                />
                <span
                  className={`relative inline-flex rounded-full h-4 w-4 text-[10px] font-bold text-white items-center justify-center ${badgeColor}`}
                >
                  {executions.length}
                </span>
              </span>
            </div>

            <div>
              <h3 className={`font-semibold text-sm ${titleColor}`}>
                {hasRunning ? t('inProgressWork') : t('interruptedWork')}
              </h3>
              <p className={`text-xs ${subtitleColor}`}>
                {runningCount > 0 && t('runningCount', { count: runningCount })}
                {runningCount > 0 && interruptedCount > 0 && ' / '}
                {interruptedCount > 0 && t('resumableCount', { count: interruptedCount })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDismissAll();
              }}
              className={`p-1.5 rounded-lg transition-colors ${closeBtnHover}`}
              title={t('closeAll')}
            >
              <X className={`w-4 h-4 ${closeIconColor}`} />
            </button>
            <div className="p-1.5">
              {isExpanded ? (
                <ChevronDown className={`w-4 h-4 ${closeIconColor}`} />
              ) : (
                <ChevronUp className={`w-4 h-4 ${closeIconColor}`} />
              )}
            </div>
          </div>
        </div>

        {/* Expanded list */}
        {isExpanded && (
          <div className="px-3 pb-3 space-y-2 max-h-72 overflow-y-auto">
            {executions.map((exec) => (
              <ExecutionItem
                key={exec.id}
                exec={exec}
                isResuming={resumingIds.has(exec.id)}
                isDismissing={dismissingIds.has(exec.id)}
                onResume={handleResume}
                onDismiss={handleDismiss}
                formatTimeAgo={formatTimeAgo}
              />
            ))}
          </div>
        )}

        {/* Collapsed quick actions */}
        {!isExpanded && executions.length > 0 && (
          <QuickActions
            executions={executions}
            resumingIds={resumingIds}
            hasRunning={hasRunning}
            runningCount={runningCount}
            interruptedCount={interruptedCount}
            onResume={handleResume}
            onResumeAll={handleResumeAll}
            onExpand={() => setIsExpanded(true)}
            formatTimeAgo={formatTimeAgo}
          />
        )}
      </div>
    </div>
  );
}
