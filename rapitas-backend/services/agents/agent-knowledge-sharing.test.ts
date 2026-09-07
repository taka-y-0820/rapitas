/**
 * agent-knowledge-sharing.test
 *
 * Verifies that findRelevantKnowledgeForAgent (called via gatherSharedKnowledge)
 * builds mode-safe WHERE clauses for title/content keyword search:
 * - SQLite: no `mode` key
 * - PostgreSQL: `mode: 'insensitive'` present
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// ─── Prisma mocks ────────────────────────────────────────────────────────────

const mockKnowledgeEntryFindMany = mock(() => Promise.resolve([]));
const mockTaskFindUnique = mock(() =>
  Promise.resolve({
    id: 1,
    title: 'Test task with keywords',
    description: 'find relevant knowledge',
    themeId: null,
    taskLabels: [],
    theme: null,
  }),
);
const mockLearningPatternFindMany = mock(() => Promise.resolve([]));
const mockPromptEvolutionFindMany = mock(() => Promise.resolve([]));
const mockTaskFindFirst = mock(() => Promise.resolve(null));

mock.module('../../config/database', () => ({
  // mock.module replaces the whole module — mirror ensureDatabaseConnection so config/index.ts re-export survives shuffled test order (else 'export not found').
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: {
    task: { findUnique: mockTaskFindUnique, findFirst: mockTaskFindFirst },
    knowledgeEntry: { findMany: mockKnowledgeEntryFindMany },
    learningPattern: { findMany: mockLearningPatternFindMany },
    promptEvolution: { findMany: mockPromptEvolutionFindMany },
  },
}));

const { gatherSharedKnowledge } = await import('./agent-knowledge-sharing');

type StringFilter = { contains: string; mode?: string };

describe('gatherSharedKnowledge → findRelevantKnowledgeForAgent — mode guard', () => {
  let savedProvider: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.RAPITAS_DB_PROVIDER;
    mockKnowledgeEntryFindMany.mockReset();
    mockKnowledgeEntryFindMany.mockResolvedValue([]);
    mockTaskFindUnique.mockReset();
    mockTaskFindUnique.mockResolvedValue({
      id: 1,
      title: 'Test task with keywords',
      description: 'find relevant knowledge here',
      themeId: null,
      taskLabels: [],
      theme: null,
    });
    mockLearningPatternFindMany.mockReset();
    mockLearningPatternFindMany.mockResolvedValue([]);
    mockPromptEvolutionFindMany.mockReset();
    mockPromptEvolutionFindMany.mockResolvedValue([]);
    mockTaskFindFirst.mockReset();
    mockTaskFindFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    if (savedProvider === undefined) {
      delete process.env.RAPITAS_DB_PROVIDER;
    } else {
      process.env.RAPITAS_DB_PROVIDER = savedProvider;
    }
  });

  it('postgresql: knowledgeEntry OR filters contain mode:insensitive', async () => {
    process.env.RAPITAS_DB_PROVIDER = 'postgresql';
    await gatherSharedKnowledge(1);

    expect(mockKnowledgeEntryFindMany).toHaveBeenCalledTimes(1);
    const where = mockKnowledgeEntryFindMany.mock.calls[0][0].where as {
      OR: Array<{ OR: Array<{ title: StringFilter } | { content: StringFilter }> }>;
    };
    const innerOr = where.OR[0].OR;
    expect((innerOr[0] as { title: StringFilter }).title.mode).toBe('insensitive');
    expect((innerOr[1] as { content: StringFilter }).content.mode).toBe('insensitive');
  });

  it('sqlite: knowledgeEntry OR filters have no mode key', async () => {
    process.env.RAPITAS_DB_PROVIDER = 'sqlite';
    await gatherSharedKnowledge(1);

    expect(mockKnowledgeEntryFindMany).toHaveBeenCalledTimes(1);
    const where = mockKnowledgeEntryFindMany.mock.calls[0][0].where as {
      OR: Array<{ OR: Array<{ title: StringFilter } | { content: StringFilter }> }>;
    };
    const innerOr = where.OR[0].OR;
    expect((innerOr[0] as { title: StringFilter }).title).not.toHaveProperty('mode');
    expect((innerOr[1] as { content: StringFilter }).content).not.toHaveProperty('mode');
  });
});

describe('gatherSharedKnowledge — skipKnowledge toggle', () => {
  beforeEach(() => {
    mockKnowledgeEntryFindMany.mockReset();
    mockKnowledgeEntryFindMany.mockResolvedValue([]);
    mockTaskFindUnique.mockReset();
    mockTaskFindUnique.mockResolvedValue({
      id: 1,
      title: 'Test task with keywords',
      description: 'find relevant knowledge here',
      themeId: null,
      taskLabels: [],
      theme: null,
    });
    mockLearningPatternFindMany.mockReset();
    mockLearningPatternFindMany.mockResolvedValue([]);
    mockPromptEvolutionFindMany.mockReset();
    mockPromptEvolutionFindMany.mockResolvedValue([]);
  });

  it('skipKnowledge=true returns an empty result without querying the DB', async () => {
    const result = await gatherSharedKnowledge(1, true);

    expect(result).toEqual({
      patterns: [],
      relevantKnowledge: [],
      promptEvolutions: [],
      warnings: [],
    });
    expect(mockTaskFindUnique).not.toHaveBeenCalled();
    expect(mockKnowledgeEntryFindMany).not.toHaveBeenCalled();
    expect(mockLearningPatternFindMany).not.toHaveBeenCalled();
    expect(mockPromptEvolutionFindMany).not.toHaveBeenCalled();
  });

  it('skipKnowledge omitted (default false) preserves existing lookup behavior', async () => {
    await gatherSharedKnowledge(1);

    expect(mockTaskFindUnique).toHaveBeenCalledTimes(1);
  });
});
