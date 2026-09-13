/**
 * ToastQuestionOptions.test
 *
 * The desktop toast answers a single structured question inline; multi- or
 * free-text questions defer to the app.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastQuestionOptions } from './ToastQuestionOptions';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('@/utils/api', () => ({ API_BASE_URL: 'http://test:3001' }));

const singleQuestionMd = `# 質問

\`\`\`json:options
{"questions":[{"id":"Q1","summary":"どうする?","options":[
  {"key":"A","label":"案A","consequence":"x"},
  {"key":"B","label":"案B","consequence":"y"}],
  "freeTextRequired":false,"freeTextReason":null,"recommended":"B","recommendedReason":"理由"}]}
\`\`\`
`;

const twoQuestionMd = singleQuestionMd.replace(
  '"recommendedReason":"理由"}]}',
  '"recommendedReason":"理由"},{"id":"Q2","summary":"次は?","options":[{"key":"A","label":"a","consequence":"z"}],"freeTextRequired":false,"freeTextReason":null,"recommended":"A","recommendedReason":"r"}]}',
);

function mockFiles(content: string, answerOk = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        String(url).endsWith('/files')
          ? { ok: true, json: () => Promise.resolve({ question: { content } }) }
          : { ok: answerOk, status: answerOk ? 200 : 500, json: () => Promise.resolve({}) },
      ),
    ),
  );
}

describe('ToastQuestionOptions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the options (recommended first) and posts the chosen answer', async () => {
    mockFiles(singleQuestionMd);
    const onAnswered = vi.fn();
    render(<ToastQuestionOptions taskId={7} onAnswered={onAnswered} onLayoutChange={vi.fn()} />);

    const buttons = await screen.findAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['案B', '案A']);
    expect(screen.getByText('questionToast.recommended')).toBeInTheDocument();

    fireEvent.click(buttons[1]);
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://test:3001/workflow/tasks/7/answer-question');
    expect((init.headers as Record<string, string>)['X-Rapitas-Source']).toBe('ui');
    const body = JSON.parse(String(init.body)) as { answer: string; selections: unknown[] };
    expect(body.answer).toContain('案A');
    expect(body.selections).toEqual([{ questionId: 'Q1', selectedKey: 'A' }]);
    expect(screen.getByText('questionToast.answered')).toBeInTheDocument();
  });

  it('shows a failure notice and keeps the options when the answer is rejected', async () => {
    mockFiles(singleQuestionMd, false);
    const onAnswered = vi.fn();
    render(<ToastQuestionOptions taskId={7} onAnswered={onAnswered} onLayoutChange={vi.fn()} />);
    fireEvent.click((await screen.findAllByRole('button'))[0]);
    await waitFor(() => expect(screen.getByText('questionToast.failed')).toBeInTheDocument());
    expect(onAnswered).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('defers multi-question blocks to the app', async () => {
    mockFiles(twoQuestionMd);
    render(<ToastQuestionOptions taskId={7} onAnswered={vi.fn()} onLayoutChange={vi.fn()} />);
    expect(await screen.findByText('questionToast.moreQuestions:{"count":2}')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('defers when question.md has no structured options', async () => {
    mockFiles('# 質問\n自由に書いてください');
    render(<ToastQuestionOptions taskId={7} onAnswered={vi.fn()} onLayoutChange={vi.fn()} />);
    expect(await screen.findByText('questionToast.answerInApp')).toBeInTheDocument();
  });
});
