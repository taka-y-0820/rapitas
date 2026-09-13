'use client';
// TaskDetailClient — orchestrates the task detail page.
import { useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { usePomodoro } from '@/feature/tasks/pomodoro/PomodoroProvider';
import TaskDetailSkeleton from '@/components/ui/skeleton/TaskDetailSkeleton';
import { useExecutionStateStore } from '@/stores/execution-state-store';
import { useWorkflowFiles } from '@/hooks/workflow/useWorkflowFiles';
import { createLogger } from '@/lib/logger';
import { API_BASE_URL } from '@/utils/api';

// Extracted hooks
import { useTaskActions } from './hooks/useTaskActions';
import { useCommentSystem } from './hooks/useCommentSystem';
import { useTaskDetailData } from './hooks/useTaskDetailData';
import { useWorkflowHandlers } from './hooks/useWorkflowHandlers';
import { useAutoExecute } from './hooks/useAutoExecute';
import { useAnalysisHandlers } from './hooks/useAnalysisHandlers';
import { useDeveloperModeEffects } from './hooks/useDeveloperModeEffects';
import { useDeveloperModeSetup } from './hooks/useDeveloperModeSetup';

// Extracted components
import TaskDetailErrorState from './components/TaskDetailErrorState';
import TaskDetailContent from './components/TaskDetailContent';
import type { TaskDetailViewBodyProps } from './components/TaskDetailViewBody';
import { useTaskTerminalContext } from '@/feature/terminal';

const logger = createLogger('TaskDetailClient');

interface TaskDetailClientProps {
  taskId?: number;
  onTaskUpdated?: () => void;
  onClose?: () => void;
}

function TaskDetailClient({ taskId: propTaskId, onTaskUpdated }: TaskDetailClientProps) {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  // NOTE: In split view (?note=xxx), the right pane (TaskNoteSplitView) owns
  // the scroll container. Enabling isPageMode here would add a second
  // overflow-auto + fixed height, causing a double scrollbar.
  const isPageMode = searchParams.get('showHeader') === 'true' && !searchParams.get('note');

  // NOTE: useParams() may not work in Tauri iframes,
  // so we fall back to extracting the ID from window.location.
  const getTaskIdFromUrl = (): string | null => {
    if (typeof window === 'undefined') return null;
    const match = window.location.pathname.match(/\/tasks\/(\d+)/);
    return match ? match[1] : null;
  };

  // Priority: propTaskId > params.id > URL extraction
  const resolvedTaskId =
    propTaskId?.toString() || (params?.id as string | undefined) || getTaskIdFromUrl();

  logger.debug('[TaskDetailClient] resolvedTaskId:', resolvedTaskId);

  const taskId = resolvedTaskId ? parseInt(resolvedTaskId) : 0;

  // Point the integrated terminal at this task's directory while detail is open.
  useTaskTerminalContext(taskId);

  // ─── Data fetching ────────────────────────────────────────────────────────
  const {
    task,
    setTask,
    loading,
    showSkeleton,
    error,
    comments,
    setComments,
    resources,
    setResources,
    globalSettings,
    cliAvailability,
    setShowAIAssistant,
    refreshTask,
  } = useTaskDetailData({ resolvedTaskId });

  // ─── Pomodoro ────────────────────────────────────────────────────────────
  const { state: pomodoroState, stopTimer } = usePomodoro();
  const isThisTaskTimer = pomodoroState.taskId === task?.id;

  // ─── Developer mode ───────────────────────────────────────────────────────
  const [showDevModeConfig, setShowDevModeConfig] = useState(false);
  const [showSaveTemplateDialog, setShowSaveTemplateDialog] = useState(false);
  const {
    devModeConfig,
    devModeLoading,
    isAnalyzing,
    isExecuting,
    executionStatus,
    executionResult,
    analysisResult,
    analysisApprovalId,
    analysisError,
    fetchDevModeConfig,
    enableDeveloperMode,
    updateDevModeConfig,
    analyzeTask,
    setAnalysisResult,
    executeAgent,
    resetExecutionState,
    restoreExecutionState,
    approveSubtaskCreation,
    setExecutionCancelled,
    isRestoringState,
    agentConfigId,
    setAgentConfigId,
    agents,
    fetchAgents,
    approveRequest,
    rejectRequest,
    approvalLoading,
  } = useDeveloperModeSetup(taskId);

  // ─── Workflow ─────────────────────────────────────────────────────────────
  const {
    files: workflowFiles,
    workflowStatus,
    isLoading: isWorkflowLoading,
    error: workflowError,
    refetch: refetchWorkflowFiles,
  } = useWorkflowFiles(taskId || null);

  const {
    currentWorkflowStatus,
    setCurrentWorkflowStatus,
    showPlanApprovalModal,
    closePlanApprovalModal,
    handlePlanApprovalRequest,
    handleApprovalComplete,
  } = useWorkflowHandlers({
    taskId,
    workflowStatus,
    taskWorkflowStatus: task?.workflowStatus ?? null,
    refetchWorkflowFiles,
    restoreExecutionState,
    onTaskUpdated,
  });

  // ─── Parallel execution (deprecated — kept as no-op for prop compat) ──────
  // The parallel-execution mechanism was removed; sub-tasks now flow through
  // the standard workflow advance path. These constants exist only so the
  // shared TaskAISection prop shape doesn't have to change in lockstep.
  const parallelSessionId: string | null = null;
  const isParallelExecutionRunning = false;
  const getSubtaskStatus = (_id: number) => undefined;
  // Run (or re-run) the subtasks of a split parent. The execute button routes
  // here whenever the task has subtasks (see useExecutionManager.handleExecute).
  // This used to be a no-op stub, so pressing 実行 on a split task did nothing —
  // the cause of "リセット後に実行できない".
  const startSession = async () => {
    if (!taskId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/workflow/orchestra/run-subtasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!res.ok) {
        logger.error('Failed to start subtask execution:', res.status);
        return;
      }
      // Pick up the parent's in_progress transition and subtask status changes.
      refreshTask();
      refetchWorkflowFiles();
    } catch (error) {
      logger.error('Error starting subtask execution:', error);
    }
  };
  const subtaskLogs:
    | Map<number, { logs: Array<{ timestamp: string; message: string; level: string }> }>
    | undefined = undefined;
  const refreshSubtaskLogs = (_id?: number) => {};

  const { isTaskExecuting } = useExecutionStateStore();
  const isTaskExecutingInStore = isTaskExecuting(taskId);

  // ─── Task actions / comment system ────────────────────────────────────────
  const [newComment, setNewComment] = useState('');
  const [isAddingComment, setIsAddingComment] = useState(false);
  const [, setShowCompleteOverlay] = useState(false);

  const taskActions = useTaskActions({
    task,
    resolvedTaskId,
    setTask,
    onTaskUpdated,
    isThisTaskTimer,
    pomodoroState,
    stopTimer,
    setShowCompleteOverlay,
  });

  const commentSystem = useCommentSystem({
    resolvedTaskId,
    comments,
    setComments,
    newComment,
    setNewComment,
    setIsAddingComment,
  });

  // ─── Side effects ─────────────────────────────────────────────────────────
  useDeveloperModeEffects({
    resolvedTaskId,
    taskId,
    task,
    globalSettings,
    devModeConfig,
    devModeLoading,
    isExecuting,
    executionResult,
    isParallelExecutionRunning,
    parallelSessionId,
    isTaskExecutingInStore,
    fetchDevModeConfig,
    fetchAgents,
    enableDeveloperMode,
    setShowAIAssistant,
  });

  useAutoExecute({
    task,
    loading,
    isExecuting,
    taskId,
    searchParams,
    executeAgent,
    setShowAIAssistant,
    setTask,
  });

  // ─── Analysis handlers ────────────────────────────────────────────────────
  const {
    optimizedPrompt,
    setOptimizedPrompt,
    handleAnalyze,
    handleApproveAnalysis,
    handleRejectAnalysis,
  } = useAnalysisHandlers({
    resolvedTaskId,
    setTask,
    analyzeTask,
    setAnalysisResult,
    approveRequest,
    rejectRequest,
  });

  // ─── Render guards ────────────────────────────────────────────────────────
  if (loading || showSkeleton) {
    return <TaskDetailSkeleton />;
  }

  if (error || !task) {
    return <TaskDetailErrorState error={error} onBackToHome={() => router.push('/')} />;
  }

  // NOTE: The AI agent execution accordion is always rendered for every task.
  // Inside, TaskAISection shows a capability-aware body that tells the user
  // what to set up (theme / workingDirectory / API key) when the task can't
  // actually execute. The old gate hid the UI behind isDevelopment + activity
  // flags, which made the feature invisible on fresh tasks.
  const showAIPanel = true;

  // ─── Render ───────────────────────────────────────────────────────────────
  const aiSectionProps = {
    globalSettings,
    cliAvailability,
    devModeConfig,
    isAnalyzing,
    analysisResult,
    analysisError,
    analysisApprovalId,
    isExecuting,
    executionStatus,
    executionResult,
    isParallelExecutionRunning,
    parallelSessionId,
    isApproving: approvalLoading,
    optimizedPrompt,
    resources,
    agentConfigId,
    agents,
    subtaskLogs,
    onOpenSettings: () => setShowDevModeConfig(true),
    onAnalyze: handleAnalyze,
    onApprove: handleApproveAnalysis,
    onReject: handleRejectAnalysis,
    onApproveSubtasks: approveSubtaskCreation,
    onPromptGenerated: setOptimizedPrompt,
    onAgentChange: setAgentConfigId,
    onExecute: async (options?: unknown) => {
      const result = await executeAgent(options);
      return result as { sessionId?: number; message?: string } | null;
    },
    onReset: resetExecutionState,
    onRestoreExecutionState: restoreExecutionState,
    onStopExecution: setExecutionCancelled,
    onStartParallelExecution: startSession,
    getSubtaskStatus,
    onRefreshSubtaskLogs: refreshSubtaskLogs,
    setTask,
    refetchWorkflowFiles,
    onTaskUpdated,
    startSession,
    isRestoringState,
  };

  const viewBodyProps: Omit<
    TaskDetailViewBodyProps,
    'task' | 'taskId' | 'resolvedTaskId' | 'taskActions'
  > = {
    resources,
    setResources,
    comments,
    newComment,
    isAddingComment,
    setNewComment,
    commentSystem,
    refreshTask,
    showAIPanel,
    aiSectionProps,
    currentWorkflowStatus,
    setCurrentWorkflowStatus,
    isWorkflowLoading,
    workflowError,
    onPlanApprovalRequest: handlePlanApprovalRequest,
    onTaskUpdated,
    setTask,
    isParallelExecutionRunning,
    getSubtaskStatus,
  };

  return (
    <TaskDetailContent
      task={task}
      taskId={taskId}
      resolvedTaskId={resolvedTaskId!}
      showSkeleton={showSkeleton}
      isPageMode={isPageMode}
      isThisTaskTimer={isThisTaskTimer}
      pomodoroState={pomodoroState}
      showDevModeConfig={showDevModeConfig}
      setShowDevModeConfig={setShowDevModeConfig}
      showSaveTemplateDialog={showSaveTemplateDialog}
      setShowSaveTemplateDialog={setShowSaveTemplateDialog}
      showPlanApprovalModal={showPlanApprovalModal}
      onClosePlanApprovalModal={closePlanApprovalModal}
      devModeConfig={devModeConfig}
      updateDevModeConfig={updateDevModeConfig}
      agentConfigId={agentConfigId}
      setAgentConfigId={setAgentConfigId}
      planFile={workflowFiles?.plan || null}
      onApprovalComplete={handleApprovalComplete}
      onBack={() => router.back()}
      taskActions={taskActions}
      viewBodyProps={viewBodyProps}
    />
  );
}

// NOTE: requireAuth HOC wrapper removed because Turbopack cannot statically
// analyze `export default HOC(Component)` or even `const X = HOC(C); export default X`.
// Auth check is handled by the page.tsx or AuthProvider instead.
export default TaskDetailClient;
