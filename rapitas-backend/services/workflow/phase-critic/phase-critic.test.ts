/**
 * phase-critic.test
 *
 * Unit tests for the pure critique aggregation, the tolerant lens parser, the
 * head+tail truncation helper, and (task 911) an ai-client-mocked integration
 * test proving acceptance criteria actually reach the sent lens prompt.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test';
import { aggregateCritiques, SEVERE_THRESHOLD } from './critique-aggregator';
import type { CriticVerdict } from './phase-critic-types';

const sendAIMessageMock = mock(async () => ({
  content: '{"pass":true,"severity":0,"issues":[]}',
}));
const isAnyApiKeyConfiguredMock = mock(async () => true);
const getDefaultProviderMock = mock(async () => 'anthropic');

mock.module('../../../utils/ai-client', () => ({
  sendAIMessage: sendAIMessageMock,
  getDefaultProvider: getDefaultProviderMock,
  getDefaultModel: async () => 'configured-critic-model',
  isAnyApiKeyConfigured: isAnyApiKeyConfiguredMock,
}));

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), debug: mock(() => {}) }),
}));

const {
  parseCriticResponse,
  isPhaseCriticEnabled,
  buildCriticUserMessage,
  truncateWithNotice,
  lensSystemPrompt,
  critiquePhase,
} = await import('./phase-critic');

const v = (over: Partial<CriticVerdict>): CriticVerdict => ({
  lens: 'l',
  pass: true,
  severity: 0,
  issues: [],
  ...over,
});

describe('aggregateCritiques', () => {
  it('returns unknown with no verdicts (fail-open)', () => {
    expect(aggregateCritiques([])).toEqual({ verdict: 'unknown', severity: 0, reasons: [] });
  });

  it('passes when all lenses pass', () => {
    expect(aggregateCritiques([v({}), v({}), v({})]).verdict).toBe('pass');
  });

  it('fails when a majority of lenses fail', () => {
    const r = aggregateCritiques([
      v({ lens: 'a', pass: false, severity: 40, issues: ['x'] }),
      v({ lens: 'b', pass: false, severity: 30, issues: ['y'] }),
      v({ pass: true }),
    ]);
    expect(r.verdict).toBe('fail');
    expect(r.reasons).toContain('[a] x');
    expect(r.reasons).toContain('[b] y');
  });

  it('fails on a single severe lens even without a majority', () => {
    const r = aggregateCritiques([
      v({ lens: 'sec', pass: false, severity: SEVERE_THRESHOLD, issues: ['leak'] }),
      v({ pass: true }),
      v({ pass: true }),
    ]);
    expect(r.verdict).toBe('fail');
    expect(r.severity).toBe(SEVERE_THRESHOLD);
  });

  it('does not fail on a single minor lens', () => {
    const r = aggregateCritiques([v({ pass: false, severity: 20, issues: ['nit'] }), v({}), v({})]);
    expect(r.verdict).toBe('pass');
  });

  it('de-duplicates issues across lenses', () => {
    const r = aggregateCritiques([
      v({ lens: 'a', pass: false, severity: 90, issues: ['dup', 'dup'] }),
    ]);
    expect(r.reasons.filter((x) => x === '[a] dup')).toHaveLength(1);
  });
});

describe('parseCriticResponse', () => {
  it('parses a clean JSON verdict', () => {
    const r = parseCriticResponse('{"pass":false,"severity":70,"issues":["a","b"]}', 'risk');
    expect(r).toEqual({ lens: 'risk', pass: false, severity: 70, issues: ['a', 'b'] });
  });

  it('extracts JSON embedded in prose', () => {
    const r = parseCriticResponse('結果: {"pass":true,"severity":0,"issues":[]} 以上', 'x');
    expect(r.pass).toBe(true);
  });

  it('defaults to pass when no JSON is present (no false block)', () => {
    expect(parseCriticResponse('no json here', 'x').pass).toBe(true);
  });

  it('treats anything but explicit false as pass', () => {
    expect(parseCriticResponse('{"severity":0}', 'x').pass).toBe(true);
  });

  it('clamps severity into 0..100', () => {
    expect(parseCriticResponse('{"pass":false,"severity":999,"issues":["x"]}', 'x').severity).toBe(
      100,
    );
  });
});

describe('truncateWithNotice', () => {
  it('returns text unchanged when within the limit', () => {
    const r = truncateWithNotice('short', 100);
    expect(r).toEqual({ text: 'short', truncated: false });
  });

  it('preserves both the head and the tail of the original text when over the limit', () => {
    const text = `HEAD${'x'.repeat(20000)}TAIL`;
    const r = truncateWithNotice(text, 16000);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('HEAD')).toBe(true);
    expect(r.text.endsWith('TAIL')).toBe(true);
    expect(r.text).toContain('中略');
    expect(r.text).toContain('原文はここで終わっていません');
    expect(r.text.length).toBeLessThanOrEqual(16000);
  });
});

describe('lensSystemPrompt', () => {
  it('forbids demanding plan-level implementation detail only for the research phase', () => {
    const research = lensSystemPrompt('research', { name: 'completeness', angle: 'x' });
    const plan = lensSystemPrompt('plan', { name: 'feasibility', angle: 'x' });
    expect(research).toContain('research.mdの役割は影響範囲・依存関係・リスクの調査');
    expect(plan).not.toContain('research.mdの役割は影響範囲・依存関係・リスクの調査');
  });

  it('forbids treating an omission marker as a real gap in both phases', () => {
    const research = lensSystemPrompt('research', { name: 'completeness', angle: 'x' });
    const plan = lensSystemPrompt('plan', { name: 'feasibility', angle: 'x' });
    expect(research).toContain('省略は表示上の制約であり、原文の欠落ではない');
    expect(plan).toContain('省略は表示上の制約であり、原文の欠落ではない');
  });
});

describe('buildCriticUserMessage', () => {
  it('with no context, is the artifact alone', () => {
    const { message, truncated } = buildCriticUserMessage('plan body');
    expect(message).toBe('# 批評対象アーティファクト\nplan body');
    expect(truncated).toBe(false);
  });

  it('orders grounding sections before the artifact and labels them as reference-only', () => {
    const { message } = buildCriticUserMessage('plan body', {
      taskBrief: 'title\n\ndesc',
      acceptanceCriteria: ['AC1: 満たすこと', 'AC2: 満たすこと'],
      referenceArtifact: 'research body',
      priorReasons: ['issue 1', 'issue 2'],
    });
    const iTask = message.indexOf('# タスク要求');
    const iAc = message.indexOf('# 受入基準');
    const iRef = message.indexOf('# 先行フェーズ文書');
    const iPrior = message.indexOf('# 前回の批評指摘');
    const iArtifact = message.indexOf('# 批評対象アーティファクト');
    expect(iTask).toBeGreaterThanOrEqual(0);
    expect(iAc).toBeGreaterThan(iTask);
    expect(iRef).toBeGreaterThan(iAc);
    expect(iPrior).toBeGreaterThan(iRef);
    expect(iArtifact).toBeGreaterThan(iPrior);
    expect(message).toContain('- issue 1');
    expect(message).toContain('- AC1: 満たすこと');
    expect(message).toContain('批評対象ではない');
  });

  it('omits the acceptance criteria section when none are given', () => {
    const { message } = buildCriticUserMessage('x', { taskBrief: 'brief' });
    expect(message).not.toContain('# 受入基準');
  });

  it('skips empty/whitespace grounding fields', () => {
    const { message, truncated } = buildCriticUserMessage('x', {
      taskBrief: '  ',
      referenceArtifact: '',
      priorReasons: [],
    });
    expect(message).toBe('# 批評対象アーティファクト\nx');
    expect(truncated).toBe(false);
  });

  it('bounds every section (taskBrief 3k / AC 4k / reference 8k / reasons 8 / artifact 16k) without silently dropping the tail', () => {
    const artifact = `HEAD${'a'.repeat(20000)}TAIL`;
    const { message, truncated } = buildCriticUserMessage(artifact, {
      taskBrief: 'b'.repeat(5000),
      referenceArtifact: 'c'.repeat(10000),
      priorReasons: Array.from({ length: 12 }, (_, i) => `r${i}`),
    });
    expect(truncated).toBe(true);
    expect(message).not.toContain('b'.repeat(3001));
    expect(message).not.toContain('c'.repeat(8001));
    expect(message).toContain('- r7');
    expect(message).not.toContain('- r8');
    // Task 911: the artifact's tail must survive truncation, not just its head.
    expect(message).toContain('HEAD');
    expect(message).toContain('TAIL');
  });

  it('prepends the truncation warning banner only when a section was actually truncated', () => {
    const truncatedMsg = buildCriticUserMessage('a'.repeat(20000)).message;
    const untruncatedMsg = buildCriticUserMessage('short').message;
    expect(truncatedMsg.startsWith('⚠️')).toBe(true);
    expect(untruncatedMsg.startsWith('⚠️')).toBe(false);
  });
});

describe('critiquePhase — sendAIMessage integration (task 911)', () => {
  beforeEach(() => {
    sendAIMessageMock.mockClear();
    sendAIMessageMock.mockImplementation(async () => ({
      content: '{"pass":true,"severity":0,"issues":[]}',
    }));
    isAnyApiKeyConfiguredMock.mockClear().mockImplementation(async () => true);
    getDefaultProviderMock.mockClear().mockImplementation(async () => 'anthropic');
  });

  it('includes the acceptance criteria text in the message actually sent to the lens (AC1)', async () => {
    await critiquePhase('research', 'research body', {
      acceptanceCriteria: ['ユニークな受入基準テキストXYZ123'],
    });
    expect(sendAIMessageMock).toHaveBeenCalled();
    const call = sendAIMessageMock.mock.calls[0]?.[0] as {
      messages: { content: string }[];
    };
    expect(call.messages[0]?.content).toContain('ユニークな受入基準テキストXYZ123');
    expect(call.messages[0]?.content).toContain('# 受入基準');
    expect(sendAIMessageMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: 'configured-critic-model' }),
    );
  });

  it('reports inputTruncated:true when the artifact exceeds the limit', async () => {
    const result = await critiquePhase('research', 'a'.repeat(20000));
    expect(result.inputTruncated).toBe(true);
    expect(result.verdict).toBe('unknown');
  });

  it('reports inputTruncated:false when nothing needed truncating', async () => {
    const result = await critiquePhase('research', 'short body');
    expect(result.inputTruncated).toBe(false);
    expect(result.evaluationComplete).toBe(true);
  });

  for (const position of ['head', 'middle', 'tail']) {
    it(`does not claim full validation with an important ${position} correction in a long brief`, async () => {
      const correction = 'IMPORTANT_CORRECTION_DO_NOT_COMPLETE_UNMET_REQUIREMENTS';
      const padding = 'x'.repeat(4000);
      const taskBrief =
        position === 'head'
          ? correction + padding + padding
          : position === 'tail'
            ? padding + padding + correction
            : padding + correction + padding;
      const { message, truncated } = buildCriticUserMessage('short artifact', { taskBrief });
      expect(truncated).toBe(true);
      expect(message.includes(correction)).toBe(position !== 'middle');
      const result = await critiquePhase('research', 'short artifact', { taskBrief });
      expect(result.verdict).toBe('unknown');
      expect(result.inputTruncated).toBe(true);
    });
  }

  it('does not report complete evaluation when a lens times out', async () => {
    sendAIMessageMock.mockImplementationOnce(async () => {
      throw new Error('Claude CLI timed out');
    });
    const result = await critiquePhase('research', 'short body');
    expect(result.evaluationComplete).toBe(false);
  });
});

describe('isPhaseCriticEnabled', () => {
  const original = process.env.RAPITAS_PHASE_CRITIC;
  afterEach(() => {
    if (original === undefined) delete process.env.RAPITAS_PHASE_CRITIC;
    else process.env.RAPITAS_PHASE_CRITIC = original;
  });

  it('is ON by default (R7 — premortem/critic gate is standing)', () => {
    delete process.env.RAPITAS_PHASE_CRITIC;
    expect(isPhaseCriticEnabled()).toBe(true);
  });

  it('stays on for truthy values', () => {
    for (const val of ['1', 'true', 'on', 'yes']) {
      process.env.RAPITAS_PHASE_CRITIC = val;
      expect(isPhaseCriticEnabled()).toBe(true);
    }
  });

  it('opts out for 0 / false / off', () => {
    for (const val of ['0', 'false', 'off']) {
      process.env.RAPITAS_PHASE_CRITIC = val;
      expect(isPhaseCriticEnabled()).toBe(false);
    }
  });
});
