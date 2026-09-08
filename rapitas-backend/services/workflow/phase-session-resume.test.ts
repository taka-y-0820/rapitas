/**
 * phase-session-resume テスト
 *
 * resolvePhaseResumeSessionId のガード（機能フラグ / エージェント種別 / ロール /
 * worktree 一致 / CLI トランスクリプトの実在）と、claudeProjectDirFor の
 * ディレクトリ名変換を検証する。
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const findMany = mock(() => Promise.resolve<Array<Record<string, unknown>>>([]));
const findFirst = mock(() => Promise.resolve<Record<string, unknown> | null>(null));
mock.module('../../config/database', () => ({
  prisma: { agentExecution: { findMany, findFirst } },
}));

const { resolvePhaseResumeSessionId, claudeProjectDirFor, claudeSessionExists } =
  await import('./phase-session-resume');

const SESSION = '36c6ecd3-6e3b-40bd-9806-c589d4fe312e';
const base = { taskId: 641, role: 'implementer', agentType: 'claude-code' as string | null };

let realProfile: string | undefined;
let realHome: string | undefined;
let hadHome = false;
let sandbox: string;

/** Point HOME/USERPROFILE at a sandbox and plant a transcript for `cwd`. */
function plantTranscript(cwd: string, sessionId: string): void {
  const dir = claudeProjectDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{}');
}

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  findFirst.mockReset();
  findFirst.mockResolvedValue(null);
  sandbox = mkdtempSync(join(tmpdir(), 'phase-resume-'));
  realProfile = process.env.USERPROFILE;
  realHome = process.env.HOME;
  hadHome = 'HOME' in process.env;
  process.env.USERPROFILE = sandbox;
  process.env.HOME = sandbox;
  delete process.env.RAPITAS_PHASE_SESSION_RESUME;
});

afterEach(() => {
  // Restore exactly — leaving HOME defined on Windows trips the global-state guard.
  if (realProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realProfile;
  if (!hadHome) delete process.env.HOME;
  else process.env.HOME = realHome as string;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('claudeProjectDirFor', () => {
  test('collapses drive colon, separators and dots the way the CLI does', () => {
    const dir = claudeProjectDirFor('C:\\Projects\\rapitas\\.worktrees\\task-643-93ba4c5c');
    expect(dir.endsWith('C--Projects-rapitas--worktrees-task-643-93ba4c5c')).toBe(true);
  });
});

describe('claudeSessionExists', () => {
  test('true only when the transcript file is present', () => {
    const cwd = 'C:\\wt\\task-1';
    expect(claudeSessionExists(cwd, SESSION)).toBe(false);
    plantTranscript(cwd, SESSION);
    expect(claudeSessionExists(cwd, SESSION)).toBe(true);
  });
});

describe('resolvePhaseResumeSessionId', () => {
  test('returns the prior session when every guard passes', async () => {
    const workingDirectory = 'C:\\wt\\task-641';
    plantTranscript(workingDirectory, SESSION);
    findMany.mockResolvedValue([{ id: 9, claudeSessionId: SESSION }]);
    expect(await resolvePhaseResumeSessionId({ ...base, workingDirectory })).toBe(SESSION);
  });

  // Each row is one guard that must fall back to a cold start. The DB row and
  // the transcript are always present, so only the named guard can be the cause.
  const COLD_START_GUARDS: Array<
    [string, () => void, { role?: string; agentType?: string | null }]
  > = [
    ['the kill switch is set', () => void (process.env.RAPITAS_PHASE_SESSION_RESUME = '0'), {}],
    ['the agent is not claude-code', () => {}, { agentType: 'codex' }],
    ['the role is researcher', () => {}, { role: 'researcher' }],
    ['the role is planner', () => {}, { role: 'planner' }],
  ];

  test.each(COLD_START_GUARDS)('cold-starts when %s', async (_name, arrange, overrides) => {
    const workingDirectory = 'C:\\wt\\task-641';
    plantTranscript(workingDirectory, SESSION);
    findMany.mockResolvedValue([{ id: 9, claudeSessionId: SESSION }]);
    arrange();
    expect(
      await resolvePhaseResumeSessionId({ ...base, ...overrides, workingDirectory }),
    ).toBeNull();
  });

  test('cold-starts when a prior resume of that session already failed (task 894)', async () => {
    const workingDirectory = 'C:\\wt\\task-641';
    plantTranscript(workingDirectory, SESSION);
    findMany.mockResolvedValue([{ id: 9, claudeSessionId: SESSION }]);
    findFirst.mockResolvedValue({ id: 3879 });
    expect(await resolvePhaseResumeSessionId({ ...base, workingDirectory })).toBeNull();
    const where = (findFirst.mock.calls[0] as unknown[])[0] as { where: Record<string, unknown> };
    expect(where.where).toMatchObject({ claudeSessionId: SESSION, status: 'failed' });
  });

  test('cold-starts when the CLI transcript is gone (a --resume would fail the run)', async () => {
    findMany.mockResolvedValue([{ id: 9, claudeSessionId: SESSION }]);
    expect(
      await resolvePhaseResumeSessionId({ ...base, workingDirectory: 'C:\\wt\\task-641' }),
    ).toBeNull();
  });

  test('scopes the lookup to this task and role, but NOT to worktreePath', async () => {
    const workingDirectory = 'C:\\wt\\task-641';
    plantTranscript(workingDirectory, SESSION);
    findMany.mockResolvedValue([{ id: 9, claudeSessionId: SESSION }]);
    await resolvePhaseResumeSessionId({ ...base, workingDirectory });
    const args = findMany.mock.calls[0]![0] as {
      where: { status: string; session: { mode: string; config: { taskId: number } } };
    };
    expect(args.where.status).toBe('completed');
    expect(args.where.session.mode).toBe('workflow-implementer');
    expect(args.where.session.config.taskId).toBe(641);
    // worktreePath is cleared on worktree cleanup (measured: 72% of implementer
    // sessions retain it, 4% of planner ones), so filtering on it silently
    // disabled resume. The on-disk transcript check replaces it.
    expect(JSON.stringify(args.where)).not.toContain('worktreePath');
  });

  test('skips candidates whose transcript lives under a different directory', async () => {
    const workingDirectory = 'C:\\wt\\task-641';
    const older = '11111111-2222-3333-4444-555555555555';
    // The newest session was filed elsewhere (worktree since recreated); only
    // the older one belongs to the directory this phase will run in.
    plantTranscript(workingDirectory, older);
    findMany.mockResolvedValue([
      { id: 12, claudeSessionId: SESSION },
      { id: 9, claudeSessionId: older },
    ]);
    expect(await resolvePhaseResumeSessionId({ ...base, workingDirectory })).toBe(older);
  });

  test('never throws — a lookup failure just cold-starts', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    expect(
      await resolvePhaseResumeSessionId({ ...base, workingDirectory: 'C:\\wt\\task-641' }),
    ).toBeNull();
  });
});
