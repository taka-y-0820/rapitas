/**
 * adversarial-diff-review.test
 *
 * Unit tests for the independent judge: the pure prompt builder + verdict
 * parser, the enable/disable flag, and the orchestration function's fail-open
 * branches / cross-provider judge selection. All heavy infrastructure (git
 * diff, AI client, prisma, workflow file reads, logger) is mocked at the
 * module boundary BEFORE the module under test is imported, so importing this
 * file never reaches the real database (config/database eagerly connects on
 * import if not mocked first).
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

const getDiff = mock(() =>
  Promise.resolve([{ filename: 'a.ts', status: 'M', additions: 1, deletions: 0, patch: '+line' }]),
);
const sendAIMessage = mock(() =>
  Promise.resolve({ content: '{"verdict":"pass","severity":0,"reasons":[]}' }),
);
const resolveWorkflowDir = mock(() => Promise.resolve({ dir: '/wf/1' }));
const readWorkflowFile = mock(() => Promise.resolve('plan content'));
const agentExecutionFindFirst = mock(() => Promise.resolve(null));
const taskFindUnique = mock(() => Promise.resolve({ title: 'Task', acceptanceCriteria: null }));
const agentExecutionConfigFindUnique = mock(() => Promise.resolve(null));
const appendEventMock = mock(() => Promise.resolve({ id: 1 }));

mock.module('../orchestrator/git-operations/core/diff-structured', () => ({ getDiff }));
let auxMode: 'api' | 'cli' = 'api';
mock.module('../../../utils/ai-client', () => ({ sendAIMessage, getAuxAiMode: () => auxMode }));
mock.module('../../workflow/workflow-file-utils', () => ({ resolveWorkflowDir, readWorkflowFile }));
mock.module('../../memory/timeline', () => ({ appendEvent: appendEventMock }));
mock.module('../../../config/database', () => ({
  prisma: {
    agentExecution: { findFirst: agentExecutionFindFirst },
    agentExecutionConfig: { findUnique: agentExecutionConfigFindUnique },
    task: { findUnique: taskFindUnique },
  },
}));
mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  buildDiffReviewPrompt,
  parseReviewVerdict,
  isAdversarialReviewEnabled,
  reviewDiffAdversarially,
  jurorIsRested,
  recordJurorOutcome,
  resetJurorHealth,
  JUROR_TIMEOUT_STRIKES,
  JUROR_COOLOFF_MS,
} = await import('./adversarial-diff-review');

describe('buildDiffReviewPrompt', () => {
  it('embeds task title, plan, acceptance criteria, and diff text', () => {
    const prompt = buildDiffReviewPrompt({
      taskTitle: 'Fix the login bug',
      planContent: 'Edit `src/login.ts` to validate the token.',
      acceptanceCriteria: ['Login rejects expired tokens', 'Existing tests still pass'],
      diffText: '--- a/src/login.ts\n+++ b/src/login.ts\n+if (expired) throw new Error();',
    });
    expect(prompt).toContain('Fix the login bug');
    expect(prompt).toContain('src/login.ts');
    expect(prompt).toContain('1. Login rejects expired tokens');
    expect(prompt).toContain('2. Existing tests still pass');
    expect(prompt).toContain('if (expired) throw new Error()');
    expect(prompt).toContain('JSONオブジェクトのみ');
  });

  // task 674 は3ラウンド連続で、既にディレクトリ化済みだった cost-optimization /
  // usage-breakdown を「変更ファイル一覧に無い＝未着手」と判定されてブロックされた。
  // ジャッジは差分しか見ないため、この区別はプロンプトで教えるほかない。
  it('未変更のファイルを未完了と断じないよう指示する', () => {
    const prompt = buildDiffReviewPrompt({
      taskTitle: 'T',
      planContent: '',
      acceptanceCriteria: [],
      diffText: 'diff',
    });
    expect(prompt).toContain('未変更の扱い');
    expect(prompt).toContain('既に目的の状態にあったため変更が不要だった');
    expect(prompt).toContain('import が不変であることは移動していない根拠にならない');
  });

  it('falls back to a placeholder when there are no acceptance criteria', () => {
    const prompt = buildDiffReviewPrompt({
      taskTitle: 'T',
      planContent: '',
      acceptanceCriteria: [],
      diffText: 'diff',
    });
    expect(prompt).toContain('(明示的な受入基準なし');
    expect(prompt).toContain('(計画なし)');
  });

  it('tells the judge that workflow artifacts never appear in the diff', () => {
    // Regression: research.md / plan.md / verify.md are WorkflowFile rows, not
    // repo files, so a criterion phrased "…が research.md に記録される" can NEVER
    // be satisfied from the diff the judge sees. Two tasks (#632, #633) were
    // failed on exactly that reasoning ("差分に見当たらない"), making such
    // criteria permanently unsatisfiable no matter how often they were retried.
    const prompt = buildDiffReviewPrompt({
      taskTitle: 'T',
      planContent: '',
      acceptanceCriteria: ['原因内訳が research.md に記録される'],
      diffText: 'd',
    });
    expect(prompt).toContain('research.md');
    expect(prompt).toContain('WorkflowFile');
    expect(prompt).toContain('fail の根拠にしてはならない');
  });

  it('truncates an overlong plan to 6000 chars', () => {
    const longPlan = 'x'.repeat(7000);
    const prompt = buildDiffReviewPrompt({
      taskTitle: 'T',
      planContent: longPlan,
      acceptanceCriteria: [],
      diffText: 'd',
    });
    // The plan section should not contain the full 7000-char run.
    const planSection = prompt.split('## 受入基準')[0];
    expect(planSection.length).toBeLessThan(6200);
  });
});

describe('parseReviewVerdict', () => {
  it('returns unknown for null/undefined/empty text', () => {
    expect(parseReviewVerdict(null)).toEqual({
      verdict: 'unknown',
      severity: 0,
      reasons: [],
      judged: false,
    });
    expect(parseReviewVerdict(undefined)).toEqual({
      verdict: 'unknown',
      severity: 0,
      reasons: [],
      judged: false,
    });
    expect(parseReviewVerdict('   ')).toEqual({
      verdict: 'unknown',
      severity: 0,
      reasons: [],
      judged: false,
    });
  });

  it('returns unknown when there is no JSON object in the text', () => {
    expect(parseReviewVerdict('no braces here')).toEqual({
      verdict: 'unknown',
      severity: 0,
      reasons: [],
      judged: false,
    });
  });

  it('returns unknown for an unbalanced/unterminated object', () => {
    expect(parseReviewVerdict('{"verdict":"fail"').judged).toBe(false);
  });

  it('returns unknown for malformed JSON inside balanced braces', () => {
    expect(parseReviewVerdict('{"verdict": fail, oops}').verdict).toBe('unknown');
  });

  it('parses a clean pass verdict', () => {
    const r = parseReviewVerdict('{"verdict":"pass","severity":0,"reasons":[]}');
    expect(r).toEqual({ verdict: 'pass', severity: 0, reasons: [], judged: true });
  });

  it('parses a clean fail verdict with reasons', () => {
    const r = parseReviewVerdict(
      '{"verdict":"fail","severity":65,"reasons":["missing edge case handling"]}',
    );
    expect(r.verdict).toBe('fail');
    expect(r.severity).toBe(65);
    expect(r.reasons).toEqual(['missing edge case handling']);
    expect(r.judged).toBe(true);
  });

  it('tolerates prose/code-fences around the JSON object', () => {
    const text =
      'Here is my review:\n```json\n{"verdict":"pass","severity":0,"reasons":[]}\n```\nDone.';
    const r = parseReviewVerdict(text);
    expect(r.verdict).toBe('pass');
  });

  it('is case-insensitive on the verdict field', () => {
    expect(parseReviewVerdict('{"verdict":"FAIL"}').verdict).toBe('fail');
    expect(parseReviewVerdict('{"verdict":"Pass"}').verdict).toBe('pass');
  });

  it('treats an unrecognized verdict string as unknown', () => {
    const r = parseReviewVerdict('{"verdict":"maybe","severity":10}');
    expect(r.verdict).toBe('unknown');
    expect(r.judged).toBe(false);
  });

  it('defaults severity to 80 for a fail with no numeric severity', () => {
    expect(parseReviewVerdict('{"verdict":"fail"}').severity).toBe(80);
  });

  it('defaults severity to 0 for a pass with no numeric severity', () => {
    expect(parseReviewVerdict('{"verdict":"pass"}').severity).toBe(0);
  });

  it('clamps severity into [0, 100]', () => {
    expect(parseReviewVerdict('{"verdict":"fail","severity":500}').severity).toBe(100);
    expect(parseReviewVerdict('{"verdict":"fail","severity":-50}').severity).toBe(0);
  });

  it('filters non-string reasons and caps the list at 10', () => {
    const reasons = [...Array(15)].map((_, i) => `reason-${i}`);
    const r = parseReviewVerdict(
      JSON.stringify({ verdict: 'fail', severity: 50, reasons: [1, null, ...reasons] }),
    );
    expect(r.reasons).toHaveLength(10);
    expect(r.reasons[0]).toBe('reason-0');
  });

  it('defaults reasons to [] when the field is missing or not an array', () => {
    expect(parseReviewVerdict('{"verdict":"fail","reasons":"oops"}').reasons).toEqual([]);
    expect(parseReviewVerdict('{"verdict":"fail"}').reasons).toEqual([]);
  });

  it('extracts the first balanced object even with nested braces before it closes', () => {
    const text = '{"verdict":"fail","severity":30,"reasons":["uses {curly} in a string"]}';
    const r = parseReviewVerdict(text);
    expect(r.verdict).toBe('fail');
    expect(r.reasons[0]).toContain('{curly}');
  });
});

describe('isAdversarialReviewEnabled', () => {
  const ENV_KEY = 'RAPITAS_ADVERSARIAL_REVIEW';
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('is enabled by default (unset)', () => {
    delete process.env[ENV_KEY];
    expect(isAdversarialReviewEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'off'])('is disabled for %s', (v) => {
    process.env[ENV_KEY] = v;
    expect(isAdversarialReviewEnabled()).toBe(false);
  });

  it('is enabled for any other value', () => {
    process.env[ENV_KEY] = 'yes-please';
    expect(isAdversarialReviewEnabled()).toBe(true);
  });
});

describe('reviewDiffAdversarially', () => {
  it('CLI mode holds high-risk work when the only real provider is unavailable', async () => {
    auxMode = 'cli';
    taskFindUnique.mockResolvedValue({
      title: 'Change login password validation',
      acceptanceCriteria: null,
    });
    sendAIMessage.mockRejectedValue(new Error('Claude unavailable'));
    try {
      const result = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
      expect(result.verdict).toBe('fail');
      expect(result.judged).toBe(false);
      expect(sendAIMessage).toHaveBeenCalledTimes(1);
    } finally {
      auxMode = 'api';
    }
  });

  it('CLI mode records unavailable families without making duplicate Claude calls', async () => {
    auxMode = 'cli';
    try {
      const result = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
      expect(result.verdict).toBe('pass');
      expect(sendAIMessage).toHaveBeenCalledTimes(1);
      expect(
        (sendAIMessage.mock.calls as unknown as Array<[{ provider: string }]>)[0][0],
      ).toMatchObject({ provider: 'claude' });
      const event = (
        appendEventMock.mock.calls as unknown as Array<
          [{ payload: { jurors: Array<{ provider: string; verdict: string; reasons: string[] }> } }]
        >
      ).at(-1)![0];
      expect(
        event.payload.jurors
          .filter((j) => j.provider !== 'claude')
          .sort((a, b) => a.provider.localeCompare(b.provider)),
      ).toEqual([
        expect.objectContaining({
          provider: 'chatgpt',
          verdict: 'unknown',
          reasons: [expect.stringContaining('unavailable')],
        }),
        expect.objectContaining({
          provider: 'gemini',
          verdict: 'unknown',
          reasons: [expect.stringContaining('unavailable')],
        }),
      ]);
    } finally {
      auxMode = 'api';
    }
  });
  beforeEach(() => {
    auxMode = 'api';
    getDiff.mockReset();
    sendAIMessage.mockReset();
    resolveWorkflowDir.mockReset();
    readWorkflowFile.mockReset();
    agentExecutionFindFirst.mockReset();
    taskFindUnique.mockReset();
    agentExecutionConfigFindUnique.mockReset();
    appendEventMock.mockReset();
    appendEventMock.mockResolvedValue({ id: 1 });
    getDiff.mockReset();
    getDiff.mockResolvedValue([
      { filename: 'a.ts', status: 'M', additions: 1, deletions: 0, patch: '+line' },
    ]);
    sendAIMessage.mockResolvedValue({ content: '{"verdict":"pass","severity":0,"reasons":[]}' });
    resolveWorkflowDir.mockResolvedValue({ dir: '/wf/1' });
    readWorkflowFile.mockResolvedValue('plan content');
    agentExecutionFindFirst.mockResolvedValue(null);
    taskFindUnique.mockResolvedValue({ title: 'Task', acceptanceCriteria: null });
    agentExecutionConfigFindUnique.mockResolvedValue(null);
    delete process.env.RAPITAS_ADVERSARIAL_REVIEW;
  });

  it('fails open (unknown, not judged) when disabled via env', async () => {
    process.env.RAPITAS_ADVERSARIAL_REVIEW = '0';
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(r).toEqual({ verdict: 'unknown', severity: 0, reasons: [], judged: false });
    expect(getDiff).not.toHaveBeenCalled();
  });

  it('fails open when there is no worktree path', async () => {
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: null });
    expect(r.judged).toBe(false);
  });

  it('fails open when there is no diff at all (nothing to review)', async () => {
    // An empty file list is the only way diffText.trim() is empty — each mapped
    // entry always carries a non-blank "--- file (status, +a/-d)" header line
    // even when patch is ''.
    getDiff.mockResolvedValue([]);
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(r.judged).toBe(false);
    expect(sendAIMessage).not.toHaveBeenCalled();
  });

  it('returns a judged pass verdict on a normal successful call', async () => {
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    // Every juror is queried independently in parallel (no early exit) — use
    // toMatchObject rather than toEqual so this doesn't hardcode the jurors[]
    // array's exact contents/order.
    expect(r).toMatchObject({ verdict: 'pass', severity: 0, reasons: [], judged: true });
    expect(sendAIMessage).toHaveBeenCalledTimes(3);
  });

  it('fails open when every judge provider throws', async () => {
    sendAIMessage.mockRejectedValue(new Error('provider down'));
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(r).toMatchObject({ verdict: 'unknown', severity: 0, reasons: [], judged: false });
    // All 3 configured judge providers were attempted.
    expect(sendAIMessage).toHaveBeenCalledTimes(3);
  });

  it('falls through to the next provider when one returns an unparseable reply', async () => {
    sendAIMessage
      .mockResolvedValueOnce({ content: 'not json at all' })
      .mockResolvedValueOnce({ content: '{"verdict":"fail","severity":90,"reasons":["bad"]}' });
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(r.verdict).toBe('fail');
    // All 3 jurors are queried in parallel regardless (2 explicit mocks + the
    // 3rd falls back to the default 'pass' set in beforeEach).
    expect(sendAIMessage).toHaveBeenCalledTimes(3);
  });

  it('fails open when the diff-review pipeline throws unexpectedly', async () => {
    getDiff.mockRejectedValue(new Error('git blew up'));
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(r).toEqual({ verdict: 'unknown', severity: 0, reasons: [], judged: false });
  });

  it('counts a wedged juror as unknown instead of holding the request open', async () => {
    // This review runs inside the saving agent's PUT request and sendAIMessage
    // has no deadline of its own, so one hung provider used to block it forever.
    process.env.RAPITAS_ADVERSARIAL_JUROR_TIMEOUT_MS = '30';
    sendAIMessage.mockImplementation(() => new Promise(() => {})); // never settles
    const started = Date.now();
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r).toMatchObject({ verdict: 'unknown', judged: false });
    delete process.env.RAPITAS_ADVERSARIAL_JUROR_TIMEOUT_MS;
  });

  it('still counts the jurors that DID answer when another one wedges', async () => {
    // The cap is per juror, so a single slow provider must not discard the
    // votes of the ones that returned in time.
    process.env.RAPITAS_ADVERSARIAL_JUROR_TIMEOUT_MS = '30';
    let call = 0;
    sendAIMessage.mockImplementation(() => {
      call++;
      return call === 1
        ? new Promise(() => {})
        : Promise.resolve({ content: '{"verdict":"fail","severity":80,"reasons":["boom"]}' });
    });
    const r = await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(r.judged).toBe(true);
    expect(r.verdict).toBe('fail');
    delete process.env.RAPITAS_ADVERSARIAL_JUROR_TIMEOUT_MS;
  });

  it('prefers task.theme.defaultBranch over AgentExecutionConfig.targetBranch as preferredBaseBranch', async () => {
    // Regression test for task 506/511: resolveBaseRef's develop→main→master
    // GUESS can land on a stale/divergent branch and pull unrelated
    // pre-existing commits into "this task's diff" — misread as scope creep
    // by the jury. task 511 additionally found AgentExecutionConfig is empty
    // for the entire autonomous pipeline, so theme.defaultBranch (populated
    // for every task) must be tried FIRST, not the config-only source.
    taskFindUnique.mockResolvedValue({ theme: { defaultBranch: 'release/1.2' } });
    await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(getDiff).toHaveBeenCalledWith('/wt', undefined, 'release/1.2');
    // Short-circuits — AgentExecutionConfig is never even queried when the
    // theme already supplies a default branch.
    expect(agentExecutionConfigFindUnique).not.toHaveBeenCalled();
  });

  it('falls back to AgentExecutionConfig.targetBranch when the theme has no default branch', async () => {
    taskFindUnique.mockResolvedValue({ theme: null });
    agentExecutionConfigFindUnique.mockResolvedValue({ targetBranch: 'release/1.2' });
    await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(getDiff).toHaveBeenCalledWith('/wt', undefined, 'release/1.2');
  });

  it('passes undefined preferredBaseBranch when neither theme nor AgentExecutionConfig provide one', async () => {
    taskFindUnique.mockResolvedValue({ theme: null });
    agentExecutionConfigFindUnique.mockResolvedValue(null);
    await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(getDiff).toHaveBeenCalledWith('/wt', undefined, undefined);
  });

  it("orders the implementer's own provider LAST among judge candidates", async () => {
    // The implementer used claude — the judge should try gemini/chatgpt first.
    agentExecutionFindFirst.mockResolvedValue({ modelName: 'claude-3-5-sonnet' });
    const calledProviders: string[] = [];
    sendAIMessage.mockImplementation((opts: { provider: string }) => {
      calledProviders.push(opts.provider);
      return Promise.resolve({ content: '{"verdict":"pass","severity":0,"reasons":[]}' });
    });
    await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    // First call must NOT be 'claude' (the implementer's own provider).
    expect(calledProviders[0]).not.toBe('claude');
  });

  it('records the adversarial_review timeline event by default (suppressEventLog omitted)', async () => {
    await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt' });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(appendEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'adversarial_review' }),
    );
  });

  it('skips the adversarial_review timeline event when suppressEventLog is true (dry-run)', async () => {
    await reviewDiffAdversarially({ taskId: 1, worktreePath: '/wt', suppressEventLog: true });
    expect(appendEventMock).not.toHaveBeenCalled();
  });
});

describe('ジャッジの連続タイムアウトを短絡する', () => {
  // 実測 2026-08-28: adversarial ログ29件がすべてタイムアウト、うち26件が同一
  // プロバイダ。jurors は Promise.all なのでレビューは最も遅い1人を待つ。必ず
  // タイムアウトする相手を毎回120秒待って 'unknown' を受け取っていた。
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    resetJurorHealth();
  });

  it('規定回数に満たないタイムアウトでは休ませない', () => {
    for (let i = 0; i < JUROR_TIMEOUT_STRIKES - 1; i++) {
      recordJurorOutcome('chatgpt', true, NOW);
    }
    expect(jurorIsRested('chatgpt', NOW)).toBe(false);
  });

  it('規定回数の連続タイムアウトで休ませる', () => {
    for (let i = 0; i < JUROR_TIMEOUT_STRIKES; i++) {
      recordJurorOutcome('chatgpt', true, NOW);
    }
    expect(jurorIsRested('chatgpt', NOW)).toBe(true);
  });

  it('冷却期間を過ぎれば再び試す', () => {
    for (let i = 0; i < JUROR_TIMEOUT_STRIKES; i++) {
      recordJurorOutcome('chatgpt', true, NOW);
    }
    expect(jurorIsRested('chatgpt', NOW + JUROR_COOLOFF_MS + 1)).toBe(false);
  });

  it('1回でも応答すれば連続カウントを捨てる', () => {
    for (let i = 0; i < JUROR_TIMEOUT_STRIKES - 1; i++) {
      recordJurorOutcome('chatgpt', true, NOW);
    }
    recordJurorOutcome('chatgpt', false, NOW);
    recordJurorOutcome('chatgpt', true, NOW);
    expect(jurorIsRested('chatgpt', NOW)).toBe(false);
  });

  it('休ませるのは当該プロバイダだけ', () => {
    for (let i = 0; i < JUROR_TIMEOUT_STRIKES; i++) {
      recordJurorOutcome('chatgpt', true, NOW);
    }
    expect(jurorIsRested('claude', NOW)).toBe(false);
  });
});
