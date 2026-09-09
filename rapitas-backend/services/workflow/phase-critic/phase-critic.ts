/**
 * Phase Critic
 *
 * Brings the judge-panel pattern to the research/plan phases: runs several
 * independent critic "lenses" in parallel over the produced artifact and
 * aggregates their verdicts. Each lens is a lightweight API call (no repo
 * access needed — it critiques the artifact text plus optional grounding
 * context), so this is safe to run within the per-task lock without spawning
 * parallel CLI agents.
 *
 * Generation only — bouncing/rollback lives in phase-critic-gate.ts. Fail-open:
 * when AI is unavailable or every lens errors, the verdict is 'unknown'.
 */
import { createLogger } from '../../../config/logger';
import {
  sendAIMessage,
  getDefaultProvider,
  getDefaultModel,
  isAnyApiKeyConfigured,
  type AIMessage,
} from '../../../utils/ai-client';
import { aggregateCritiques } from './critique-aggregator';
import type { CriticPhase, CriticVerdict, PhaseCritiqueResult } from './phase-critic-types';

const log = createLogger('workflow:phase-critic');

/** A single critic lens: a name and the angle it judges from. */
interface Lens {
  name: string;
  angle: string;
}

/**
 * Per-section input caps (task 911). Kept at their original values — the fix
 * is HOW each section truncates (head+tail, with an explicit marker), not a
 * blanket increase of the limits.
 */
const TASK_BRIEF_MAX_CHARS = 3000;
const REFERENCE_ARTIFACT_MAX_CHARS = 8000;
const ARTIFACT_MAX_CHARS = 16000;
const ACCEPTANCE_CRITERIA_MAX_CHARS = 4000;

/** Marker inserted where a section's middle was cut. */
const TRUNCATION_MARKER =
  '\n\n…[中略: 文字数上限のため中間部分を省略。原文はここで終わっていません]\n\n';

/** Banner prepended to the critic input when any section was truncated. */
const TRUNCATION_BANNER =
  '⚠️ 注意: 以下の文書の一部は文字数上限により中略されています（「…[中略: …]」マーカー参照）。' +
  '中略部分の内容を「記載がない」「未完成」と判定しないでください。' +
  '中略はこの入力の表示上の制約であり、原文の欠落を意味しません。';

/**
 * Truncates text to at most maxChars while preserving BOTH the head and the
 * tail — a long document's opening context (what was investigated) and its
 * closing content (conclusions, corrections, hand-off notes) are both kept
 * visible instead of only the head surviving a naive slice(0, maxChars).
 * Exported for tests.
 *
 * @param text - Text to bound. / 対象テキスト
 * @param maxChars - Maximum length of the returned text. / 上限文字数
 * @returns The bounded text and whether truncation occurred. / 整形結果と切断有無
 */
export function truncateWithNotice(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  const headLen = Math.floor(budget * 0.6);
  const tailLen = budget - headLen;
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : '';
  return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true };
}

/** Lenses per phase — kept few to bound cost. */
const LENSES: Record<CriticPhase, Lens[]> = {
  research: [
    { name: 'completeness', angle: '依存関係・影響範囲・変更対象ファイルの特定に漏れがないか' },
    { name: 'risk', angle: '破壊的変更・後方互換・移行・セキュリティのリスク評価が十分か' },
    { name: 'duplication', angle: '既存実装/重複の調査が不足していないか（車輪の再発明リスク）' },
  ],
  plan: [
    { name: 'feasibility', angle: '計画が調査結果と整合し、実装可能で粒度が適切か' },
    { name: 'acceptance', angle: 'タスクの受入基準を計画が確実に満たすか（抜けがないか）' },
    { name: 'scope', angle: 'スコープ過大/過小、リスク対策・テスト戦略の欠落がないか' },
  ],
};

/**
 * Whether the research/plan critic gate is enabled (default ON — R7).
 * Iterative judge-critique of plans detects defects PRE-execution with ~90%
 * recall (arXiv:2509.02761), and a caught plan defect is far cheaper than the
 * implement→verify→bounce loop it would otherwise cause. Set
 * RAPITAS_PHASE_CRITIC=0/false/off to opt out. Callers additionally skip the
 * gate for lightweight-mode tasks (no plan phase; trivial work stays cheap).
 */
