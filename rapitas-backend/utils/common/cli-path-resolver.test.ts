/**
 * cli-path-resolver ユニットテスト
 *
 * resolveCliPathAsync(): where 成功 / .cmd フォールバック成功 / 両方失敗 /
 * 非Windows即時return / 同時呼び出しの de-dup / 1000ms超過WARN / タイムアウト
 * フォールバックを検証する。
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mutable state read by all mock implementations — lets each test set its own
// behaviour without re-requiring the module (caches are module-scoped).
// ---------------------------------------------------------------------------

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

let execImpl: (cmd: string, cb: ExecCallback) => void = (_cmd, cb) => {
  cb(new Error('not configured'));
};
let execCallCount = 0;
let existsSyncImpl: (p: string) => boolean = () => true;

const mockWarn = mock((..._args: unknown[]) => {});
const mockInfo = mock((..._args: unknown[]) => {});

mock.module('child_process', () => ({
  exec: (cmd: string, _opts: unknown, cb: ExecCallback) => {
    execCallCount++;
    execImpl(cmd, cb);
  },
}));

mock.module('fs', () => ({
  existsSync: (p: string) => existsSyncImpl(p),
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    warn: mockWarn,
    info: mockInfo,
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

// Import after mocks so the module sees the mocked implementations.
const { resolveCliPathAsync, getClaudePathAsync, __resetCliPathCacheForTests } =
  await import('./cli-path-resolver');

/** Unique CLI names prevent cliPathCache from returning stale results across tests. */
let nameSeq = 0;
const uniqueName = (prefix: string) => `${prefix}-${++nameSeq}`;

beforeEach(() => {
  mockWarn.mockClear();
  mockInfo.mockClear();
  execCallCount = 0;
  __resetCliPathCacheForTests();
});

describe('resolveCliPathAsync', () => {
  it('非Windowsでは where を呼ばずに元の名前をそのまま返す', async () => {
    if (process.platform === 'win32') return; // Windows 専用テストは skip

    const name = uniqueName('test-cli');
    const result = await resolveCliPathAsync(name);

    expect(result).toBe(name);
    expect(execCallCount).toBe(0);
  });

  it('where が成功したとき絶対パスを返し INFO ログを出す', async () => {
    if (process.platform !== 'win32') return;

    const absPath = 'C:\\npm\\claude.cmd';
    execImpl = (_cmd, cb) => cb(null, { stdout: `${absPath}\r\n`, stderr: '' });
    existsSyncImpl = () => true;

    const name = uniqueName('test-where-ok');
    const result = await resolveCliPathAsync(name);

    expect(result).toBe(absPath);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('[resolveCliPathAsync]'));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('where が失敗しても .cmd 再試行が成功すれば WARN を出さずに絶対パスを返す', async () => {
    if (process.platform !== 'win32') return;

    const cmdPath = 'C:\\npm\\claude.cmd';
    execImpl = (cmd, cb) => {
      if (cmd.endsWith('.cmd')) return cb(null, { stdout: `${cmdPath}\r\n`, stderr: '' });
      cb(new Error('not found'));
    };
    existsSyncImpl = () => true;

    const name = uniqueName('test-cmd-fallback');
    const result = await resolveCliPathAsync(name);

    expect(result).toBe(cmdPath);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalled();
  });

  it('.cmd で終わる名前は .cmd 再試行をしない（無限ループ防止）', async () => {
    if (process.platform !== 'win32') return;

    execImpl = (_cmd, cb) => cb(new Error('not found'));
    existsSyncImpl = () => false;

    const name = `${uniqueName('test-already-cmd')}.cmd`;
    await resolveCliPathAsync(name);

    expect(execCallCount).toBe(1); // where は1回だけ呼ばれる
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('[resolveCliPathAsync]'));
  });

  it('where と .cmd 再試行の両方が失敗したとき WARN を出して元の名前を返す', async () => {
    if (process.platform !== 'win32') return;

    execImpl = (_cmd, cb) => cb(new Error('not found'));
    existsSyncImpl = () => false;

    const name = uniqueName('test-both-fail');
    const result = await resolveCliPathAsync(name);

    expect(result).toBe(name);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('[resolveCliPathAsync]'));
  });

  it('同じ名前への2回目の呼び出しはキャッシュから返す（where は再呼び出しされない）', async () => {
    if (process.platform !== 'win32') return;

    const absPath = 'C:\\npm\\claude-cached.cmd';
    execImpl = (_cmd, cb) => cb(null, { stdout: `${absPath}\r\n`, stderr: '' });
    existsSyncImpl = () => true;

    const name = uniqueName('test-cache');
    await resolveCliPathAsync(name);
    await resolveCliPathAsync(name);

    expect(execCallCount).toBe(1); // exec は1回だけ（2回目はキャッシュ）
  });

  it('同時に呼び出された同名解決は1回の exec 実行に収束する（in-flight de-dup）', async () => {
    if (process.platform !== 'win32') return;

    const absPath = 'C:\\npm\\claude-concurrent.cmd';
    execImpl = (_cmd, cb) => {
      // Simulate async completion after other synchronous callers have already
      // registered their promise, to exercise the in-flight de-dup path.
      setTimeout(() => cb(null, { stdout: `${absPath}\r\n`, stderr: '' }), 5);
    };
    existsSyncImpl = () => true;

    const name = uniqueName('test-concurrent');
    const [r1, r2, r3] = await Promise.all([
      resolveCliPathAsync(name),
      resolveCliPathAsync(name),
      resolveCliPathAsync(name),
    ]);

    expect(execCallCount).toBe(1);
    expect(r1).toBe(absPath);
    expect(typeof r1).toBe('string');
    expect(r2).toBe(absPath);
    expect(r3).toBe(absPath);
  });

  it('解決に1000msを超えた場合 elapsedMs 付きの WARN が出力される', async () => {
    if (process.platform !== 'win32') return;

    const absPath = 'C:\\npm\\claude-slow.cmd';
    execImpl = (_cmd, cb) => {
      setTimeout(() => cb(null, { stdout: `${absPath}\r\n`, stderr: '' }), 1010);
    };
    existsSyncImpl = () => true;

    const name = uniqueName('test-slow');
    await resolveCliPathAsync(name);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ cliName: name, elapsedMs: expect.any(Number) }),
      expect.stringContaining('slow CLI path resolution'),
    );
  }, 3000);

  it('タイムアウト（5000ms）到達時は例外を捕捉しフォールバックする', async () => {
    if (process.platform !== 'win32') return;

    execImpl = (_cmd, cb) => {
      const err = Object.assign(new Error('Command timed out'), { killed: true });
      cb(err);
    };
    existsSyncImpl = () => true;

    const name = uniqueName('test-timeout');
    const result = await resolveCliPathAsync(name);

    expect(result).toBe(name);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('[resolveCliPathAsync]'));
  });
});

describe('getClaudePathAsync', () => {
  it('CLAUDE_CODE_PATH が未設定のとき Windows では claude.cmd を基底名に使う', async () => {
    if (process.platform !== 'win32') return;

    const original = process.env.CLAUDE_CODE_PATH;
    delete process.env.CLAUDE_CODE_PATH;

    const absPath = 'C:\\npm\\claude.cmd';
    execImpl = (_cmd, cb) => cb(null, { stdout: `${absPath}\r\n`, stderr: '' });
    existsSyncImpl = () => true;

    const result = await getClaudePathAsync();
    expect(result).toBe(absPath);

    if (original !== undefined) process.env.CLAUDE_CODE_PATH = original;
  });
});
