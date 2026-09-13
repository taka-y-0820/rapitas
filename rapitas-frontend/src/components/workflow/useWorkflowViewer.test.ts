import { renderHook, waitFor, act } from '@testing-library/react';
import { useWorkflowViewer } from './useWorkflowViewer';
import { setAppHidden } from '@/hooks/common/app-visibility-store';

vi.mock('next-intl', () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});
vi.mock('@/utils/api', () => ({ API_BASE_URL: 'http://test:3001' }));

const mockRefetch = vi.fn();
let mockWorkflowStatus: string | null = null;
vi.mock('@/hooks/workflow/useWorkflowFiles', () => ({
  useWorkflowFiles: () => ({
    files: null,
    isLoading: false,
    error: null,
    refetch: mockRefetch,
    workflowPath: null,
    get workflowStatus() {
      return mockWorkflowStatus;
    },
  }),
}));

type SseHandler = (event: MessageEvent) => void;
type ConnectionListener = (connected: boolean) => void;

let sseConnected = true;
const subscribedHandlers: Record<string, Set<SseHandler>> = {};
const connectionListeners = new Set<ConnectionListener>();

const mockSubscribe = vi.fn((eventType: string, handler: SseHandler) => {
  (subscribedHandlers[eventType] ??= new Set()).add(handler);
  return () => subscribedHandlers[eventType]?.delete(handler);
});
const mockOnConnectionChange = vi.fn((listener: ConnectionListener) => {
  connectionListeners.add(listener);
  listener(sseConnected);
  return () => connectionListeners.delete(listener);
});
const mockIsConnected = vi.fn(() => sseConnected);

function emitSse(eventType: string, payload: unknown) {
  const set = subscribedHandlers[eventType];
  if (!set) return;
  const event = { data: JSON.stringify(payload) } as MessageEvent;
  for (const handler of set) handler(event);
}

function setSseConnected(connected: boolean) {
  sseConnected = connected;
  for (const listener of connectionListeners) listener(connected);
}

vi.mock('@/lib/sse/shared-event-source', () => ({
  sharedEventSource: {
    subscribe: (eventType: string, handler: SseHandler) => mockSubscribe(eventType, handler),
    onConnectionChange: (listener: ConnectionListener) => mockOnConnectionChange(listener),
    isConnected: () => mockIsConnected(),
  },
}));