export function isPhaseCriticEnabled(): boolean {
  const v = (process.env.RAPITAS_PHASE_CRITIC || '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * Optional grounding context handed to every lens. Without it the critic can
 * only judge the artifact text in a vacuum — observed failure mode (task 551):
 * the plan critic demanded restating facts that already lived in research.md,
 * and each re-review invented a fresh batch of demands because it never saw
 * what the previous rejection asked for. All fields are best-effort.
 */
export interface CriticContext {
  /** Required grounding could not be loaded; do not judge the artifact in isolation. */
  unavailable?: boolean;
  /** Task title + description the artifact must serve. / タスク要求 */
  taskBrief?: string;
  /** Prior-phase document the artifact builds on (research.md for plan). / 先行フェーズ文書 */
  referenceArtifact?: string;
  /** Reasons from this phase's previous critic rejection. / 前回の差し戻し理由 */
  priorReasons?: string[];
  /**
   * Task's acceptance criteria. Reference material, not a critique target —
   * lets the critic notice when the artifact fails to address a criterion
   * (task 911: without this the gate had no way to see AC3/4/5 at all).
   * / タスクの受入基準。参考資料として渡し、批評対象ではない
   */
  acceptanceCriteria?: string[];
}

/** Build the system prompt for a lens. Exported for tests. */
export function lensSystemPrompt(phase: CriticPhase, lens: Lens): string {
  const artifact = phase === 'research' ? '調査レポート(research.md)' : '実装計画(plan.md)';
  // NOTE: The earlier "甘い合格を出さず、必ず指摘してください" wording forced the
  // LLM to fail nearly every artifact (3 consecutive critiques on task 551, all
  // rejected, each round with brand-new nitpicks) — the gate degenerated into a
  // fixed regenerate-once tax. A critic needs explicit PASS criteria and a
  // convergence rule at least as much as it needs strictness.
  return `あなたは厳格だが公正なレビュアーです。提示された${artifact}を「${lens.angle}」という観点だけで批評してください。
合格基準: ${
    phase === 'research'
      ? 'プランナーが設計を開始できるよう、受入条件ごとの課題・影響範囲・依存関係・リスクが調査されていること。設計の確定や実装手順の完成は求めない。具体的な制御フロー・接続先の関数・停止ガードの採用方法・監査APIの呼出方法は計画フェーズで確定してよい。これらの具体化をプランナーに残しているだけではfailにしない。受入条件そのものの見落とし、事実との矛盾、設計を開始できない重大な未調査だけをfailにする。'
      : '次フェーズの担当者が追加の質問なしに作業へ進める情報が揃っていること。次フェーズが高確率で手戻りする重大な欠落・誤りがある場合のみ pass=false とすること。'
  }
受入条件の充足は見出しや「対応済み」という自己申告ではなく、提案の適用対象・除外条件・実際の動作と照合してください。特定のパス・語句・事例だけを扱う提案が、より広い受入条件を満たすとは限りません。文書が明示的に対象外とした必須ケースは、省略部分に記述があると推測して免除しないでください。
次のものを fail の理由にしてはならない:
- 参考資料（タスク要求・先行フェーズ文書）に既に記載されている情報の${artifact}への再記載要求
- 実装時に自明に決まる細部（ログレベル・ファイル配置・変数名など）の事前確定要求
- 文体・見出し名・体裁など、内容の正しさに影響しない指摘
- 「前回の批評指摘」が提示されている場合: それらが解消済みなら、前回と同等以下の重要度の新規指摘のみを理由とした fail（指摘の後出しで永遠に不合格にしない）
- 本文中に「…[中略: …]」という省略マーカーがある場合、その省略部分の内容が「無い」「途中で切れている」ことを理由にした fail（省略は表示上の制約であり、原文の欠落ではない）${
    phase === 'research'
      ? '\n- research.md（調査）の段階でplan.md（計画）が確定すべき実装詳細（関数シグネチャ・具体的なコード差分・変更前後の行番号・挿入位置の一意な決定）の事前確定要求。research.mdの役割は影響範囲・依存関係・リスクの調査であり、設計の確定はplanフェーズの責務'
      : ''
  }
出力は次のJSONのみ（前後に説明やコードブロックを付けない）:
{"pass":true|false,"severity":0-100,"issues":["具体的な指摘",...]}
- pass=false のとき issues に対応すべき具体的指摘を1件以上。
- severity は問題の深刻度（pass=true なら 0）。`;
}

/**
 * Assemble the user message a lens critiques: grounding sections first (marked
 * as reference material, not critique targets), the artifact last. Every
 * section is head+tail truncated independently via {@link truncateWithNotice}
 * (task 911) so no section is silently cut, and a warning banner is prepended
 * whenever any section was. Pure — exported for tests.
 *
 * @param content - Artifact body. / アーティファクト本文
 * @param context - Optional grounding context. / 参考資料
 * @returns The composed user message and whether any section was truncated. / レンズに渡す本文と切断有無
 */
export function buildCriticUserMessage(
  content: string,
  context?: CriticContext,
): { message: string; truncated: boolean } {
  const parts: string[] = [];
  let truncated = false;

  if (context?.taskBrief?.trim()) {
    const t = truncateWithNotice(context.taskBrief, TASK_BRIEF_MAX_CHARS);
    truncated = truncated || t.truncated;
    parts.push(`# タスク要求（参考資料 — 批評対象ではない）\n${t.text}`);
  }
  if (context?.acceptanceCriteria?.length) {
    const list = context.acceptanceCriteria.map((c) => `- ${c}`).join('\n');
    const t = truncateWithNotice(list, ACCEPTANCE_CRITERIA_MAX_CHARS);
    truncated = truncated || t.truncated;
    parts.push(
      `# 受入基準（参考資料 — 批評対象ではない。満たせているか判断材料にすること）\n${t.text}`,
    );
  }
  if (context?.referenceArtifact?.trim()) {
    const t = truncateWithNotice(context.referenceArtifact, REFERENCE_ARTIFACT_MAX_CHARS);
    truncated = truncated || t.truncated;
    parts.push(
      `# 先行フェーズ文書（参考資料 — 批評対象ではない。ここに既にある情報の再記載を要求しないこと）\n${t.text}`,
    );
  }
  if (context?.priorReasons?.length) {
    const reasons = context.priorReasons
      .slice(0, 8)
      .map((r) => `- ${r}`)
      .join('\n');
    parts.push(`# 前回の批評指摘（この文書は指摘を受けて改訂済み）\n${reasons}`);
  }
  {
    const t = truncateWithNotice(content, ARTIFACT_MAX_CHARS);
    truncated = truncated || t.truncated;
    parts.push(`# 批評対象アーティファクト\n${t.text}`);
  }

  const message = truncated ? `${TRUNCATION_BANNER}\n\n${parts.join('\n\n')}` : parts.join('\n\n');
  return { message, truncated };
}

/** Tolerantly parse a lens response. On parse failure, default to pass (no false block). */
export function parseCriticResponse(content: string, lens: string): CriticVerdict {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return { lens, pass: true, severity: 0, issues: [] };
  try {
    const parsed = JSON.parse(match[0]) as {
      pass?: unknown;
      severity?: unknown;
      issues?: unknown;
    };
    const pass = parsed.pass !== false; // anything but explicit false = pass
    const severity =
      typeof parsed.severity === 'number'
        ? Math.max(0, Math.min(100, parsed.severity))
        : pass
          ? 0
          : 50;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
      : [];
    return { lens, pass, severity, issues };
  } catch {
    return { lens, pass: true, severity: 0, issues: [] };
  }
}

/**
 * Critique a research/plan artifact across all lenses and aggregate the verdict.
 *
 * @param phase - Which artifact is being judged. / 判定対象フェーズ
 * @param content - The artifact's markdown body. / アーティファクト本文
 * @param context - Optional grounding (task brief / prior phase doc / prior reasons). / 参考資料
 * @returns Aggregated verdict ('unknown' when critics could not run). / 集約結果
 */
export async function critiquePhase(
  phase: CriticPhase,
  content: string,
  context?: CriticContext,
): Promise<PhaseCritiqueResult> {
  if (context?.unavailable) {
    return {
      verdict: 'unknown',
      severity: 0,
      reasons: ['Required critique context could not be loaded'],
      inputTruncated: false,
      evaluationComplete: false,
    };
  }
  if (!content.trim())
    return { verdict: 'unknown', severity: 0, reasons: [], inputTruncated: false };
  if (!(await isAnyApiKeyConfigured()))
    return { verdict: 'unknown', severity: 0, reasons: [], inputTruncated: false };

  let provider: Awaited<ReturnType<typeof getDefaultProvider>>;
  let model: string;
  try {
    provider = await getDefaultProvider();
    model = await getDefaultModel(provider);
  } catch {
    return { verdict: 'unknown', severity: 0, reasons: [], inputTruncated: false };
  }

  const lenses = LENSES[phase];
  const { message: userMessage, truncated: inputTruncated } = buildCriticUserMessage(
    content,
    context,
  );
  const verdicts = await Promise.all(
    lenses.map(async (lens): Promise<CriticVerdict | null> => {
      try {
        const messages: AIMessage[] = [{ role: 'user', content: userMessage }];
        const res = await sendAIMessage({
          provider,
          model,
          messages,
          systemPrompt: lensSystemPrompt(phase, lens),
          maxTokens: 800,
        });
        return parseCriticResponse(res.content, lens.name);
      } catch (err) {
        log.warn({ err, phase, lens: lens.name }, '[phase-critic] lens failed (skipped)');
        return null;
      }
    }),
  );

  const aggregated = aggregateCritiques(verdicts.filter((v): v is CriticVerdict => v !== null));
  const evaluationComplete = verdicts.every((v) => v !== null);
  const result: PhaseCritiqueResult = {
    ...aggregated,
    // A partial document cannot establish that the whole artifact passed.
    verdict: inputTruncated && aggregated.verdict === 'pass' ? 'unknown' : aggregated.verdict,
    inputTruncated,
    evaluationComplete,
  };
  log.info(
    {
      phase,
      verdict: result.verdict,
      severity: result.severity,
      lenses: lenses.length,
      evaluationComplete,
      inputTruncated,
    },
    '[phase-critic] critique complete',
  );
  return result;
}
