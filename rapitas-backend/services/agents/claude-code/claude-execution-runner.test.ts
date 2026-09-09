/**
 * claude-execution-runner ユニットテスト
 *
 * buildClaudeArgs / buildSpawnEnv のセキュリティ関連フラグを固定するリグレッションテスト。
 * 将来の変更が --dangerously-skip-permissions の補償コントロール（disallowedTools /
 * 環境サニタイズ）を静かに緩めないようにする。実DB接続なしで動作する（ClaudeCodeAgent の
 * コンストラクタは Prisma へ接続しない — 遅延接続のため import のみでは副作用なし）。
 */
import { describe, expect, test } from 'bun:test';
import { ClaudeCodeAgent } from './agent-core';
import { buildClaudeArgs, buildSpawnEnv } from './claude-execution-runner';

describe('buildClaudeArgs', () => {
  test('dangerouslySkipPermissions=true のとき bypass 系フラグが両方付与される', () => {
    const agent = new ClaudeCodeAgent('t1', 'test-agent', {
      dangerouslySkipPermissions: true,
    });

    const { args } = buildClaudeArgs(agent);

    expect(args).toContain('--dangerously-skip-permissions');
    const modeIdx = args.indexOf('--permission-mode');
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(args[modeIdx + 1]).toBe('bypassPermissions');
  });

  test('dangerouslySkipPermissions=false のとき bypass 系フラグは付与されない', () => {
    const agent = new ClaudeCodeAgent('t2', 'test-agent', {
      dangerouslySkipPermissions: false,
    });

    const { args } = buildClaudeArgs(agent);

    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  test('通常モード（investigationMode=false）: ネットワーク越境/再帰系ツールが disallowedTools に含まれる', () => {
    const agent = new ClaudeCodeAgent('t3', 'test-agent', {
      dangerouslySkipPermissions: true,
      investigationMode: false,
    });

    const { args } = buildClaudeArgs(agent);
    const idx = args.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const disallowed = args[idx + 1].split(',');

    // NOTE: implementer/verifier に不要なツール群 — 緩めた変更を検知するための固定リスト
    for (const tool of [
      'EnterWorktree',
      'ExitWorktree',
      'WebFetch',
      'WebSearch',
      'ToolSearch',
      'Skill',
      'Task',
    ]) {
      expect(disallowed).toContain(tool);
    }
    // 通常モードでは Bash/Edit/Write は許可されたまま（実装作業に必須）
    expect(disallowed).not.toContain('Bash');
    expect(disallowed).not.toContain('Edit');
    expect(disallowed).not.toContain('Write');
  });

  test('investigationMode=true: 上記に加え Bash/Edit/Write/PowerShell/NotebookEdit も禁止される', () => {
    const agent = new ClaudeCodeAgent('t4', 'test-agent', {
      dangerouslySkipPermissions: true,
      investigationMode: true,
    });

    const { args } = buildClaudeArgs(agent);
    const idx = args.indexOf('--disallowedTools');
    const disallowed = args[idx + 1].split(',');

    for (const tool of [
      'EnterWorktree',
      'ExitWorktree',
      'WebFetch',
      'WebSearch',
      'ToolSearch',
      'Skill',
      'Task',
      'Bash',
      'PowerShell',
      'Edit',
      'Write',
      'NotebookEdit',
    ]) {
      expect(disallowed).toContain(tool);
    }
  });

  test('--strict-mcp-config は常に付与される（機械全体のMCPサーバーをアンビエントに読み込ませない）', () => {
    const agent = new ClaudeCodeAgent('t5', 'test-agent', {});
    const { args } = buildClaudeArgs(agent);
    expect(args).toContain('--strict-mcp-config');
    // --mcp-config は渡さない設計 — strict と組み合わせて初めて「MCPサーバーを一切読み込まない」になる
    expect(args).not.toContain('--mcp-config');
  });
});

describe('buildSpawnEnv', () => {
  test('secrets が process.env にあってもサニタイズされ、CLI用オーバーライドは維持される', () => {
    const originalEncryptionKey = process.env.ENCRYPTION_KEY;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalGithubToken = process.env.GITHUB_TOKEN;

    process.env.ENCRYPTION_KEY = 'super-secret-key';
    process.env.DATABASE_URL = 'postgres://user:pass@localhost/db';
    process.env.GITHUB_TOKEN = 'ghp_dummy';

    try {
      const env = buildSpawnEnv();

      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();

      // CLI-friendly overrides applied by this function
      expect(env.FORCE_COLOR).toBe('0');
      expect(env.NO_COLOR).toBe('1');
      expect(env.CI).toBe('1');
    } finally {
      // restore so this test doesn't leak env state into other test files
      if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = originalEncryptionKey;
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGithubToken;
    }
  });
});

describe('autonomous reasoning effort', () => {
  test.each([undefined, 'invalid', 'high', ' medium '])(
    'bounds effort and records the selected value',
    (configured) => {
      const previous = process.env.RAPITAS_CLAUDE_EFFORT;
      try {
        if (configured === undefined) delete process.env.RAPITAS_CLAUDE_EFFORT;
        else process.env.RAPITAS_CLAUDE_EFFORT = configured;
        const agent = new ClaudeCodeAgent('effort', 'test-agent', {});
        const { args, logExtras } = buildClaudeArgs(agent);
        const expected = configured === 'high' ? 'high' : 'medium';
        expect(args[args.indexOf('--effort') + 1]).toBe(expected);
        expect(logExtras.some((line) => line.endsWith('Effort: ' + expected))).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.RAPITAS_CLAUDE_EFFORT;
        else process.env.RAPITAS_CLAUDE_EFFORT = previous;
      }
    },
  );
});
