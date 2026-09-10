/**
 * Critic Lessons
 *
 * The cross-task learning loop for the quality gates: aggregates the reasons
 * past artifacts (any task) were bounced — research/plan critic findings,
 * verify.md output-discipline rejections, and adversarial diff-review
 * rejections — distills them into a generalized pre-writing checklist, and
 * renders it for injection into the producing role's context BEFORE
 * generation. This moves recurring findings from the post-hoc gate (bounce =
 * expensive rework) to the prompt (prevention = free), leaving the gates to
 * catch NEW kinds of misses. Same-task bounce feedback is NOT this module —
 * see buildCriticFeedback.
 */
import { prisma } from '../../../config/database';
import { createLogger } from '../../../config/logger';
import { sendAIMessage, getDefaultProvider, isAnyApiKeyConfigured } from '../../../utils/ai-client';
import type { CriticPhase } from './phase-critic-types';
import { createHash } from 'node:crypto';
import { readCriticLessonCache, writeCriticLessonCache } from './critic-lesson-cache';

const log = createLogger('workflow:critic-lessons');

/**
 * A lesson stream: which role's recurring bounce reasons feed which checklist.
 * research/plan = phase-critic findings; verify = verify.md rejections
 * (honesty/output-discipline); implement = adversarial diff-review rejections.
 */
export type LessonStream = CriticPhase | 'verify' | 'implement';

/** How a stream sources and filters its bounce reasons. */
interface StreamSpec {
  /** WorkflowTransition.cause values to aggregate. */
  causes: string[];
  /** Where the reason text lives in the transition metadata. */
  shape: 'reasons-array' | 'reason-string';
  /** Keep only reasons that carry a generalizable lesson. */
  include?: (reason: string) => boolean;
}

const STREAMS: Record<LessonStream, StreamSpec> = {
  research: {
    causes: ['research_critic_failed', 'research_critic_exhausted'],
    shape: 'reasons-array',
  },
  plan: { causes: ['plan_critic_failed', 'plan_critic_exhausted'], shape: 'reasons-array' },
  verify: {
    causes: ['verify_repair'],
    shape: 'reason-string',
    // Only rejections about verify.md ITSELF (self-contradiction, discipline).
    // "explicitly marks the verification as failed" is the gate working as
    // intended on a genuinely bad implementation — no lesson for the verifier.
    include: (r) => r.includes('verify.md') && !r.includes('explicitly marks'),
  },
  implement: {
    causes: ['verify_repair'],
    shape: 'reason-string',
    // Adversarial diff-review rejections describe what the IMPLEMENTATION
    // got bounced for (scope drift, missing planned files, acceptance-criteria
    // misreads) — the implementer's lesson stream.
    include: (r) => r.startsWith('差分レビュー不合格'),
  },
};

/** Latest N critic-failure transitions considered per phase. */
const SOURCE_WINDOW = 80;
/** Minimum source reasons before distilling — thin evidence overfits. */
const MIN_REASONS = 4;
/** Findings must recur across at least this many distinct tasks. */
const MIN_TASKS = 2;
/** Max checklist items injected — a nudge, not a wall. */
const MAX_LESSONS = 8;
/** Per-item length cap; longer items are distillation failures, dropped. */
const MAX_LESSON_CHARS = 160;
/** Re-distill at most this often even when no new failures arrive. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Cap on the reason text handed to the distiller. */
const MAX_SOURCE_CHARS = 7000;

interface CacheEntry {
  /** Source contents and distillation instructions — edits also invalidate. */
  fingerprint: string;
  at: number;
  bullets: string[];
}

const cache = new Map<LessonStream, CacheEntry>();

/**
 * Whether cross-task critic-lesson injection is enabled (default ON).
 * Set RAPITAS_CRITIC_LESSONS=0/false/off to opt out.
 */
