'use client';
// WorkflowViewer

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { WorkflowFileType, WorkflowStatus } from '@/types';
import { API_BASE_URL } from '@/utils/api';
import { useExecutionStateStore } from '@/stores/execution-state-store';
import { type WorkflowMode } from './CompactWorkflowSelector';
import { useWorkflowViewer } from './useWorkflowViewer';
import { getWorkflowTabs } from './workflow-viewer-utils';
import {
  PlanApprovalBanner,
  NextPhaseButton,
  AdvanceErrorBanner,
  FetchErrorBanner,
} from './WorkflowBanners';
import { WorkflowTabBar } from './WorkflowTabBar';
import { WorkflowFileContent } from './WorkflowFileContent';
import { WorkflowQuestionPanel } from './WorkflowQuestionPanel';
import { IntakeQuestionFlow } from './IntakeQuestionFlow';
import { StructuredQuestionFlow } from './StructuredQuestionFlow';
import {
  splitIntakeQuestion,
  parseIntakeQuestions,
  parseOptionsBlock,
  stripOptionsBlock,
  type StructuredSelection,
} from './workflow-question-utils';
import { selectWorkflowTabs } from './workflow-tab-selection';

export interface WorkflowViewerProps {
  taskId: number;
  workflowStatus?: WorkflowStatus | null;
  workflowMode?: WorkflowMode | null;
  complexityScore?: number | null;
  workflowModeOverride?: boolean;
  /** Effective state — already OR'd with global UserSettings by the caller. */
  autoApprovePlan?: boolean;
  /** Where the effective ON state originates. Optional informational hint. */
  autoApprovePlanSource?: 'task' | 'global' | 'subtask-global';
  onPlanApprovalRequest?: () => void;
  onStatusChange?: (newStatus: WorkflowStatus) => void;
  onWorkflowModeChange?: (mode: WorkflowMode, isOverride: boolean) => void;
  showWorkflowMode?: boolean;
  className?: string;
  /**
   * Set when the phase-critic gate just archived research.md/plan.md and
   * rolled the status back a step (see TaskWorkflowSection's criticRejection
   * state). Lets the tab bar and empty-state read "regenerating" instead of
   * "not produced yet" for the affected tab, so the file's disappearance
   * doesn't look like data loss.
   */
  criticRejectionPhase?: 'research' | 'plan' | null;
  /**
   * Effective "skip the multi-phase workflow" state (task-level OR global —
   * see TaskWorkflowSection's effectiveWorkflowDisabled). The single-run agent
   * never produces research.md/plan.md/question.md in this mode (see
   * instruction-builder.ts's workflowDisabled branch), so those tabs are
   * hidden rather than showing a permanently-empty state.
   */
  workflowDisabled?: boolean;
}

