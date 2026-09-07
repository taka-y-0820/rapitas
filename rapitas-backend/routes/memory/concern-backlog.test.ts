/**
 * concern-backlog.test.ts
 *
 * Integration tests for POST /concerns via Elysia handle(). Covers #888: the
 * response must surface `submitConcern`'s outcome/reason (created / reused /
 * suppressed) instead of a bare `{ success: true, id }` that cannot be told
 * apart from a suppressed (no new row) filing.
 * services/memory/concern-backlog-service and services/github/concern-bridge
 * are stubbed via mock.module (process-global — run this file in isolation).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockSubmitConcern = mock(() =>
  Promise.resolve({ id: 1, outcome: 'created' as const, reason: 'new' as const }),
) as ReturnType<typeof mock>;
const mockListConcerns = mock(() =>
  Promise.resolve({ concerns: [], total: 0 }),
) as ReturnType<typeof mock>;
const mockSetConcernStatus = mock(() => Promise.resolve(true)) as ReturnType<typeof mock>;
const mockDeleteConcern = mock(() => Promise.resolve(true)) as ReturnType<typeof mock>;
const mockConvertConcernToTask = mock(() => Promise.resolve(100)) as ReturnType<typeof mock>;
const mockGetConcernStats = mock(() => Promise.resolve({})) as ReturnType<typeof mock>;

mock.module('../../services/memory/concern-backlog-service', () => ({
  submitConcern: mockSubmitConcern,
  listConcerns: mockListConcerns,
  setConcernStatus: mockSetConcernStatus,
  deleteConcern: mockDeleteConcern,
  convertConcernToTask: mockConvertConcernToTask,
  getConcernStats: mockGetConcernStats,
  normalizeConcernType: (v: unknown) => v ?? 'bug',
  normalizeConcernSeverity: (v: unknown) => v ?? 'medium',
}));

const mockCloseIssueForConcern = mock(() => Promise.resolve()) as ReturnType<typeof mock>;
mock.module('../../services/github/concern-bridge', () => ({
  closeIssueForConcern: mockCloseIssueForConcern,
}));

const { concernBacklogRoutes } = await import('./concern-backlog');

const BASE = 'http://localhost/concerns';

function resetMocks() {
  mockSubmitConcern.mockReset().mockResolvedValue({ id: 1, outcome: 'created', reason: 'new' });
  mockListConcerns.mockReset().mockResolvedValue({ concerns: [], total: 0 });
  mockSetConcernStatus.mockReset().mockResolvedValue(true);
  mockDeleteConcern.mockReset().mockResolvedValue(true);
  mockConvertConcernToTask.mockReset().mockResolvedValue(100);
  mockGetConcernStats.mockReset().mockResolvedValue({});
  mockCloseIssueForConcern.mockReset().mockResolvedValue(undefined);
}

function postConcern(body: Record<string, unknown>) {
  return concernBacklogRoutes.handle(
    new Request(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /concerns', () => {
  beforeEach(resetMocks);

  it('新規作成時は success:true と outcome:created, reason:new を返す', async () => {
    mockSubmitConcern.mockResolvedValue({ id: 1, outcome: 'created', reason: 'new' });

    const res = await postConcern({ title: 'タイトル', detail: '詳細' });
    const body = await res.json();

    expect(body).toEqual({ success: true, id: 1, outcome: 'created', reason: 'new' });
  });

  it('theme-saturation で抑制された場合、outcome:suppressed を返し新規行は作られない', async () => {
    // submitConcern が既存行 (id:5) を anchor として返す時点で新規 KnowledgeEntry
    // は作成されていない（submitConcern 内部で create() を呼ばない分岐）ため、
    // 続く GET /concerns の一覧に新規行が増えないことは submitConcern 側の
    // 単体テスト(concern-backlog-service.test.ts)で保証している。本テストは
    // ルート層がその outcome/reason を応答へ正しく反映することのみを検証する。
    mockSubmitConcern.mockResolvedValue({ id: 5, outcome: 'suppressed', reason: 'theme-saturation' });

    const res = await postConcern({ title: 'タイトル', detail: '詳細' });
    const body = await res.json();

    expect(body).toEqual({ success: true, id: 5, outcome: 'suppressed', reason: 'theme-saturation' });
  });

  it('near-duplicate で抑制された場合、outcome:suppressed, reason:near-duplicate を返す', async () => {
    mockSubmitConcern.mockResolvedValue({ id: 7, outcome: 'suppressed', reason: 'near-duplicate' });

    const res = await postConcern({ title: 'タイトル', detail: '詳細' });
    const body = await res.json();

    expect(body.outcome).toBe('suppressed');
    expect(body.reason).toBe('near-duplicate');
  });

  it('title/detail が空白のみなら 400 を返し submitConcern を呼ばない', async () => {
    const res = await postConcern({ title: '   ', detail: '   ' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('タイトルと詳細は必須です');
    expect(mockSubmitConcern).not.toHaveBeenCalled();
  });

  it('submitConcern が例外を投げたら 500 を返す', async () => {
    mockSubmitConcern.mockRejectedValue(new Error('db error'));

    const res = await postConcern({ title: 'タイトル', detail: '詳細' });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('懸念の登録に失敗しました');
  });
});
