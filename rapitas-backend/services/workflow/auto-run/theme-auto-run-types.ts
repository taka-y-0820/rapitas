/**
 * theme-auto-run-types
 *
 * Type definitions and the DB-row → ThemeAutoRunState mapper shared by
 * theme-auto-run-mutations.ts and theme-auto-run-queries.ts. Split out of
 * theme-auto-run-service.ts (task 784) to stay under the file-size ratchet;
 * theme-auto-run-service.ts re-exports this as a barrel.
 */
import { narrowEnum } from '../../../utils/common/type-guards';

/**
 * Runtime array of all valid auto-run status values. Derive AutoRunStatus from this
 * so the type and the runtime validation list can never drift apart.
 *
 * `paused_user` / `paused_approval` (task 883) distinguish an explicit user pause
 * from an awaiting-plan-approval pause on the existing `status` String column —
 * no schema change. The bare legacy `paused` value is kept (never written again,
 * but still readable) so pre-migration rows are not silently coerced to `idle`.
 */
export const AUTO_RUN_STATUSES = [
  'idle',
  'running',
  'paused',
  'paused_user',
  'paused_approval',
  'stopping',
] as const;

/** Valid status values for ThemeAutoRun.status. */
export type AutoRunStatus = (typeof AUTO_RUN_STATUSES)[number];

/** Subset of AutoRunStatus that represents "paused for some reason". */
export const PAUSED_AUTO_RUN_STATUSES: readonly AutoRunStatus[] = [
  'paused',
  'paused_user',
  'paused_approval',
];

/**
 * Narrows a DB string (or null/undefined) to AutoRunStatus, returning 'idle' as
 * the safe fallback when the value is absent or unrecognised.
 *
 * @param s - Raw value from the database. / DBからの生の値
 * @returns A valid AutoRunStatus. / 有効なAutoRunStatus
 */
export function narrowAutoRunStatus(s: string | null | undefined): AutoRunStatus {
  return narrowEnum(s, AUTO_RUN_STATUSES, 'idle');
}

/**
 * True when the status represents any kind of pause (explicit user pause,
 * awaiting-approval pause, or the legacy reason-unknown pause).
 *
 * @param status - Status to check. / 判定対象のステータス
 * @returns Whether the status is a paused variant. / 一時停止系の値かどうか
 */
export function isPausedAutoRunStatus(status: AutoRunStatus): boolean {
  return PAUSED_AUTO_RUN_STATUSES.includes(status);
}

/**
 * True only for the awaiting-approval pause — the sole status the polling
 * safety net (processPausedThemesImpl) and onPlanApproved() may auto-resume.
 * An explicit user pause or a reason-unknown legacy pause must never be
 * silently overridden (task 883, incident 2026-09-07T09:45Z).
 *
 * @param status - Status to check. / 判定対象のステータス
 * @returns Whether this status may be auto-resumed. / 自動再開してよいか
 */
export function isAutoResumablePauseStatus(status: AutoRunStatus): boolean {
  return status === 'paused_approval';
}

/** Public (API-facing) reason a theme is paused. */
export type PauseReason = 'user' | 'awaiting_approval' | 'unknown';

/**
 * Maps an internal AutoRunStatus to the public pause reason it implies, or
 * null when the status is not a paused variant at all.
 *
 * @param status - Internal status value. / 内部ステータス値
 * @returns The public pause reason, or null when not paused. / 公開用の一時停止理由（非pausedならnull）
 */
export function toPauseReason(status: AutoRunStatus): PauseReason | null {
  if (status === 'paused_user') return 'user';
  if (status === 'paused_approval') return 'awaiting_approval';
  if (status === 'paused') return 'unknown';
  return null;
}

/** Public status values exposed over the API — pause reason granularity collapses to 'paused'. */
export type PublicAutoRunStatus = 'idle' | 'running' | 'paused' | 'stopping';

/** Serialisable view of a ThemeAutoRun record. */
export interface ThemeAutoRunState {
  id: number;
  themeId: number;
  enabled: boolean;
  status: AutoRunStatus;
  order: 'priority' | 'created';
  currentTaskId: number | null;
  processedCount: number;
  lastError: string | null;
  lastRunAt: string | null;
  startedAt: string | null;
  /** When the theme went idle with no work (idle-stop timer origin); null while running. */
  idleSince: string | null;
  /** Set when the idle-stop timer disabled auto-run; null after a USER stop or a start. */
  idleStoppedAt: string | null;
  /** When the nightly backlog self-refill last ran for this theme. */
  lastSelfRefillAt: string | null;
  updatedAt: string;
}

/** API-facing view of a ThemeAutoRun record: internal pause granularity collapses into pauseReason. */
export interface ThemeAutoRunPublicState extends Omit<ThemeAutoRunState, 'status'> {
  status: PublicAutoRunStatus;
  pauseReason: PauseReason | null;
}

/**
 * Converts an internal ThemeAutoRunState (which may carry paused_user /
 * paused_approval / legacy paused) to the public shape the API returns:
 * status is collapsed to the 4 documented values and pauseReason carries the
 * detail. Existing frontend callers matching on status==='paused' keep
 * working unmodified.
 *
 * @param state - Internal state. / 内部状態
 * @returns Public state. / 公開用状態
 */
export function toPublicAutoRunState(state: ThemeAutoRunState): ThemeAutoRunPublicState {
  const pauseReason = toPauseReason(state.status);
  const status: PublicAutoRunStatus =
    pauseReason !== null ? 'paused' : (state.status as PublicAutoRunStatus);
  return { ...state, status, pauseReason };
}

/**
 * Idle-timer columns (task 784), which the generated Prisma client only
 * knows after the next regeneration/restart. Read/write through a cast.
 */
export type IdleTimerColumns = {
  idleSince?: Date | null;
  idleStoppedAt?: Date | null;
  lastSelfRefillAt?: Date | null;
};

/**
 * Map a raw ThemeAutoRun DB row to its serialisable state. Idle-timer columns
 * are read by name via a cast: absent (pre-regeneration client) reads as null.
 * Shared by theme-auto-run-mutations.ts and theme-auto-run-queries.ts.
 *
 * @param r - Raw Prisma row. / 生のPrisma行
 * @returns Serialisable state. / シリアライズ可能な状態
 */
export function mapToState(r: {
  id: number;
  themeId: number;
  enabled: boolean;
  status: string;
  order: string;
  currentTaskId: number | null;
  processedCount: number;
  lastError: string | null;
  lastRunAt: Date | null;
  startedAt: Date | null;
  updatedAt: Date;
}): ThemeAutoRunState {
  const idle = r as IdleTimerColumns;
  return {
    id: r.id,
    themeId: r.themeId,
    enabled: r.enabled,
    status: narrowAutoRunStatus(r.status),
    order: r.order as 'priority' | 'created',
    currentTaskId: r.currentTaskId,
    processedCount: r.processedCount,
    lastError: r.lastError,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    idleSince: idle.idleSince?.toISOString() ?? null,
    idleStoppedAt: idle.idleStoppedAt?.toISOString() ?? null,
    lastSelfRefillAt: idle.lastSelfRefillAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  };
}
