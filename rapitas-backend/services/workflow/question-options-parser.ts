/**
 * Question Options Parser
 *
 * Backend-side parser for the `json:options` fenced block in question.md, plus
 * the auto-answer eligibility check used by the stale-question auto-answer heal
 * pass (workflow-reconciler-question-auto-answer.ts). Not responsible for
 * rendering, answering, or persisting anything.
 *
 * NOTE: keep in sync with
 * rapitas-frontend/src/components/workflow/workflow-question-utils.ts's
 * parseOptionsBlock — no shared package exists between the two apps, so this
 * is a deliberate duplicate of that parsing logic.
 */

/** One selectable option within a {@link ParsedQuestion}. */
export interface ParsedQuestionOption {
  /** Short key the recommendation/selection is recorded under (e.g. "A"). / 選択キー */
  key: string;
  /** Button label / 選択肢の表示文 */
  label: string;
  /** One-line consequence of choosing this option. / 選択時の影響 */
  consequence?: string;
  /** True when choosing this option would change a gate's verification threshold/condition — never auto-answered. / ゲート条件を変更するか */
  mutatesGate?: boolean;
}

/** One machine-readable question parsed from a `json:options` block. */
export interface ParsedQuestion {
  /** Stable id used to correlate the answer (audit trail). / 質問ID */
  id: string;
  /** One-line summary shown as the question heading. / 一行要約 */
  summary: string;
  /** Selectable options (may be empty when freeTextRequired). / 選択肢 */
  options: ParsedQuestionOption[];
  /** True when a free-text answer is required (options alone can't express it). / 自由入力必須か */
  freeTextRequired: boolean;
  /** Why free text is required; non-null only when freeTextRequired. / 自由入力が必要な理由 */
  freeTextReason?: string | null;
  /** `key` of the recommended option, or '' when absent/invalid. / 推奨する選択肢のkey */
  recommended: string;
  /** Rationale for `recommended`, or '' when absent. / 推奨理由 */
  recommendedReason: string;
}

/** Parsed content of a `json:options` fenced block. */
export interface ParsedQuestionBlock {
  questions: ParsedQuestion[];
  /**
   * Optional explicit question kind at the TOP LEVEL of the block (sibling of
   * `questions`), e.g. `"kind": "execution_continuation"`. Only
   * `execution_continuation`/`completion_confirmation` are meaningful here —
   * `spec_change` is reserved for intake questions and is never read from
   * this field (see question-kind-resolver.ts). Absent/invalid values parse
   * as `undefined`, never an error. / 明示指定されたkind
   */
  kind?: string;
}

const OPTIONS_BLOCK_RE = /```json:options\s*\n([\s\S]*?)```/;

/**
 * Parse the machine-readable `json:options` fenced block from a question.md
 * body. Returns `null` for ANY non-viable input (missing block, malformed
 * JSON, a question with neither options nor freeTextRequired) so callers can
 * treat "can't parse" and "not eligible" as separate, sequential checks. Never
 * throws.
 *
 * @param content - The question.md body. / question.md 本文
 * @returns The parsed block, or `null` when absent/invalid. / パース結果、無効時は null
 */
