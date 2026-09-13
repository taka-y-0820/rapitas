/**
 * SettingsExtraFields
 *
 * Persistence helpers for user-settings fields that live outside the typed
 * Prisma client: columns pending client regeneration (written via cast) and
 * the file-backed autoRestartOnMergedCode toggle (no DB column at all —
 * schema changes were prohibited for that feature).
 * Not responsible for HTTP routing or validation; see settings-routes.ts.
 */
import { prisma } from '../../../config/database';
import { createLogger } from '../../../config/logger';
import {
  readAutoRestartEnabled,
  writeAutoRestartEnabled,
} from '../../../services/scheduling/auto-restart-merged-code/settings-store';
import {
  readRetroReviewEnabled,
  writeRetroReviewEnabled,
} from '../../../services/workflow/process-retro/retro-settings-store';
import {
  readMergeBarrierEnabled,
  writeMergeBarrierEnabled,
} from '../../../services/scheduling/merge-barrier/merge-barrier';
import type { UserSettingsUpdateBody } from './settings-types';
import {
  asPromptLanguage,
  readPromptLanguage,
  writePromptLanguage,
} from '../../../services/system/prompt-language-store';

const log = createLogger('routes:settings');

/** Max idleStopMinutes accepted on write (24h) — task 784. */
const MAX_IDLE_STOP_MINUTES = 1440;
/**
 * executionStallThresholdMinutes clamp range (task 870): 1 avoids a
 * "0 = always stalled" no-op setting, 120 keeps the dashboard's purpose
 * (early detection) meaningful.
 */
const MIN_EXECUTION_STALL_THRESHOLD_MINUTES = 1;
const MAX_EXECUTION_STALL_THRESHOLD_MINUTES = 120;
/** Local "HH:MM" format required for selfRefillWindowStart — task 784. */
const SELF_REFILL_WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Persist the "pending client regeneration" columns via cast writes: the
 * Prisma client type does not include these columns until it is regenerated
 * (on the next backend restart), so write them through a cast to keep this
 * compiling now. The values still land in the row the same way once the
 * columns exist. Applied values are mirrored onto `settingsRef` so the PATCH
 * response reflects them immediately.
 *
 * @param settingsId - UserSettings row id / 対象UserSettings行のid
 * @param body - PATCH body (only defined fields are written) / PATCHボディ
 * @param settingsRef - Response object to mirror applied values onto / 反映先レスポンスオブジェクト
 */
export async function applyPendingClientColumns(
  settingsId: number,
  body: UserSettingsUpdateBody,
  settingsRef: Record<string, unknown>,
): Promise<void> {
  const {
    restartOnAutoRunDry,
    verifyRepairLimit,
    executionStallThresholdMinutes,
    workflowDisabledGlobally,
    idleStopMinutes,
    selfRefillWindowStart,
  } = body;

  if (restartOnAutoRunDry !== undefined) {
    await prisma.userSettings
      .update({
        where: { id: settingsId },
        data: { restartOnAutoRunDry } as unknown as Parameters<
          typeof prisma.userSettings.update
        >[0]['data'],
      })
      .catch((err) => log.warn({ err }, 'restartOnAutoRunDry persist failed'));
    settingsRef.restartOnAutoRunDry = restartOnAutoRunDry;
  }

  if (verifyRepairLimit !== undefined) {
    // Clamp to a sane 0..10 range.
    const clamped = Math.max(0, Math.min(10, Math.floor(verifyRepairLimit)));
    await prisma.userSettings
      .update({
        where: { id: settingsId },
        data: { verifyRepairLimit: clamped } as unknown as Parameters<
          typeof prisma.userSettings.update
        >[0]['data'],
      })
      .catch((err) => log.warn({ err }, 'verifyRepairLimit persist failed'));
    settingsRef.verifyRepairLimit = clamped;
  }

  if (executionStallThresholdMinutes !== undefined) {
    // Clamp to 1..120 minutes — see MIN/MAX_EXECUTION_STALL_THRESHOLD_MINUTES above.
    const clamped = Math.max(
      MIN_EXECUTION_STALL_THRESHOLD_MINUTES,
      Math.min(MAX_EXECUTION_STALL_THRESHOLD_MINUTES, Math.floor(executionStallThresholdMinutes)),
    );
    await prisma.userSettings
      .update({
        where: { id: settingsId },
        data: { executionStallThresholdMinutes: clamped } as unknown as Parameters<
          typeof prisma.userSettings.update
        >[0]['data'],
      })
      .catch((err) => log.warn({ err }, 'executionStallThresholdMinutes persist failed'));
    settingsRef.executionStallThresholdMinutes = clamped;
  }

  if (workflowDisabledGlobally !== undefined) {
    await prisma.userSettings
      .update({
        where: { id: settingsId },
        data: { workflowDisabledGlobally } as unknown as Parameters<
          typeof prisma.userSettings.update
        >[0]['data'],
      })
      .catch((err) => log.warn({ err }, 'workflowDisabledGlobally persist failed'));
    settingsRef.workflowDisabledGlobally = workflowDisabledGlobally;
  }

  // Idle-stop timer (task 784): clamp to 0..1440 minutes (24h); 0 disables it.
  if (idleStopMinutes !== undefined) {
    const clamped = Math.max(0, Math.min(MAX_IDLE_STOP_MINUTES, Math.floor(idleStopMinutes)));
    await prisma.userSettings
      .update({
        where: { id: settingsId },
        data: { idleStopMinutes: clamped } as unknown as Parameters<
          typeof prisma.userSettings.update
        >[0]['data'],
      })
      .catch((err) => log.warn({ err }, 'idleStopMinutes persist failed'));
    settingsRef.idleStopMinutes = clamped;
  }

  // Nightly self-refill window (task 784): '' disables it. An invalid "HH:MM"
  // is REJECTED (write skipped, warning logged) rather than silently
  // defaulted — a bad value must never land in the row.
  if (selfRefillWindowStart !== undefined) {
    if (selfRefillWindowStart !== '' && !SELF_REFILL_WINDOW_RE.test(selfRefillWindowStart)) {
      log.warn(
        { selfRefillWindowStart },
        'selfRefillWindowStart rejected — not "" or a valid "HH:MM"; write skipped',
      );
    } else {
      await prisma.userSettings
        .update({
          where: { id: settingsId },
          data: { selfRefillWindowStart } as unknown as Parameters<
            typeof prisma.userSettings.update
          >[0]['data'],
        })
        .catch((err) => log.warn({ err }, 'selfRefillWindowStart persist failed'));
      settingsRef.selfRefillWindowStart = selfRefillWindowStart;
    }
  }
}

