/**
 * GitHub Service テスト
 * GitHubService クラスのユニットテスト
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- mocks ---
const mockExecAsync = mock(() => Promise.resolve({ stdout: '', stderr: '' }));

mock.module('child_process', () => ({
  exec: (_cmd: string, _opts: unknown, cb: Function) => {
    mockExecAsync()
      .then((r) => cb(null, r))
      .catch((e) => cb(e));
  },
  // NOTE: gh-client.ts/git-exec.ts が `import { execFile } from 'child_process'` する。
  // promisify は下でモック済みで引数を無視して mockExecAsync を返すため、ここは
  // named export の欠落を防ぐダミーで十分（呼び出し実体は使われない）。
  execFile: (_file: string, _args: string[], _opts: unknown, cb: Function) => {
    mockExecAsync()
      .then((r) => cb(null, r))
      .catch((e) => cb(e));
  },
}));
mock.module('util', () => ({
  promisify: () => mockExecAsync,
}));

const mockPrisma = {
  gitHubIntegration: {
    findUnique: mock(() => Promise.resolve(null)),
    findFirst: mock(() => Promise.resolve(null)),
  },
  gitHubPullRequest: {
    upsert: mock(() => Promise.resolve({})),
  },
  gitHubIssue: {
    upsert: mock(() => Promise.resolve({})),
  },
  notification: {
    create: mock(() => Promise.resolve({})),
  },
};

// Note: Do not mock @prisma/client globally as it affects other test files.
// The GitHubService accepts prisma as a constructor parameter, so we can inject the mock directly.

const noopLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};
// NOTE: config/index.ts の `export { logger, createLogger } from './logger'` が
// GitHubService → sync-webhook → concern-backlog-service → task-mutations →
// task-calendar-sync 経由で読み込まれるため、createLogger だけでなく logger も必須
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

mock.module('../../services/communication/realtime-service', () => ({
  realtimeService: {
    sendGitHubEvent: mock(() => {}),
  },
}));

const { GitHubService } = await import('../../services/core/github-service');

function resetAllMocks() {
  mockExecAsync.mockReset();
  for (const model of Object.values(mockPrisma)) {
    if (typeof model === 'object' && model !== null) {
      for (const method of Object.values(model)) {
        if (typeof method === 'function' && 'mockReset' in method) {
          (method as ReturnType<typeof mock>).mockReset();
        }
      }
    }
  }
}

type MockPrismaType = typeof mockPrisma;

describe('GitHubService', () => {
  let service: InstanceType<typeof GitHubService>;

  beforeEach(() => {
    resetAllMocks();
    service = new GitHubService(mockPrisma as unknown as MockPrismaType);
  });

  describe('isGhAvailable', () => {
    test('gh CLIが利用可能な場合trueを返すこと', async () => {
      mockExecAsync.mockResolvedValue({ stdout: 'gh version 2.40.0', stderr: '' });
      const result = await service.isGhAvailable();
      expect(result).toBe(true);
    });

    test('gh CLIが利用不可の場合falseを返すこと', async () => {
      mockExecAsync.mockRejectedValue(new Error('command not found'));
      const result = await service.isGhAvailable();
      expect(result).toBe(false);
    });
  });

  describe('isAuthenticated', () => {
    test('認証済みの場合trueを返すこと', async () => {
      mockExecAsync.mockResolvedValue({ stdout: 'Logged in to github.com', stderr: '' });
      const result = await service.isAuthenticated();
      expect(result).toBe(true);
    });

    test('未認証の場合falseを返すこと', async () => {
      mockExecAsync.mockRejectedValue(new Error('not logged in'));
      const result = await service.isAuthenticated();
      expect(result).toBe(false);
    });
  });

  describe('getPullRequests', () => {
    test('PRリストをパースして返すこと', async () => {
      const prsJson = JSON.stringify([
        {
          number: 1,
          title: 'Fix bug',
          body: 'Bug fix description',
          state: 'OPEN',
          headRefName: 'fix/bug',
          baseRefName: 'main',
          author: { login: 'dev1' },
          url: 'https://github.com/owner/repo/pull/1',
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-01T00:00:00Z',
          additions: 10,
          deletions: 5,
          changedFiles: 2,
        },
      ]);
      mockExecAsync.mockResolvedValue({ stdout: prsJson, stderr: '' });

      const prs = await service.getPullRequests('owner/repo');
      expect(prs).toHaveLength(1);
      expect(prs[0].number).toBe(1);
      expect(prs[0].title).toBe('Fix bug');
      expect(prs[0].headBranch).toBe('fix/bug');
      expect(prs[0].authorLogin).toBe('dev1');
    });

    test('空のレスポンスで空配列を返すこと', async () => {
      mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const prs = await service.getPullRequests('owner/repo');
      expect(prs).toEqual([]);
    });
  });

  describe('getPullRequest', () => {
    test('PR詳細を返すこと', async () => {
      const prJson = JSON.stringify({
        number: 42,
        title: 'Add feature',
        body: 'New feature',
        state: 'OPEN',
        headRefName: 'feature/new',
        baseRefName: 'main',
        author: { login: 'dev1' },
        url: 'https://github.com/owner/repo/pull/42',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-01T00:00:00Z',
        mergeable: true,
        additions: 100,
        deletions: 20,
        changedFiles: 5,
      });
      mockExecAsync.mockResolvedValue({ stdout: prJson, stderr: '' });

      const pr = await service.getPullRequest('owner/repo', 42);
      expect(pr).not.toBeNull();
      expect(pr!.number).toBe(42);
      expect(pr!.mergeable).toBe(true);
    });

    test('存在しないPRでnullを返すこと', async () => {
      mockExecAsync.mockRejectedValue(new Error('not found'));
      const pr = await service.getPullRequest('owner/repo', 999);
      expect(pr).toBeNull();
    });
  });

  describe('getIssues', () => {
    test('Issueリストをパースして返すこと', async () => {
      const issuesJson = JSON.stringify([
        {
          number: 10,
          title: 'Bug report',
          body: 'Something is broken',
          state: 'OPEN',
          labels: [{ name: 'bug' }],
          author: { login: 'reporter' },
          url: 'https://github.com/owner/repo/issues/10',
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-01T00:00:00Z',
        },
      ]);
      mockExecAsync.mockResolvedValue({ stdout: issuesJson, stderr: '' });

      const issues = await service.getIssues('owner/repo');
      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(10);
      expect(issues[0].labels).toEqual(['bug']);
    });
  });

  describe('getIssue', () => {
    test('Issue詳細を返すこと', async () => {
      const issueJson = JSON.stringify({
        number: 10,
        title: 'Bug report',
        body: 'Details',
        state: 'OPEN',
        labels: [{ name: 'bug' }, { name: 'priority' }],
        author: { login: 'user1' },
        url: 'https://github.com/owner/repo/issues/10',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-01T00:00:00Z',
      });
      mockExecAsync.mockResolvedValue({ stdout: issueJson, stderr: '' });

      const issue = await service.getIssue('owner/repo', 10);
      expect(issue).not.toBeNull();
      expect(issue!.title).toBe('Bug report');
      expect(issue!.labels).toEqual(['bug', 'priority']);
    });

    test('存在しないIssueでnullを返すこと', async () => {
      mockExecAsync.mockRejectedValue(new Error('not found'));
      const issue = await service.getIssue('owner/repo', 999);
      expect(issue).toBeNull();
    });
  });

  describe('syncPullRequests', () => {
    test('Integrationが見つからない場合エラーをスローすること', async () => {
      mockPrisma.gitHubIntegration.findUnique.mockResolvedValue(null);
      await expect(service.syncPullRequests(1)).rejects.toThrow('Integration not found');
    });

    test('PRを同期してカウントを返すこと', async () => {
      mockPrisma.gitHubIntegration.findUnique.mockResolvedValue({
        id: 1,
        ownerName: 'owner',
        repositoryName: 'repo',
      });
      const prsJson = JSON.stringify([
        {
          number: 1,
          title: 'PR 1',
          body: null,
          state: 'OPEN',
          headRefName: 'feat',
          baseRefName: 'main',
          author: { login: 'dev' },
          url: 'https://github.com/owner/repo/pull/1',
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-01T00:00:00Z',
        },
      ]);
      mockExecAsync.mockResolvedValue({ stdout: prsJson, stderr: '' });
      mockPrisma.gitHubPullRequest.upsert.mockResolvedValue({});

      const count = await service.syncPullRequests(1);
      expect(count).toBe(1);
      expect(mockPrisma.gitHubPullRequest.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleWebhook', () => {
    test('pull_requestイベントを処理できること', async () => {
      mockPrisma.gitHubIntegration.findFirst.mockResolvedValue(null);

      await service.handleWebhook('pull_request', {
        action: 'opened',
        repository: {
          name: 'repo',
          html_url: 'https://github.com/owner/repo',
          owner: { login: 'owner' },
        },
        pull_request: {
          number: 1,
          title: 'New PR',
          body: null,
          state: 'open',
          head: { ref: 'feature' },
          base: { ref: 'main' },
          user: { login: 'dev' },
          html_url: 'https://github.com/owner/repo/pull/1',
        },
      });

      // Should not throw - webhook handled gracefully
    });

    test('pull_requestなしのpull_requestイベントで何もしないこと', async () => {
      await service.handleWebhook('pull_request', {
        action: 'opened',
        repository: {
          name: 'repo',
          html_url: 'https://github.com/owner/repo',
          owner: { login: 'owner' },
        },
      });
      // Should not throw
    });

    test('未対応のイベントタイプでもエラーにならないこと', async () => {
      await service.handleWebhook('unknown_event', {
        action: 'test',
        repository: {
          name: 'repo',
          html_url: 'https://github.com/owner/repo',
          owner: { login: 'owner' },
        },
      });
      // Should not throw
    });
  });
});
