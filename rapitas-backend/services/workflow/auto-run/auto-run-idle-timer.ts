/**
 * auto-run-idle-timer
 *
 * Idle-stop timer and nightly backlog self-refill decision logic (task 784):
 * settings readers, pure timer/window predicates, the combined
 * shouldRefillBacklogNow gate, the human-origin-todo counter, the
 * severity-bypass promotion, and the idle-timeout stop write + notification.
 * Not responsible for the idle-theme poll loop itself — see
 * auto-run-lifecycle.ts (processIdleThemesImpl) — nor for the ordinary
 * bandit-based promotion — see backlog-promoter-execute.ts.
 */
import { prisma } from '../../../config/database';
import { createLogger } from '../../../config/logger';
import { logCycleEvent } from '../../observability';
import { listConcerns } from '../../memory/concern-backlog-service';
import { countOutstandingAutoCreated, resolveLimit } from './backlog-promoter-eligibility';
import { promoteConcern } from './backlog-promoter-execute';
import { notifyIdleStopped } from './auto-run-notifications-terminal';
import { eligibleTopLevelTodoWhere } from './auto-run-eligibility';

const log = createLogger('auto-run:idle-timer');

/** Default minutes of idle (no new filing) before auto-run is stopped. */
export const DEFAULT_IDLE_STOP_MINUTES = 60;
/** Hard ceiling for idleStopMinutes (24h) — larger values are clamped. */
export const MAX_IDLE_STOP_MINUTES = 24 * 60;
/** Default local time ("HH:MM") the nightly self-refill window opens. */
export const DEFAULT_SELF_REFILL_WINDOW_START = '03:00';
/**
 * Concern severities whose auto-filing bypasses the idle timer (design point
 * 3: "severity=high の懸念自動起票が来たら通常運転に復帰"). Urgent first so a
 * bypass probe checks the more severe arm first. Distinct from the bandit's
 * CRITICAL_CONCERN_SEVERITIES (backlog-bandit.ts), which only orders arms and
 * stays 'urgent'-only — the two constants serve different mechanisms.
 */
export const IDLE_BYPASS_CONCERN_SEVERITIES: ReadonlySet<string> = new Set(['urgent', 'high']);

const WINDOW_START_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Clamp a raw idleStopMinutes value into 0..MAX_IDLE_STOP_MINUTES (integer).
 * Non-numeric / null / undefined fall back to the default — the column may be
 * absent on rows created before the migration.
 *
 * @param value - Raw setting value. / 生の設定値
 * @returns Normalised minutes (0 = disabled). / 正規化済みの分数
 */
export function normalizeIdleStopMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_IDLE_STOP_MINUTES;
  return Math.max(0, Math.min(MAX_IDLE_STOP_MINUTES, Math.floor(value)));
}

/**
 * Normalise a raw selfRefillWindowStart value: '' stays '' (disabled), a
 * valid "HH:MM" is kept, anything else (absent column, malformed) falls back
 * to the default so a bad value can never silently disable the nightly loop.
 *
 * @param value - Raw setting value. / 生の設定値
 * @returns '' or a valid "HH:MM". / 空文字または妥当な "HH:MM"
 */
export function normalizeSelfRefillWindowStart(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SELF_REFILL_WINDOW_START;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return WINDOW_START_RE.test(trimmed) ? trimmed : DEFAULT_SELF_REFILL_WINDOW_START;
}

/**
 * Read UserSettings.idleStopMinutes (0 = timer disabled). Column read by
 * name via a cast — pending client regeneration; a lookup failure returns
 * the default (timer armed).
 *
 * @returns Normalised idle-stop minutes. / 正規化済みアイドル停止分数
 */
export async function getIdleStopMinutes(): Promise<number> {
  const s = await prisma.userSettings.findFirst().catch(() => null);
  return normalizeIdleStopMinutes((s as { idleStopMinutes?: unknown } | null)?.idleStopMinutes);
}

/**
 * Read UserSettings.selfRefillWindowStart ('' = self-refill disabled).
 * Column read by name via a cast — pending client regeneration.
 *
 * @returns Normalised window start ("HH:MM" or ''). / 正規化済みウィンドウ開始時刻
 */
export async function getSelfRefillWindowStart(): Promise<string> {
  const s = await prisma.userSettings.findFirst().catch(() => null);
  return normalizeSelfRefillWindowStart(
    (s as { selfRefillWindowStart?: unknown } | null)?.selfRefillWindowStart,
  );
}

/** Minimal ThemeAutoRun shape isIdleTimerActivelyCounting needs. */
export interface IdleCountingState {
  enabled: boolean;
  status: string;
  idleSince: Date | string | null;
}