/**
 * Persist the file-backed autoRestartOnMergedCode toggle (no Prisma column —
 * the value lives in RAPITAS_DATA_DIR) and mirror the effective value onto
 * `settingsRef` so GET/PATCH responses always carry the field.
 *
 * @param body - PATCH body (field written only when defined) / PATCHボディ
 * @param settingsRef - Response object to mirror the value onto / 反映先レスポンスオブジェクト
 */
export function applyAutoRestartOnMergedCode(
  body: UserSettingsUpdateBody,
  settingsRef: Record<string, unknown>,
): void {
  if (body.autoRestartOnMergedCode !== undefined) {
    writeAutoRestartEnabled(body.autoRestartOnMergedCode);
  }
  settingsRef.autoRestartOnMergedCode = readAutoRestartEnabled();
}

/**
 * Persist the file-backed retroReviewEnabled toggle (no Prisma column — the
 * value lives in RAPITAS_DATA_DIR, default ON) and mirror the effective value
 * onto `settingsRef` so GET/PATCH responses always carry the field.
 *
 * @param body - PATCH body (field written only when defined) / PATCHボディ
 * @param settingsRef - Response object to mirror the value onto / 反映先レスポンスオブジェクト
 */
export function applyRetroReviewEnabled(
  body: UserSettingsUpdateBody,
  settingsRef: Record<string, unknown>,
): void {
  if (body.retroReviewEnabled !== undefined) {
    writeRetroReviewEnabled(body.retroReviewEnabled);
  }
  settingsRef.retroReviewEnabled = readRetroReviewEnabled();
}

/**
 * Persist the file-backed mergeBarrierEnabled toggle (no Prisma column — the
 * value lives in RAPITAS_DATA_DIR, default OFF; task 573 C) and mirror the
 * effective value onto `settingsRef` so GET/PATCH responses always carry the
 * field.
 *
 * @param body - PATCH body (field written only when defined) / PATCHボディ
 * @param settingsRef - Response object to mirror the value onto / 反映先レスポンスオブジェクト
 */
export function applyMergeBarrierEnabled(
  body: UserSettingsUpdateBody,
  settingsRef: Record<string, unknown>,
): void {
  if (body.mergeBarrierEnabled !== undefined) {
    writeMergeBarrierEnabled(body.mergeBarrierEnabled);
  }
  settingsRef.mergeBarrierEnabled = readMergeBarrierEnabled();
}

/**
 * Persist the file-backed UI locale (no Prisma column — the value lives in
 * RAPITAS_DATA_DIR) that every agent prompt reads its output language from,
 * and mirror the effective value onto `settingsRef`.
 *
 * @param body - PATCH body (field written only when a supported locale) / PATCHボディ
 * @param settingsRef - Response object to mirror the value onto / 反映先レスポンスオブジェクト
 */
export function applyUiLocale(
  body: UserSettingsUpdateBody,
  settingsRef: Record<string, unknown>,
): void {
  const language = asPromptLanguage(body.uiLocale);
  if (language) {
    writePromptLanguage(language);
  }
  settingsRef.uiLocale = readPromptLanguage();
}
