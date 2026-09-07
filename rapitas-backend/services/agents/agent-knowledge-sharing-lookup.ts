/**
 * AgentKnowledgeSharingLookup
 *
 * Internal lookup/ranking helpers for agent-knowledge-sharing: pattern and
 * knowledge relevance scoring, warning generation, keyword extraction and
 * pattern upsert. Split out of agent-knowledge-sharing.ts (file-size ratchet,
 * task 872) — not part of the public API, imported only by that module.
 */
import { prisma } from '../../config/database';
import { getInsensitiveMode } from '../../config/db-provider';

export async function findRelevantPatterns(task: {
  title: string;
  themeId: number | null;
  taskLabels: Array<{ label: { name: string } }>;
}) {
  const keywords = extractKeywords(task.title);
  const labels = task.taskLabels.map((tl) => tl.label.name);

  const patterns = await prisma.learningPattern.findMany({
    where: {
      confidence: { gte: 0.4 },
    },
    // id tiebreak: two patterns tying on occurrences+confidence would
    // otherwise have DB-whim ordering decide which 30 make the `take` cutoff.
    orderBy: [{ occurrences: 'desc' }, { confidence: 'desc' }, { id: 'asc' }],
    take: 30,
  });

  // Filter and rank by relevance
  return (
    patterns
      .map((p) => {
        let relevance = 0;
        try {
          const conditions = JSON.parse(p.conditions);

          if (conditions.titleKeywords) {
            const matchCount = (conditions.titleKeywords as string[]).filter((kw: string) =>
              keywords.includes(kw),
            ).length;
            relevance += matchCount * 10;
          }

          if (conditions.labels) {
            const matchCount = (conditions.labels as string[]).filter((l: string) =>
              labels.includes(l),
            ).length;
            relevance += matchCount * 15;
          }

          if (conditions.themeId && conditions.themeId === task.themeId) {
            relevance += 20;
          }

          const taskCategory = inferTaskCategory(task.title, labels);
          if (p.category === taskCategory) {
            relevance += 10;
          }
        } catch {
          // NOTE: On conditions parse failure, fall back to category match only
          const taskCategory = inferTaskCategory(task.title, labels);
          if (p.category === taskCategory) relevance += 10;
        }

        return { pattern: p, relevance };
      })
      .filter((item) => item.relevance > 0)
      // id tiebreak keeps the top-5 slice reproducible when two patterns tie on
      // computed relevance.
      .sort((a, b) => b.relevance - a.relevance || a.pattern.id - b.pattern.id)
      .slice(0, 5)
      .map((item) => ({
        id: item.pattern.id,
        type: item.pattern.patternType,
        category: item.pattern.category,
        description: item.pattern.description,
        actions: (() => {
          try {
            return JSON.parse(item.pattern.actions);
          } catch {
            return [];
          }
        })(),
        confidence: item.pattern.confidence,
        occurrences: item.pattern.occurrences,
      }))
  );
}