export function parseQuestionOptionsBlock(content: string): ParsedQuestionBlock | null {
  try {
    const match = (content ?? '').match(OPTIONS_BLOCK_RE);
    if (!match) return null;
    const parsed: unknown = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    const questionsRaw = (parsed as { questions?: unknown }).questions;
    if (!Array.isArray(questionsRaw) || questionsRaw.length === 0) return null;

    const questions: ParsedQuestion[] = [];
    for (const raw of questionsRaw) {
      if (!raw || typeof raw !== 'object') return null;
      const q = raw as Record<string, unknown>;
      const id = q.id;
      const summary = q.summary;
      if (typeof id !== 'string' || !id.trim() || typeof summary !== 'string' || !summary.trim()) {
        return null;
      }
      const options: ParsedQuestionOption[] = [];
      if (Array.isArray(q.options)) {
        for (const rawOption of q.options) {
          if (!rawOption || typeof rawOption !== 'object') continue;
          const o = rawOption as Record<string, unknown>;
          if (typeof o.key !== 'string' || !o.key.trim() || typeof o.label !== 'string') continue;
          options.push({
            key: o.key,
            label: o.label,
            consequence: typeof o.consequence === 'string' ? o.consequence : '',
            mutatesGate: o.mutatesGate === true,
          });
        }
      }
      const freeTextRequired = q.freeTextRequired === true;
      const freeTextReason = typeof q.freeTextReason === 'string' ? q.freeTextReason : null;
      // Neither answerable path is available — this question can't be rendered/answered.
      if (!freeTextRequired && options.length === 0) return null;
      questions.push({
        id,
        summary,
        options,
        freeTextRequired,
        freeTextReason,
        recommended: typeof q.recommended === 'string' ? q.recommended : '',
        recommendedReason: typeof q.recommendedReason === 'string' ? q.recommendedReason : '',
      });
    }
    const topLevelKind = (parsed as { kind?: unknown }).kind;
    return {
      questions,
      ...(typeof topLevelKind === 'string' ? { kind: topLevelKind } : {}),
    };
  } catch {
    return null;
  }
}

/** Result of {@link isQuestionBlockEligibleForAutoAnswer}. */
export interface AutoAnswerEligibility {
  eligible: boolean;
  /** Human-readable reason, present only when `eligible` is false. / 対象外の理由 */
  reason?: string;
}

/**
 * Whether every question in a parsed block can be safely auto-answered with
 * its recommended option. Any single ineligible question disqualifies the
 * WHOLE block — the existing answer handlers apply one answer payload per
 * task, so a partial auto-answer is not a supported input shape.
 *
 * @param block - Parsed `json:options` content. / パース済みブロック
 * @returns Eligibility and, when ineligible, why. / 適格性と理由
 */
export function isQuestionBlockEligibleForAutoAnswer(
  block: ParsedQuestionBlock,
): AutoAnswerEligibility {
  for (const q of block.questions) {
    if (q.freeTextRequired) {
      return { eligible: false, reason: `question ${q.id} requires free text` };
    }
    if (!q.recommendedReason.trim()) {
      return { eligible: false, reason: `question ${q.id} has no recommendedReason` };
    }
    const option = q.options.find((o) => o.key === q.recommended);
    if (!option) {
      return {
        eligible: false,
        reason: `question ${q.id} recommended key "${q.recommended}" is not a valid option`,
      };
    }
    if (option.mutatesGate) {
      return {
        eligible: false,
        reason: `question ${q.id} recommended option "${option.key}" mutates a gate`,
      };
    }
  }
  return { eligible: true };
}

/** Result of {@link composeAutoAnswerText}. */
export interface ComposedAutoAnswer {
  /** Answer text in the same `## <id>: <summary>` shape composeStructuredAnswer (frontend) produces. / 合成回答文 */
  answerText: string;
  /** Audit list of which option was auto-selected per question. / 自動選択監査 */
  selections: { questionId: string; selectedKey: string }[];
}

/**
 * Compose the answer text + selections audit list for auto-adopting each
 * question's recommended option. Only call on a block that already passed
 * {@link isQuestionBlockEligibleForAutoAnswer} — this does not re-validate.
 *
 * @param block - Parsed `json:options` content. / パース済みブロック
 * @returns The composed answer text and selections audit list. / 合成回答と選択監査
 */
export function composeAutoAnswerText(block: ParsedQuestionBlock): ComposedAutoAnswer {
  const parts: string[] = [];
  const selections: { questionId: string; selectedKey: string }[] = [];
  for (const q of block.questions) {
    const option = q.options.find((o) => o.key === q.recommended);
    const body = option
      ? option.consequence
        ? `選択: ${option.label}（影響: ${option.consequence}）`
        : `選択: ${option.label}`
      : '';
    parts.push(`## ${q.id}: ${q.summary}\n${body}`);
    selections.push({ questionId: q.id, selectedKey: q.recommended });
  }
  return { answerText: parts.join('\n\n'), selections };
}
