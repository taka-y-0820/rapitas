/**
 * cli-utils unit tests
 *
 * resolveCliPath / getClaudePath are re-exports of utils/common/cli-path-resolver
 * (see cli-path-resolver.test.ts for the where-success / .cmd-fallback / both-fail /
 * caching behavior). This file only verifies checkClaudeAvailable() and
 * buildSpawnCommand(), and that the re-exports delegate correctly.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockResolveCliPathAsync = mock((cliName: string) => Promise.resolve(`resolved:${cliName}`));
const mockGetClaudePathAsync = mock(() => Promise.resolve('resolved:claude.cmd'));

mock.module('../../utils/common/cli-path-resolver', () => ({
  resolveCliPathAsync: mockResolveCliPathAsync,
  getClaudePathAsync: mockGetClaudePathAsync,
}));

mock.module('child_process', () => ({
  spawn: mock(() => ({
    on: (event: string, cb: (code: number) => void) => {
      if (event === 'close') cb(0);
    },
    kill: mock(() => {}),
  })),
}));

// Import after mocks so the module sees the mocked implementations.
const { resolveCliPath, getClaudePath, checkClaudeAvailable, buildSpawnCommand } =
  await import('../../services/agents/claude-code/cli-utils');

beforeEach(() => {
  mockResolveCliPathAsync.mockClear();
  mockGetClaudePathAsync.mockClear();
});

describe('resolveCliPath / getClaudePath', () => {
  it('resolveCliPath は共有 cli-path-resolver に委譲する', async () => {
    const result = await resolveCliPath('claude');
    expect(result).toBe('resolved:claude');
    expect(mockResolveCliPathAsync).toHaveBeenCalledWith('claude');
  });

  it('getClaudePath は共有 cli-path-resolver に委譲する', async () => {
    const result = await getClaudePath();
    expect(result).toBe('resolved:claude.cmd');
    expect(mockGetClaudePathAsync).toHaveBeenCalled();
  });
});

describe('checkClaudeAvailable', () => {
  it('getClaudePath で解決したパスを使って CLI を起動する', async () => {
    await checkClaudeAvailable();
    expect(mockGetClaudePathAsync).toHaveBeenCalled();
  });
});

describe('buildSpawnCommand', () => {
  it('Windows 以外ではコマンドと引数をそのまま返す', async () => {
    if (process.platform === 'win32') return;
    const [command, args] = buildSpawnCommand('claude', ['--print']);
    expect(command).toBe('claude');
    expect(args).toEqual(['--print']);
  });

  it('Windows では chcp 65001 を前置した単一コマンド文字列を返す', async () => {
    if (process.platform !== 'win32') return;
    const [command, args] = buildSpawnCommand('claude.cmd', ['--print']);
    expect(command).toContain('chcp 65001');
    expect(command).toContain('claude.cmd --print');
    expect(args).toEqual([]);
  });
});