export function isCriticLessonsEnabled(): boolean {
  const v = (process.env.RAPITAS_CRITIC_LESSONS || '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * Tolerantly parse the distiller's response into checklist bullets.
 * Invalid/oversized items are dropped rather than failing the whole set.
 *
 * @param content - Raw model response. / モデル応答の生文字列
 * @returns Validated bullets (possibly empty). / 検証済みチェック項目
 */
export function parseLessonsResponse(content: string): string[] {
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0 && x.length <= MAX_LESSON_CHARS)
      .slice(0, MAX_LESSONS);
  } catch {
    return [];
  }
}

/** Human labels per stream, used in the section header and distill prompt. */
const STREAM_LABELS: Record<
  LessonStream,
  { artifact: string; ja: string; en: string; distillSubject: string }
> = {
  research: {
    artifact: 'research.md',
    ja: '過去タスクで頻出した見落とし観点（research.md 事前チェックリスト）',
    en: 'Recurring misses from past tasks (research.md pre-writing checklist)',
    distillSubject: '調査レポート(research.md)が品質ゲートに指摘された理由',
  },
  plan: {
    artifact: 'plan.md',
    ja: '過去タスクで頻出した見落とし観点（plan.md 事前チェックリスト）',
    en: 'Recurring misses from past tasks (plan.md pre-writing checklist)',
    distillSubject: '実装計画(plan.md)が品質ゲートに指摘された理由',
  },
  verify: {
    artifact: 'verify.md',
    ja: '過去タスクで頻出した verify.md の差し戻し観点（記述前チェックリスト）',
    en: 'Recurring verify.md rejections from past tasks (pre-writing checklist)',
    distillSubject:
      '検証レポート(verify.md)の記述自体が差し戻された理由（実測結果との自己矛盾・出力規律違反など）',
  },
  implement: {
    artifact: '実装差分',
    ja: '過去タスクで実装が差し戻された頻出観点（実装前チェックリスト）',
    en: 'Recurring implementation rejections from past tasks (pre-coding checklist)',
    distillSubject:
      '実装差分が敵対的レビューで差し戻された理由（スコープ逸脱・計画必須項目の欠落・受入基準の読み違いなど）',
  },
};

/**
 * Render the checklist section, or '' with no bullets.
 *
 * @param bullets - Distilled lesson items. / 蒸留済み観点
 * @param stream - Which artifact the checklist targets. / 対象ストリーム
 * @param language - Output language for the framing text. / 出力言語
 * @returns Markdown section, or ''. / セクション文字列
 */
export function renderLessonsSection(
  bullets: string[],
  stream: LessonStream,
  language: 'ja' | 'en' = 'ja',
): string {
  if (bullets.length === 0) return '';
  const label = STREAM_LABELS[stream];
  const header = language === 'ja' ? `## ${label.ja}` : `## ${label.en}`;
  const intro =
    language === 'ja'
      ? '過去のタスクで品質ゲートがタスク横断で繰り返し指摘した観点です。作業に入る**前に**自己点検し、該当する観点は明示的にカバーしてください。このタスクに該当しない項目は無視して構いません。'
      : 'These viewpoints were repeatedly flagged by the quality gates across past tasks. Self-check BEFORE starting and explicitly cover the applicable ones. Ignore items that do not apply to this task.';
  return `${header}\n\n${intro}\n\n${bullets.map((b) => `- [ ] ${b}`).join('\n')}`;
}

/** Distillation system prompt — generalization ONLY, no invented requirements. */
function distillSystemPrompt(stream: LessonStream): string {
  return `あなたは品質レビューの分析者です。入力は、過去のタスクで「${STREAM_LABELS[stream].distillSubject}」の一覧です。
これらを、今後のタスクで作業前に自己点検できる「一般化されたチェックリスト観点」に要約してください。
厳守事項:
- 提供された指摘の一般化・集約のみを行うこと。一覧に無い新しい要求を発明しない。
- 特定タスク固有の固有名詞（ファイル名・ライブラリ名・プロジェクト名）は残さず、観点として一般化する。
- 繰り返し現れる観点・深刻な観点を優先し、最大${MAX_LESSONS}項目。各項目は1行・80文字以内。
- 出力はJSON配列のみ（前後に説明やコードブロックを付けない）: ["観点1","観点2",...]`;
}

