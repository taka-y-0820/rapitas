/**
 * concern-bridge.test
 *
 * Tests for the concern<->issue bridge:
 * - Pure mapping helpers (labelValue, buildIssueContent)
 * - DB-backed operations (publishConcernToIssue, importIssueAsConcern,
 *   closeIssueForConcern) with prisma + issue-operations + backlog-service mocked
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock declarations are hoisted by bun before static imports.
const mockGetConcern = mock(() => Promise.resolve(null));
const mockSubmitConcern = mock(() =>
  Promise.resolve({ id: 0, outcome: 'created' as const, reason: 'new' as const }),
);

mock.module('../memory/concern-backlog-service', () => ({
  getConcern: mockGetConcern,
  submitConcern: mockSubmitConcern,
  normalizeConcernType: (v: unknown) =>
    (['bug', 'refactor', 'security', 'perf', 'other'] as const).includes(v as never)
      ? (v as string)
      : 'bug',
  normalizeConcernSeverity: (v: unknown) =>
    (['urgent', 'high', 'medium', 'low'] as const).includes(v as never) ? (v as string) : 'medium',
}));

const mockIntegrationFindUnique = mock(() => Promise.resolve(null));
const mockIssueFindFirst = mock(() => Promise.resolve(null));
const mockIssueFindUnique = mock(() => Promise.resolve(null));
const mockIssueUpsert = mock(() =>
  Promise.resolve({
    id: 10,
    issueNumber: 1,
    url: 'https://github.com/owner/repo/issues/1',
    state: 'open',
  }),
);
const mockIssueUpdate = mock(() => Promise.resolve({}));

mock.module('../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: {
    gitHubIntegration: { findUnique: mockIntegrationFindUnique },
    gitHubIssue: {
      findFirst: mockIssueFindFirst,
      findUnique: mockIssueFindUnique,
      upsert: mockIssueUpsert,
      update: mockIssueUpdate,
    },
  },
}));

const mockCreateIssue = mock(() =>
  Promise.resolve({
    number: 1,
    title: 'Auth flaw',
    body: 'JWT not validated',
    state: 'open',
    labels: ['type:security', 'priority:high'],
    authorLogin: 'bot',
    url: 'https://github.com/owner/repo/issues/1',
  }),
);
const mockCloseIssue = mock(() => Promise.resolve(undefined));

// NOTE: Mirror ALL issue-operations exports to avoid bun mock.module process-global
// pollution when tests run in the same process as issue-operations.test.ts.
mock.module('./issue-operations', () => ({
  createIssue: mockCreateIssue,
  closeIssue: mockCloseIssue,
  getIssues: mock(() => Promise.resolve([])),
  getIssue: mock(() => Promise.resolve(null)),
  addIssueComment: mock(() => Promise.resolve({ id: 0, body: '' })),
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }),
}));

const {
  labelValue,
  buildIssueContent,
  publishConcernToIssue,
  importIssueAsConcern,
  closeIssueForConcern,
} = await import('./concern-bridge');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_INTEGRATION = { id: 2, ownerName: 'owner', repositoryName: 'repo' };

const MOCK_CONCERN_NO_LINK = {
  id: 1,
  title: 'Auth flaw',
  detail: 'JWT not validated',
  type: 'security' as const,
  severity: 'high' as const,
  location: 'src/auth.ts',
  status: 'open' as const,
  originTaskId: null,
  createdTaskId: null,
  themeId: null,
  createdAt: new Date(),
  linkedIssue: null,
};

const MOCK_CONCERN_WITH_LINK = {
  ...MOCK_CONCERN_NO_LINK,
  linkedIssue: {
    id: 10,
    issueNumber: 1,
    url: 'https://github.com/owner/repo/issues/1',
    state: 'open',
  },
};

const MOCK_ISSUE_ROW = {
  id: 5,
  issueNumber: 42,
  title: 'Fix auth',
  body: 'Details about the auth fix.',
  state: 'open',
  labels: '["type:bug","priority:medium"]',
  linkedConcernId: null,
  integrationId: 2,
};

// ─── Reset helper ──────────────────────────────────────────────────────────────

function resetMocks() {
  mockGetConcern.mockReset().mockResolvedValue(null);
  mockSubmitConcern
    .mockReset()
    .mockResolvedValue({ id: 99, outcome: 'created', reason: 'new' });
  mockIntegrationFindUnique.mockReset().mockResolvedValue(null);
  mockIssueFindFirst.mockReset().mockResolvedValue(null);
  mockIssueFindUnique.mockReset().mockResolvedValue(null);
  mockIssueUpsert.mockReset().mockResolvedValue({
    id: 10,
    issueNumber: 1,
    url: 'https://github.com/owner/repo/issues/1',
    state: 'open',
  });
  mockIssueUpdate.mockReset().mockResolvedValue({});
  mockCreateIssue.mockReset().mockResolvedValue({
    number: 1,
    title: 'Auth flaw',
    body: 'body',
    state: 'open',
    labels: ['type:security', 'priority:high'],
    authorLogin: 'bot',
    url: 'https://github.com/owner/repo/issues/1',
  });
  mockCloseIssue.mockReset().mockResolvedValue(undefined);
}

// ─── Pure helper tests ────────────────────────────────────────────────────────

describe('labelValue', () => {
  it('extracts the value after a matching prefix', () => {
    const labels = JSON.stringify(['type:bug', 'priority:high']);
    expect(labelValue(labels, 'type')).toBe('bug');
    expect(labelValue(labels, 'priority')).toBe('high');
  });

  it('returns undefined when the prefix is absent', () => {
    expect(labelValue(JSON.stringify(['enhancement']), 'type')).toBeUndefined();
  });

  it('returns undefined for empty / malformed JSON', () => {
    expect(labelValue('', 'type')).toBeUndefined();
    expect(labelValue('not json', 'type')).toBeUndefined();
  });

  it('only matches the prefix at the start, not mid-string', () => {
    expect(labelValue(JSON.stringify(['subtype:bug']), 'type')).toBeUndefined();
  });

  it('preserves values that themselves contain a colon', () => {
    expect(labelValue(JSON.stringify(['loc:src/a.ts:42']), 'loc')).toBe('src/a.ts:42');
  });
});

describe('buildIssueContent', () => {
  const base = { id: 7, type: 'bug', severity: 'high', detail: 'It breaks', location: null };

  it('maps type and severity to labels', () => {
    const { labels } = buildIssueContent(base);
    expect(labels).toContain('type:bug');
    expect(labels).toContain('priority:high');
  });

  it('appends extra labels', () => {
    const { labels } = buildIssueContent(base, ['needs-triage']);
    expect(labels).toEqual(['type:bug', 'priority:high', 'needs-triage']);
  });

  it('keeps the detail and adds a provenance footer referencing the concern id', () => {
    const { body } = buildIssueContent(base);
    expect(body).toContain('It breaks');
    expect(body).toContain('#7');
  });

  it('includes the location when present', () => {
    const { body } = buildIssueContent({ ...base, location: 'src/auth.ts:42' });
    expect(body).toContain('対象箇所: src/auth.ts:42');
  });

  it('omits the location line when absent', () => {
    const { body } = buildIssueContent(base);
    expect(body).not.toContain('対象箇所');
  });
});

// ─── publishConcernToIssue ────────────────────────────────────────────────────

describe('publishConcernToIssue', () => {
  beforeEach(resetMocks);

  it('正常公開: createIssue と upsert が呼ばれ issue を返す', async () => {
    mockGetConcern.mockResolvedValue(MOCK_CONCERN_NO_LINK);
    mockIntegrationFindUnique.mockResolvedValue(MOCK_INTEGRATION);

    const result = await publishConcernToIssue(1, 2);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.issue.issueNumber).toBe(1);
      expect(result.issue.url).toBe('https://github.com/owner/repo/issues/1');
    }
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockIssueUpsert).toHaveBeenCalledTimes(1);
    const upsertCall = mockIssueUpsert.mock.calls[0][0];
    expect(upsertCall.create.linkedConcernId).toBe(1);
  });

  it('冪等ガード: linkedIssue 既存なら createIssue を呼ばない', async () => {
    mockGetConcern.mockResolvedValue(MOCK_CONCERN_WITH_LINK);

    const result = await publishConcernToIssue(1, 2);

    expect(result.success).toBe(true);
    if (result.success) expect(result.issue.issueNumber).toBe(1);
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockIssueUpsert).not.toHaveBeenCalled();
  });

  it('concernId 不在 → { success: false, status: 404 }', async () => {
    mockGetConcern.mockResolvedValue(null);

    const result = await publishConcernToIssue(99, 2);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(404);
      expect(result.error).toBeDefined();
    }
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('integrationId 不在 → { success: false, status: 404 }', async () => {
    mockGetConcern.mockResolvedValue(MOCK_CONCERN_NO_LINK);
    mockIntegrationFindUnique.mockResolvedValue(null);

    const result = await publishConcernToIssue(1, 999);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.status).toBe(404);
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('createIssue 失敗 → { success: false, status: 502 }', async () => {
    mockGetConcern.mockResolvedValue(MOCK_CONCERN_NO_LINK);
    mockIntegrationFindUnique.mockResolvedValue(MOCK_INTEGRATION);
    mockCreateIssue.mockReturnValue(Promise.reject(new Error('gh: API rate limit exceeded')));

    const result = await publishConcernToIssue(1, 2);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(502);
      expect(result.error).toContain('rate limit');
    }
    expect(mockIssueUpsert).not.toHaveBeenCalled();
  });
});

// ─── importIssueAsConcern ─────────────────────────────────────────────────────

describe('importIssueAsConcern', () => {
  beforeEach(resetMocks);

  it('正常取り込み: submitConcern と update が呼ばれ concernId を返す', async () => {
    mockIssueFindUnique.mockResolvedValue(MOCK_ISSUE_ROW);
    mockSubmitConcern.mockResolvedValue({ id: 99, outcome: 'created', reason: 'new' });

    const result = await importIssueAsConcern(5);

    expect(result.success).toBe(true);
    if (result.success) expect(result.concernId).toBe(99);
    expect(mockSubmitConcern).toHaveBeenCalledTimes(1);
    const submitCall = mockSubmitConcern.mock.calls[0][0];
    expect(submitCall.dedupKey).toBe('gh-issue:5');
    expect(mockIssueUpdate).toHaveBeenCalledTimes(1);
  });

  it('冪等ガード: linkedConcernId 既存なら submitConcern を呼ばない', async () => {
    mockIssueFindUnique.mockResolvedValue({ ...MOCK_ISSUE_ROW, linkedConcernId: 5 });

    const result = await importIssueAsConcern(5);

    expect(result.success).toBe(true);
    if (result.success) expect(result.concernId).toBe(5);
    expect(mockSubmitConcern).not.toHaveBeenCalled();
    expect(mockIssueUpdate).not.toHaveBeenCalled();
  });

  it('issueId 不在 → { success: false, status: 404 }', async () => {
    mockIssueFindUnique.mockResolvedValue(null);

    const result = await importIssueAsConcern(999);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.status).toBe(404);
    expect(mockSubmitConcern).not.toHaveBeenCalled();
  });

  it('ラベルから type/severity を復元して submitConcern に渡す', async () => {
    mockIssueFindUnique.mockResolvedValue({
      ...MOCK_ISSUE_ROW,
      labels: '["type:security","priority:urgent"]',
    });
    mockSubmitConcern.mockResolvedValue({ id: 77, outcome: 'created', reason: 'new' });

    await importIssueAsConcern(5);

    const submitCall = mockSubmitConcern.mock.calls[0][0];
    expect(submitCall.type).toBe('security');
    expect(submitCall.severity).toBe('urgent');
  });
});

// ─── closeIssueForConcern ─────────────────────────────────────────────────────

describe('closeIssueForConcern', () => {
  beforeEach(resetMocks);

  it('open なリンク有り → closeIssue と state=closed 更新を呼ぶ', async () => {
    mockIssueFindFirst.mockResolvedValue({
      id: 10,
      issueNumber: 1,
      state: 'open',
      integration: { ownerName: 'owner', repositoryName: 'repo' },
    });

    await closeIssueForConcern(1);

    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 1);
    expect(mockIssueUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockIssueUpdate.mock.calls[0][0];
    expect(updateCall.data.state).toBe('closed');
  });

  it('リンクなし → no-op', async () => {
    mockIssueFindFirst.mockResolvedValue(null);

    await closeIssueForConcern(99);

    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(mockIssueUpdate).not.toHaveBeenCalled();
  });

  it('closeIssue 失敗しても例外をスローしない (best-effort)', async () => {
    mockIssueFindFirst.mockResolvedValue({
      id: 10,
      issueNumber: 1,
      state: 'open',
      integration: { ownerName: 'owner', repositoryName: 'repo' },
    });
    mockCloseIssue.mockReturnValue(Promise.reject(new Error('Network error')));

    await closeIssueForConcern(1);

    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    expect(mockIssueUpdate).not.toHaveBeenCalled();
  });
});
