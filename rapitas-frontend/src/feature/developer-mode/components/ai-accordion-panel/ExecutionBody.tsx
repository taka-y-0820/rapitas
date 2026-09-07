'use client';
// ExecutionBody

import type { ExecutionLogStatus } from '../ExecutionLogViewer';
import { SubtaskLogTabs } from '../SubtaskLogTabs';
import { PhaseTimeline } from '../phase-timeline';
import type { Task } from '@/types';
import type { ParallelExecutionStatus } from '@/feature/tasks/components/status/SubtaskExecutionStatus';
import { ContinuationForm } from './ContinuationForm';
import { IdleExecutionForm } from './idle-execution-form';
import { AgentQuestionCard } from './agent-question-card';

export type ExecutionBodyProps = {
  /** Task ID — feeds the phase timeline's `GET /workflow/tasks/:taskId/phase-timeline` fetch. */
  taskId: number;
  isRunning: boolean;
  isCompleted: boolean;
  isCancelled: boolean;
  isFailed: boolean | string | null | undefined;
  isInterrupted: boolean | string | null | undefined;
  isExecuting: boolean;
  // Logs
  logs: string[];
  showLogs: boolean;
  logViewerStatus: ExecutionLogStatus;
  isSseConnected: boolean;
  executionError: string | null;
  pollingSessionMode?: string | null;
  // Question
  hasQuestion: boolean;
  question: string;
  questionDetails?: {
    options?: Array<{ label: string; description?: string }>;
    headers?: string[];
    multiSelect?: boolean;
    questions?: Array<{
      header?: string;
      question: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  } | null;
  userResponse: string;
  isSendingResponse: boolean;
  onSetUserResponse: (v: string) => void;
  onSendResponse: () => Promise<void>;
  // Subtask logs
  subtasks?: Task[];
  subtaskLogs?: Map<number, { logs: Array<{ timestamp: string; message: string; level: string }> }>;
  parallelSessionId?: string | null;
  hasSubtasks: boolean;
  getSubtaskStatus?: (subtaskId: number) => ParallelExecutionStatus | undefined;
  onRefreshSubtaskLogs?: (taskId?: number) => void;
  // Continuation
  continueInstruction: string;
  onSetContinueInstruction: (v: string) => void;
  onContinueExecution: () => Promise<void>;
  // Initial form
  optimizedPrompt?: string | null;
  instruction: string;
  branchName: string;
  baseBranch: string;
  baseBranches: string[];
  isGeneratingBranchName: boolean;
  onSetInstruction: (v: string) => void;
  onSetBranchName: (v: string) => void;
  onSetBaseBranch: (v: string) => void;
  onGenerateBranchName: () => Promise<void>;
};

/**
 * Renders the appropriate execution body based on current status.
 * The parent (ExecutionSection) is responsible for mounting this inside the expanded panel.
 *
 * @param props - Derived state and handlers from useExecutionManager.
 */
export function ExecutionBody({
  taskId,
  isRunning,
  isCompleted,
  isCancelled,
  isFailed,
  isInterrupted,
  isExecuting,
  logs,
  showLogs,
  logViewerStatus: _logViewerStatus,
  isSseConnected: _isSseConnected,
  executionError,
  pollingSessionMode: _pollingSessionMode,
  hasQuestion,
  question,
  questionDetails,
  userResponse,
  isSendingResponse,
  onSetUserResponse,
  onSendResponse,
  subtasks,
  subtaskLogs,
  parallelSessionId,
  hasSubtasks,
  getSubtaskStatus,
  onRefreshSubtaskLogs,
  continueInstruction,
  onSetContinueInstruction,
  onContinueExecution,
  optimizedPrompt,
  instruction,
  branchName,
  baseBranch,
  baseBranches,
  isGeneratingBranchName: _isGeneratingBranchName,
  onSetInstruction,
  onSetBranchName,
  onSetBaseBranch,
  onGenerateBranchName: _onGenerateBranchName,
}: ExecutionBodyProps) {
  const hasSubtaskLogs = !!(hasSubtasks && subtaskLogs && parallelSessionId);

  // Running state
  if (isRunning) {
    return (
      <div className="space-y-2">
        {hasQuestion && (
          <AgentQuestionCard
            question={question}
            questionDetails={questionDetails}
            userResponse={userResponse}
            isSendingResponse={isSendingResponse}
            onSetUserResponse={onSetUserResponse}
            onSendResponse={onSendResponse}
          />
        )}
        <div id="execution-logs">
          {hasSubtaskLogs ? (
            <SubtaskLogTabs
              subtasks={subtasks || []}
              getSubtaskStatus={getSubtaskStatus}
              subtaskLogs={subtaskLogs!}
              isRunning={isRunning}
              onRefreshLogs={onRefreshSubtaskLogs}
              maxHeight={300}
            />
          ) : (
            <PhaseTimeline taskId={taskId} isRunning={isRunning} liveLogs={logs} />
          )}
        </div>
      </div>
    );
  }

  // Completed state — status card removed, shown in ExecutionSection header badge
  if (isCompleted) {
    return (
      <div className="space-y-2">
        {hasSubtaskLogs ? (
          <SubtaskLogTabs
            subtasks={subtasks || []}
            getSubtaskStatus={getSubtaskStatus}
            subtaskLogs={subtaskLogs!}
            isRunning={false}
            onRefreshLogs={onRefreshSubtaskLogs}
            maxHeight={300}
          />
        ) : showLogs ? (
          <PhaseTimeline taskId={taskId} isRunning={false} liveLogs={logs} />
        ) : null}
        <ContinuationForm
          continueInstruction={continueInstruction}
          onSetContinueInstruction={onSetContinueInstruction}
          onContinueExecution={onContinueExecution}
          isExecuting={isExecuting}
        />
      </div>
    );
  }

  // Cancelled state — status shown in header badge
  if (isCancelled) {
    return showLogs ? <PhaseTimeline taskId={taskId} isRunning={false} liveLogs={logs} /> : null;
  }

  // Interrupted state — status shown in header badge
  if (isInterrupted) {
    return showLogs ? <PhaseTimeline taskId={taskId} isRunning={false} liveLogs={logs} /> : null;
  }

  // Failed state — error detail shown inline only if message exists
  if (isFailed) {
    return (
      <div className="space-y-2">
        {typeof executionError === 'string' && executionError && (
          <p className="text-[10px] text-red-600 dark:text-red-400 line-clamp-2 px-1">
            {executionError}
          </p>
        )}
        {showLogs && <PhaseTimeline taskId={taskId} isRunning={false} liveLogs={logs} />}
      </div>
    );
  }

  // Initial (idle) state — execution form
  return (
    <IdleExecutionForm
      optimizedPrompt={optimizedPrompt}
      instruction={instruction}
      branchName={branchName}
      baseBranch={baseBranch}
      baseBranches={baseBranches}
      onSetInstruction={onSetInstruction}
      onSetBranchName={onSetBranchName}
      onSetBaseBranch={onSetBaseBranch}
    />
  );
}
