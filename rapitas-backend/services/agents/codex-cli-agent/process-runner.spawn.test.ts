/**
 * process-runner.spawn.test
 *
 * Covers the pure argument/env builders exported by process-runner.ts:
 * `buildSpawnCommand`, `buildProcessEnv`, and `normalizeCodexModel`. No
 * process is spawned by these tests — they exercise plain functions.
 * CLI-argument construction inside `spawnCodexProcess` itself (implementation
 * / yolo / sandbox / investigation / resume modes) plus the low-level spawn
 * wiring live in process-runner.args.test.ts (kept separate to stay under the
 * 300-500 line file-size policy); event-parsing coordination lives in
 * process-runner.events.test.ts / process-runner.timing.test.ts; error/close
 * handling lives in process-runner.errors.test.ts.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { buildSpawnCommand, buildProcessEnv, normalizeCodexModel } from './process-runner';

// ── buildSpawnCommand ────────────────────────────────────────────────────────

describe('buildSpawnCommand', () => {
  test('non-Windows: passes command and args through unchanged', () => {
    const [command, args] = buildSpawnCommand('/usr/local/bin/codex', ['exec', 'do it'], false);
    expect(command).toBe('/usr/local/bin/codex');
    expect(args).toEqual(['exec', 'do it']);
  });

  test.each([
    [
      'wraps in a chcp 65001 prefix and flattens args into one string',
      ['exec', '--cd', 'C:/work'],
      'chcp 65001 >NUL 2>&1 && codex.cmd exec --cd C:/work',
    ],
    [
      'leaves simple args unquoted',
      ['exec', '--json'],
      'chcp 65001 >NUL 2>&1 && codex.cmd exec --json',
    ],
  ])('Windows: %s', (_desc, args, expectedCommand) => {
    const [command, finalArgs] = buildSpawnCommand('codex.cmd', args, true);
    expect(command).toBe(expectedCommand);
    expect(finalArgs).toEqual([]);
  });

  test('Windows: quotes the codex path when it contains a space', () => {
    const [command] = buildSpawnCommand('C:/Program Files/codex.cmd', ['exec'], true);
    expect(command).toContain('"C:/Program Files/codex.cmd"');
  });

  test('Windows: quotes args containing spaces, &, |, or newlines and escapes embedded quotes', () => {
    const [command] = buildSpawnCommand(
      'codex.cmd',
      ['has space', 'a&b', 'a|b', 'a\nb', 'say "hi"'],
      true,
    );
    expect(command).toContain('"has space"');
    expect(command).toContain('"a&b"');
    expect(command).toContain('"a|b"');
    expect(command).toContain('"a\nb"');
    expect(command).toContain('"say \\"hi\\""');
  });
});

// ── buildProcessEnv ──────────────────────────────────────────────────────────

describe('buildProcessEnv', () => {
  const secretKeys = ['DATABASE_URL', 'ENCRYPTION_KEY'] as const;
  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of secretKeys) {
      originalValues[key] = process.env[key];
      process.env[key] = 'super-secret-value';
    }
  });

  test('sanitizes secrets from the inherited env and applies CLI-friendly overrides', () => {
    const env = buildProcessEnv({}, false);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.NO_COLOR).toBe('1');
    expect(env.CI).toBe('1');
    expect(env.TERM).toBe('dumb');
    for (const key of secretKeys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  });

  test('injects OPENAI_API_KEY when config.apiKey is provided', () => {
    const env = buildProcessEnv({ apiKey: 'sk-test-123' }, false);
    expect(env.OPENAI_API_KEY).toBe('sk-test-123');
  });

  test('does not set OPENAI_API_KEY when config.apiKey is absent', () => {
    // NOTE: the CI/dev shell may already export OPENAI_API_KEY for other
    // tools — buildProcessEnv only skips *adding* one, it never strips an
    // inherited value (OPENAI_ is a keep-prefix), so isolate the assertion.
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const env = buildProcessEnv({}, false);
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  test('adds Windows-only encoding vars only when isWindows=true', () => {
    // NOTE: buildProcessEnv only ever SETS these four vars on the
    // isWindows=true branch — on isWindows=false it just inherits whatever
    // the host shell already exports via buildSanitizedSpawnEnv's
    // process.env spread (none of them are secrets, so the denylist never
    // strips them). Some shells (observed: this repo's own dev machines)
    // export LANG/PYTHONIOENCODING for every process, so asserting they are
    // undefined on the non-Windows branch is only valid with a clean
    // process.env — hence the isolate/restore below (task #869).
    const keys = ['LANG', 'PYTHONIOENCODING', 'PYTHONUTF8', 'CHCP'] as const;
    const originalValues: Record<string, string | undefined> = {};
    for (const key of keys) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const winEnv = buildProcessEnv({}, true);
      expect(winEnv.LANG).toBe('en_US.UTF-8');
      expect(winEnv.PYTHONIOENCODING).toBe('utf-8');
      expect(winEnv.PYTHONUTF8).toBe('1');
      expect(winEnv.CHCP).toBe('65001');

      const nonWinEnv = buildProcessEnv({}, false);
      expect(nonWinEnv.LANG).toBeUndefined();
      expect(nonWinEnv.PYTHONIOENCODING).toBeUndefined();
      expect(nonWinEnv.PYTHONUTF8).toBeUndefined();
      expect(nonWinEnv.CHCP).toBeUndefined();
    } finally {
      for (const key of keys) {
        if (originalValues[key] === undefined) delete process.env[key];
        else process.env[key] = originalValues[key];
      }
    }
  });
});

// ── normalizeCodexModel ──────────────────────────────────────────────────────

describe('normalizeCodexModel', () => {
  test('trims surrounding whitespace', () => {
    expect(normalizeCodexModel('  gpt-5.5  ', true)).toBe('gpt-5.5');
  });

  test('returns an empty string unchanged', () => {
    expect(normalizeCodexModel('   ', false)).toBe('');
  });

  test.each(['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo', 'GPT-4O'])(
    'remaps legacy model %s to gpt-5.5 when there is no API key',
    (model) => {
      expect(normalizeCodexModel(model, false)).toBe('gpt-5.5');
    },
  );

  test.each(['gpt-4', 'gpt-3.5-turbo'])(
    'keeps legacy model %s unchanged when an API key is present',
    (model) => {
      expect(normalizeCodexModel(model, true)).toBe(model);
    },
  );

  test('leaves unrelated model names unchanged regardless of API key', () => {
    expect(normalizeCodexModel('o3-mini', false)).toBe('o3-mini');
    expect(normalizeCodexModel('o3-mini', true)).toBe('o3-mini');
  });
});
