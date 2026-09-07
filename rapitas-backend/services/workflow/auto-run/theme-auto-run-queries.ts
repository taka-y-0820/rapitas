/**
 * theme-auto-run-queries
 *
 * Read-only accessors for ThemeAutoRun records. Split out of
 * theme-auto-run-service.ts (task 784) to stay under the file-size ratchet;
 * theme-auto-run-service.ts re-exports this as a barrel. Not responsible for
 * state transitions — see theme-auto-run-mutations.ts.
 */
import { prisma } from '../../../config';
import {
  mapToState,
  isPausedAutoRunStatus,
  narrowAutoRunStatus,
  type AutoRunStatus,
  type ThemeAutoRunState,
} from './theme-auto-run-types';

/**
 * Return or create the ThemeAutoRun record for a theme.
 *
 * @param themeId - Theme to look up / 検索するテーマID
 * @returns ThemeAutoRun state / ThemeAutoRun状態
 */
export async function getOrCreateAutoRun(themeId: number): Promise<ThemeAutoRunState> {
  const existing = await prisma.themeAutoRun.findUnique({ where: { themeId } });
  if (existing) return mapToState(existing);

  const created = await prisma.themeAutoRun.create({
    data: { themeId },
  });
  return mapToState(created);
}

/**
 * Retrieve the auto-run state for a theme; returns null when no record exists.
 *
 * @param themeId - Theme ID / テーマID
 * @returns state or null / 状態またはnull
 */
export async function getAutoRunState(themeId: number): Promise<ThemeAutoRunState | null> {
  const record = await prisma.themeAutoRun.findUnique({ where: { themeId } });
  return record ? mapToState(record) : null;
}

/**
 * Whether a theme's auto-run is the actor currently executing `taskId`.
 *
 * When the user stops such a task, the loop must also be halted — otherwise the
 * scheduler re-selects the just-stopped task on its next poll (the "press stop,
 * it runs again" bug). True only when auto-run is actively driving THIS task.
 *
 * @param state - The theme's auto-run state (or null). / テーマのauto-run状態（またはnull）
 * @param taskId - The task being stopped. / 停止対象タスクID
 * @returns true when auto-run is currently running this task. / auto-runが当該タスクを実行中ならtrue
 */
export function isAutoRunHandlingTask(state: ThemeAutoRunState | null, taskId: number): boolean {
  if (!state) return false;
  return (
    state.currentTaskId === taskId &&
    (state.status === 'running' ||
      isPausedAutoRunStatus(state.status) ||
      state.status === 'stopping')
  );
}

/**
 * Return true when the theme has an active auto-run (running or paused).
 * Used by the execute-route to block manual execution.
 *
 * @param themeId - Theme ID / テーマID
 * @returns true if auto-run is active / 自動実行がアクティブならtrue
 */
export async function isThemeAutoRunActive(themeId: number | null | undefined): Promise<boolean> {
  if (!themeId) return false;
  const record = await prisma.themeAutoRun.findUnique({
    where: { themeId },
    select: { status: true },
  });
  return (
    record != null &&
    (record.status === 'running' || isPausedAutoRunStatus(narrowAutoRunStatus(record.status)))
  );
}

/**
 * Return all ThemeAutoRun records whose status matches any of the given values.
 *
 * @param statuses - Status values to include / 含めるステータス
 * @returns matching records / 一致するレコード
 */
export async function findByStatuses(statuses: AutoRunStatus[]): Promise<ThemeAutoRunState[]> {
  const records = await prisma.themeAutoRun.findMany({
    where: { status: { in: statuses } },
  });
  return records.map(mapToState);
}
