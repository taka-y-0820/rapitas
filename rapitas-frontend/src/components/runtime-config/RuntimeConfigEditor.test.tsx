/**
 * RuntimeConfigEditor
 *
 * Parses an incoming JSON value once (lazy initial state, no reactive
 * re-sync), lets each field be edited, and re-serializes to JSON on every
 * change — including check-path add/remove — while defaulting empty/blank
 * fields the same way the backend's parseRuntimeConfig does.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { RuntimeConfigEditor } from './RuntimeConfigEditor';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

describe('RuntimeConfigEditor', () => {
  it('preserves the readiness contract when another setting changes', () => {
    const onChange = vi.fn();
    render(
      <RuntimeConfigEditor
        value={JSON.stringify({
          start: 'app',
          url: 'http://localhost:{port}',
          readySelector: '[data-ready]',
          readinessTimeoutMs: 12000,
        })}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText('readySelector')).toHaveValue('[data-ready]');
    expect(screen.getByLabelText('readinessTimeoutMs')).toHaveValue(12);
    fireEvent.change(screen.getByLabelText('start'), { target: { value: 'app dev' } });
    expect(JSON.parse(onChange.mock.calls.at(-1)![0])).toMatchObject({
      readySelector: '[data-ready]',
      readinessTimeoutMs: 12000,
    });
  });
  it('renders defaults when the value is empty', () => {
    render(<RuntimeConfigEditor value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('start')).toHaveValue('');
    expect(screen.getByLabelText('healthPath')).toHaveValue('/');
    expect(screen.getByLabelText('readyTimeoutMs')).toHaveValue(90);
  });

  it('parses an existing JSON value into its fields', () => {
    const value = JSON.stringify({
      start: 'npm run dev -- -p {port}',
      url: 'http://localhost:{port}',
      healthPath: '/health',
      readyTimeoutMs: 30_000,
      checkPaths: ['/', '/about'],
    });
    render(<RuntimeConfigEditor value={value} onChange={vi.fn()} />);
    expect(screen.getByLabelText('start')).toHaveValue('npm run dev -- -p {port}');
    expect(screen.getByLabelText('url')).toHaveValue('http://localhost:{port}');
    expect(screen.getByLabelText('healthPath')).toHaveValue('/health');
    expect(screen.getByLabelText('readyTimeoutMs')).toHaveValue(30);
    expect(screen.getByDisplayValue('/about')).toBeInTheDocument();
  });

  it('falls back to defaults when the value is malformed JSON', () => {
    render(<RuntimeConfigEditor value="not json" onChange={vi.fn()} />);
    expect(screen.getByLabelText('start')).toHaveValue('');
    expect(screen.getByLabelText('healthPath')).toHaveValue('/');
  });

  it('re-serializes on every field edit', () => {
    const onChange = vi.fn();
    render(<RuntimeConfigEditor value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('start'), {
      target: { value: 'npm run dev -- -p {port}' },
    });
    fireEvent.change(screen.getByLabelText('url'), {
      target: { value: 'http://localhost:{port}' },
    });
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(JSON.parse(lastCall)).toEqual({
      start: 'npm run dev -- -p {port}',
      url: 'http://localhost:{port}',
      healthPath: '/',
      readyTimeoutMs: 90_000,
      checkPaths: ['/'],
    });
  });

  it('accepts the ready timeout in seconds and serializes it as milliseconds', () => {
    const onChange = vi.fn();
    render(<RuntimeConfigEditor value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('readyTimeoutMs'), { target: { value: '45' } });
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(JSON.parse(lastCall).readyTimeoutMs).toBe(45_000);
    expect(screen.getByLabelText('readyTimeoutMs')).toHaveValue(45);
  });

  it('adds and removes check-path rows', () => {
    const onChange = vi.fn();
    render(<RuntimeConfigEditor value="" onChange={onChange} />);
    fireEvent.click(screen.getByText('addPath'));
    const pathInputs = screen.getAllByLabelText(/checkPaths/);
    expect(pathInputs).toHaveLength(2);

    fireEvent.change(pathInputs[1], { target: { value: '/about' } });
    fireEvent.click(screen.getAllByLabelText('removePath')[0]);

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(JSON.parse(lastCall).checkPaths).toEqual(['/about']);
  });

  it('drops blank check-path rows and falls back to ["/"] when all are removed', () => {
    const onChange = vi.fn();
    render(<RuntimeConfigEditor value="" onChange={onChange} />);
    fireEvent.click(screen.getAllByLabelText('removePath')[0]);
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(JSON.parse(lastCall).checkPaths).toEqual(['/']);
  });
});
