/**
 * PreviewDeployService テスト
 *
 * triggerPreviewDeploy / pollDeploymentStatus のユニットテスト。
 * deployなし・previewUrl有無・gh失敗・JSON不正・maxAttempts到達のエッジケースを網羅する。
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// --- mutable execSync implementation (テスト毎に差し替え) ---
let execSyncImpl: (cmd: string) => string = () => {
  throw new Error('not configured');
};

// --- mocks (import より前に宣言が必須) ---
mock.module('child_process', () => ({
  execSync: (cmd: string, _opts: unknown) => execSyncImpl(cmd),
  // NOTE: checkGitHubDeployments は execFileSync(gh CLI) 経由に変更済み。execSyncImpl と
  // 同じ差し替え可能な実装を共有し、既存のテストシナリオ切り替えをそのまま使えるようにする。
  execFileSync: (_file: string, _args: string[], _opts: unknown) => execSyncImpl(_file),
  // NOTE: gh-client.ts imports execFile at the top level; supply a no-op so the
  // module loads. postDeploymentComment calls runGhCommandWithBody → execFile,
  // but the test scenarios that reach it expect a successful (empty) response.
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout: '', stderr: '' });
  },
}));

const mockFindFirst = mock(() => Promise.resolve(null));

mock.module('../../config/database', () => ({
  prisma: {
    userSettings: {
      findFirst: mockFindFirst,
    },
  },
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  }),
}));

const { triggerPreviewDeploy, pollDeploymentStatus } =
  await import('../../services/misc/preview-deploy-service');

// --- env helpers ---
let savedVercel: string | undefined;
let savedNetlify: string | undefined;

function saveAndClearTokens(): void {
  savedVercel = process.env.VERCEL_TOKEN;
  savedNetlify = process.env.NETLIFY_AUTH_TOKEN;
  delete process.env.VERCEL_TOKEN;
  delete process.env.NETLIFY_AUTH_TOKEN;
}

function restoreTokens(): void {
  if (savedVercel !== undefined) {
    process.env.VERCEL_TOKEN = savedVercel;
  } else {
    delete process.env.VERCEL_TOKEN;
  }
  if (savedNetlify !== undefined) {
    process.env.NETLIFY_AUTH_TOKEN = savedNetlify;
  } else {
    delete process.env.NETLIFY_AUTH_TOKEN;
  }
}

describe('triggerPreviewDeploy', () => {
  beforeEach(() => {
    saveAndClearTokens();
    mockFindFirst.mockReset();
    mockFindFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    restoreTokens();
  });

  test('deployなし（空配列）のとき skipped を返す', async () => {
    execSyncImpl = () => JSON.stringify([]);

    const result = await triggerPreviewDeploy('/repo', 1, 'feature/test');

    expect(result.status).toBe('skipped');
    expect(result.provider).toBe('none');
  });

  test('deploy検出 + previewUrl ありのとき ready と previewUrl を返す', async () => {
    const checks = [
      { name: 'vercel-preview', state: 'SUCCESS', link: 'https://preview.example.com' },
    ];
    execSyncImpl = () => JSON.stringify(checks);

    const result = await triggerPreviewDeploy('/repo', 2, 'feature/test');

    expect(result.status).toBe('ready');
    expect(result.previewUrl).toBe('https://preview.example.com');
  });

  test('deploy検出でpreviewUrlなし（link空）のとき ready / previewUrl undefined を返す', async () => {
    const checks = [{ name: 'vercel-preview', state: 'SUCCESS', link: '' }];
    execSyncImpl = () => JSON.stringify(checks);

    const result = await triggerPreviewDeploy('/repo', 3, 'feature/test');

    expect(result.status).toBe('ready');
    expect(result.previewUrl).toBeUndefined();
  });

  test('gh コマンド失敗時は catch して skipped を返す', async () => {
    execSyncImpl = () => {
      throw new Error('gh: command not found');
    };

    const result = await triggerPreviewDeploy('/repo', 4, 'feature/test');

    expect(result.status).toBe('skipped');
    expect(result.provider).toBe('none');
  });

  test('不正JSON のとき catch して skipped を返す', async () => {
    execSyncImpl = () => 'not valid json {{{';

    const result = await triggerPreviewDeploy('/repo', 5, 'feature/test');

    expect(result.status).toBe('skipped');
    expect(result.provider).toBe('none');
  });
});

describe('pollDeploymentStatus', () => {
  beforeEach(() => {
    saveAndClearTokens();
  });

  afterEach(() => {
    restoreTokens();
  });

  test('初回ポーリングで SUCCESS → status ready を返す', async () => {
    const checks = [{ name: 'vercel-preview', state: 'SUCCESS', link: 'https://preview.com' }];
    // NOTE: execSyncImpl は1回目の pr checks と postDeploymentComment の2回呼ばれる。
    execSyncImpl = () => JSON.stringify(checks);

    const result = await pollDeploymentStatus('/repo', 1, 3, 0);

    expect(result.status).toBe('ready');
  });

  test('deployなし（空配列）のとき即時 skipped を返す', async () => {
    execSyncImpl = () => JSON.stringify([]);

    const result = await pollDeploymentStatus('/repo', 2, 3, 0);

    expect(result.status).toBe('skipped');
  });

  test('常にPENDING状態でmaxAttempts到達後に pending を返す', async () => {
    const checks = [{ name: 'deploy-check', state: 'PENDING', link: '' }];
    execSyncImpl = () => JSON.stringify(checks);

    const result = await pollDeploymentStatus('/repo', 3, 2, 0);

    expect(result.status).toBe('pending');
    expect(result.provider).toBe('none');
  });

  test('ready状態でpreviewUrlなしのとき status ready を返す（コメント投稿なし）', async () => {
    const checks = [{ name: 'vercel-preview', state: 'SUCCESS', link: '' }];
    execSyncImpl = () => JSON.stringify(checks);

    const result = await pollDeploymentStatus('/repo', 4, 3, 0);

    expect(result.status).toBe('ready');
    expect(result.previewUrl).toBeUndefined();
  });
});
