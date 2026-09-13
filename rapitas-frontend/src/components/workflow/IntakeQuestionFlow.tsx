'use client';
/**
 * IntakeQuestionFlow
 *
 * Presents a multi-question intake `question.md` as ONE-question-at-a-time (1問1答)
 * so each question's answer corresponds clearly to its question. Tracks the current
 * index + collected answers; on the last question it combines them into a single
 * labelled answer and submits via onSubmitAll (the parent POSTs it). Reuses
 * WorkflowQuestionPanel for the per-question choices + free-text.
 */
import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { WorkflowQuestionPanel } from './WorkflowQuestionPanel';
import type { ParsedIntakeQuestion } from './workflow-question-utils';
import { MarkdownView } from '../markdown/MarkdownView';

interface IntakeQuestionFlowProps {
  /** Intro prose shown above the question (e.g. why the spec is thin). / 導入文 */
  intro: string;
  /** The parsed questions to ask one at a time. / 1問1答で聞く質問群 */
  questions: ParsedIntakeQuestion[];
  /** Whether the final submission is in flight. / 送信中か */
  submitting: boolean;
  /** Receives the combined, labelled answer for all questions. / 全回答の結合 */
  onSubmitAll: (combinedAnswer: string) => void;
}

/**
 * @param props - See {@link IntakeQuestionFlowProps}.
 */
export function IntakeQuestionFlow({
  intro,
  questions,
  submitting,
  onSubmitAll,
}: IntakeQuestionFlowProps) {
  const t = useTranslations('workflow');
  const total = questions.length;
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''));

  const current = questions[Math.min(idx, total - 1)];
  const isLast = idx >= total - 1;

  const handleAnswer = (answer: string) => {
    const next = [...answers];
    next[idx] = answer;
    setAnswers(next);
    if (!isLast) {
      setIdx(idx + 1);
      return;
    }
    // Last question — combine every answer under its question label and submit.
    const combined = questions
      .map((q, i) => `## ${q.label}\n${(next[i] || '').trim()}`)
      .join('\n\n');
    onSubmitAll(combined);
  };

  return (
    <div className="space-y-3">
      {intro && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-200">
          <MarkdownView content={intro} />
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

      <WorkflowQuestionPanel
        // Remount per question so selection state never leaks between two
        // questions that happen to share the same text.
        key={idx}
        // taskId is unused by the panel for intake answers (the parent handles POST).
        question={{ taskId: 0, text: current.text, options: current.options }}
        submitting={submitting && isLast}
        onAnswer={handleAnswer}
        freeTextOnly={current.options.length === 0}
        submitLabel={
          isLast ? t('intakeQuestionFlow.submitAll') : t('intakeQuestionFlow.nextQuestion')
        }
      />
    </div>
  );
}

export default IntakeQuestionFlow;
