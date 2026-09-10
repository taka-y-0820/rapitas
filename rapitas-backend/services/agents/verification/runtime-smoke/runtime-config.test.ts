/**
 * runtime-config.test
 *
 * Unit tests for resolveRuntimeConfig: prefers a Theme's runtimeConfigJson
 * reached via a task (managed in rapitas's own theme settings), then a Theme
 * whose workingDirectory matches the workdir directly (no taskId needed),
 * and only then falls back to a rapitas.runtime.json file at the workdir.
 * `prisma` is mocked (task.findUnique, theme.findFirst) — no real DB touched.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const mockTaskFindUnique = mock(() => Promise.resolve<Record<string, unknown> | null>(null));
const mockThemeFindFirst = mock(() => Promise.resolve<Record<string, unknown> | null>(null));
const mockThemeUpdate = mock(() => Promise.resolve({ id: 1 }));
mock.module('../../../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: {
    task: { findUnique: mockTaskFindUnique },
    theme: { findFirst: mockThemeFindFirst, update: mockThemeUpdate },
  },
}));

const { resolveRuntimeConfig, getTaskThemeRuntimeConfigJson, setTaskThemeRuntimeConfigJson } =
  await import('./runtime-config');

const VALID_CONFIG_JSON = JSON.stringify({
  start: 'npm run dev -- -p {port}',
  url: 'http://localhost:{port}',
});

test('validates and preserves a bounded browser readiness contract', async () => {
  const { parseRuntimeConfig } = await import('./runtime-config');
  const base = JSON.parse(VALID_CONFIG_JSON);
  expect(
    parseRuntimeConfig(JSON.stringify({ ...base, readySelector: ' [data-ready] ' })).config,
  ).toMatchObject({ readySelector: '[data-ready]', readinessTimeoutMs: 25000 });
  for (const value of [0, -1, 60001, '1000']) {
    expect(
      parseRuntimeConfig(
        JSON.stringify({ ...base, readySelector: '[data-ready]', readinessTimeoutMs: value }),
      ).error,
    ).toBeDefined();
  }
  expect(parseRuntimeConfig(JSON.stringify({ ...base, readySelector: ' ' })).error).toBeDefined();
});

beforeEach(() => {
  mockTaskFindUnique.mockReset().mockResolvedValue(null);
  mockThemeFindFirst.mockReset().mockResolvedValue(null);
  mockThemeUpdate.mockReset().mockResolvedValue({ id: 1 });
});

describe('resolveRuntimeConfig', () => {
  test('falls back to the file when no taskId is given and no theme matches the workdir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rapitas-rc-'));
    try {
      await writeFile(join(dir, 'rapitas.runtime.json'), VALID_CONFIG_JSON, 'utf8');
      const result = await resolveRuntimeConfig({ workdir: dir });
      expect(result?.config?.start).toBe('npm run dev -- -p {port}');
      expect(mockTaskFindUnique).not.toHaveBeenCalled();
      expect(mockThemeFindFirst).toHaveBeenCalledWith({
        where: { workingDirectory: dir },
        select: { runtimeConfigJson: true },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('resolves via a Theme matching the workdir when no taskId is given', async () => {
    mockThemeFindFirst.mockResolvedValue({ runtimeConfigJson: VALID_CONFIG_JSON });
    const dir = await mkdtemp(join(tmpdir(), 'rapitas-rc-'));
    try {
      const result = await resolveRuntimeConfig({ workdir: dir });
      expect(result?.config?.start).toBe('npm run dev -- -p {port}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('falls back to the file when the task has no theme runtimeConfigJson set', async () => {
    mockTaskFindUnique.mockResolvedValue({ theme: { runtimeConfigJson: null } });
    const dir = await mkdtemp(join(tmpdir(), 'rapitas-rc-'));
    try {
      await writeFile(join(dir, 'rapitas.runtime.json'), VALID_CONFIG_JSON, 'utf8');
      const result = await resolveRuntimeConfig({ workdir: dir, taskId: 1 });
      expect(result?.config?.start).toBe('npm run dev -- -p {port}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('prefers the theme runtimeConfigJson over the file when both are present', async () => {
    mockTaskFindUnique.mockResolvedValue({
      theme: {
        runtimeConfigJson: JSON.stringify({
          start: 'npm run dev:db -- -p {port}',
          url: 'http://localhost:{port}',
        }),
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'rapitas-rc-'));
    try {
      await writeFile(join(dir, 'rapitas.runtime.json'), VALID_CONFIG_JSON, 'utf8');
      const result = await resolveRuntimeConfig({ workdir: dir, taskId: 1 });
      expect(result?.config?.start).toBe('npm run dev:db -- -p {port}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('surfaces a validation error from a broken theme runtimeConfigJson without touching the file', async () => {
    mockTaskFindUnique.mockResolvedValue({ theme: { runtimeConfigJson: 'not json' } });
    const dir = await mkdtemp(join(tmpdir(), 'rapitas-rc-'));
    try {
      await writeFile(join(dir, 'rapitas.runtime.json'), VALID_CONFIG_JSON, 'utf8');
      const result = await resolveRuntimeConfig({ workdir: dir, taskId: 1 });
      expect(result?.error).toMatch(/invalid JSON/);
      expect(result?.config).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns null when neither source is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rapitas-rc-'));
    try {
      const result = await resolveRuntimeConfig({ workdir: dir, taskId: 1 });
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('getTaskThemeRuntimeConfigJson', () => {
  test.each([
    { theme: null, expected: { themeId: null } },
    {
      theme: { id: 7, runtimeConfigJson: VALID_CONFIG_JSON },
      expected: { themeId: 7, runtimeConfigJson: VALID_CONFIG_JSON },
    },
    {
      theme: { id: 7, runtimeConfigJson: null },
      expected: { themeId: 7, runtimeConfigJson: null },
    },
  ])('resolves $expected from a task whose theme is $theme', async ({ theme, expected }) => {
    mockTaskFindUnique.mockResolvedValue({ theme });
    const result = await getTaskThemeRuntimeConfigJson(1);
    expect(result).toEqual(expected);
  });
});

describe('setTaskThemeRuntimeConfigJson', () => {
  test('rejects invalid JSON without touching the DB', async () => {
    const result = await setTaskThemeRuntimeConfigJson(1, 'not json');
    expect(result.ok).toBe(false);
    expect(mockTaskFindUnique).not.toHaveBeenCalled();
    expect(mockThemeUpdate).not.toHaveBeenCalled();
  });

  test('rejects when the task has no theme', async () => {
    mockTaskFindUnique.mockResolvedValue({ themeId: null });
    const result = await setTaskThemeRuntimeConfigJson(1, VALID_CONFIG_JSON);
    expect(result.ok).toBe(false);
    expect(mockThemeUpdate).not.toHaveBeenCalled();
  });

  test('validates then persists onto the task theme', async () => {
    mockTaskFindUnique.mockResolvedValue({ themeId: 7 });
    const result = await setTaskThemeRuntimeConfigJson(1, VALID_CONFIG_JSON);
    expect(result).toEqual({ ok: true });
    expect(mockThemeUpdate).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { runtimeConfigJson: VALID_CONFIG_JSON },
    });
  });
});
