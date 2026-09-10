/**
 * critic-lessons.test
 *
 * Unit tests for the cross-task critic-lesson loop: the tolerant response
 * parser, the section renderer, and the orchestration (source thresholds,
 * caching, fail-soft). Prisma / ai-client / logger are mocked.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

const findManyMock = mock(async (): Promise<unknown[]> => []);
const readCache = mock(
  async (): Promise<{ fingerprint: string; at: number; bullets: string[] } | undefined> =>
    undefined,
);
const writeCache = mock(async () => {});
mock.module('./critic-lesson-cache', () => ({
  readCriticLessonCache: readCache,
  writeCriticLessonCache: writeCache,
}));

mock.module('../../../config/database', () => ({
  prisma: { workflowTransition: { findMany: findManyMock } },
}));

const sendAIMessageMock = mock(async () => ({ content: '[]' }));
const isAnyApiKeyConfiguredMock = mock(async () => true);

mock.module('../../../utils/ai-client', () => ({
  sendAIMessage: sendAIMessageMock,
  getDefaultProvider: mock(async () => 'anthropic'),
  isAnyApiKeyConfigured: isAnyApiKeyConfiguredMock,
}));

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), debug: mock(() => {}) }),
}));

const { buildCriticLessonsSection, parseLessonsResponse, renderLessonsSection } =
  await import('./critic-lessons');

/** A critic-failure transition row with the given task + reasons. */
function row(id: number, taskId: number, reasons: string[]) {
  return { id, taskId, metadata: JSON.stringify({ severity: 60, reasons }) };
}

beforeEach(() => {
  readCache.mockReset().mockResolvedValue(undefined);
  writeCache.mockClear();
  findManyMock.mockClear();
  sendAIMessageMock.mockClear();
  isAnyApiKeyConfiguredMock.mockClear();
  findManyMock.mockImplementation(async () => []);
  sendAIMessageMock.mockImplementation(async () => ({ content: '[]' }));
  isAnyApiKeyConfiguredMock.mockImplementation(async () => true);
});

afterEach(() => {
  delete process.env.RAPITAS_CRITIC_LESSONS;
});

describe('parseLessonsResponse', () => {
  it('parses a clean JSON array', () => {
    expect(parseLessonsResponse('["a","b"]')).toEqual(['a', 'b']);
  });

  it('extracts an array embedded in prose', () => {
    expect(parseLessonsResponse('結果: ["観点1"] 以上')).toEqual(['観点1']);
  });

  it('returns [] for non-JSON and non-array payloads', () => {
    expect(parseLessonsResponse('no json')).toEqual([]);
    expect(parseLessonsResponse('{"a":1}')).toEqual([]);
  });

  it('drops non-string, empty, and oversized items', () => {
    const long = 'x'.repeat(500);
    expect(parseLessonsResponse(JSON.stringify(['ok', 42, '', long]))).toEqual(['ok']);
  });

  it('caps the number of lessons at 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => `観点${i}`);
    expect(parseLessonsResponse(JSON.stringify(many))).toHaveLength(8);
  });
});

describe('renderLessonsSection', () => {
  it('returns empty string with no bullets', () => {
    expect(renderLessonsSection([], 'research')).toBe('');
  });

  it('renders a checkbox list with the phase artifact in the header', () => {
    const s = renderLessonsSection(['影響ファイルを列挙する'], 'research', 'ja');
    expect(s).toContain('research.md');
    expect(s).toContain('- [ ] 影響ファイルを列挙する');
  });

  it('uses plan.md for the plan phase and English framing when asked', () => {
    const s = renderLessonsSection(['x'], 'plan', 'en');
    expect(s).toContain('plan.md');
    expect(s).toContain('Recurring misses');
  });
});

