/**
 * findRelatedKnowledge ガバナンス テスト
 *
 * 注入対象から rejected/conflict を除外し、validated を pending より優先する。
 */
import { describe, test, expect, mock } from 'bun:test';

// HACK(agent): Bun mock型推論の制限 — `as any` で型チェックをバイパス
const findMany = mock(() => Promise.resolve([] as unknown[])) as any;
const mockPrisma = { knowledgeEntry: { findMany } };

mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../../config/logger', () => {
  const noop = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
  return { createLogger: () => noop, logger: noop, getBackendLogFilePath: () => '/tmp/b.log' };
});
mock.module('../../utils/ai-client', () => ({
  sendAIMessage: () => Promise.resolve({ content: '', tokensUsed: 0 }),
}));
mock.module('../../utils/common/json-extractor', () => ({ parseJsonArray: () => null }));
mock.module('../../services/memory/timeline', () => ({ appendEvent: () => Promise.resolve() }));
mock.module('../../services/memory/index', () => ({
  memoryTaskQueue: { enqueue: () => Promise.resolve() },
}));
// NOTE: rag/vector-index.ts が cosineSimilarity を named import するため、ミラー漏れは load error になる
mock.module('../../services/memory/utils', () => ({
  createContentHash: (s: string) => s,
  parseTagsAsStrings: (raw: string) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  },
  cosineSimilarity: () => 0,
}));

const { findRelatedKnowledge } = await import('../../services/memory/task-knowledge-extractor');

describe('findRelatedKnowledge governance', () => {
  test('where は rejected/conflict を除外する', async () => {
    findMany.mockResolvedValueOnce([]);
    await findRelatedKnowledge('JSON 抽出 ヘルパー', 'extractJsonArray');
    const where = (
      findMany.mock.calls[0][0] as { where: { validationStatus?: { notIn?: string[] } } }
    ).where;
    expect(where.validationStatus?.notIn).toEqual(['rejected', 'conflict']);
  });

  test('同条件なら validated が pending より上位になる', async () => {
    const base = {
      content: 'extractJsonArray helper',
      category: 'pattern',
      confidence: 0.7,
      decayScore: 1,
      themeId: null,
      tags: '[]',
    };
    findMany.mockResolvedValueOnce([
      { id: 1, title: 'extractJsonArray pending', validationStatus: 'pending', ...base },
      { id: 2, title: 'extractJsonArray validated', validationStatus: 'validated', ...base },
    ]);
    const res = await findRelatedKnowledge('extractJsonArray helper', '');
    expect(res[0].id).toBe(2); // validated boosted above pending
  });
});
