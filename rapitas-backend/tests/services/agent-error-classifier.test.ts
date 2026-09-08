/**
 * Agent Error Classifier テスト
 *
 * Validates that provider-specific failure messages are mapped to the
 * right cooldown reason and reset hint.
 */
import { describe, it, expect, test } from 'bun:test';
import { classifyAgentError } from '../../services/ai/agent-error-classifier';
import { BOUNDARY_STRINGS } from '../helpers/boundary-values';

describe('classifyAgentError', () => {
  it('Codex/ChatGPT の usage limit を quota として判定する', () => {
    const r = classifyAgentError(
      "■ You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:19 PM.",
    );
    expect(r).not.toBeNull();
    expect(r!.provider).toBe('openai');
    expect(r!.reason).toBe('quota');
    expect(r!.retryWithFallback).toBe(true);
    expect(r!.resetAt).toBeDefined();
  });

  it('Claude の monthly spend limit を claude の quota として判定する', () => {
    // 実測 2026-08-19: この文言が未分類だったため cooldown もフォールバックも
    // 起きず、12実行が連続失敗してタスクが恒久 blocked になった。
    const r = classifyAgentError(
      [
        'Process exited with code 1',
        '[System: init]',
        "You've hit your monthly spend limit. ",
      ].join('\n') +
        'Switch to another model, or manage usage credits at ' +
        'claude.ai/settings/usage?from=cc_cli_limit_message',
    );
    expect(r).not.toBeNull();
    expect(r!.provider).toBe('claude');
    expect(r!.reason).toBe('quota');
    expect(r!.retryWithFallback).toBe(true);
  });

  it('claude.ai の請求URLは codex ルールより優先して claude に帰属する', () => {
    const r = classifyAgentError(
      "You've hit your usage limit. See claude.ai/settings/usage for details.",
    );
    expect(r?.provider).toBe('claude');
  });

  it('codex の請求URLは openai に帰属したままになる', () => {
    const r = classifyAgentError(
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage",
    );
    expect(r?.provider).toBe('openai');
  });

  it('try again at HH:MM AM/PM の時刻パースに対応する', () => {
    const r = classifyAgentError('usage limit. try again at 11:30 AM');
    expect(r?.resetAt).toBeDefined();
    expect(r!.resetAt!.getHours()).toBe(11);
    expect(r!.resetAt!.getMinutes()).toBe(30);
  });

  it('API の 5xx は transient として判定する', () => {
    // 実測 2026-08-24 task 624: この文言が未分類だったため cooldown も
    // フォールバックも起きず、さらに「原因不明＝モデル起因」と見なされて
    // 再試行が premium に昇格していた。サーバー側の瞬断で支払いが増える形。
    for (const msg of [
      'Process exited with code 1\n[System: init] API Error: 500 Internal server error.',
      'API Error: 503 Service Unavailable',
      'API Error: 529 overloaded_error',
      'API Error: 502 Bad Gateway',
    ]) {
      const r = classifyAgentError(msg);
      expect(r?.reason).toBe('transient');
      expect(r?.retryWithFallback).toBe(true);
    }
  });

  it('コード中やログ本文の "500" では transient に誤検知しない', () => {
    for (const msg of [
      'const TIMEOUT_MS = 500; // retry window',
      'ファイルは500行を超えています',
      'if (res.status === 500) { handleServerError(res); }',
    ]) {
      expect(classifyAgentError(msg, { strict: true })).toBeNull();
    }
  });

  it('Anthropic credit_balance_too_low を quota として判定する', () => {
    const r = classifyAgentError('Anthropic API error: credit_balance_too_low');
    expect(r?.provider).toBe('claude');
    expect(r?.reason).toBe('quota');
  });

  it('Anthropic rate_limit を rate_limit として判定する', () => {
    const r = classifyAgentError('Anthropic API error: rate_limit_error');
    expect(r?.provider).toBe('claude');
    expect(r?.reason).toBe('rate_limit');
  });

  it('rate_limit_error が行頭に来る場合も判定する', () => {
    const r = classifyAgentError('\nrate_limit_error: Request rate limited');
    expect(r?.provider).toBe('claude');
    expect(r?.reason).toBe('rate_limit');
  });

  it('エージェントがコード内で rate_limit_error を使っても誤検知しない', () => {
    // False-positive guard: agents often write code that handles Anthropic
    // rate limit errors — these strings must NOT trigger the fallback path.
    const codeSnippets = [
      "if (error.type === 'rate_limit_error') { handleRateLimit(error); }",
      "case 'rate_limit_error': return retryWithBackoff();",
      "const ERR_RATE_LIMIT = 'rate_limit_error';",
      'I updated the handler to manage rate_limit_error cases properly.',
      '// TODO: handle rate_limit_error from Anthropic',
    ];
    for (const snippet of codeSnippets) {
      const r = classifyAgentError(snippet, { strict: true });
      expect(r).toBeNull();
    }
    // Also check lenient mode — the lenient heuristics should not catch these
    // since none of them have an ERROR context marker at the line beginning.
    for (const snippet of codeSnippets) {
      const r = classifyAgentError(snippet);
      expect(r).toBeNull();
    }
  });

  it('Gemini RESOURCE_EXHAUSTED を quota として判定する', () => {
    const r = classifyAgentError('googleapis: RESOURCE_EXHAUSTED');
    expect(r?.provider).toBe('gemini');
    expect(r?.reason).toBe('quota');
  });

  it('Anthropic invalid api key は auth として判定し fallbackは行わない', () => {
    const r = classifyAgentError('Anthropic API error: invalid api key');
    expect(r?.provider).toBe('claude');
    expect(r?.reason).toBe('auth');
    expect(r?.retryWithFallback).toBe(false);
  });

  it('該当パターンが無い場合は null を返す', () => {
    expect(classifyAgentError('unrelated noise')).toBeNull();
  });

  test.each(BOUNDARY_STRINGS)(
    '境界文字列 $label はパターン不一致で null を返すこと',
    ({ value }) => {
      expect(classifyAgentError(value)).toBeNull();
    },
  );

  it('hint があり 429 ヒントが見つかれば rate_limit として hint プロバイダで分類する', () => {
    const r = classifyAgentError('HTTP 429 Too Many Requests\nERROR: rate limit', 'gemini');
    expect(r?.reason).toBe('rate_limit');
    expect(r?.provider).toBe('gemini');
  });

  describe('strict mode (false-positive prevention)', () => {
    type StrictModeCase = {
      label: string;
      input: string;
      expected: null | { provider: string; reason: string };
    };

    // 旧来の lenient モード: 最初の3件は false-positive する文字列（strict では無視すべき）。
    // 残りの2件は strict でも明示的なパターンとしてマッチすべき文字列。
    const strictModeCases: StrictModeCase[] = [
      {
        label: 'rate limiting の実装に関する説明文',
        input: 'Implemented rate limiting on the API endpoints.',
        expected: null,
      },
      {
        label: 'クレジット表記（@メンション）',
        input: 'Give credit to @ymd for the original idea.',
        expected: null,
      },
      {
        label: 'README内のクレジット残高セクションの説明',
        input: 'See credit balance section in README.',
        expected: null,
      },
      {
        label: 'Codex/ChatGPT の usage limit',
        input: "ERROR: You've hit your usage limit. try again at 1:19 PM",
        expected: { provider: 'openai', reason: 'quota' },
      },
      {
        label: 'Anthropic credit_balance_too_low',
        input: 'Anthropic API error: credit_balance_too_low',
        expected: { provider: 'claude', reason: 'quota' },
      },
      {
        label: 'ERRORコンテキストなしの裸429（execution3874再現）',
        input: 'Plan: implement local HTTP 429 rate-limit handling in the client SDK.',
        expected: null,
      },
      {
        label: 'ERRORコンテキストありの429はstrictでも検知する（安全網の維持）',
        input: 'ERROR: 429 Too Many Requests from upstream',
        expected: { provider: 'gemini', reason: 'rate_limit' },
      },
    ];

    test.each(strictModeCases)('strict mode: $label', ({ input, expected }) => {
      const r = classifyAgentError(input, { strict: true });
      if (expected === null) {
        expect(r).toBeNull();
      } else {
        expect(r).not.toBeNull();
        expect(r!.provider).toBe(expected.provider);
        expect(r!.reason).toBe(expected.reason);
      }
    });

    it('lenient mode (デフォルト) でも、ERRORコンテキストなしの単独 "credit" は誤検知しない（修正後）', () => {
      // 修正前: '\b(quota|usage limit|credit)\b' で単独"credit"が誤検知
      // 修正後: ERRORコンテキスト+具体的なフレーズ要求でこれは null
      expect(classifyAgentError('Give credit to original author')).toBeNull();
      expect(classifyAgentError('Implements rate limiting middleware')).toBeNull();
    });

    it('lenient mode で ERROR文脈 + 明確な quotaフレーズはマッチする', () => {
      const r = classifyAgentError('ERROR: usage limit exceeded for this hour');
      expect(r?.reason).toBe('quota');
    });
  });

  describe('model_unavailable', () => {
    it('Claude Fable 5 is currently unavailable を model_unavailable として判定する', () => {
      const r = classifyAgentError(
        'Claude Fable 5 is currently unavailable. Learn more: https://www.anthropic.com/news/fable-mythos-access',
      );
      expect(r).not.toBeNull();
      expect(r!.provider).toBe('claude');
      expect(r!.reason).toBe('model_unavailable');
      expect(r!.retryWithFallback).toBe(true);
    });

    it('provider クールダウンに入れない（retryWithFallback が true）', () => {
      const r = classifyAgentError('Some model is currently unavailable.');
      expect(r).not.toBeNull();
      expect(r!.retryWithFallback).toBe(true);
    });

    it('unavailable が prose 中に出ても誤検知しない', () => {
      // "currently unavailable" を含まない prose は null
      const r = classifyAgentError('The feature is temporarily unavailable due to maintenance.');
      // "is currently unavailable" のフレーズ要件を満たさないのでマッチしない
      expect(r).toBeNull();
    });
  });
});
