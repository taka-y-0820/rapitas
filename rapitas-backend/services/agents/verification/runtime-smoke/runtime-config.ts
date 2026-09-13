/**
 * runtime-smoke/runtime-config
 *
 * Loads and validates the per-project runtime verification config. Three
 * sources, tried in order, all DB-first: (1) the task's Theme's
 * `runtimeConfigJson` column when a taskId is given, (2) a Theme whose
 * `workingDirectory` matches `workdir` when no taskId is given (or its task
 * has no theme) — covers ad hoc runs (e.g. a manual runtime-smoke check)
 * against a directory rapitas already has a Theme for, (3) a
 * `rapitas.runtime.json` file at the worktree root, kept only as a read-only
 * legacy fallback for a project with neither of the above — nothing in this
 * module ever writes that file; saves always go to the Theme row. Absence of
 * all three means the project simply isn't opted into runtime smoke
 * verification/live preview.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { prisma } from '../../../../config/database';

/** File name looked up at the worktree root. */
export const RUNTIME_CONFIG_FILENAME = 'rapitas.runtime.json';

/** Validated runtime verification config. */
export interface RuntimeConfig {
  /** Shell command that starts the app; `{port}` is substituted. */
  start: string;
  /** Base URL the app serves on; `{port}` is substituted. */
  url: string;
  /** Path polled until the app responds (default "/"). */
  healthPath: string;
  /** Max ms to wait for the app to become responsive (default 90s). */
  readyTimeoutMs: number;
  /** Paths driven in the browser smoke pass (default ["/"], max 10). */
  checkPaths: string[];
  /** Visible element proving that the application has finished loading. */
  readySelector?: string;
  /** Browser readiness deadline, separate from server startup. */
  readinessTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const MAX_READY_TIMEOUT_MS = 5 * 60_000;
const MAX_CHECK_PATHS = 10;

/**
 * Substitute the `{port}` placeholder.
 *
 * @param template - String possibly containing `{port}` / プレースホルダ付き文字列
 * @param port - Allocated port / 割り当てポート
 * @returns Substituted string / 置換後の文字列
 */
export function substitutePort(template: string, port: number): string {
  return template.split('{port}').join(String(port));
}

/**
 * Parse and validate a rapitas.runtime.json payload.
 *
 * @param raw - File content / ファイル内容
 * @returns Validated config, or an error string / 検証済み設定またはエラー
 */
export function parseRuntimeConfig(raw: string): { config?: RuntimeConfig; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof json !== 'object' || json === null) return { error: 'config must be an object' };
  const o = json as Record<string, unknown>;

  if (typeof o.start !== 'string' || o.start.trim() === '') {
    return { error: '"start" (launch command) is required' };
  }
  if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) {
    return { error: '"url" must be an http(s) URL (use {port} for the allocated port)' };
  }

  const healthPath = typeof o.healthPath === 'string' && o.healthPath ? o.healthPath : '/';
  if (
    o.readySelector !== undefined &&
    (typeof o.readySelector !== 'string' ||
      !o.readySelector.trim() ||
      o.readySelector.length > 1000)
  ) {
    return { error: '"readySelector" must be a non-empty selector (max 1000 characters)' };
  }
  if (
    o.readinessTimeoutMs !== undefined &&
    (typeof o.readinessTimeoutMs !== 'number' ||
      !Number.isFinite(o.readinessTimeoutMs) ||
      o.readinessTimeoutMs < 500 ||
      o.readinessTimeoutMs > 60000)
  ) {
    return { error: '"readinessTimeoutMs" must be between 500 and 60000' };
  }
  const rawTimeout = typeof o.readyTimeoutMs === 'number' ? o.readyTimeoutMs : NaN;
  const readyTimeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(MAX_READY_TIMEOUT_MS, Math.max(5_000, rawTimeout))
    : DEFAULT_READY_TIMEOUT_MS;
  const checkPaths = (
    Array.isArray(o.checkPaths)
      ? o.checkPaths.filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
      : []
  ).slice(0, MAX_CHECK_PATHS);

  return {
    config: {
      start: o.start.trim(),
      url: o.url.trim().replace(/\/+$/, ''),
      healthPath,
      readyTimeoutMs,
      checkPaths: checkPaths.length > 0 ? checkPaths : ['/'],
      ...(typeof o.readySelector === 'string'
        ? {
            readySelector: o.readySelector.trim(),
            readinessTimeoutMs:
              typeof o.readinessTimeoutMs === 'number' ? o.readinessTimeoutMs : 25000,
          }
        : {}),
    },
  };
}

/**
 * Load the runtime config from a worktree root.
 *
 * @param workdir - Worktree root directory / worktree ルート
 * @returns Config, a config error, or null when the file is absent / 設定・エラー・無ければnull
 */