export async function findRelevantKnowledgeForAgent(task: {
  title: string;
  themeId: number | null;
  description: string | null;
}) {
  const keywords = extractKeywords(`${task.title} ${task.description || ''}`);

  if (keywords.length === 0) return [];

  const entries = await prisma.knowledgeEntry.findMany({
    where: {
      forgettingStage: { in: ['active', 'dormant'] },
      confidence: { gte: 0.5 },
      OR: keywords.slice(0, 4).map((kw) => ({
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
      themeId: true,
    },
    // id tiebreak: confidence/decayScore ties would otherwise leave the
    // pre-`take` candidate set to DB-whim ordering.
    orderBy: [{ confidence: 'desc' }, { decayScore: 'desc' }, { id: 'asc' }],
    take: 5,
  });

  // Prioritize theme matches. id tiebreak keeps the top-3 slice reproducible
  // when two entries tie on the theme-bonus + confidence score.
  return entries
    .sort((a, b) => {
      const aBonus = a.themeId === task.themeId ? 100 : 0;
      const bBonus = b.themeId === task.themeId ? 100 : 0;
      return bBonus + b.confidence * 10 - (aBonus + a.confidence * 10) || a.id - b.id;
    })
    .slice(0, 3)
    .map((e) => ({
      id: e.id,
      title: e.title,
      content: e.content.slice(0, 300),
      category: e.category,
      confidence: e.confidence,
    }));
}

export async function getLatestPromptEvolutions() {
  const evolutions = await prisma.promptEvolution.findMany({
    where: { performanceDelta: { gt: 0 } },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: {
      category: true,
      improvement: true,
      performanceDelta: true,
    },
  });

  return evolutions.map((e) => ({
    category: e.category,
    improvement: e.improvement || '',
    performanceDelta: e.performanceDelta,
  }));
}

export async function generateWarnings(task: {
  title: string;
  themeId: number | null;
  taskLabels: Array<{ label: { name: string } }>;
}): Promise<string[]> {
  const warnings: string[] = [];
  const keywords = extractKeywords(task.title);

  const failurePatterns = await prisma.learningPattern.findMany({
    where: {
      patternType: { in: ['failure_pattern', 'anti_pattern'] },
      confidence: { gte: 0.5 },
      occurrences: { gte: 2 },
    },
    orderBy: { occurrences: 'desc' },
    take: 20,
  });

  for (const pattern of failurePatterns) {
    try {
      const conditions = JSON.parse(pattern.conditions);

      if (conditions.titleKeywords) {
        const matchCount = (conditions.titleKeywords as string[]).filter((kw: string) =>
          keywords.includes(kw),
        ).length;

        if (matchCount >= 2) {
          warnings.push(
            `${pattern.description}（${pattern.occurrences}回発生、信頼度${Math.round(pattern.confidence * 100)}%）`,
          );
        }
      }

      const taskCategory = inferTaskCategory(
        task.title,
        task.taskLabels.map((tl) => tl.label.name),
      );
      if (pattern.category === taskCategory && !conditions.titleKeywords) {
        warnings.push(`[${taskCategory}] ${pattern.description}`);
      }
    } catch {
      // ignore
    }
  }

  return warnings.slice(0, 3);
}

export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'の',
    'を',
    'に',
    'は',
    'が',
    'で',
    'と',
    'する',
    'した',
    'です',
    'ます',
    'a',
    'an',
    'the',
    'is',
    'are',
    'for',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'from',
    'by',
    'with',
    'as',
    'of',
    'add',
    'update',
    'fix',
  ]);

  return text
    .toLowerCase()
    .split(/[\s\-_\/\\:;,.\(\)\[\]{}]+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w))
    .slice(0, 10);
}

export function inferTaskCategory(title: string, labels: string[]): string {
  const text = `${title} ${labels.join(' ')}`.toLowerCase();

  if (text.match(/bug|fix|修正|エラー|error|不具合/)) return 'bug_fix';
  if (text.match(/feature|機能|実装|implement|新規/)) return 'feature_implementation';
  if (text.match(/refactor|リファクタ|整理|cleanup/)) return 'refactoring';
  if (text.match(/test|テスト|spec/)) return 'testing';
  if (text.match(/debug|デバッグ|調査|investigate/)) return 'debugging';

  return 'feature_implementation';
}

export async function upsertPattern(input: {
  patternType: string;
  category: string;
  description: string;
  conditions: string;
  actions: string;
  executionId: number;
}): Promise<void> {
  const existing = await prisma.learningPattern.findFirst({
    where: {
      patternType: input.patternType,
      category: input.category,
      description: { contains: input.description.slice(0, 30) },
    },
  });

  if (existing) {
    const newConfidence = Math.min(1.0, existing.confidence + 0.05 * (1 - existing.confidence));

    await prisma.learningPattern.update({
      where: { id: existing.id },
      data: {
        occurrences: { increment: 1 },
        confidence: newConfidence,
        lastObserved: new Date(),
        metadata: JSON.stringify({
          ...(() => {
            try {
              return JSON.parse(existing.metadata);
            } catch {
              return {};
            }
          })(),
          lastExecutionId: input.executionId,
        }),
      },
    });
  } else {
    await prisma.learningPattern.create({
      data: {
        patternType: input.patternType,
        category: input.category,
        description: input.description.slice(0, 500),
        conditions: input.conditions,
        actions: input.actions,
        confidence: 0.5,
        occurrences: 1,
        metadata: JSON.stringify({ executionId: input.executionId }),
      },
    });
  }
}
