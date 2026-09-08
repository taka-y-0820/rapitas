import { render, screen } from '@testing-library/react';
import { ExecutionBody, type ExecutionBodyProps } from './ExecutionBody';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('./ContinuationForm', () => ({ ContinuationForm: () => null }));
vi.mock('./idle-execution-form', () => ({ IdleExecutionForm: () => null }));
vi.mock('@/utils/api', () => ({ API_BASE_URL: 'http://test:3001' }));

const base: ExecutionBodyProps = {
  taskId: 894,
  isRunning: false,
  isCompleted: false,
  isCancelled: false,
  isFailed: false,
  isInterrupted: false,
  isExecuting: false,
  logs: [],
  showLogs: true,
  logViewerStatus: 'idle',
  isSseConnected: false,
  executionError: null,
  hasQuestion: false,
  question: '',
  userResponse: '',
  isSendingResponse: false,
  onSetUserResponse: vi.fn(),
  onSendResponse: vi.fn(),
  hasSubtasks: false,
  continueInstruction: '',
  onSetContinueInstruction: vi.fn(),
  onContinueExecution: vi.fn(),
  instruction: '',
  branchName: '',
  baseBranch: '',
  baseBranches: [],
  isGeneratingBranchName: false,
  onSetInstruction: vi.fn(),
  onSetBranchName: vi.fn(),
  onSetBaseBranch: vi.fn(),
  onGenerateBranchName: vi.fn(),
};

afterEach(() => vi.unstubAllGlobals());

it.each(['idle', 'isRunning', 'isCompleted', 'isCancelled', 'isInterrupted', 'isFailed'] as const)(
  'loads saved planning output with empty live logs when %s',
  async (flag) => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('phase-timeline')
          ? {
              success: true,
              workflowMode: 'standard',
              taskStatus: 'in-progress',
              phases: [
                {
                  phaseType: 'plan',
                  iterations: [
                    {
                      iterationNumber: 1,
                      executionIds: [3865],
                      startedAt: null,
                      completedAt: null,
                      status: 'completed',
                      logLineCount: 1,
                      boundaryUncertain: false,
                      summary: {
                        status: 'completed',
                        durationMs: null,
                        logLineCount: 1,
                        testPass: null,
                        testFail: null,
                      },
                    },
                  ],
                },
              ],
            }
          : { success: true, logs: [{ logChunk: 'Saved planning execution output' }] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ExecutionBody {...base} {...(flag === 'idle' ? {} : { [flag]: true })} />);
    expect(await screen.findByText(/Saved planning execution output/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/executions/3865/logs'));
  },
);

it('respects hidden logs after completion', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  render(<ExecutionBody {...base} isCompleted showLogs={false} />);
  expect(fetchMock).not.toHaveBeenCalled();
});
