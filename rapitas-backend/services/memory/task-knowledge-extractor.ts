/**
 * Task Knowledge Auto-Extraction Service
 *
 * On task completion, extracts lessons learned from verify.md, comments, and
 * execution logs, registers them as KnowledgeEntry records, and presents
 * related knowledge when similar tasks are created.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { sendAIMessage } from '../../utils/ai-client';
import { parseJsonArray } from '../../utils/common/json-extractor';
import { createContentHash } from './utils';
import { appendEvent } from './timeline';
import { memoryTaskQueue } from './index';
import { getInsensitiveMode } from '../../config/db-provider';
import { findSemanticDuplicate, findLexicalDuplicate } from './dedup';
import { boostDecayOnAccess } from './forgetting';
import { readWorkflowFile } from '../workflow/workflow-file-utils';
import { notifyKnowledgeExtracted } from '../communication/notification-service';

const log = createLogger('memory:task-knowledge');

/**
 * Auto-extract and register knowledge on task completion.
 *
 * @param taskId - Completed task ID
 * @returns Array of created KnowledgeEntry IDs
 */
export async function extractKnowledgeFromTask(taskId: number): Promise<number[]> {
  const entryIds: number[] = [];

  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        theme: { include: { category: true } },
        comments: { orderBy: { createdAt: 'desc' }, take: 10 },
        taskLabels: { include: { label: true } },
      },
    });

    if (!task) {
      log.warn({ taskId }, 'Task not found for knowledge extraction');
      return entryIds;
    }

    // NOTE: Only DEVELOPMENT tasks (themes with a workingDirectory) are mined —
    // operator decision 2026-09-05: study/personal tasks yield noise knowledge, and
    // the synchronous DB/similarity work stalled the event loop 2-3s per manual completion.
    if (!task.theme?.workingDirectory) {
      log.debug({ taskId }, 'Skipping knowledge extraction — theme has no workingDirectory');
      return entryIds;
    }

    // Load verify.md content
    const verifyContent = (await readWorkflowFile(taskId, 'verify')) ?? '';

    // Build extraction context
    const context = buildExtractionContext(task, verifyContent);

    if (context.length < 50) {
      log.debug({ taskId }, 'Insufficient context for knowledge extraction');
      return entryIds;
    }

    // Extract knowledge via AI
    const extracted = await extractWithAI(context, task.title);

    for (const item of extracted) {
      // Duplicate check by content hash
      const existing = await prisma.knowledgeEntry.findFirst({
        where: {
          contentHash: createContentHash(item.content),
          forgettingStage: { not: 'archived' },
        },
      });

      if (existing) {
        log.debug({ taskId, title: item.title }, 'Duplicate knowledge entry, skipping');
        continue;
      }

      // Near-duplicate (same lesson, different wording) — reinforce the
      // existing entry instead of storing a paraphrase. This is the main cure for
      // the ~11-near-duplicates-per-task bloat: corroboration strengthens one
      // memory rather than spawning many. Two channels: embedding cosine plus
      // the lexical bigram fallback (cosine misses Japanese paraphrases — the
      // failure mode behind the contradiction-backlog explosion).
      const dupId =
        (await findSemanticDuplicate(item.content)) ??
        (await findLexicalDuplicate(item.title, item.content));
      if (dupId != null) {
        await boostDecayOnAccess(dupId, 0.1).catch(() => {});
        log.debug(
          { taskId, title: item.title, dupId },
          'Near-duplicate knowledge — reinforced existing instead of inserting',
        );
        continue;
      }

      const entry = await prisma.knowledgeEntry.create({
        data: {
          sourceType: 'task_pattern',
          sourceId: `task_${taskId}`,
          title: item.title,
          content: item.content,
          contentHash: createContentHash(item.content),
          category: item.category,
          tags: JSON.stringify(['auto_extracted', ...task.taskLabels.map((tl) => tl.label.name)]),
          confidence: 0.7,
          themeId: task.themeId,
          taskId: task.id,
          validationStatus: 'pending',
        },
      });

      entryIds.push(entry.id);

      // Queue background embedding generation
      await memoryTaskQueue.enqueue('embed', { entryId: entry.id, content: item.content }, 10);
      await memoryTaskQueue.enqueue('validate', { entryId: entry.id }, 5);
      await memoryTaskQueue.enqueue('detect_contradiction', { entryId: entry.id }, 3);
    }

    if (entryIds.length > 0) {
      await appendEvent({
        eventType: 'task_knowledge_extracted',
        actorType: 'system',
        payload: { taskId, entriesCreated: entryIds.length, entryIds },
      });

      await notifyKnowledgeExtracted(taskId, task.title, entryIds);

      log.info({ taskId, count: entryIds.length }, 'Knowledge extracted from task');
    }
  } catch (error) {
    log.error({ err: error, taskId }, 'Failed to extract knowledge from task');
  }

  return entryIds;
}

