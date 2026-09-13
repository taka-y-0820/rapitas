/**
 * WorkflowViewer.test
 *
 * Task 902 (AC3): verifies handleAnswerIntakeQuestion reads the
 * answer-question response's `toStatus` and applies it immediately via
 * applyResolvedQuestionStatus + onStatusChange, for all three kinds
 * (spec_change→draft, execution_continuation→in_progress,
 * completion_confirmation→verify_done). useWorkflowViewer itself is mocked
 * (its own pin-mechanism behavior is covered by useWorkflowViewer.test.ts) —
 * this test covers only WorkflowViewer's own response-reading logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WorkflowViewer from './WorkflowViewer';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock('lucide-react', async (importOriginal) => {
  const { buildLucideMock } = await import('@/__tests__/helpers/lucide-react-mock');
  return buildLucideMock(importOriginal);
});

vi.mock('@/utils/api', () => ({ API_BASE_URL: 'http://test:3001' }));

const mockRefetch = vi.fn();
const mockApplyResolvedQuestionStatus = vi.fn();
const mockSetActiveTab = vi.fn();

function makeFiles(questionContent: string) {
  return {
    research: { exists: false, content: null, lastModified: null },
    plan: { exists: false, content: null, lastModified: null },
    question: { exists: true, content: questionContent, lastModified: null },
    verify: { exists: false, content: null, lastModified: null },
  };
}

vi.mock('./useWorkflowViewer', () => ({
  useWorkflowViewer: vi.fn(),
}));

import { useWorkflowViewer } from './useWorkflowViewer';

function armHook(effectiveStatus: string, questionContent: string) {
  vi.mocked(useWorkflowViewer).mockReturnValue({
    activeTab: 'question',
    setActiveTab: mockSetActiveTab,
    files: makeFiles(questionContent),
    isLoading: false,
    error: null,
    refetch: mockRefetch,
    workflowPath: null,
    effectiveStatus: effectiveStatus as never,
    applyResolvedQuestionStatus: mockApplyResolvedQuestionStatus,
    isAdvancing: false,
    advanceError: null,
    setAdvanceError: vi.fn(),
    roles: [],
    autoComplexityAnalysis: false,
    isPolling: false,
    activeFile: { exists: true, content: questionContent, lastModified: null },
    tabStatus: { research: false, question: true, plan: false, verify: false },
    handleAdvance: vi.fn(),
    handleAnalysisComplete: vi.fn(),
  } as never);
}

const QUESTION_MD = '# 質問\n続けてよいですか？';

describe('WorkflowViewer — handleAnswerIntakeQuestion applies the resolved toStatus (task 902 AC3)', () => {
  beforeEach(() => {
    mockRefetch.mockClear();
    mockApplyResolvedQuestionStatus.mockClear();
    mockSetActiveTab.mockClear();
  });

  it.each([
    ['spec_change', 'draft'],
    ['execution_continuation', 'in_progress'],
    ['completion_confirmation', 'verify_done'],
  ] as const)(
    '%s answer: onStatusChange and applyResolvedQuestionStatus are called with toStatus=%s',
    async (resolvedKind, toStatus) => {
      armHook('awaiting_question', QUESTION_MD);
      const onStatusChange = vi.fn();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ taskId: 1, ok: true, toStatus, resolvedKind }),
        }),
      );

      render(
        <WorkflowViewer
          taskId={1}
          workflowStatus="awaiting_question"
          onStatusChange={onStatusChange}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText('questionPanel.freeTextPlaceholder'), {
        target: { value: '承認します' },
      });
      fireEvent.click(screen.getByText('questionPanel.submitAndResume'));

      await waitFor(() => expect(mockApplyResolvedQuestionStatus).toHaveBeenCalledWith(toStatus));
      expect(onStatusChange).toHaveBeenCalledWith(toStatus);
      expect(mockRefetch).toHaveBeenCalled();

      vi.unstubAllGlobals();
    },
  );

  it('does not apply a status when the response has no toStatus field (defensive)', async () => {
    armHook('awaiting_question', QUESTION_MD);
    const onStatusChange = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    );

    render(
      <WorkflowViewer
        taskId={1}
        workflowStatus="awaiting_question"
        onStatusChange={onStatusChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('questionPanel.freeTextPlaceholder'), {
      target: { value: '承認します' },
    });
    fireEvent.click(screen.getByText('questionPanel.submitAndResume'));

    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
    expect(mockApplyResolvedQuestionStatus).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not apply a status when the fetch itself fails (leaves the question visible for retry)', async () => {
    armHook('awaiting_question', QUESTION_MD);
    const onStatusChange = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    render(
      <WorkflowViewer
        taskId={1}
        workflowStatus="awaiting_question"
        onStatusChange={onStatusChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('questionPanel.freeTextPlaceholder'), {
      target: { value: '承認します' },
    });
    fireEvent.click(screen.getByText('questionPanel.submitAndResume'));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(mockApplyResolvedQuestionStatus).not.toHaveBeenCalled();
    expect(mockRefetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('WorkflowViewer — answered question no longer renders the answer form', () => {
  beforeEach(() => {
    mockRefetch.mockClear();
    mockApplyResolvedQuestionStatus.mockClear();
    mockSetActiveTab.mockClear();
  });

  it('renders the form while paused on the question', () => {
    armHook('awaiting_question', QUESTION_MD);
    render(<WorkflowViewer taskId={1} workflowStatus="awaiting_question" />);
    expect(screen.getByText('questionPanel.title')).toBeInTheDocument();
    expect(mockSetActiveTab).toHaveBeenCalledWith('question');
  });

  it('hides the form once the workflow resumed even though question.md still exists', () => {
    // execution_continuation / completion_confirmation answers append to
    // question.md and resume without archiving the file.
    armHook('in_progress', QUESTION_MD + '\n\n## 回答\n続けてください');
    render(<WorkflowViewer taskId={1} workflowStatus="in_progress" />);
    expect(screen.queryByText('questionPanel.title')).toBeNull();
    expect(screen.queryByText('questionPanel.submitAndResume')).toBeNull();
    // The tab is not auto-selected for a historical question.
    expect(mockSetActiveTab).not.toHaveBeenCalledWith('question');
  });
});