export async function loadRuntimeConfig(
  workdir: string,
): Promise<{ config?: RuntimeConfig; error?: string } | null> {
  let raw: string;
  try {
    raw = await readFile(join(workdir, RUNTIME_CONFIG_FILENAME), 'utf8');
  } catch {
    return null; // absent = project not opted in
  }
  return parseRuntimeConfig(raw);
}

/**
 * Resolve the runtime config for a task: prefer its Theme's
 * `runtimeConfigJson` (managed in rapitas's own theme settings, not
 * scattered across every project repo); if that's unavailable (no taskId, or
 * the task's theme has nothing set), look for a Theme whose
 * `workingDirectory` matches `workdir` — so a directory rapitas already
 * tracks resolves from the DB even without a taskId; only then fall back to
 * a `rapitas.runtime.json` file at `workdir` (read-only legacy path).
 *
 * @param opts.workdir - Worktree/working directory; also used to match a
 *   Theme by `workingDirectory` and as the legacy file's fallback location. / 対象ディレクトリ
 * @param opts.taskId - Task whose theme to check first, if any. / 対象タスクID
 * @returns Config, a config error, or null when no source is set. / 設定・エラー・無ければnull
 */
export async function resolveRuntimeConfig(opts: {
  workdir: string;
  taskId?: number | null;
}): Promise<{ config?: RuntimeConfig; error?: string } | null> {
  if (opts.taskId != null) {
    const task = await prisma.task
      .findUnique({
        where: { id: opts.taskId },
        select: { theme: { select: { runtimeConfigJson: true } } },
      })
      .catch(() => null);
    if (task?.theme?.runtimeConfigJson) {
      return parseRuntimeConfig(task.theme.runtimeConfigJson);
    }
  }
  const theme = await prisma.theme
    .findFirst({
      where: { workingDirectory: opts.workdir },
      select: { runtimeConfigJson: true },
    })
    .catch(() => null);
  if (theme?.runtimeConfigJson) {
    return parseRuntimeConfig(theme.runtimeConfigJson);
  }
  return loadRuntimeConfig(opts.workdir);
}

/**
 * The task's theme working directory (its main checkout), used to tell a
 * worktree that merely predates the runtime harness apart from a genuinely
 * broken runtime configuration.
 *
 * @param taskId - Task whose theme to look up. / 対象タスクID
 * @returns The theme's workingDirectory, or null when unknown / 主チェックアウト
 */
export async function resolveThemeWorkingDirectory(
  taskId: number | null | undefined,
): Promise<string | null> {
  if (taskId == null) return null;
  const task = await prisma.task
    .findUnique({
      where: { id: taskId },
      select: { theme: { select: { workingDirectory: true } } },
    })
    .catch(() => null);
  const dir = task?.theme?.workingDirectory;
  return typeof dir === 'string' && dir.trim() ? dir : null;
}

export type TaskThemeRuntimeConfig =
  | { themeId: number; runtimeConfigJson: string | null }
  | { themeId: null };

/**
 * Fetch the raw runtimeConfigJson currently set on a task's theme (or
 * confirmation that the task has no theme at all), for pre-filling an inline
 * edit form on the task detail page — the raw string, unvalidated; a
 * previously-saved value is trusted (it was validated on write).
 *
 * @param taskId - Task whose theme to look up. / 対象タスクID
 * @returns The theme id + its current value, or `{themeId: null}` when the
 *   task has no theme to store a config on. / テーマのruntime設定
 */
export async function getTaskThemeRuntimeConfigJson(
  taskId: number,
): Promise<TaskThemeRuntimeConfig> {
  const task = await prisma.task
    .findUnique({
      where: { id: taskId },
      select: { theme: { select: { id: true, runtimeConfigJson: true } } },
    })
    .catch(() => null);
  if (!task?.theme) return { themeId: null };
  return { themeId: task.theme.id, runtimeConfigJson: task.theme.runtimeConfigJson };
}

/**
 * Validate and persist a runtimeConfigJson string onto a task's theme — the
 * write side of the task-detail inline editor, so a user hitting
 * "not_configured" while starting a preview can fix it right there instead
 * of navigating to theme settings.
 *
 * @param taskId - Task whose theme to update. / 対象タスクID
 * @param runtimeConfigJson - Raw JSON string to validate and save. / 保存するJSON文字列
 * @returns Success, or a validation/lookup error. / 実行結果
 */
export async function setTaskThemeRuntimeConfigJson(
  taskId: number,
  runtimeConfigJson: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = parseRuntimeConfig(runtimeConfigJson);
  if (error) return { ok: false, error };

  const task = await prisma.task
    .findUnique({ where: { id: taskId }, select: { themeId: true } })
    .catch(() => null);
  if (!task?.themeId) {
    return {
      ok: false,
      error: 'このタスクにはテーマが設定されていないため、ここでは保存できません。',
    };
  }

  await prisma.theme.update({ where: { id: task.themeId }, data: { runtimeConfigJson } });
  return { ok: true };
}