/** WorkflowTransition causes worth reflecting on (a task hit trouble / failed). */
const FAILURE_CAUSES = [
  'verify_repair',
  'ci_repair',
  'adversarial_review_failed',
  'verify_validation_failed',
  'verify_no_changes',
  'verify_pr_not_created',
  'auto_merge_blocked',
  'log_polluted_rejected',
];

/**
 * Reflexion (Shinn 2023): on a task that FAILED or needed repair, distil a
 * concrete, transferable lesson ("what went wrong → what to do instead") and
 * store it as knowledge so similar future tasks retrieve+inject it. Failures are
 * the richest learning signal, yet the success-only extractor ignored them — this
 * is what lets the loop get smarter from its mistakes. Best-effort; never throws.
 *
 * Stored as sourceType 'failure_lesson', which the recall path
 * (findRelatedKnowledge / buildMemoryContext) surfaces like any knowledge —
 * trust-weighted, decayed, deduped, validated by the same background queue.
 *
 * @param taskId - The task that reached a terminal failure. / 失敗したタスク
 * @param finalStatus - Terminal status (reflects when not 'completed' or trouble fired). / 終端状態
 * @returns Created knowledge entry ids. / 作成した知識ID
 */
export async function reflectOnFailure(taskId: number, finalStatus: string): Promise<number[]> {
  const entryIds: number[] = [];
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        theme: { include: { category: true } },
        comments: { orderBy: { createdAt: 'desc' }, take: 5 },
        taskLabels: { include: { label: true } },
      },
    });
    if (!task) return entryIds;

    // The WHY: which trouble causes fired and how often (the failure's shape).
    const troubles = await prisma.workflowTransition
      .groupBy({
        by: ['cause'],
        where: { taskId, cause: { in: FAILURE_CAUSES } },
        _count: { cause: true },
      })
      .catch(() => [] as { cause: string | null; _count: { cause: number } }[]);
    const causeSummary = troubles.map((t) => `${t.cause} ×${t._count.cause}`).join(', ');
    // A clean completion with no trouble has no failure to reflect on.
    if (!causeSummary && finalStatus === 'completed') return entryIds;

    const verifyContent = (await readWorkflowFile(taskId, 'verify').catch(() => null)) ?? '';
    const context = [
      `タスク: ${task.title}`,
      task.description ? `説明: ${task.description.slice(0, 400)}` : '',
      `最終状態: ${finalStatus}`,
      causeSummary ? `発生したトラブル: ${causeSummary}` : '',
      verifyContent ? `検証レポート(抜粋):\n${verifyContent.slice(0, 1500)}` : '',
      task.comments.length
        ? `コメント:\n${task.comments
            .slice(0, 3)
            .map((c) => c.content)
            .join('\n')
            .slice(0, 400)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (context.length < 60) return entryIds;

    const lessons = await extractFailureLessonWithAI(context);
    for (const item of lessons) {
      const hash = createContentHash(item.content);
      const existing = await prisma.knowledgeEntry.findFirst({
        where: { contentHash: hash, forgettingStage: { not: 'archived' } },
      });
      if (existing) continue;
      const dupId =
        (await findSemanticDuplicate(item.content)) ??
        (await findLexicalDuplicate(item.title, item.content));
      if (dupId != null) {
        await boostDecayOnAccess(dupId, 0.15).catch(() => {});
        continue;
      }
      const entry = await prisma.knowledgeEntry.create({
        data: {
          sourceType: 'failure_lesson',
          sourceId: `task_${taskId}`,
          title: item.title,
          content: item.content,
          contentHash: hash,
          category: item.category,
          tags: JSON.stringify([
            'reflexion',
            'failure',
            ...task.taskLabels.map((tl) => tl.label.name),
          ]),
          // A failure is a concrete, high-signal lesson — slightly above the
          // success extractor's 0.7 so it ranks in retrieval.
          confidence: 0.75,
          themeId: task.themeId,
          taskId: task.id,
          validationStatus: 'pending',
        },
      });
      entryIds.push(entry.id);
      await memoryTaskQueue.enqueue('embed', { entryId: entry.id, content: item.content }, 10);
      await memoryTaskQueue.enqueue('validate', { entryId: entry.id }, 5);
    }
    if (entryIds.length > 0) {
      await appendEvent({
        eventType: 'task_knowledge_extracted',
        actorType: 'system',
        payload: {
          taskId,
          finalStatus,
          entryIds,
          causes: causeSummary,
          kind: 'failure_reflection',
        },
      }).catch(() => {});
      log.info(
        { taskId, count: entryIds.length, causes: causeSummary },
        '[reflexion] Distilled failure lessons',
      );
    }
  } catch (err) {
    log.warn({ err, taskId }, '[reflexion] reflectOnFailure failed');
  }
  return entryIds;
}

/** Reflexion-framed extraction: a lesson to AVOID this failure next time. */
async function extractFailureLessonWithAI(context: string): Promise<ExtractedKnowledge[]> {
  try {
    const response = await sendAIMessage({
      messages: [
        {
          role: 'user',
          content: `次のタスクは失敗または修復を要しました。この失敗から、**今後の類似タスクで同じ失敗を避けるための、具体的で転用可能な教訓**を抽出してください。

${context}

純粋なJSON配列のみ（マークダウンのコードブロックなし）:
[
  { "title": "教訓の要点（簡潔）", "content": "何が問題で、次回どうすべきか。可能なら file:line / パターン名 / テスト名で具体化する", "category": "procedure|pattern|insight" }
]

ルール:
- 汎用的で転用可能なもののみ（このタスク固有の些末は除外）
- 最大2件
- 抽出すべき教訓が無ければ []`,
        },
      ],
      maxTokens: 700,
    });
    const parsed = parseJsonArray<ExtractedKnowledge>(response.content.trim());
    if (!parsed) return [];
    const valid = ['procedure', 'pattern', 'insight', 'fact', 'preference', 'general'];
    return parsed
      .filter((i) => i.title && i.content)
      .map((i) => ({ ...i, category: valid.includes(i.category) ? i.category : 'insight' }))
      .slice(0, 2);
  } catch (err) {
    log.warn({ err }, '[reflexion] extractFailureLessonWithAI failed');
    return [];
  }
}

/**
 * Search and return related knowledge when creating/editing a task.
 */
export async function findRelatedKnowledge(
  title: string,
  description?: string | null,
  themeId?: number | null,
  limit: number = 5,
): Promise<
  Array<{
    id: number;
    title: string;
    content: string;
    category: string;
    confidence: number;
    relevanceScore: number;
  }>
> {
  try {
    // Keyword-based search (fallback when vector search is unavailable)
    const searchText = `${title} ${description || ''}`.toLowerCase();
    const keywords = searchText
      .split(/[\s\-_\/\\:;,.\(\)\[\]{}]+/)
      .filter((w) => w.length >= 2)
      .slice(0, 8);

    if (keywords.length === 0) return [];

    // Search active knowledge with theme matching.
    // NOTE: `mode: 'insensitive'` is PostgreSQL-only; SQLite Prisma clients
    // reject it as an unknown argument. We already lower-case the keywords
    // above (L140), and Japanese (the dominant content language) has no
    // case distinction, so dropping `mode` is functionally equivalent and
    // works on both database backends.
    // Knowledge governance: NEVER inject knowledge a validation step rejected or
    // flagged as contradictory — injecting bad/conflicting knowledge biases the
    // agent and amplifies errors (the "context failure" / self-improvement-loop
    // risk). `pending` is still allowed (it's the bulk of auto-extracted
    // knowledge); `validated` is boosted in scoring below.
    const where: Record<string, unknown> = {
      forgettingStage: { in: ['active', 'dormant'] },
      validationStatus: { notIn: ['rejected', 'conflict'] },
      OR: keywords.map((kw) => ({
        OR: [{ title: { contains: kw } }, { content: { contains: kw } }],
      })),
    };

    const entries = await prisma.knowledgeEntry.findMany({
      where,
      select: {
        id: true,
        title: true,
        content: true,
        category: true,
        confidence: true,
        decayScore: true,
        themeId: true,
        tags: true,
        validationStatus: true,
      },
      // Tertiary `id` key breaks ties when both decayScore and confidence
      // match — otherwise which entries survive the take/slice boundary
      // (and their relative order) could vary run to run.
      orderBy: [{ decayScore: 'desc' }, { confidence: 'desc' }, { id: 'asc' }],
      take: limit * 3, // Fetch extra for post-scoring
    });

    // Relevance scoring
    const scored = entries.map((entry) => {
      let relevanceScore = 0;

      // Keyword match count
      const entryText = `${entry.title} ${entry.content}`.toLowerCase();
      const matchCount = keywords.filter((kw) => entryText.includes(kw)).length;
      relevanceScore += (matchCount / keywords.length) * 50;

      // Theme match bonus
      if (themeId && entry.themeId === themeId) {
        relevanceScore += 30;
      }

      // Confidence and decay score
      relevanceScore += entry.confidence * 10;
      relevanceScore += entry.decayScore * 10;

      // Prefer human/automatically VALIDATED knowledge over still-pending entries.
      if (entry.validationStatus === 'validated') relevanceScore += 15;

      return {
        id: entry.id,
        title: entry.title,
        content: entry.content.slice(0, 500),
        category: entry.category,
        confidence: entry.confidence,
        relevanceScore: Math.round(relevanceScore * 100) / 100,
        /** True when this knowledge came from a different project/theme. */
        isCrossProject: themeId ? entry.themeId !== themeId : false,
        sourceThemeId: entry.themeId,
      };
    });

    // Secondary `id` key breaks ties on identical relevanceScore — this list
    // feeds the related-knowledge context in the next prompt.
    return scored
      .sort((a, b) => b.relevanceScore - a.relevanceScore || a.id - b.id)
      .slice(0, limit);
  } catch (error) {
    log.error({ err: error }, 'Failed to find related knowledge');
    return [];
  }
}

/**
 * Search knowledge across ALL projects, explicitly surfacing cross-project insights.
 * Groups results by source theme to show "where this knowledge came from."
 *
 * @param query - Search query text / 検索クエリ
 * @param excludeThemeId - Current theme to de-prioritize (still included but flagged) / 除外するテーマ
 * @param limit - Max results / 最大結果数
 * @returns Knowledge grouped by source project / ソースプロジェクト別にグループ化された知識
 */
export async function searchCrossProjectKnowledge(
  query: string,
  excludeThemeId?: number | null,
  limit: number = 10,
): Promise<{
  results: Array<{
    id: number;
    title: string;
    content: string;
    category: string;
    confidence: number;
    relevanceScore: number;
    isCrossProject: boolean;
    sourceThemeId: number | null;
    sourceThemeName?: string;
  }>;
  totalAcrossProjects: number;
  projectCount: number;
}> {
  try {
    const keywords = query
      .toLowerCase()
      .split(/[\s\-_\/\\:;,.\(\)\[\]{}]+/)
      .filter((w) => w.length >= 2)
      .slice(0, 10);

    if (keywords.length === 0) return { results: [], totalAcrossProjects: 0, projectCount: 0 };

    // NOTE: keywords are already lower-cased (line 244-248) so SQLite hits lower-case DB entries.
    const entries = await prisma.knowledgeEntry.findMany({
      where: {
        forgettingStage: { in: ['active', 'dormant'] },
        OR: keywords.map((kw) => ({
          OR: [
            { title: { contains: kw, ...getInsensitiveMode() } },
            { content: { contains: kw, ...getInsensitiveMode() } },
          ],
        })),
      },
      select: {
        id: true,
        title: true,
        content: true,
        category: true,
        confidence: true,
        decayScore: true,
        themeId: true,
        tags: true,
      },
      // Tertiary `id` key breaks ties (see getRelatedKnowledge above).
      orderBy: [{ decayScore: 'desc' }, { confidence: 'desc' }, { id: 'asc' }],
      take: limit * 5,
    });

    // Fetch theme names for context
    const themeIds = [...new Set(entries.map((e) => e.themeId).filter(Boolean))] as number[];
    const themes =
      themeIds.length > 0
        ? // determinism-ok: collapsed into an id→name Map below — order irrelevant.
          await prisma.theme.findMany({
            where: { id: { in: themeIds } },
            select: { id: true, name: true },
          })
        : [];
    const themeMap = new Map(themes.map((t) => [t.id, t.name]));

    const scored = entries.map((entry) => {
      let relevanceScore = 0;
      const entryText = `${entry.title} ${entry.content}`.toLowerCase();
      const matchCount = keywords.filter((kw) => entryText.includes(kw)).length;
      relevanceScore += (matchCount / keywords.length) * 50;

      // NOTE: Cross-project knowledge gets a BONUS (not penalty) to surface diverse insights
      const isCrossProject = excludeThemeId ? entry.themeId !== excludeThemeId : false;
      if (isCrossProject && entry.themeId) {
        relevanceScore += 15;
      }

      relevanceScore += entry.confidence * 10;
      relevanceScore += entry.decayScore * 10;

      return {
        id: entry.id,
        title: entry.title,
        content: entry.content.slice(0, 500),
        category: entry.category,
        confidence: entry.confidence,
        relevanceScore: Math.round(relevanceScore * 100) / 100,
        isCrossProject,
        sourceThemeId: entry.themeId,
        sourceThemeName: entry.themeId ? themeMap.get(entry.themeId) : undefined,
      };
    });

    // Secondary `id` key breaks ties on identical relevanceScore (see
    // getRelatedKnowledge above) — this list also feeds a prompt.
    const sorted = scored
      .sort((a, b) => b.relevanceScore - a.relevanceScore || a.id - b.id)
      .slice(0, limit);
    const uniqueThemes = new Set(entries.map((e) => e.themeId).filter(Boolean));

    return {
      results: sorted,
      totalAcrossProjects: entries.length,
      projectCount: uniqueThemes.size,
    };
  } catch (error) {
    log.error({ err: error }, 'Failed to search cross-project knowledge');
    return { results: [], totalAcrossProjects: 0, projectCount: 0 };
  }
}

// ──── Helper Functions ────

function buildExtractionContext(
  task: {
    title: string;
    description: string | null;
    comments: Array<{ content: string }>;
  },
  verifyContent: string,
): string {
  const parts: string[] = [];

  parts.push(`タスク: ${task.title}`);
  if (task.description) {
    parts.push(`説明: ${task.description.slice(0, 500)}`);
  }
  if (verifyContent) {
    parts.push(`検証レポート:\n${verifyContent.slice(0, 2000)}`);
  }
  if (task.comments.length > 0) {
    const commentText = task.comments
      .slice(0, 5)
      .map((c) => c.content)
      .join('\n');
    parts.push(`コメント:\n${commentText.slice(0, 500)}`);
  }

  return parts.join('\n\n');
}

interface ExtractedKnowledge {
  title: string;
  content: string;
  category: string;
}

async function extractWithAI(context: string, _taskTitle: string): Promise<ExtractedKnowledge[]> {
  try {
    const response = await sendAIMessage({
      messages: [
        {
          role: 'user',
          content: `以下のタスク完了情報から、今後再利用できる知識を抽出してください。
各知識は独立した項目として、JSON配列で返してください。

${context}

以下のJSON形式で返してください（マークダウンのコードブロックなし、純粋なJSON配列のみ）:
[
  {
    "title": "知識のタイトル（簡潔に）",
    "content": "具体的な知識の内容（手順、注意点、パターンなど）",
    "category": "procedure|pattern|insight|fact"
  }
]

ルール:
- 汎用的で再利用可能な知識のみ抽出（タスク固有の情報は除外）
- 最大3件まで
- 空配列[]を返す場合は、抽出すべき知識がないことを意味する`,
        },
      ],
      maxTokens: 1024,
    });

    const text = response.content.trim();
    const parsed = parseJsonArray<ExtractedKnowledge>(text);
    if (!parsed) return [];
    const validCategories = ['procedure', 'pattern', 'insight', 'fact', 'preference', 'general'];

    return parsed
      .filter((item) => item.title && item.content)
      .map((item) => ({
        title: item.title.slice(0, 200),
        content: item.content.slice(0, 2000),
        category: validCategories.includes(item.category) ? item.category : 'insight',
      }))
      .slice(0, 3);
  } catch (error) {
    log.error({ err: error }, 'AI extraction failed, returning empty');
    return [];
  }
}
