import { renderHook, waitFor } from '@testing-library/react';
import { useWorkflowFiles } from '../workflow/useWorkflowFiles';

vi.mock('next-intl', () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});

vi.mock('@/utils/api', () => ({
  API_BASE_URL: 'http://test:3001',
}));

type SseHandler = (event: MessageEvent) => void;
const sseHandlers = new Map<string, Set<SseHandler>>();
vi.mock('@/lib/sse/shared-event-source', () => ({
  sharedEventSource: {
    subscribe: (type: string, handler: SseHandler) => {
      if (!sseHandlers.has(type)) sseHandlers.set(type, new Set());
      sseHandlers.get(type)!.add(handler);
      return () => sseHandlers.get(type)?.delete(handler);
    },
  },
}));
const emitSse = (type: string, payload: unknown) =>
  sseHandlers
    .get(type)
    ?.forEach((h) => h(new MessageEvent(type, { data: JSON.stringify(payload) })));

const mockFilesResponse = {
  research: {
    type: 'research',
    exists: true,
    content: '# Research',
    lastModified: '2026-01-01',
    size: 100,
  },
  question: { type: 'question', exists: false },
  plan: {
    type: 'plan',
    exists: true,
    content: '# Plan',
    lastModified: '2026-01-02',
    size: 200,
  },
  verify: { type: 'verify', exists: false },
  workflowStatus: 'plan_created',
  path: { taskId: 1, categoryId: 2, themeId: 3, dir: '/tasks/2/3/1' },
};

describe('useWorkflowFiles', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockFilesResponse),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sseHandlers.clear();
  });

  it('refetches on task-scoped SSE events so the status stays live', async () => {
    const { result, unmount } = renderHook(() => useWorkflowFiles(1));
    await waitFor(() => expect(result.current.workflowStatus).toBe('plan_created'));
    expect(fetch).toHaveBeenCalledTimes(1);

    // Another task's event must not trigger a fetch.
    emitSse('phase_transition', { taskId: 2, newPhase: 'plan_approved' });
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockFilesResponse, workflowStatus: 'in_progress' }),
    } as Response);
    emitSse('phase_transition', { taskId: 1, newPhase: 'in_progress' });
    await waitFor(() => expect(result.current.workflowStatus).toBe('in_progress'));

    emitSse('task_updated', { taskId: 1 });
    emitSse('item_update', { taskId: 1 });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));

    // Malformed payloads are ignored rather than thrown.
    sseHandlers
      .get('task_updated')
      ?.forEach((h) => h(new MessageEvent('task_updated', { data: '{not json' })));
    expect(fetch).toHaveBeenCalledTimes(4);

    unmount();
    emitSse('phase_transition', { taskId: 1 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('should not fetch when taskId is null', () => {
    renderHook(() => useWorkflowFiles(null));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should fetch files when taskId is provided', async () => {
    const { result } = renderHook(() => useWorkflowFiles(1));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // The hook passes a no-store fetch options object so polled refetches always
    // see the agent's latest md writes — tolerate the second argument.
    expect(fetch).toHaveBeenCalledWith(
      'http://test:3001/workflow/tasks/1/files',
      expect.anything(),
    );
    expect(result.current.files).toEqual({
      research: mockFilesResponse.research,
      question: mockFilesResponse.question,
      plan: mockFilesResponse.plan,
      verify: mockFilesResponse.verify,
    });
    expect(result.current.workflowStatus).toBe('plan_created');
    expect(result.current.workflowPath).toEqual(mockFilesResponse.path);
  });

  it('should set isLoading true on initial fetch', () => {
    const { result } = renderHook(() => useWorkflowFiles(1));
    expect(result.current.isLoading).toBe(true);
  });

  it('should compute hasAnyFile correctly when files exist', async () => {
    const { result } = renderHook(() => useWorkflowFiles(1));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.hasAnyFile).toBe(true);
  });

  it('should compute hasAnyFile as false when no files exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            research: { type: 'research', exists: false },
            question: { type: 'question', exists: false },
            plan: { type: 'plan', exists: false },
            verify: { type: 'verify', exists: false },
            workflowStatus: 'draft',
          }),
      }),
    );

    const { result } = renderHook(() => useWorkflowFiles(1));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.hasAnyFile).toBe(false);
  });

  it('should handle fetch error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }),
    );

    const { result } = renderHook(() => useWorkflowFiles(1));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('HTTP 500');
    expect(result.current.files).toBeNull();
  });

  it('should handle network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const { result } = renderHook(() => useWorkflowFiles(1));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
  });

  it('keeps the same files object reference across refetch when content is unchanged', async () => {
    const { result } = renderHook(() => useWorkflowFiles(1));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const firstFiles = result.current.files;

    // A second poll returning byte-identical content must not produce a new
    // object reference — otherwise every consumer (MarkdownView, Mermaid
    // diagrams) re-renders on every 3s poll tick even though nothing changed.
    await result.current.refetch();

    expect(result.current.files).toBe(firstFiles);
  });

  it('replaces the files object reference when content actually changes', async () => {
    const { result } = renderHook(() => useWorkflowFiles(1));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const firstFiles = result.current.files;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockFilesResponse,
            research: { ...mockFilesResponse.research, content: '# Research (updated)' },
          }),
      }),
    );

    await result.current.refetch();

    await waitFor(() => {
      expect(result.current.files?.research.content).toBe('# Research (updated)');
    });
    expect(result.current.files).not.toBe(firstFiles);
  });

  it('should reset state when taskId changes', async () => {
    const { result, rerender } = renderHook(({ taskId }) => useWorkflowFiles(taskId), {
      initialProps: { taskId: 1 as number | null },
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.files).not.toBeNull();

    rerender({ taskId: 2 });

    // files should be reset immediately on taskId change
    // (they get set to null in the useEffect)
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        'http://test:3001/workflow/tasks/2/files',
        expect.anything(),
      );
    });
  });
});
