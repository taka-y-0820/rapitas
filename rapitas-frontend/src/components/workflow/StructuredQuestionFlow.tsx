'use client';
/**
 * StructuredQuestionFlow
 *
 * Presents the `json:options` machine-readable questions (see
 * workflow-question-utils.parseOptionsBlock) ONE-question-at-a-time (1問1答),
 * delegating each question's choices/free-text to WorkflowQuestionPanel. On
 * the final question's answer, asks for confirmation (useConfirmDialog) before
 * composing the final answer text + selections audit and calling onSubmitAll.
 * A separate component from IntakeQuestionFlow because the data contract
 * differs (key/label/consequence vs plain option strings) — see plan.md's
 * "実装者への申し送り事項" #3.
 */
import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { MarkdownView } from '../markdown/MarkdownView';
import { WorkflowQuestionPanel } from './WorkflowQuestionPanel';
import { useConfirmDialog } from '../ui/dialog/ConfirmDialogProvider';
import {
  composeStructuredAnswer,
  type StructuredAnswerEntry,
  type StructuredQuestion,
  type StructuredSelection,
} from './workflow-question-utils';

interface StructuredQuestionFlowProps {
  /** The parsed structured questions to ask one at a time. / 1問1答で聞く構造化質問群 */
  questions: StructuredQuestion[];
  /** Whether the final submission is in flight. / 送信中か */
  submitting: boolean;
  /** Receives the composed answer text and the per-question selections audit. / 合成回答と選択監査 */
  onSubmitAll: (answerText: string, selections: StructuredSelection[]) => void;
  /**
   * question.md prose body with the `json:options` block stripped (see
   * workflow-question-utils.stripOptionsBlock). Rendered once above the flow
   * so tables/headings giving the questions their context stay visible.
   * Optional for backward compatibility; empty string renders nothing.
   * / json:options 除去済みの question.md 本文（省略・空文字なら非表示）
   */
  body?: string;
}

/**
 * @param props - See {@link StructuredQuestionFlowProps}.
 */
export function StructuredQuestionFlow({
  questions,
  submitting,
  onSubmitAll,
  body,
}: StructuredQuestionFlowProps) {
  const t = useTranslations('workflow');
  const confirm = useConfirmDialog();
  const total = questions.length;
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<StructuredAnswerEntry[]>(() =>
    questions.map(() => ({ key: null, freeText: '' })),
  );
  const [confirming, setConfirming] = useState(false);

  const current = questions[Math.min(idx, total - 1)];
  const isLast = idx >= total - 1;
  // Recommended option (if any) is surfaced first so the user's first glance
  // lands on it; the underlying option/key order is untouched (composeStructuredAnswer
  // and the `selections` audit still key off `current.options`, not this display order).
  const recommendedOption = current.recommendedKey
    ? (current.options.find((o) => o.key === current.recommendedKey) ?? null)
    : null;
  const orderedOptions = recommendedOption
    ? [recommendedOption, ...current.options.filter((o) => o.key !== recommendedOption.key)]
    : current.options;

  const handleAnswer = async (answerText: string) => {
    const matchedOption = current.options.find((o) => o.label === answerText);
    const entry: StructuredAnswerEntry = matchedOption
      ? { key: matchedOption.key, freeText: '' }
      : { key: null, freeText: answerText };
    const nextAnswers = [...answers];
    nextAnswers[idx] = entry;
    setAnswers(nextAnswers);

    if (!isLast) {
      setIdx(idx + 1);
      return;
    }

    const { answerText: composedText, selections } = composeStructuredAnswer(
      questions,
      nextAnswers,
    );
    const summaryLines = questions
      .map((q, i) => {
        const a = nextAnswers[i];
        const chosen = a.key ? (q.options.find((o) => o.key === a.key)?.label ?? '') : a.freeText;
        return `${q.summary}: ${chosen}`;
      })
      .join('\n');

    setConfirming(true);
    try {
      const ok = await confirm({
        title: t('structuredQuestionFlow.confirmTitle'),
        message: `${t('structuredQuestionFlow.confirmMessage')}\n\n${summaryLines}`,
        confirmLabel: t('structuredQuestionFlow.confirmSubmit'),
      });
      if (ok) {
        onSubmitAll(composedText, selections);
      }
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Same intro-box treatment as IntakeQuestionFlow so the two question
          flows stay visually consistent; guard keeps options-only files from
          rendering an empty box. */}
      {body && (
        <div
          data-testid="structured-question-body"
          className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-200"
        >
          <MarkdownView content={body} />
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {t('intakeQuestionFlow.progress', { current: idx + 1, total })}
        </span>
        {idx > 0 && (
          <button
            type="button"
            onClick={() => setIdx(idx - 1)}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('intakeQuestionFlow.previousQuestion')}
          </button>
        )}
      </div>

      {/* Progress dots so the user sees how many questions remain. */}
      <div className="flex gap-1.5">
        {questions.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full ${
              i < idx
                ? 'bg-green-400 dark:bg-green-500'
                : i === idx
                  ? 'bg-indigo-500'
                  : 'bg-zinc-200 dark:bg-zinc-700'
            }`}
          />
        ))}
      </div>

      {/* key={idx}: the panel resets its selection on question TEXT change
          only, so two consecutive questions with identical summaries kept the
          previous choice. Remounting per index makes the reset unconditional. */}
      <WorkflowQuestionPanel
        key={idx}
        question={{
          taskId: 0,
          text: current.summary,
          options: orderedOptions.map((o) => o.label),
        }}
        submitting={(submitting || confirming) && isLast}
        onAnswer={handleAnswer}
        freeTextOnly={current.freeTextRequired}
        hideFreeText={!current.freeTextRequired}
        freeTextReason={current.freeTextRequired ? current.freeTextReason : null}
        recommendedLabel={recommendedOption?.label ?? null}
        recommendedReason={recommendedOption ? current.recommendedReason : null}
        submitLabel={
          isLast ? t('intakeQuestionFlow.submitAll') : t('intakeQuestionFlow.nextQuestion')
        }
      />
    </div>
  );
}

export default StructuredQuestionFlow;
