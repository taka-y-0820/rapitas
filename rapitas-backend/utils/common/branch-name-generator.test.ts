/**
 * branch-name-generator ユニットテスト
 *
 * 純粋関数群（extractBranchName / sanitizeBranchName / assertSafeGitRef /
 * isValidBranchName / generateFallbackBranchName）を実実装で固定し、
 * generateBranchName の AI 呼び出し成功・失敗（フォールバック）経路を
 * ../ai-client のモックで検証する。
 */
import { afterEach, beforeEach, describe, test, expect, mock } from 'bun:test';

const noopLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  fatal: () => {},
};
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

const mockSendAIMessage = mock(() =>
  Promise.resolve({ content: 'feature/add-user-authentication', tokensUsed: 0 }),
) as ReturnType<typeof mock>;

mock.module('../ai-client', () => ({
  sendAIMessage: mockSendAIMessage,
  sendAIMessageStream: mock(() => Promise.resolve(new ReadableStream())),
  getAuxAiMode: mock(() => 'cli'),
  isValidApiKeyFormat: mock(() => true),
  getApiKeyForProvider: mock(() => Promise.resolve(null)),
  getDefaultModel: mock(() => 'claude-model'),
  getDefaultProvider: mock(() => Promise.resolve('claude')),
  isAnyApiKeyConfigured: mock(() => Promise.resolve(true)),
  getConfiguredProviders: mock(() => Promise.resolve([])),
  getOllamaUrl: mock(() => 'http://localhost:11434'),
  formatApiError: mock(() => 'error'),
  handleApiError: mock(() => ({ content: '', tokensUsed: 0 })),
  callClaude: mock(() => Promise.resolve({ content: '', tokensUsed: 0 })),
  callClaudeStream: mock(() => Promise.resolve(new ReadableStream())),
  callClaudeCli: mock(() => Promise.resolve({ content: '', tokensUsed: 0 })),
  callClaudeCliStream: mock(() => Promise.resolve(new ReadableStream())),
  isClaudeCliAvailable: mock(() => Promise.resolve(true)),
  callChatGPT: mock(() => Promise.resolve({ content: '', tokensUsed: 0 })),
  callChatGPTStream: mock(() => Promise.resolve(new ReadableStream())),
  callGemini: mock(() => Promise.resolve({ content: '', tokensUsed: 0 })),
  callGeminiStream: mock(() => Promise.resolve(new ReadableStream())),
  callOllama: mock(() => Promise.resolve({ content: '', tokensUsed: 0 })),
  callOllamaStream: mock(() => Promise.resolve(new ReadableStream())),
  checkOllamaConnection: mock(() => Promise.resolve(true)),
  PROVIDER_NAMES: { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', ollama: 'Ollama' },
}));

import {
  generateBranchName,
  extractBranchName,
  sanitizeBranchName,
  assertSafeGitRef,
  isValidBranchName,
  generateFallbackBranchName,
  hasTaskIdMarker,
} from './branch-name-generator';

/** Count occurrences of the exact `t<taskId>` segment in a branch name. */
function countTaskIdMarkers(name: string, taskId: number): number {
  const matches = name.match(new RegExp(`(?:^|[/-])t${taskId}(?=[/-]|$)`, 'g'));
  return matches ? matches.length : 0;
}

describe('extractBranchName', () => {
  test('passes through a clean branch name unchanged', () => {
    expect(extractBranchName('feature/add-user-authentication')).toBe(
      'feature/add-user-authentication',
    );
  });

  test('strips markdown code fences', () => {
    expect(extractBranchName('```\nfeature/add-auth\n```')).toBe('feature/add-auth');
  });

  test('strips surrounding backticks', () => {
    expect(extractBranchName('`feature/add-auth`')).toBe('feature/add-auth');
  });

  test('takes only the first line when the LLM appends explanatory text', () => {
    expect(extractBranchName('feature/add-auth\nThis adds authentication.')).toBe(
      'feature/add-auth',
    );
  });

  test('removes surrounding quotes', () => {
    expect(extractBranchName('"feature/add-auth"')).toBe('feature/add-auth');
  });

  test('removes a "branch name:" style prefix', () => {
    expect(extractBranchName('Branch name: feature/add-auth')).toBe('feature/add-auth');
  });

  test('normalizes fix/ to bugfix/', () => {
    expect(extractBranchName('fix/login-button')).toBe('bugfix/login-button');
  });

  test('prepends feature/ when no valid prefix is present', () => {
    expect(extractBranchName('add-user-authentication')).toBe('feature/add-user-authentication');
  });

  test('inserts "implement-" when the slug after the prefix has no hyphen', () => {
    expect(extractBranchName('feature/auth')).toBe('feature/implement-auth');
  });
});

describe('sanitizeBranchName', () => {
  test('lowercases the input', () => {
    expect(sanitizeBranchName('Feature/Add-Auth')).toBe('feature/add-auth');
  });

  test('replaces disallowed characters with hyphens', () => {
    expect(sanitizeBranchName('feature/add auth!!')).toBe('feature/add-auth');
  });

  test('collapses consecutive hyphens', () => {
    expect(sanitizeBranchName('feature/add---auth')).toBe('feature/add-auth');
  });

  test('strips leading and trailing hyphens', () => {
    expect(sanitizeBranchName('-feature/add-auth-')).toBe('feature/add-auth');
  });

  test('truncates to 50 characters', () => {
    const long = 'feature/' + 'a'.repeat(60);
    const result = sanitizeBranchName(long);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe('assertSafeGitRef', () => {
  test('accepts a well-formed branch name', () => {
    expect(() => assertSafeGitRef('feature/add-auth')).not.toThrow();
  });

  test('rejects an empty string', () => {
    expect(() => assertSafeGitRef('')).toThrow();
  });

  test('rejects a value longer than 200 characters', () => {
    expect(() => assertSafeGitRef('a'.repeat(201))).toThrow();
  });

  test('rejects shell metacharacters', () => {
    expect(() => assertSafeGitRef('feature/add; rm -rf /')).toThrow();
  });

  test('rejects path traversal', () => {
    expect(() => assertSafeGitRef('feature/../../etc/passwd')).toThrow();
  });

  test('rejects a leading hyphen (git option injection)', () => {
    expect(() => assertSafeGitRef('--force')).toThrow();
  });

  test('includes the field name in the error message', () => {
    expect(() => assertSafeGitRef('', 'baseBranch')).toThrow(/baseBranch/);
  });
});

describe('isValidBranchName', () => {
  test('accepts a valid feature branch name', () => {
    expect(isValidBranchName('feature/add-user-auth')).toBe(true);
  });

  test('rejects an empty name', () => {
    expect(isValidBranchName('')).toBe(false);
  });

  test('rejects a name over 50 characters', () => {
    expect(isValidBranchName('feature/' + 'a-'.repeat(30))).toBe(false);
  });

  test('rejects a name without a recognized prefix', () => {
    expect(isValidBranchName('add-user-auth')).toBe(false);
  });

  test('rejects a single-word slug (no hyphen after the prefix)', () => {
    expect(isValidBranchName('feature/auth')).toBe(false);
  });

  test('rejects names containing special characters', () => {
    expect(isValidBranchName('feature/add~auth')).toBe(false);
  });

  test('rejects consecutive dots', () => {
    expect(isValidBranchName('feature/add..auth')).toBe(false);
  });

  test('rejects a leading dot', () => {
    expect(isValidBranchName('.feature/add-auth')).toBe(false);
  });

  test('rejects a trailing hyphen', () => {
    expect(isValidBranchName('feature/add-auth-')).toBe(false);
  });
});

describe('generateFallbackBranchName', () => {
  test('generates a feature/ branch for a generic task title', () => {
    const name = generateFallbackBranchName('Add dashboard charts');
    expect(name).toMatch(/^feature\//);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('generates a bugfix/ branch when the title contains a bug keyword', () => {
    const name = generateFallbackBranchName('Fix login button error');
    expect(name).toMatch(/^bugfix\//);
  });

  test('generates a bugfix/ branch for a Japanese bug keyword', () => {
    const name = generateFallbackBranchName('ログインボタンのバグ修正');
    expect(name).toMatch(/^bugfix\//);
  });

  test('generates a chore/ branch when the title contains a chore keyword', () => {
    const name = generateFallbackBranchName('Update dependencies');
    expect(name).toMatch(/^chore\//);
  });

  test('falls back to "task" when the title has no usable characters', () => {
    const name = generateFallbackBranchName('!!!');
    expect(name).toBe('feature/update-task');
  });

  test('always produces a name that passes isValidBranchName', () => {
    const titles = ['', '   ', '日本語のみのタスク', 'A', 'Refactor the whole auth module now'];
    for (const title of titles) {
      expect(isValidBranchName(generateFallbackBranchName(title))).toBe(true);
    }
  });
});

describe('hasTaskIdMarker', () => {
  test('detects the marker right after the prefix', () => {
    expect(hasTaskIdMarker('feature/t319-implement-perf', 319)).toBe(true);
  });

  test('detects the marker as a trailing segment', () => {
    expect(hasTaskIdMarker('feature/fallback-branch-t1', 1)).toBe(true);
  });

  test('does not match a shorter taskId prefixing a longer number', () => {
    expect(hasTaskIdMarker('feature/t319-implement-perf', 31)).toBe(false);
  });

  test('does not match a longer number for a shorter taskId', () => {
    expect(hasTaskIdMarker('feature/t31-x', 3)).toBe(false);
    expect(hasTaskIdMarker('feature/t319-implement-perf', 3190)).toBe(false);
  });

  test('does not match a plain word containing t<id> without boundaries', () => {
    expect(hasTaskIdMarker('feature/at319x-work', 319)).toBe(false);
  });
});

describe('generateFallbackBranchName with taskId', () => {
  test('embeds the marker right after the prefix, exactly once', () => {
    const name = generateFallbackBranchName('Add dashboard charts', 539);
    expect(name).toMatch(/^feature\/t539-/);
    expect(countTaskIdMarkers(name, 539)).toBe(1);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('keeps prefix detection (bugfix/chore) with the marker', () => {
    expect(generateFallbackBranchName('Fix login button error', 12)).toMatch(/^bugfix\/t12-/);
    expect(generateFallbackBranchName('Update dependencies', 12)).toMatch(/^chore\/t12-/);
  });

  test('makes unknown non-ASCII titles unique without using implement-task', () => {
    const a = generateFallbackBranchName('日本語のみのタスク', 100);
    const b = generateFallbackBranchName('別の日本語タスク', 200);
    expect(a).toBe('feature/t100-update-task');
    expect(b).toBe('feature/t200-update-task');
    expect(a).not.toContain('implement-task');
    expect(b).not.toContain('implement-task');
    expect(a).not.toBe(b);
    expect(isValidBranchName(a)).toBe(true);
    expect(isValidBranchName(b)).toBe(true);
  });

  test('generates meaningful deterministic slugs for Japanese-only titles', () => {
    const auth = generateFallbackBranchName('認証画面の不具合を修正', 100);
    const workflow = generateFallbackBranchName('ワークフロー実行を改善', 200);
    const tokens = generateFallbackBranchName('モデル選択とトークンを最適化', 300);

    expect(auth).toBe('bugfix/t100-fix-authentication-ui');
    expect(workflow).toBe('feature/t200-improve-workflow-execution');
    expect(tokens).toBe('feature/t300-improve-model-tokens');
    for (const name of [auth, workflow, tokens]) {
      expect(name).not.toContain('implement-task');
      expect(isValidBranchName(name)).toBe(true);
    }
  });

  test('never truncates the marker on long titles (50-char limit falls on the slug)', () => {
    const name = generateFallbackBranchName(
      'Refactor the entire authentication and authorization module now',
      1234567,
    );
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name).toMatch(/^chore\/t1234567-/);
    expect(countTaskIdMarkers(name, 1234567)).toBe(1);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('produces a minimal valid slug when the marker consumes nearly the whole budget', () => {
    // 9-digit taskId: head = "feature/t123456789-" (19 chars) still leaves slug room;
    // validity must hold regardless.
    const name = generateFallbackBranchName('!!!', 123456789);
    expect(name).toMatch(/^feature\/t123456789-/);
    expect(name.length).toBeLessThanOrEqual(50);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('omitting taskId preserves the legacy output exactly', () => {
    expect(generateFallbackBranchName('!!!')).toBe('feature/update-task');
  });
});

describe('generateBranchName', () => {
  beforeEach(() => {
    process.env.RAPITAS_AI_BRANCH_NAMES = '1';
  });

  afterEach(() => {
    delete process.env.RAPITAS_AI_BRANCH_NAMES;
  });

  test('uses the deterministic generator by default without an AI call', async () => {
    delete process.env.RAPITAS_AI_BRANCH_NAMES;
    mockSendAIMessage.mockClear();

    const name = await generateBranchName('Fix login button error', undefined, 539);

    expect(name).toBe('bugfix/t539-fix-login-button-error');
    expect(mockSendAIMessage).not.toHaveBeenCalled();
    expect(isValidBranchName(name)).toBe(true);
  });

  test('returns the AI-generated branch name when the response is valid', async () => {
    mockSendAIMessage.mockImplementationOnce(() =>
      Promise.resolve({ content: 'feature/add-user-authentication', tokensUsed: 10 }),
    );
    const name = await generateBranchName('Add user authentication');
    expect(name).toBe('feature/add-user-authentication');
  });

  test('falls back to a generated name when the AI call rejects', async () => {
    mockSendAIMessage.mockImplementationOnce(() => Promise.reject(new Error('AI unavailable')));
    const name = await generateBranchName('Fix login button error');
    expect(name).toMatch(/^bugfix\//);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('falls back to a generated name when the AI response is unusable (empty)', async () => {
    mockSendAIMessage.mockImplementationOnce(() => Promise.resolve({ content: '', tokensUsed: 0 }));
    const name = await generateBranchName('Update dependencies');
    expect(name).toMatch(/^chore\//);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('embeds the taskId marker exactly once into a valid AI response', async () => {
    mockSendAIMessage.mockImplementationOnce(() =>
      Promise.resolve({ content: 'feature/add-user-authentication', tokensUsed: 10 }),
    );
    const name = await generateBranchName('Add user authentication', undefined, 539);
    expect(name).toBe('feature/t539-add-user-authentication');
    expect(countTaskIdMarkers(name, 539)).toBe(1);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('keeps the taskId marker when falling back after an AI rejection', async () => {
    mockSendAIMessage.mockImplementationOnce(() => Promise.reject(new Error('AI unavailable')));
    const name = await generateBranchName('Fix login button error', undefined, 539);
    expect(name).toMatch(/^bugfix\/t539-/);
    expect(countTaskIdMarkers(name, 539)).toBe(1);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('keeps the taskId marker when falling back on an empty AI response', async () => {
    mockSendAIMessage.mockImplementationOnce(() => Promise.resolve({ content: '', tokensUsed: 0 }));
    const name = await generateBranchName('Update dependencies', undefined, 539);
    expect(name).toMatch(/^chore\/t539-/);
    expect(countTaskIdMarkers(name, 539)).toBe(1);
    expect(isValidBranchName(name)).toBe(true);
  });

  test('caps a long AI-generated name at 50 chars without truncating the marker', async () => {
    mockSendAIMessage.mockImplementationOnce(() =>
      Promise.resolve({ content: 'feature/add-comprehensive-user-authentication', tokensUsed: 10 }),
    );
    const name = await generateBranchName('Add user authentication', undefined, 1234567);
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name).toMatch(/^feature\/t1234567-/);
    expect(isValidBranchName(name)).toBe(true);
  });
});
