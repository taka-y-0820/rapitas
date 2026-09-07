/**
 * PromptEvolutionAddendumQuality
 *
 * Pure text checks that reject LLM-authored prompt addenda which cannot be
 * injected into a role prompt as an instruction — a bare code fence, a text
 * that only asks questions, or a request for an instruction file the agent
 * has no way to supply. Not responsible for judging whether a well-formed
 * addendum is a GOOD idea (that is the settlement measurement's job), nor for
 * the deletion-signal guard (see isPureAddendum in prompt-evolution-settle).
 */

/** Why an addendum is unusable as an injected instruction. */
export type AddendumQualityReason =
  | 'code_fence_only'
  | 'question_only'
  | 'instruction_file_request';

export interface AddendumQualityResult {
  valid: boolean;
  reason?: AddendumQualityReason;
}

/**
 * Fenced blocks (```...```), including an unterminated trailing fence. The
 * generator is asked for imperative bullets, so a response made ONLY of these
 * carries no instruction for the agent to follow.
 */
const CODE_FENCE_BLOCK = /```[\s\S]*?(?:```|$)/g;

/** Leading list/heading markers stripped before judging a line's shape. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)]|#{1,6})\s*/;

/**
 * Requests for an external instruction/spec file. Such an addendum asks the
 * OPERATOR for input rather than telling the agent what to do, so injecting it
 * makes every run of the role beg for a file that will never arrive.
 */
const INSTRUCTION_FILE_REQUEST = /指示ファイル|指示書|instruction\s*file|instructions\s*file/i;

/**
 * Strip fenced code blocks and return the remaining prose.
 *
 * @param addendum - Raw addendum text. / 生の追記文
 * @returns Text outside every fenced block. / コードフェンス外のテキスト
 */
function stripCodeFences(addendum: string): string {
  return addendum.replace(CODE_FENCE_BLOCK, ' ');
}

/**
 * Meaningful lines: non-blank, with list/heading markers removed.
 *
 * @param text - Prose to split. / 対象テキスト
 * @returns Content lines without their markers. / マーカーを除いた本文行
 */
function contentLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Whether an addendum is usable as an injected role-prompt instruction.
 *
 * NOTE: an empty / whitespace-only addendum also reports `code_fence_only` —
 * the first check is "no instructional prose survives fence removal", and a
 * blank string trivially satisfies it. Callers that care about the empty case
 * specifically should test it before calling.
 *
 * @param addendum - Generated addendum text. / 生成された追記文
 * @returns Validity plus the first failing reason. / 妥当性と最初の不合格理由
 */
export function validateAddendumQuality(addendum: string): AddendumQualityResult {
  const lines = contentLines(stripCodeFences(addendum ?? ''));
  if (lines.length === 0) return { valid: false, reason: 'code_fence_only' };

  if (lines.some((line) => INSTRUCTION_FILE_REQUEST.test(line))) {
    return { valid: false, reason: 'instruction_file_request' };
  }

  if (lines.every((line) => /[?？]\s*$/.test(line))) {
    return { valid: false, reason: 'question_only' };
  }

  return { valid: true };
}
