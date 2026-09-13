'use client';
/**
 * ToastQuestionOptions
 *
 * Inline answer surface for an agent question inside the desktop toast
 * window: fetches the task's pending `question.md`, renders the structured
 * `json:options` choices of a single-question block, and POSTs the chosen
 * option through the same answer-question API the in-app Q&A tab uses.
 * Multi-question blocks and free-text-only questions fall back to an
 * "answer in app" prompt — the toast is too small for a full flow.
 * Not responsible for showing/hiding the toast window itself.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { API_BASE_URL } from '@/utils/api';
import {
  composeStructuredAnswer,
  parseOptionsBlock,
  type StructuredQuestion,
} from '@/components/workflow/workflow-question-utils';

interface ToastQuestionOptionsProps {
  /** Task whose question.md is pending. / 質問中のタスク */
  taskId: number;
  /** Called once an answer was accepted by the backend. / 回答受理後 */
  onAnswered: () => void;
  /** Called whenever the rendered height may have changed. / 高さ変化通知 */
  onLayoutChange: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'single'; question: StructuredQuestion }
  | { kind: 'multiple'; count: number }
  | { kind: 'unavailable' };

/**
 * Fetch and render the pending question's options for the toast.
 *
 * @param props - See {@link ToastQuestionOptionsProps}.
 */
export function ToastQuestionOptions({
  taskId,
  onAnswered,
  onLayoutChange,
}: ToastQuestionOptionsProps) {
  const t = useTranslations('notification');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<'answered' | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    setNotice(null);
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/workflow/tasks/${taskId}/files`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { question?: { content?: string | null } };
        const block = parseOptionsBlock(data.question?.content ?? '');
        if (cancelled) return;
        if (!block || block.questions.length === 0) setState({ kind: 'unavailable' });
        else if (block.questions.length > 1)
          setState({ kind: 'multiple', count: block.questions.length });
        else if (block.questions[0].freeTextRequired || block.questions[0].options.length === 0)
          setState({ kind: 'unavailable' });
        else setState({ kind: 'single', question: block.questions[0] });
      } catch {
        if (!cancelled) setState({ kind: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Any state change can change the height — let the page re-measure.
  useEffect(() => {
    onLayoutChange();
  }, [state, notice, onLayoutChange]);

  const answer = async (question: StructuredQuestion, key: string) => {
    if (submittingKey) return;
    setSubmittingKey(key);
    const { answerText, selections } = composeStructuredAnswer([question], [{ key, freeText: '' }]);
    try {
      const res = await fetch(`${API_BASE_URL}/workflow/tasks/${taskId}/answer-question`, {
        method: 'POST',
        // Same human-source header as the in-app Q&A tab: the backend rejects
        // agent-originated answers without it (task 662).
        headers: { 'Content-Type': 'application/json', 'X-Rapitas-Source': 'ui' },
        body: JSON.stringify({ answer: answerText, selections }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotice('answered');
      onAnswered();
    } catch {
      setNotice('failed');
    } finally {
      setSubmittingKey(null);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 px-4 pb-3 text-xs text-zinc-500 dark:text-zinc-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  if (notice === 'answered') {
    return (
      <p className="px-4 pb-3 text-xs font-medium text-green-700 dark:text-green-300">
        {t('questionToast.answered')}
      </p>
    );
  }

  if (state.kind !== 'single') {
    return (
      <p className="px-4 pb-3 text-xs text-zinc-600 dark:text-zinc-300">
        {state.kind === 'multiple'
          ? t('questionToast.moreQuestions', { count: state.count })
          : t('questionToast.answerInApp')}
      </p>
    );
  }

  const { question } = state;
  const recommendedFirst = [
    ...question.options.filter((o) => o.key === question.recommendedKey),
    ...question.options.filter((o) => o.key !== question.recommendedKey),
  ];

  return (
    <div className="px-4 pb-3">
      <p className="mb-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        {t('questionToast.hint')}
      </p>
      <div className="grid gap-1.5">
        {recommendedFirst.map((option) => {
          const isRecommended = option.key === question.recommendedKey;
          const busy = submittingKey === option.key;
          return (
            <button
              key={option.key}
              type="button"
              disabled={!!submittingKey}
              onClick={() => void answer(question, option.key)}
              aria-label={option.label}
              className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-60 ${
                isRecommended
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-900 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-100'
                  : 'border-zinc-200 bg-white text-zinc-700 hover:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
              }`}
            >
              <span className="mt-px shrink-0 font-bold">{option.key}</span>
              <span className="min-w-0 flex-1 line-clamp-2">
                {option.label}
                {isRecommended && (
                  <span className="ml-1 rounded-full bg-indigo-100 px-1.5 py-px text-[10px] font-semibold text-indigo-700 dark:bg-indigo-800/60 dark:text-indigo-200">
                    {t('questionToast.recommended')}
                  </span>
                )}
              </span>
              {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {notice === 'failed' && (
        <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
          {t('questionToast.failed')}
        </p>
      )}
    </div>
  );
}
