/**
 * PreviewDeployService — postDeploymentComment テスト
 *
 * postDeploymentComment（非公開）は pollDeploymentStatus 経由で間接的に検証する。
 * runGhCommandWithBody 経由で pr comment が正しく呼ばれることを確認する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

let ghClientCalls: Array<{ args: string[]; body: string | undefined; cwd: string | undefined }> =
  [];

mock.module('../github/gh-client', () => ({
  runGhCommandWithBody: async (args: string[], body?: string, cwd?: string) => {
    ghClientCalls.push({ args, body, cwd });
    return '';
  },
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module('../../config/database', () => ({
  prisma: { userSettings: { findFirst: async () => null } },
}));

// Controls the JSON returned by checkGitHubDeployments via execFileSync.
let execSyncResult = '[]';
mock.module('child_process', () => ({
  execSync: () => execSyncResult,
  // NOTE: checkGitHubDeployments は execFileSync(gh CLI) を使う実装に変更済み。ミラー不足だと常に skipped に潰れる
  execFileSync: () => execSyncResult,
}));

const { pollDeploymentStatus } = await import('./preview-deploy-service');

beforeEach(() => {
  ghClientCalls = [];
  execSyncResult = '[]';
});

describe('postDeploymentComment (via pollDeploymentStatus)', () => {
  test('previewUrl があるとき runGhCommandWithBody で pr comment を呼ぶこと', async () => {
    execSyncResult = JSON.stringify([
      { name: 'vercel deploy', state: 'SUCCESS', link: 'https://preview.example.com' },
    ]);

    await pollDeploymentStatus('/repo', 10, 1, 0);

    expect(ghClientCalls.length).toBe(1);
    const call = ghClientCalls[0];
    expect(call.args).toEqual(['pr', 'comment', '10']);
    expect(call.cwd).toBe('/repo');
    expect(call.body).toContain('https://preview.example.com');
  });

  test('previewUrl がないとき runGhCommandWithBody を呼ばないこと', async () => {
    // link が空文字 → previewUrl = undefined → early return
    execSyncResult = JSON.stringify([{ name: 'vercel deploy', state: 'SUCCESS', link: '' }]);

    await pollDeploymentStatus('/repo', 10, 1, 0);

    expect(ghClientCalls.length).toBe(0);
  });

  test('deploy チェックが存在しないとき skipped を返し runGhCommandWithBody を呼ばないこと', async () => {
    execSyncResult = '[]';

    const result = await pollDeploymentStatus('/repo', 5, 1, 0);

    expect(result.status).toBe('skipped');
    expect(ghClientCalls.length).toBe(0);
  });
});