/**
 * Whether the idle-stop timer is currently counting down for a theme: armed
 * (idleStopMinutes>0), the theme is idle-but-enabled with a recorded
 * idleSince, and elapsed time has not yet reached the threshold.
 *
 * @param state - enabled/status/idleSince of the theme. / テーマの状態
 * @param idleStopMinutes - Timer length; 0 disables. / タイマー長（分）
 * @param now - Current time. / 現在時刻
 * @returns true while the countdown is still running. / カウントダウン中なら true
 */
export function isIdleTimerActivelyCounting(
  state: IdleCountingState,
  idleStopMinutes: number,
  now: Date,
): boolean {
  if (idleStopMinutes <= 0) return false;
  if (!state.enabled || state.status !== 'idle' || !state.idleSince) return false;
  const since = typeof state.idleSince === 'string' ? new Date(state.idleSince) : state.idleSince;
  if (Number.isNaN(since.getTime())) return false;
  return now.getTime() - since.getTime() < idleStopMinutes * 60_000;
}

/**
 * Whether the idle-stop timer has fully expired (the mirror of
 * isIdleTimerActivelyCounting once the countdown reaches the threshold).
 *
 * @param idleSince - When the theme went idle (null = timer not started). / アイドル開始時刻
 * @param idleStopMinutes - Timer length; 0 disables. / タイマー長（分）
 * @param now - Current time. / 現在時刻
 * @returns true when auto-run should be stopped now. / 停止すべきなら true
 */
export function isIdleTimerExpired(
  idleSince: Date | string | null | undefined,
  idleStopMinutes: number,
  now: Date,
): boolean {
  if (idleStopMinutes <= 0 || !idleSince) return false;
  const since = typeof idleSince === 'string' ? new Date(idleSince) : idleSince;
  if (Number.isNaN(since.getTime())) return false;
  return now.getTime() - since.getTime() >= idleStopMinutes * 60_000;
}

/**
 * Whether `now` is at or past today's local self-refill window opening.
 * "Not-before" semantics: '' or a malformed window is always closed.
 *
 * @param now - Current time. / 現在時刻
 * @param windowStart - "HH:MM" local time; '' disables. / ウィンドウ開始時刻
 * @returns true when `now` is within (at or after) today's opening. / ウィンドウ内なら true
 */
export function isWithinSelfRefillWindow(now: Date, windowStart: string): boolean {
  const m = WINDOW_START_RE.exec(windowStart);
  if (!m) return false;
  const openToday = new Date(now.getTime());
  openToday.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return now.getTime() >= openToday.getTime();
}

/** Whether two instants fall on the same local calendar day. */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Whether the theme has already self-refilled today (local calendar day).
 * Combined with isWithinSelfRefillWindow this gives "not-before, once per
 * day": a theme that missed yesterday's window still refills as soon as
 * today's window opens, no separate overdue/catch-up logic needed.
 *
 * @param lastSelfRefillAt - Last self-refill for the theme, or null. / 前回の自己補充時刻
 * @param now - Current time. / 現在時刻
 * @returns true when a refill already ran today. / 本日実行済みなら true
 */
export function hasRefilledToday(lastSelfRefillAt: Date | string | null, now: Date): boolean {
  if (!lastSelfRefillAt) return false;
  const last = typeof lastSelfRefillAt === 'string' ? new Date(lastSelfRefillAt) : lastSelfRefillAt;
  if (Number.isNaN(last.getTime())) return false;
  return isSameLocalDay(last, now);
}