export default function WorkflowViewer({
  taskId,
  workflowStatus,
  workflowMode = null,
  workflowModeOverride = false,
  onPlanApprovalRequest,
  onStatusChange,
  onWorkflowModeChange,
  autoApprovePlan = false,
  className = '',
  criticRejectionPhase = null,
  workflowDisabled = false,
}: WorkflowViewerProps) {
  const {
    activeTab,
    setActiveTab,
    files,
    isLoading,
    error,
    refetch,
    effectiveStatus,
    applyResolvedQuestionStatus,
    isAdvancing,
    advanceError,
    setAdvanceError,
    roles,
    isPolling,
    activeFile,
    tabStatus,
    handleAdvance,
  } = useWorkflowViewer({
    taskId,
    workflowStatus,
    workflowMode,
    onStatusChange,
    onWorkflowModeChange,
    workflowModeOverride,
  });

  const resolvedMode = workflowMode || 'comprehensive';
  const tWorkflow = useTranslations('workflow');
  const allWorkflowTabs = getWorkflowTabs(resolvedMode, tWorkflow);

  // Live agent question (published by the execution layer). Rendered in the Q&A
  // tab; the interactive prompt was relocated here from the execution log.
  const liveQuestion = useExecutionStateStore((s) => s.liveQuestions.get(taskId) ?? null);
  const markQuestionAnswered = useExecutionStateStore((s) => s.markQuestionAnswered);
  const [submittingAnswer, setSubmittingAnswer] = useState(false);

  // The Q&A tab is only worth showing when a question actually exists — agents
  // ask rarely, so a permanently-empty Q&A tab is noise. Surface it ONLY when
  // there is a live question, a saved question.md, or the workflow is paused
  // awaiting an answer. (Per user request: タブは質問があった際に表示する。)
  const hasPendingQuestion =
    !!liveQuestion || !!tabStatus.question || effectiveStatus === 'awaiting_question';
  const workflowTabs = selectWorkflowTabs(allWorkflowTabs, {
    workflowDisabled,
    hasPendingQuestion,
    tabHasContent: tabStatus,
  });

  // Number badged on the Q&A tab: structured `json:options` question count when
  // present, else parsed 質問N count for a legacy intake question.md, else 1 for
  // a live/legacy single question. Lets the user see at a glance how many
  // questions await without opening the tab.
  const parsedQuestionCount = files?.question?.content
    ? (parseOptionsBlock(files.question.content)?.questions.length ??
      parseIntakeQuestions(files.question.content).questions.length)
    : 0;
  const qaBadgeCount = liveQuestion
    ? 1
    : parsedQuestionCount > 0
      ? parsedQuestionCount
      : tabStatus.question
        ? 1
        : 0;

  // Fallback to first tab if activeTab doesn't exist in current mode
  const validActiveTab = workflowTabs.some((t) => t.id === activeTab)
    ? activeTab
    : (workflowTabs[0]?.id ?? ('research' as WorkflowFileType));

  useEffect(() => {
    if (validActiveTab !== activeTab) {
      setActiveTab(validActiveTab);
    }
  }, [validActiveTab, activeTab, setActiveTab]);

  const activeTabConfig = workflowTabs.find((t) => t.id === validActiveTab)!;
  const hasQAtab = workflowTabs.some((t) => t.id === 'question');

  // Auto-switch to the Q&A tab ONCE when a question first appears (live OR a
  // paused intake question.md), so the user notices it without losing manual
  // control afterwards.
  const announcedQuestionRef = useRef(false);
  useEffect(() => {
    if (hasPendingQuestion && hasQAtab && !announcedQuestionRef.current) {
      announcedQuestionRef.current = true;
      setActiveTab('question');
    }
    if (!hasPendingQuestion) announcedQuestionRef.current = false;
  }, [hasPendingQuestion, hasQAtab, setActiveTab]);

  /** POST the answer to the agent, then optimistically clear the live question. */
  const handleAnswerQuestion = async (answer: string) => {
    setSubmittingAnswer(true);
    try {
      const res = await fetch(`${API_BASE_URL}/tasks/${taskId}/agent-respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: answer }),
      });
      if (res.ok) markQuestionAnswered(taskId);
    } catch {
      /* leave the question visible so the user can retry */
    } finally {
      setSubmittingAnswer(false);
    }
  };

  /**
   * POST an answer to a workflow QUESTION FILE (the intake gate's question.md,
   * or any other kind-based pause — see workflow-handlers-resume-dispatch.ts).
   * The backend resolves the recorded kind (spec_change/execution_continuation/
   * completion_confirmation) and returns the confirmed `toStatus` it applied;
   * this is read and applied immediately (task 902 AC3) via
   * `applyResolvedQuestionStatus` (pins `effectiveStatus`, sidestepping any
   * stale `workflowStatus` prop) and `onStatusChange` (propagates the same
   * value to the parent so the prop itself catches up), alongside the normal
   * `refetch()` so the resolved question.md (archived only for spec_change)
   * disappears. `selections` is the optional audit payload from a structured
   * `json:options` question (see StructuredQuestionFlow) — omitted for legacy
   * intake/free-text answers, which existing callers pass as a single string.
   */
  const handleAnswerIntakeQuestion = async (answer: string, selections?: StructuredSelection[]) => {
    setSubmittingAnswer(true);
    try {
      const res = await fetch(`${API_BASE_URL}/workflow/tasks/${taskId}/answer-question`, {
        method: 'POST',
        // A spec answer is a decision only a person may make: the backend
        // rejects this call without the source header so an agent cannot answer
        // its own question through a shell curl (task 662).
        headers: { 'Content-Type': 'application/json', 'X-Rapitas-Source': 'ui' },
        body: JSON.stringify(selections ? { answer, selections } : { answer }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { toStatus?: WorkflowStatus } | null;
        if (data?.toStatus) {
          applyResolvedQuestionStatus(data.toStatus);
          onStatusChange?.(data.toStatus);
        }
        refetch();
      }
    } catch {
      /* leave the question visible so the user can retry */
    } finally {
      setSubmittingAnswer(false);
    }
  };

  // Show the approval banner/button during plan_created — UNLESS auto-approve is
  // effective, in which case the plan is approved automatically and no manual
  // approval prompt should appear.
  const isPlanAwaitingApproval =
    tabStatus.plan &&
    effectiveStatus === 'plan_created' &&
    !!onPlanApprovalRequest &&
    !autoApprovePlan;

  // Approval button within plan tab
  const showApprovalButton = activeTab === 'plan' && isPlanAwaitingApproval;

  return (
    <div className={className}>
      {/* NOTE: The workflow file path (e.g. tasks/1/17) is intentionally not
          shown — it is an internal reference only. workflowPath is still
          provided by useWorkflowViewer for internal use. */}

      {/* Approval pending banner (always shown during plan_created) */}
      {isPlanAwaitingApproval && onPlanApprovalRequest && (
        <PlanApprovalBanner
          onNavigateToPlan={() => setActiveTab('plan')}
          onPlanApprovalRequest={onPlanApprovalRequest}
        />
      )}

      {/* NOTE: Both the "検証結果を確認" banner and the in-content "実装完了"
          fallback were removed. Verification auto-completes the task on success
          (verify handler in workflow-handlers-files.ts); on failure it is flagged
          for re-verification. Force-completing a verify_done task bypassed the
          completion/verification gate and skipped commit/PR, so it is gone. */}

      {/* Next phase execution button */}
      {effectiveStatus &&
        effectiveStatus !== 'completed' &&
        effectiveStatus !== 'plan_created' &&
        !isPolling && (
          <NextPhaseButton
            effectiveStatus={effectiveStatus}
            workflowMode={resolvedMode as WorkflowMode}
            roles={roles}
            isAdvancing={isAdvancing}
            onAdvance={handleAdvance}
          />
        )}

      {/* Execution error display */}
      {advanceError && (
        <AdvanceErrorBanner error={advanceError} onDismiss={() => setAdvanceError(null)} />
      )}

      {/* Fetch error display */}
      {error && <FetchErrorBanner error={error} isLoading={isLoading} onRefetch={refetch} />}

      {/* Tab header */}
      <WorkflowTabBar
        tabs={workflowTabs}
        activeTab={validActiveTab}
        tabStatus={tabStatus}
        effectiveStatus={effectiveStatus}
        questionCount={qaBadgeCount}
        onTabChange={setActiveTab}
        lastModified={activeFile?.exists ? activeFile.lastModified : undefined}
        onRefetch={refetch}
        isRefetching={isLoading}
        regeneratingTab={criticRejectionPhase}
        taskId={taskId}
      />

      {/* Content area */}
      <div className="p-5">
        {(() => {
          // An intake / spec-clarification question.md is answerable here even
          // though there is no live agent session (the panel was previously
          // live-question-only). When EITHER kind of question panel renders, the
          // question text is already shown in the panel, so the raw question.md
          // file body is NOT re-rendered below (it duplicated the panel).
          const showingIntakeQuestion =
            validActiveTab === 'question' &&
            !liveQuestion &&
            tabStatus.question &&
            effectiveStatus !== 'completed' &&
            !!activeFile?.content;
          const showingQuestionPanel =
            validActiveTab === 'question' && (!!liveQuestion || showingIntakeQuestion);
          return (
            <>
              {validActiveTab === 'question' && liveQuestion && (
                <div className="mb-4">
                  <WorkflowQuestionPanel
                    question={liveQuestion}
                    submitting={submittingAnswer}
                    onAnswer={handleAnswerQuestion}
                  />
                </div>
              )}
              {showingIntakeQuestion &&
                (() => {
                  const content = activeFile?.content ?? '';
                  // Machine-readable `json:options` questions take priority — see
                  // plan.md's "パーサのフォールバック契約". Only a successfully
                  // parsed, non-empty block short-circuits to the new UI; a
                  // missing or malformed block falls through to the legacy chain
                  // below so a bad agent output never blanks the Q&A tab.
                  const structuredBlock = parseOptionsBlock(content);
                  if (structuredBlock) {
                    return (
                      <div className="mb-4">
                        <StructuredQuestionFlow
                          questions={structuredBlock.questions}
                          submitting={submittingAnswer}
                          onSubmitAll={handleAnswerIntakeQuestion}
                          // Prose context (headings/tables) around the options
                          // block would otherwise be dropped entirely.
                          body={stripOptionsBlock(content)}
                        />
                      </div>
                    );
                  }
                  // 1問1答: parse the `## 質問N` blocks and present them one at a
                  // time. Legacy single-question files (no 質問 blocks) fall back to
                  // the single panel with its `### 選択肢`.
                  const { intro, questions } = parseIntakeQuestions(content);
                  if (questions.length > 0) {
                    return (
                      <div className="mb-4">
                        <IntakeQuestionFlow
                          intro={intro}
                          questions={questions}
                          submitting={submittingAnswer}
                          onSubmitAll={handleAnswerIntakeQuestion}
                        />
                      </div>
                    );
                  }
                  const { text, options } = splitIntakeQuestion(content);
                  return (
                    <div className="mb-4">
                      <WorkflowQuestionPanel
                        question={{ taskId, text, options }}
                        submitting={submittingAnswer}
                        onAnswer={handleAnswerIntakeQuestion}
                        freeTextOnly={options.length === 0}
                      />
                    </div>
                  );
                })()}
              {!showingQuestionPanel && (
                <WorkflowFileContent
                  isLoading={isLoading}
                  activeFile={activeFile}
                  activeTabConfig={activeTabConfig ?? workflowTabs[0]}
                  showApprovalButton={!!showApprovalButton}
                  onPlanApprovalRequest={onPlanApprovalRequest}
                  isRegenerating={criticRejectionPhase === validActiveTab}
                />
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}
