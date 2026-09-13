'use client';
/**
 * WorkflowQuestionPanel
 *
 * Interactive Q&A for a pending agent question, rendered in the workflow Q&A
 * tab (relocated from the execution log). Self-contained and presentational:
 * it manages only its own selection / free-text state and reports the answer
 * via onAnswer — the parent performs the POST. Multiple-choice is the default
 * (synthesized yes/no when the agent asked free-text); free-text entry stays
 * available for specific user-directed answers.
 */
import { useEffect, useState } from 'react';
import { HelpCircle, Send, Loader2, Clock, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { LiveQuestion } from '@/stores/execution-state-store';
import { resolveQuestionOptions, secondsUntil } from './workflow-question-utils';
import { isImeComposing } from '@/utils/ime';
import { MarkdownView } from '../markdown/MarkdownView';
import { getAppHidden, subscribeAppHidden } from '@/hooks/common/app-visibility-store';
import { useOnVisible } from '@/hooks/common/useOnVisible';

interface WorkflowQuestionPanelProps {
  /** The pending question to answer. */
  question: LiveQuestion;
  /** Whether an answer submission is in flight. */
  submitting: boolean;
  /** Submit the chosen/typed answer. */
  onAnswer: (answer: string) => void;
  /**
   * Free-text-only mode: skip the synthesized yes/no quick-choices and render a
   * multi-line textarea. Used for spec-clarification (intake) questions, whose
   * answer is an open-ended bullet list of goals/constraints/acceptance — the
   * default はい/いいえ buttons are meaningless and confusing there.
   */
  freeTextOnly?: boolean;
  /** Submit-button label (e.g. "次の質問へ" / "送信"). Defaults to 送信. / 送信ボタン文言 */
  submitLabel?: string;
  /**
   * Hide the always-on "その他（自由記述）" row entirely. Used by
   * StructuredQuestionFlow for `json:options` questions whose
   * `freeTextRequired` is false — per policy, free text is shown ONLY when the
   * agent explicitly marked it required. Additive/optional: unset for every
   * existing caller (live question, legacy intake), so their behavior is
   * unchanged.
   */
  hideFreeText?: boolean;
  /**
   * Reason free text is required for this question (only meaningful together
   * with `freeTextOnly`). When set, rendered as an explicit notice above the
   * textarea instead of the free-text row being silently always-available.
   */
  freeTextReason?: string | null;
  /**
   * Label of the option the question author recommends (must match an entry
   * in `question.options` verbatim). When set, that option's button is
   * badged "(推奨)". Unset for live/legacy questions, which carry no
   * recommendation.
   */
  recommendedLabel?: string | null;
  /**
   * 1-2 sentence rationale for `recommendedLabel`, rendered below the option
   * buttons. Only meaningful together with `recommendedLabel`.
   */
  recommendedReason?: string | null;
}

// Neutral card + indigo accent: the panel used to be an amber block, which
// made body text and the recommendation hard to read and clashed with every
// other white card in the workflow section (user report 2026-09-13).
const INPUT_CLASS =
  'rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100';
const SUBMIT_CLASS =
  'flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';
const NOTE_CLASS = 'text-xs text-zinc-500 dark:text-zinc-400';

/**
 * Renders the pending question with selectable options + a free-text fallback.
 *
 * @param props - See {@link WorkflowQuestionPanelProps}.
 */
export function WorkflowQuestionPanel({
  question,
  submitting,
  onAnswer,
  freeTextOnly = false,
  submitLabel,
  hideFreeText = false,
  freeTextReason = null,
  recommendedLabel = null,
  recommendedReason = null,
}: WorkflowQuestionPanelProps) {
  const t = useTranslations('workflow');
  const tc = useTranslations('common');
  const { options, isDefault } = freeTextOnly
    ? { options: [] as string[], isDefault: false }
    : resolveQuestionOptions(question.options, [tc('yes'), tc('no')]);
  const [selected, setSelected] = useState<string>('');
  const [freeText, setFreeText] = useState<string>('');
  const [remaining, setRemaining] = useState<number | null>(
    secondsUntil(question.timeoutDeadline, Date.now()),
  );

  // Reset local state when the question itself changes (next question arrives).
  useEffect(() => {
    setSelected('');
    setFreeText('');
  }, [question.text]);

  // Tick the auto-continue countdown once per second.
  useEffect(() => {
    if (!question.timeoutDeadline) {
      setRemaining(null);
      return;
    }
    const isHidden = () => (typeof document !== 'undefined' && document.hidden) || getAppHidden();
    const tick = () => setRemaining(secondsUntil(question.timeoutDeadline, Date.now()));
    tick();
    const id = setInterval(() => {
      if (isHidden()) return;
      tick();
    }, 1000);
    return () => clearInterval(id);
  }, [question.timeoutDeadline]);

  // Force one immediate recompute on return from background so the countdown
  // doesn't sit frozen at its pre-hidden value until the next tick.
  useOnVisible(() => {
    if (question.timeoutDeadline) setRemaining(secondsUntil(question.timeoutDeadline, Date.now()));
  });
  useEffect(() => {
    return subscribeAppHidden(() => {
      if (!getAppHidden() && question.timeoutDeadline) {
        setRemaining(secondsUntil(question.timeoutDeadline, Date.now()));
      }
    });
  }, [question.timeoutDeadline]);

  const answer = (freeText.trim() || selected).trim();
  const canSubmit = answer.length > 0 && !submitting;

  const submitButton = (label: string) => (
    <button
      type="button"
      onClick={() => canSubmit && onAnswer(answer)}
      disabled={!canSubmit}
      className={SUBMIT_CLASS}
    >
      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      {label}
    </button>
  );

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-indigo-dark-900">
      <div className="mb-3 flex items-center gap-2">
        <div className="rounded-lg bg-indigo-50 p-1.5 dark:bg-indigo-900/40">
          <HelpCircle className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        </div>
        <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {t('questionPanel.title')}
        </h4>
        {question.confirmed && (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900/40 dark:text-green-300">
            {t('questionPanel.confirmed')}
          </span>
        )}
      </div>

      <div className="mb-3 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-100">
        <MarkdownView content={question.text} />
      </div>

      {options.length > 0 && (
        <p className={`mb-2 font-medium ${NOTE_CLASS}`}>{t('questionPanel.chooseAnswer')}</p>
      )}

      <div className="grid gap-2">
        {options.map((option, index) => {
          const key = String.fromCharCode(65 + index); // A, B, C, D
          const isSel = selected === option && !freeText.trim();
          const isRecommended = recommendedLabel === option;
          return (
            <button
              key={index}
              type="button"
              aria-label={option}
              aria-pressed={isSel}
              onClick={() => {
                setSelected(option);
                setFreeText('');
              }}
              className={`rounded-lg border-2 px-4 py-3 text-left transition-all ${
                isSel
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-100'
                  : isRecommended
                    ? 'border-indigo-300 bg-white text-zinc-800 hover:border-indigo-400 dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100'
                    : 'border-zinc-200 bg-white text-zinc-700 hover:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    isSel
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400'
                  }`}
                >
                  {key}
                </span>
                <span className="flex-1 text-sm">
                  {option}
                  {isRecommended && (
                    <span className="ml-2 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200">
                      {t('questionPanel.recommendedBadge')}
                    </span>
                  )}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {isDefault && <p className={`mt-2 ${NOTE_CLASS}`}>{t('questionPanel.defaultOptionsNote')}</p>}

      {recommendedReason && (
        // Callout instead of a one-line footnote: the rationale is the main
        // thing a user reads before choosing, so it gets body-size text, an
        // icon, and its own bordered box.
        <div className="mt-3 flex gap-2.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5 dark:border-indigo-800 dark:bg-indigo-900/30">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
          <div className="text-sm leading-relaxed text-indigo-950 dark:text-indigo-100">
            <span className="font-semibold">{t('questionPanel.recommendedReasonLabel')}</span>
            <p className="mt-1 whitespace-pre-wrap">{recommendedReason}</p>
          </div>
        </div>
      )}

      {remaining !== null && remaining > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 dark:border-indigo-700 dark:bg-indigo-900/30">
          <Clock className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-sm text-indigo-700 dark:text-indigo-300">
            {t('questionPanel.autoContinuePrefix')}{' '}
            <span className="font-mono font-medium">{remaining}</span>{' '}
            {t('questionPanel.autoContinueSuffix')}
          </span>
        </div>
      )}

      {freeTextOnly ? (
        <div className="mt-1">
          {freeTextReason && (
            <p className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
              {t('questionPanel.freeTextRequiredNotice', { reason: freeTextReason })}
            </p>
          )}
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            aria-label={t('questionPanel.freeTextPlaceholder')}
            rows={5}
            placeholder={t('questionPanel.freeTextPlaceholder')}
            className={`w-full resize-y ${INPUT_CLASS}`}
          />
          <div className="mt-2 flex justify-end">
            {submitButton(submitLabel ?? t('questionPanel.submitAndResume'))}
          </div>
        </div>
      ) : hideFreeText ? (
        <div className="mt-3 flex justify-end">
          {submitButton(submitLabel ?? t('questionPanel.submit'))}
        </div>
      ) : (
        <div className="mt-3">
          {options.length > 0 && (
            <p className={`mb-1 ${NOTE_CLASS}`}>{t('questionPanel.otherFreeText')}</p>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              aria-label={t('questionPanel.otherFreeText')}
              onKeyDown={(e) =>
                e.key === 'Enter' && !isImeComposing(e) && canSubmit && onAnswer(answer)
              }
              placeholder={t('questionPanel.freeTextInputPlaceholder')}
              className={`flex-1 ${INPUT_CLASS}`}
            />
            {submitButton(submitLabel ?? t('questionPanel.submit'))}
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkflowQuestionPanel;