/** Read the ThemeAutoRun row's idle-timer columns (cast — pending client regen). */
async function readThemeIdleRow(themeId: number): Promise<{
  enabled: boolean;
  status: string;
  idleSince: Date | null;
  lastSelfRefillAt: Date | null;
} | null> {
  try {
    const row = await prisma.themeAutoRun.findUnique({ where: { themeId } });
    if (!row) return null;
    const idle = row as { idleSince?: Date | null; lastSelfRefillAt?: Date | null };
    return {
      enabled: row.enabled,
      status: row.status,
      idleSince: idle.idleSince ?? null,
      lastSelfRefillAt: idle.lastSelfRefillAt ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a backlog self-refill may run right now for a theme (task 784,
 * design point 6 — "自己補充は 1 日 1 回の夜間ウィンドウでのみ"): false while
 * the idle-stop timer is actively counting (design point 2 — refilling would
 * be the very thing the timer is holding off), false outside today's
 * self-refill window, false when already refilled today; true otherwise.
 *
 * @param themeId - Theme to evaluate. / 対象テーマID
 * @param now - Decision time (injectable for tests). / 判定時刻
 * @returns true when promoteBacklogForTheme may run now. / 自己補充可能なら true
 */
export async function shouldRefillBacklogNow(themeId: number, now: Date): Promise<boolean> {
  const idleStopMinutes = await getIdleStopMinutes();
  const row = await readThemeIdleRow(themeId);
  if (
    row &&
    isIdleTimerActivelyCounting(
      { enabled: row.enabled, status: row.status, idleSince: row.idleSince },
      idleStopMinutes,
      now,
    )
  ) {
    return false;
  }
  const windowStart = await getSelfRefillWindowStart();
  if (!isWithinSelfRefillWindow(now, windowStart)) return false;
  if (hasRefilledToday(row?.lastSelfRefillAt ?? null, now)) return false;
  return true;
}

/**
 * Count top-level todo tasks a HUMAN filed (not backlog-promoted) — the
 * "new work appeared" signal that returns an idle-but-counting-down theme to
 * normal operation without waiting for the timer to expire. "runnable" here
 * is defined by eligibleTopLevelTodoWhere and MUST stay aligned with
 * selectNextTask's exclusions (task 884) — otherwise a workflowDisabled or
 * awaiting_question task can trigger an immediate resume that selectNextTask
 * then refuses, bouncing the theme straight back to idle.
 *
 * @param themeId - Theme to count for. / 対象テーマID
 * @returns Number of human-origin todo tasks. / 人間起票のtodoタスク数
 */
export async function countHumanOriginTodo(themeId: number): Promise<number> {
  return prisma.task
    .count({ where: eligibleTopLevelTodoWhere(themeId, { autoCreatedFromBacklog: false }) })
    .catch(() => 0);
}

/**
 * Attempt an immediate single-concern promotion for a theme whose idle timer
 * is actively counting down, when a high/urgent concern is open (design
 * point 3). Respects the same outstanding-created cap as ordinary promotion;
 * returns false without promoting when the cap is full or nothing bypass-
 * eligible is open.
 *
 * @param themeId - Theme to check/promote for. / 対象テーマID
 * @returns true when a concern was promoted. / 起票できたら true
 */
export async function attemptCriticalConcernBypass(themeId: number): Promise<boolean> {
  const limit = await resolveLimit();
  if (limit <= 0) return false;
  const outstanding = await countOutstandingAutoCreated(themeId);
  if (outstanding >= limit) return false;

  for (const severity of IDLE_BYPASS_CONCERN_SEVERITIES) {
    const { concerns } = await listConcerns({
      status: 'open',
      themeId,
      severity: severity as never,
      limit: 1,
    }).catch(() => ({ concerns: [] as Array<{ id: number; severity: string; title?: string }> }));
    const concern = concerns[0];
    if (concern && (await promoteConcern(themeId, concern))) return true;
  }
  return false;
}

/**
 * Idle-stop: the timer has expired, so disable auto-run (enabled=false),
 * record the timer-originated stop marker, log the cycle event, and notify
 * the user (task 784).
 *
 * @param themeId - Theme to stop. / 停止するテーマID
 */
export async function stopThemeForIdleTimeout(themeId: number): Promise<void> {
  const idleStoppedAt = new Date();
  try {
    await prisma.themeAutoRun.update({
      where: { themeId },
      data: { enabled: false, idleStoppedAt } as unknown as Parameters<
        typeof prisma.themeAutoRun.update
      >[0]['data'],
    });
  } catch (err) {
    log.warn({ err, themeId }, '[auto-run-idle-timer] stopThemeForIdleTimeout write failed');
    return;
  }
  log.warn(
    { themeId, idleStoppedAt: idleStoppedAt.toISOString() },
    `[auto-run-idle-timer] Idle-stop timer expired for theme ${themeId} (enabled=false)`,
  );
  logCycleEvent('auto_run.idle_stopped', {
    theme: themeId,
    idleStoppedAt: idleStoppedAt.toISOString(),
    msg: 'no new filing since the theme ran dry — auto-run stopped',
  });
  await notifyIdleStopped(themeId);
}

/**
 * Stamp the theme's lastSelfRefillAt after a SUCCESSFUL self-refill —
 * consumes the nightly window for the rest of today (task 784).
 *
 * @param themeId - Theme that just self-refilled. / 自己補充したテーマID
 * @param now - Stamp time. / 記録時刻
 */
export async function markSelfRefillSucceeded(themeId: number, now: Date): Promise<void> {
  try {
    await prisma.themeAutoRun.updateMany({
      where: { themeId },
      data: { lastSelfRefillAt: now } as unknown as Parameters<
        typeof prisma.themeAutoRun.updateMany
      >[0]['data'],
    });
  } catch (err) {
    log.warn({ err, themeId }, '[auto-run-idle-timer] markSelfRefillSucceeded persist failed');
  }
}