/** Extract a row's lesson-bearing reasons per the stream's metadata shape. */
function extractReasons(spec: StreamSpec, metadata: string): string[] {
  try {
    const meta = JSON.parse(metadata) as { reasons?: unknown; reason?: unknown };
    const raw =
      spec.shape === 'reasons-array'
        ? Array.isArray(meta.reasons)
          ? meta.reasons
          : []
        : typeof meta.reason === 'string'
          ? [meta.reason]
          : [];
    return raw
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim())
      .filter((r) => (spec.include ? spec.include(r) : true));
  } catch {
    return []; // Skip malformed metadata — never fail the whole build on one row.
  }
}

/**
 * Build the cross-task lessons checklist for a stream, distilling (and
 * caching) from recent bounce transitions. Fail-soft: any error returns ''.
 *
 * @param stream - 'research' | 'plan' | 'verify' | 'implement'. / 対象ストリーム
 * @param language - Output language. / 出力言語
 * @returns Markdown section for prompt injection, or ''. / 注入用セクション
 */
export async function buildCriticLessonsSection(
  stream: LessonStream,
  language: 'ja' | 'en' = 'ja',
): Promise<string> {
  if (!isCriticLessonsEnabled()) return '';
  try {
    const spec = STREAMS[stream];
    const rows = await prisma.workflowTransition.findMany({
      where: { cause: { in: spec.causes } },
      orderBy: { createdAt: 'desc' },
      take: SOURCE_WINDOW,
      select: { id: true, taskId: true, metadata: true },
    });

    const reasons: string[] = [];
    const tasks = new Set<number>();
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.metadata) continue;
      for (const r of extractReasons(spec, row.metadata)) {
        if (seen.has(r)) continue;
        seen.add(r);
        reasons.push(r);
        tasks.add(row.taskId);
      }
    }
    // Cross-task requirement: one task's findings are that task's feedback
    // (buildCriticFeedback / verify.md bounce context), not a house-wide lesson.
    if (reasons.length < MIN_REASONS || tasks.size < MIN_TASKS) return '';

    const fingerprint = createHash('sha256')
      .update(JSON.stringify(rows))
      .update(distillSystemPrompt(stream))
      .digest('hex');
    const cached = cache.get(stream);
    if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < CACHE_TTL_MS) {
      return renderLessonsSection(cached.bullets, stream, language);
    }

    const persisted = await readCriticLessonCache(stream, fingerprint, CACHE_TTL_MS);
    if (persisted) {
      cache.set(stream, persisted);
      log.info({ stream }, '[critic-lessons] reused persisted lessons');
      return renderLessonsSection(persisted.bullets, stream, language);
    }

    if (!(await isAnyApiKeyConfigured())) return '';
    const provider = await getDefaultProvider();
    let source = reasons.map((r) => `- ${r}`).join('\n');
    if (source.length > MAX_SOURCE_CHARS) source = source.slice(0, MAX_SOURCE_CHARS);
    const res = await sendAIMessage({
      provider,
      messages: [{ role: 'user', content: source }],
      systemPrompt: distillSystemPrompt(stream),
      maxTokens: 800,
    });
    const bullets = parseLessonsResponse(res.content);
    // Cache even an empty distillation — retrying every prompt build would
    // burn an AI call per failure until the fingerprint changes.
    const entry = { fingerprint, at: Date.now(), bullets };
    cache.set(stream, entry);
    await writeCriticLessonCache(stream, entry);
    log.info(
      { stream, sourceReasons: reasons.length, sourceTasks: tasks.size, lessons: bullets.length },
      '[critic-lessons] distilled cross-task lessons',
    );
    return renderLessonsSection(bullets, stream, language);
  } catch (err) {
    log.debug({ err, stream }, '[critic-lessons] build failed (skipped)');
    return '';
  }
}
