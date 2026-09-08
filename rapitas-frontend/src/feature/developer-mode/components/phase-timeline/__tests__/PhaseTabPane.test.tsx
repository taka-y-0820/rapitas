import { render, screen } from '@testing-library/react';
import { PhaseTabPane } from '../PhaseTabPane';
import type { PhaseIteration } from '../../../hooks/usePhaseTimeline';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/utils/api', () => ({ API_BASE_URL: 'http://test:3001' }));

const iteration: PhaseIteration = {
  iterationNumber: 1,
  executionIds: [42],
  startedAt: null,
  completedAt: null,
  status: 'running',
  logLineCount: 0,
  boundaryUncertain: false,
  summary: { status: 'running', durationMs: null, logLineCount: 0, testPass: null, testFail: null },
};
const props = {
  iteration,
  filterWarnOnly: false,
  searchQuery: '',
  searchOpts: { caseSensitive: false, wholeWord: false, useRegex: false },
  activeMatchIndex: 0,
  isLive: false,
  liveLogLines: null,
};
const response = (logs: string[]) => ({
  ok: true,
  json: async () => ({ success: true, logs: logs.map((logChunk) => ({ logChunk })) }),
});
afterEach(() => vi.unstubAllGlobals());

it('loads new planning logs when the timeline grows without live SSE', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response([]))
    .mockResolvedValueOnce(response(['Planning persisted progress']));
  vi.stubGlobal('fetch', fetch);
  const view = render(<PhaseTabPane {...props} />);
  await screen.findByText('noLogsYet');
  view.rerender(<PhaseTabPane {...props} iteration={{ ...iteration, logLineCount: 1 }} />);
  await screen.findByText(/Planning persisted progress/);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('retries a failed read after a new timeline snapshot', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(response(['Recovered planning log']));
  vi.stubGlobal('fetch', fetch);
  const view = render(<PhaseTabPane {...props} />);
  await screen.findByText('loadFailed');
  view.rerender(<PhaseTabPane {...props} iteration={{ ...iteration, logLineCount: 1 }} />);
  await screen.findByText(/Recovered planning log/);
  expect(screen.queryByText('loadFailed')).not.toBeInTheDocument();
});