describe('buildCriticLessonsSection', () => {
  it('reuses persisted source-matched lessons without another AI call', async () => {
    findManyMock.mockResolvedValue([row(90001, 10, ['a', 'b']), row(90000, 11, ['c', 'd'])]);
    readCache.mockResolvedValue({
      fingerprint: 'persisted',
      at: Date.now(),
      bullets: ['Persisted lesson'],
    });
    expect(await buildCriticLessonsSection('research')).toContain('Persisted lesson');
    expect(sendAIMessageMock).not.toHaveBeenCalled();
  });

  it('a correction to existing source metadata invalidates the cache', async () => {
    findManyMock.mockResolvedValue([row(91001, 10, ['a', 'b']), row(91000, 11, ['c', 'd'])]);
    await buildCriticLessonsSection('research');
    findManyMock.mockResolvedValue([
      row(91001, 10, ['corrected', 'b']),
      row(91000, 11, ['c', 'd']),
    ]);
    await buildCriticLessonsSection('research');
    expect(sendAIMessageMock).toHaveBeenCalledTimes(2);
    expect(writeCache).toHaveBeenCalledTimes(2);
  });
  it('returns "" when disabled via env', async () => {
    process.env.RAPITAS_CRITIC_LESSONS = 'off';
    expect(await buildCriticLessonsSection('research')).toBe('');
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('returns "" below the source thresholds (too few reasons)', async () => {
    findManyMock.mockImplementation(async () => [row(1, 10, ['a', 'b'])]);
    expect(await buildCriticLessonsSection('research')).toBe('');
    expect(sendAIMessageMock).not.toHaveBeenCalled();
  });

  it('returns "" when all findings come from a single task (not cross-task)', async () => {
    findManyMock.mockImplementation(async () => [
      row(1, 10, ['a', 'b']),
      row(2, 10, ['c', 'd', 'e']),
    ]);
    expect(await buildCriticLessonsSection('research')).toBe('');
    expect(sendAIMessageMock).not.toHaveBeenCalled();
  });

  it('distills and renders when findings recur across tasks', async () => {
    findManyMock.mockImplementation(async () => [
      row(3, 10, ['[completeness] 影響ファイルの列挙漏れ', '[risk] 移行戦略なし']),
      row(2, 11, ['[completeness] バージョン要件未確認', '[risk] ロールバック手順なし']),
    ]);
    sendAIMessageMock.mockImplementation(async () => ({
      content: '["変更の影響ファイルを網羅的に列挙する","移行・ロールバック手順を明記する"]',
    }));
    const s = await buildCriticLessonsSection('research', 'ja');
    expect(s).toContain('- [ ] 変更の影響ファイルを網羅的に列挙する');
    expect(sendAIMessageMock).toHaveBeenCalledTimes(1);
  });

  it('serves the cached distillation for an unchanged fingerprint', async () => {
    // NOTE: distinct ids from other tests — the module-level cache persists
    // across tests, and identical ids would collide on the fingerprint.
    findManyMock.mockImplementation(async () => [
      row(103, 10, ['r1', 'r2']),
      row(102, 11, ['r3', 'r4']),
    ]);
    sendAIMessageMock.mockImplementation(async () => ({ content: '["観点A","観点B"]' }));
    const first = await buildCriticLessonsSection('research');
    const second = await buildCriticLessonsSection('research');
    expect(first).toBe(second);
    expect(sendAIMessageMock).toHaveBeenCalledTimes(1); // second hit is cached
  });

  it('re-distills when a new failure changes the fingerprint', async () => {
    findManyMock.mockImplementation(async () => [
      row(205, 10, ['r1', 'r2']),
      row(102, 11, ['r3', 'r4']),
    ]);
    sendAIMessageMock.mockImplementation(async () => ({ content: '["観点C"]' }));
    // NOTE: cache from the prior test persists (module-level) — id 205 differs
    // from id 103, so the fingerprint changes and a fresh distillation runs.
    await buildCriticLessonsSection('research');
    expect(sendAIMessageMock).toHaveBeenCalledTimes(1);
  });

  it('fails soft to "" when the DB query throws', async () => {
    findManyMock.mockImplementation(async () => {
      throw new Error('db down');
    });
    expect(await buildCriticLessonsSection('plan')).toBe('');
  });

  it('returns "" when no API key is configured (no distillation possible)', async () => {
    findManyMock.mockImplementation(async () => [
      row(9, 20, ['p1', 'p2']),
      row(8, 21, ['p3', 'p4']),
    ]);
    isAnyApiKeyConfiguredMock.mockImplementation(async () => false);
    expect(await buildCriticLessonsSection('plan')).toBe('');
    expect(sendAIMessageMock).not.toHaveBeenCalled();
  });
});

/** A verify_repair transition row with a single reason string. */
function repairRow(id: number, taskId: number, reason: string) {
  return { id, taskId, metadata: JSON.stringify({ attempt: 1, max: 3, reason }) };
}

describe('buildCriticLessonsSection — verify / implement streams', () => {
  it('verify stream keeps verify.md-discipline rejections and drops honest failures', async () => {
    findManyMock.mockImplementation(async () => [
      repairRow(301, 30, 'verify.md self-contradicts: claims all tests pass while body fails'),
      repairRow(302, 31, 'verify.md self-contradicts: verdict vocabulary paraphrased'),
      repairRow(303, 32, 'verify.md explicitly marks the verification as failed.'),
      repairRow(304, 33, 'verify.md self-contradicts: measured NG but reported pass'),
      repairRow(305, 34, 'verify.md self-contradicts: summary line missing'),
    ]);
    sendAIMessageMock.mockImplementation(async () => ({
      content: '["実測結果と矛盾する判定を書かない"]',
    }));
    const s = await buildCriticLessonsSection('verify', 'ja');
    expect(s).toContain('verify.md の差し戻し観点');
    expect(s).toContain('- [ ] 実測結果と矛盾する判定を書かない');
    // The honest-failure row must not have reached the distiller.
    const sent = String(sendAIMessageMock.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '');
    expect(sent).not.toContain('explicitly marks');
  });

  it('implement stream keeps only adversarial diff-review rejections', async () => {
    findManyMock.mockImplementation(async () => [
      repairRow(401, 40, '差分レビュー不合格: 計画外の無関係な変更が混入している'),
      repairRow(402, 41, '差分レビュー不合格: 計画で必須とされた回帰テストが未追加'),
      repairRow(403, 42, 'verify.md self-contradicts: not an implement lesson'),
      repairRow(404, 43, '差分レビュー不合格: 受入基準の読み違い'),
      repairRow(405, 44, '差分レビュー不合格: 実装ファイルが diff に含まれない'),
    ]);
    sendAIMessageMock.mockImplementation(async () => ({
      content: '["計画に列挙されたファイル以外の変更を混入させない"]',
    }));
    const s = await buildCriticLessonsSection('implement', 'ja');
    expect(s).toContain('実装が差し戻された頻出観点');
    const sent = String(sendAIMessageMock.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '');
    expect(sent).not.toContain('self-contradicts');
  });

  it('verify stream returns "" when only honest failures exist (nothing to learn)', async () => {
    findManyMock.mockImplementation(async () => [
      repairRow(501, 50, 'verify.md explicitly marks the verification as failed.'),
      repairRow(502, 51, 'verify.md explicitly marks the verification as failed.'),
      repairRow(503, 52, 'verify.md explicitly marks the verification as failed.'),
      repairRow(504, 53, 'verify.md explicitly marks the verification as failed.'),
    ]);
    expect(await buildCriticLessonsSection('verify')).toBe('');
    expect(sendAIMessageMock).not.toHaveBeenCalled();
  });
});
