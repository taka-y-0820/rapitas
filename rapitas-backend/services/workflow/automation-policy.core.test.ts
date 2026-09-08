/**
 * automation-policy.core.test
 *
 * Coverage for resolveAutomationPolicy's 4-tier precedence (task > user
 * settings > env var > hardcoded default) for each of autoCommit /
 * autoCreatePR / autoMergePR, plus the env-boolean parser's tolerance for
 * malformed values. resolveLandingMode is covered separately in
 * automation-policy.landing-mode.test.ts.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { PrismaClient } from '../../generated/prisma-postgres';

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

const { resolveAutomationPolicy } = await import('./automation-policy');

interface TaskAutoFields {
  id: number;
  autoCommit?: boolean | null;
  autoCreatePR?: boolean | null;
  autoMergePR?: boolean | null;
}

interface UserSettingsAutoFields {
  autoCommitDefault?: boolean | null;
  autoCreatePRDefault?: boolean | null;
  autoMergePRDefault?: boolean | null;
}

function fakePrisma(
  task: TaskAutoFields | null,
  userSettings: UserSettingsAutoFields | null = null,
): PrismaClient {
  return {
    task: { findUnique: () => Promise.resolve(task) },
    userSettings: { findFirst: () => Promise.resolve(userSettings) },
  } as unknown as PrismaClient;
}

const ENV_KEYS = [
  'RAPITAS_DEFAULT_AUTO_COMMIT',
  'RAPITAS_DEFAULT_AUTO_CREATE_PR',
  'RAPITAS_DEFAULT_AUTO_MERGE_PR',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('resolveAutomationPolicy — hardcoded defaults', () => {
  it('falls back to commit=ON, createPR=ON, mergePR=OFF when nothing else is set', async () => {
    const result = await resolveAutomationPolicy(fakePrisma({ id: 1 }), 1);

    expect(result).toEqual({
      autoCommit: true,
      autoCreatePR: true,
      autoMergePR: false,
      source: { autoCommit: 'default', autoCreatePR: 'default', autoMergePR: 'default' },
    });
  });

  it('falls back to defaults when the task row does not exist', async () => {
    const result = await resolveAutomationPolicy(fakePrisma(null), 999);

    expect(result.autoCommit).toBe(true);
    expect(result.source.autoCommit).toBe('default');
  });
});

describe('resolveAutomationPolicy — env var tier', () => {
  it('true env values ("true"/"1") override the default', async () => {
    process.env.RAPITAS_DEFAULT_AUTO_MERGE_PR = 'true';

    const result = await resolveAutomationPolicy(fakePrisma({ id: 1 }), 1);

    expect(result.autoMergePR).toBe(true);
    expect(result.source.autoMergePR).toBe('env');
  });

  it('false env values ("false"/"0") override the default', async () => {
    process.env.RAPITAS_DEFAULT_AUTO_COMMIT = '0';

    const result = await resolveAutomationPolicy(fakePrisma({ id: 1 }), 1);

    expect(result.autoCommit).toBe(false);
    expect(result.source.autoCommit).toBe('env');
  });

  it('an unrecognized env value is ignored and falls through to the hardcoded default', async () => {
    process.env.RAPITAS_DEFAULT_AUTO_CREATE_PR = 'yes-please';

    const result = await resolveAutomationPolicy(fakePrisma({ id: 1 }), 1);

    expect(result.autoCreatePR).toBe(true); // hardcoded default, not env-derived
    expect(result.source.autoCreatePR).toBe('default');
  });
});

describe('resolveAutomationPolicy — user-settings tier', () => {
  it('a UserSettings default overrides the env var', async () => {
    process.env.RAPITAS_DEFAULT_AUTO_MERGE_PR = 'false';

    const result = await resolveAutomationPolicy(
      fakePrisma({ id: 1 }, { autoMergePRDefault: true }),
      1,
    );

    expect(result.autoMergePR).toBe(true);
    expect(result.source.autoMergePR).toBe('user');
  });

  it('a null UserSettings field does not shadow the env var', async () => {
    process.env.RAPITAS_DEFAULT_AUTO_COMMIT = 'false';

    const result = await resolveAutomationPolicy(
      fakePrisma({ id: 1 }, { autoCommitDefault: null }),
      1,
    );

    expect(result.autoCommit).toBe(false);
    expect(result.source.autoCommit).toBe('env');
  });

  it('unreadable settings cannot silently downgrade required automation to defaults', async () => {
    const prisma = {
      task: { findUnique: () => Promise.resolve({ id: 1 }) },
      userSettings: { findFirst: () => Promise.reject(new Error('DB down')) },
    } as unknown as PrismaClient;

    await expect(resolveAutomationPolicy(prisma, 1)).rejects.toThrow('DB down');
  });
});

describe('resolveAutomationPolicy — task tier (highest precedence)', () => {
  it('a per-task boolean overrides user settings, env, and default simultaneously', async () => {
    process.env.RAPITAS_DEFAULT_AUTO_COMMIT = 'false';

    const result = await resolveAutomationPolicy(
      fakePrisma(
        { id: 1, autoCommit: true, autoCreatePR: false, autoMergePR: true },
        { autoCommitDefault: false, autoCreatePRDefault: true, autoMergePRDefault: false },
      ),
      1,
    );

    expect(result).toEqual({
      autoCommit: true,
      autoCreatePR: false,
      autoMergePR: true,
      source: { autoCommit: 'task', autoCreatePR: 'task', autoMergePR: 'task' },
    });
  });

  it('a null per-task field does not shadow lower tiers', async () => {
    const result = await resolveAutomationPolicy(
      fakePrisma({ id: 1, autoCommit: null }, { autoCommitDefault: true }),
      1,
    );

    expect(result.autoCommit).toBe(true);
    expect(result.source.autoCommit).toBe('user');
  });
});

// NOTE: The dedup debug-log cache (lastLoggedPolicy) has no externally
// observable effect besides a log call, and automation-policy.ts is a
// process-wide singleton also imported for real by auto-merge-candidates.ts.
// When multiple test files transitively load it in one bun process, only the
// FIRST file's config/logger mock ends up wired to the module's internal
// `log` — asserting call counts here is order-dependent flakiness, not a
// real regression signal, so it is intentionally not covered.