describe('useWorkflowViewer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    mockWorkflowStatus = null;
    sseConnected = true;
    for (const key of Object.keys(subscribedHandlers)) delete subscribedHandlers[key];
    connectionListeners.clear();
    mockRefetch.mockClear();
    mockSubscribe.mockClear();
    mockOnConnectionChange.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setAppHidden(false);
  });

  it('selects the question tab when workflowStatus is awaiting_question', async () => {
    const { result } = renderHook(() =>
      useWorkflowViewer({ taskId: 1, workflowStatus: 'awaiting_question' }),
    );

    await waitFor(() => expect(result.current.activeTab).toBe('question'));
  });

  it.each([
    ['research_done', 'research'],
    ['plan_created', 'plan'],
    ['in_progress', 'plan'],
    ['verify_done', 'verify'],
    ['completed', 'verify'],
  ] as const)('keeps selecting %s -> %s tab (regression)', async (workflowStatus, expectedTab) => {
    const { result } = renderHook(() => useWorkflowViewer({ taskId: 1, workflowStatus }));

    await waitFor(() => expect(result.current.activeTab).toBe(expectedTab));
  });

  it('leaves activeTab at the initial research tab for a status with no mapping (regression)', () => {
    const { result } = renderHook(() =>
      useWorkflowViewer({ taskId: 1, workflowStatus: 'blocked' }),
    );

    expect(result.current.activeTab).toBe('research');
  });

  describe('SSE駆動ポーリング（可視性連動フォールバック）', () => {
    it('ACTIVE状態でSSE接続中は phase_transition と item_update を購読する', () => {
      renderHook(() => useWorkflowViewer({ taskId: 1, workflowStatus: 'plan_created' }));

      expect(mockSubscribe).toHaveBeenCalledWith('phase_transition', expect.any(Function));
      expect(mockSubscribe).toHaveBeenCalledWith('item_update', expect.any(Function));
    });

    it('自タスクの phase_transition イベント受信で refetch がトリガーされる', () => {
      renderHook(() => useWorkflowViewer({ taskId: 42, workflowStatus: 'in_progress' }));
      mockRefetch.mockClear();

      act(() => {
        emitSse('phase_transition', { taskId: 42 });
      });

      expect(mockRefetch).toHaveBeenCalled();
    });

    it('他タスクのイベントは無視され refetch されない', () => {
      renderHook(() => useWorkflowViewer({ taskId: 42, workflowStatus: 'in_progress' }));
      mockRefetch.mockClear();

      act(() => {
        emitSse('item_update', { taskId: 999 });
      });

      expect(mockRefetch).not.toHaveBeenCalled();
    });

    it('SSE切断かつ画面表示中のみ3秒フォールバックポーリングが起動する', () => {
      vi.useFakeTimers();
      renderHook(() => useWorkflowViewer({ taskId: 1, workflowStatus: 'in_progress' }));
      mockRefetch.mockClear();

      act(() => {
        setSseConnected(false);
      });
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(mockRefetch).toHaveBeenCalled();
    });

    it('document.hidden=true では SSE切断でもフォールバックポーリングが起動しない', () => {
      vi.useFakeTimers();
      renderHook(() => useWorkflowViewer({ taskId: 1, workflowStatus: 'in_progress' }));
      mockRefetch.mockClear();

      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      act(() => {
        setSseConnected(false);
      });
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(mockRefetch).not.toHaveBeenCalled();
    });

    it('getAppHidden()=true（最小化）では SSE切断でもフォールバックポーリングが起動しない', () => {
      vi.useFakeTimers();
      renderHook(() => useWorkflowViewer({ taskId: 1, workflowStatus: 'in_progress' }));
      mockRefetch.mockClear();

      setAppHidden(true);
      act(() => {
        setSseConnected(false);
      });
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(mockRefetch).not.toHaveBeenCalled();
    });

    it('SSEが再接続するとフォールバックポーリングは停止する', () => {
      vi.useFakeTimers();
      renderHook(() => useWorkflowViewer({ taskId: 1, workflowStatus: 'in_progress' }));

      act(() => {
        setSseConnected(false);
      });
      act(() => {
        setSseConnected(true);
      });
      mockRefetch.mockClear();

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(mockRefetch).not.toHaveBeenCalled();
    });

    it('plan_approved のとき isPolling===true である（次フェーズボタンの誤出現防止・回帰テスト）', () => {
      const { result } = renderHook(() =>
        useWorkflowViewer({ taskId: 1, workflowStatus: 'plan_approved' }),
      );

      expect(result.current.isPolling).toBe(true);
    });

    it('終端状態（completed）では isPolling===false かつ購読しない', () => {
      const { result } = renderHook(() =>
        useWorkflowViewer({ taskId: 1, workflowStatus: 'completed' }),
      );

      expect(result.current.isPolling).toBe(false);
    });
  });

  describe('質問応答の即時反映（pin機構, task 902 AC3）', () => {
    it('[既存機能チェック#16] pinを使わない場合、高順位のworkflowStatusプロパティが正当な後退をマスクし続ける（既知の制約・回帰確認）', async () => {
      mockWorkflowStatus = 'plan_created';
      const { result, rerender } = renderHook(
        (props: { workflowStatus: string }) =>
          useWorkflowViewer({
            taskId: 1,
            workflowStatus: props.workflowStatus as never,
          }),
        { initialProps: { workflowStatus: 'plan_created' } },
      );
      await waitFor(() => expect(result.current.effectiveStatus).toBe('plan_created'));

      // Backend legitimately regressed to draft (e.g. a spec_change answer),
      // but the parent's workflowStatus prop has not been updated yet.
      mockWorkflowStatus = 'draft';
      rerender({ workflowStatus: 'plan_created' });

      expect(result.current.effectiveStatus).toBe('plan_created');
    });

    it('applyResolvedQuestionStatus はプロパティの順位に関わらずeffectiveStatusを即座に確定させる', async () => {
      mockWorkflowStatus = 'plan_created';
      const { result } = renderHook(() =>
        useWorkflowViewer({ taskId: 1, workflowStatus: 'plan_created' }),
      );
      await waitFor(() => expect(result.current.effectiveStatus).toBe('plan_created'));

      act(() => {
        result.current.applyResolvedQuestionStatus('draft');
      });

      expect(result.current.effectiveStatus).toBe('draft');
    });

    it.each(['draft', 'in_progress', 'verify_done'] as const)(
      'applyResolvedQuestionStatus(%s) は即座にeffectiveStatusへ反映される',
      async (toStatus) => {
        mockWorkflowStatus = 'awaiting_question';
        const { result } = renderHook(() =>
          useWorkflowViewer({ taskId: 1, workflowStatus: 'awaiting_question' }),
        );
        await waitFor(() => expect(result.current.effectiveStatus).toBe('awaiting_question'));

        act(() => {
          result.current.applyResolvedQuestionStatus(toStatus);
        });

        expect(result.current.effectiveStatus).toBe(toStatus);
      },
    );

    it('親の古い高順位状態を残して取得状態だけが追いついても後退先を保持する', async () => {
      mockWorkflowStatus = 'plan_created';
      const { result, rerender } = renderHook(
        (props: { workflowStatus: string }) =>
          useWorkflowViewer({
            taskId: 1,
            workflowStatus: props.workflowStatus as never,
          }),
        { initialProps: { workflowStatus: 'plan_created' } },
      );
      await waitFor(() => expect(result.current.effectiveStatus).toBe('plan_created'));

      act(() => {
        result.current.applyResolvedQuestionStatus('draft');
      });
      expect(result.current.effectiveStatus).toBe('draft');

      // The parent callback is optional and may update later than the fetch.
      mockWorkflowStatus = 'draft';
      rerender({ workflowStatus: 'plan_created' });

      await waitFor(() => expect(result.current.effectiveStatus).toBe('draft'));

      mockWorkflowStatus = 'research_done';
      rerender({ workflowStatus: 'plan_created' });
      await waitFor(() => expect(result.current.effectiveStatus).toBe('research_done'));

      // A later parent update must regain its normal forward-progress role.
      rerender({ workflowStatus: 'plan_approved' });
      await waitFor(() => expect(result.current.effectiveStatus).toBe('plan_approved'));
    });

    it('親だけが先に後退先へ追いついても古い取得状態へ戻らない', async () => {
      mockWorkflowStatus = 'plan_created';
      const { result, rerender } = renderHook(
        ({ workflowStatus }: { workflowStatus: 'plan_created' | 'draft' }) =>
          useWorkflowViewer({ taskId: 1, workflowStatus }),
        { initialProps: { workflowStatus: 'plan_created' as 'plan_created' | 'draft' } },
      );
      act(() => result.current.applyResolvedQuestionStatus('draft'));
      rerender({ workflowStatus: 'draft' });
      expect(result.current.effectiveStatus).toBe('draft');
      mockWorkflowStatus = 'draft';
      rerender({ workflowStatus: 'draft' });
      await waitFor(() => expect(result.current.effectiveStatus).toBe('draft'));
    });

    it('別タスクへ切替後に古い回答が返っても新しいタスクの状態を固定しない', async () => {
      mockWorkflowStatus = 'plan_created';
      const { result, rerender } = renderHook(
        ({ taskId }) => useWorkflowViewer({ taskId, workflowStatus: 'plan_created' }),
        { initialProps: { taskId: 1 } },
      );
      const lateAnswer = result.current.applyResolvedQuestionStatus;
      act(() => lateAnswer('draft'));
      expect(result.current.effectiveStatus).toBe('draft');
      rerender({ taskId: 2 });
      expect(result.current.effectiveStatus).toBe('plan_created');
      act(() => lateAnswer('verify_done'));
      expect(result.current.effectiveStatus).toBe('plan_created');
    });

    it('（プレモーテム#1）pin中にfetchedStatusが別の値へ進んだ場合はpinを即座に解除しその新しい値へ追随する', async () => {
      mockWorkflowStatus = 'in_progress';
      const { result, rerender } = renderHook(
        (props: { workflowStatus: string }) =>
          useWorkflowViewer({
            taskId: 1,
            workflowStatus: props.workflowStatus as never,
          }),
        { initialProps: { workflowStatus: 'in_progress' } },
      );
      await waitFor(() => expect(result.current.effectiveStatus).toBe('in_progress'));

      act(() => {
        result.current.applyResolvedQuestionStatus('verify_done');
      });
      expect(result.current.effectiveStatus).toBe('verify_done');

      // Backend actually progressed further than the pinned value (e.g. an
      // auto-merge watcher completed the task) before fetchedStatus ever
      // reported the pinned value itself — the pin must not stick forever.
      mockWorkflowStatus = 'completed';
      rerender({ workflowStatus: 'verify_done' });

      await waitFor(() => expect(result.current.effectiveStatus).toBe('completed'));
    });
  });
});
