/**
 * PromptComparisonStore
 *
 * File-backed persistence for prompt comparison records, one JSON file per
 * PromptEvolution candidate (~/.rapitas/.prompt-comparisons/<id>.json) —
 * schema changes are prohibited (CLAUDE.md §1), same mechanism as
 * experiment-store.ts. A `<file>.lock` marker rejects a concurrent comparison
 * run for the SAME candidate while different candidates write to different
 * files and never contend. An `in_progress` record left over from a crashed
 * run is discarded rather than trusted (partial shadow-run data would skew
 * the verdict).
 *
 * Also the append point for LIVE trial runs (recordComparisonRun): a staged
 * candidate is measured on real workflow phases rather than a dedicated
 * shadow-run batch, so runs arrive one at a time and the summary is
 * recomputed on each append.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createLogger } from '../../../config/logger';
import { withAlphaLedgerLock, writeAlphaLedger } from './prompt-comparison-alpha-storage';
import { readTrialManifest } from './prompt-comparison-trial-manifest';
import { buildComparisonSummary } from './prompt-comparison-metrics';
import type { ComparisonArm, ComparisonRecord, ComparisonRun } from './prompt-comparison-types';

const log = createLogger('self-learning:prompt-comparison-store');

function dataDir(): string {
  const base = process.env.RAPITAS_DATA_DIR?.trim() || join(homedir(), '.rapitas');
  return join(base, '.prompt-comparisons');
}

function recordFile(promptEvolutionId: number): string {
  return join(dataDir(), `${promptEvolutionId}.json`);
}

function lockFile(promptEvolutionId: number): string {
  return `${recordFile(promptEvolutionId)}.lock`;
}

/** Minimal shape check so a hand-edited/corrupt file degrades to null. */
function isComparisonRecord(value: unknown): value is ComparisonRecord {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<ComparisonRecord>;
  return (
    typeof v.promptEvolutionId === 'number' &&
    typeof v.role === 'string' &&
    typeof v.modelName === 'string' &&
    typeof v.status === 'string' &&
    Array.isArray(v.sampleTaskIds) &&
    Array.isArray(v.arms)
  );
}

/**
 * Short checksum identifying WHICH addendum text was injected. Recorded on
 * both the assignment and the run so a comparison result can be traced back
 * to the exact version the agent actually ran under, rather than to whatever
 * the candidate row happens to say later.
 *
 * @param text - Addendum text as injected. / 注入した追記文
 * @returns 12-hex-char sha256 prefix. / 版の識別子
 */
export function addendumVersionHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Why a comparison record could not be used, or the record itself.
 *
 * `readComparisonRecord` collapses every one of these into `null`, which is
 * enough for "can I use this record?" but not for "may I overwrite it?" —
 * a missing file and a corrupt file demand opposite actions, and treating
 * both as "absent" let staging silently destroy measured evidence.
 */
export type ComparisonReadStatus =
  | { kind: 'ok'; record: ComparisonRecord }
  | { kind: 'not_found' }
  | { kind: 'in_progress'; record: ComparisonRecord }
  | { kind: 'corrupted' }
  | { kind: 'io_error'; error: unknown };

/**
 * Read a candidate's comparison record, reporting WHY it is unusable when it
 * is. Callers that only need "a usable record or nothing" should keep using
 * readComparisonRecord; callers that may WRITE must use this, so they can tell
 * "nothing to lose" (`not_found`) from "evidence I must not clobber"
 * (`corrupted` / `in_progress` / `io_error`).
 *
 * @param promptEvolutionId - Candidate id. / 候補ID
 * @returns The record, or the reason it cannot be used. / 記録、または使用不可の理由
 */
export function readComparisonRecordStatus(promptEvolutionId: number): ComparisonReadStatus {
  let raw: string;
  try {
    raw = readFileSync(recordFile(promptEvolutionId), 'utf8');
  } catch (error) {
    // ENOENT is the only "there is genuinely nothing here" case. Every other
    // fs failure (EACCES, EISDIR, EBUSY, ...) means a file may well exist and
    // we simply could not read it.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' ? { kind: 'not_found' } : { kind: 'io_error', error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupted' };
  }
  if (!isComparisonRecord(parsed)) return { kind: 'corrupted' };
  return parsed.status === 'in_progress'
    ? { kind: 'in_progress', record: parsed }
    : { kind: 'ok', record: parsed };
}

/**
 * Read a candidate's comparison record. An `in_progress` record (left behind
 * by a run interrupted before completion, e.g. a server restart) is treated
 * as absent — partial shadow-run data must never be surfaced as a result.
 *
 * @param promptEvolutionId - Candidate id. / 候補ID
 * @returns The completed record, or null when none/incomplete/corrupt. / 完了済み記録 or null
 */
export function readComparisonRecord(promptEvolutionId: number): ComparisonRecord | null {
  const status = readComparisonRecordStatus(promptEvolutionId);
  return status.kind === 'ok' ? status.record : null;
}

/**
 * Persist a candidate's comparison record (create or overwrite).
 *
 * @param record - Comparison record to persist. / 保存する比較記録
 * @returns True when the write succeeded. / 書込成功なら true
 */
export function writeComparisonRecord(record: ComparisonRecord): boolean {
  try {
    const file = recordFile(record.promptEvolutionId);
    mkdirSync(dirname(file), { recursive: true });
    return writeAlphaLedger(file, record);
  } catch {
    return false;
  }
}

/** Change only rollout scope under the same lock as measured outcome appends. */
export function updateComparisonScope(
  id: number,
  expected: ComparisonRecord['stagedTaskIds'],
  next: ComparisonRecord['stagedTaskIds'],
): boolean {
  return (
    withAlphaLedgerLock(recordFile(id), () => {
      const current = readComparisonRecord(id);
      if (!current || JSON.stringify(current.stagedTaskIds) !== JSON.stringify(expected))
        return false;
      return writeComparisonRecord({ ...current, stagedTaskIds: next });
    }) === true
  );
}

/**
 * Acquire the per-candidate comparison lock. Fails (returns false) when a
 * comparison run for the SAME candidate is already in progress — different
 * candidates use different lock files and never contend.
 *
 * @param promptEvolutionId - Candidate id. / 候補ID
 * @returns True when the lock was acquired. / ロック取得に成功したら true
 */
export function acquireComparisonLock(promptEvolutionId: number): boolean {
  const file = lockFile(promptEvolutionId);
  try {
    if (existsSync(file)) return false;
    mkdirSync(dirname(file), { recursive: true });
    // 'wx' fails atomically if the file already exists — closes the
    // check-then-write race between the existsSync check above and this write.
    writeFileSync(file, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the per-candidate comparison lock. Safe to call even when the lock
 * was never acquired (no-op on a missing file).
 *
 * @param promptEvolutionId - Candidate id. / 候補ID
 */
export function releaseComparisonLock(promptEvolutionId: number): void {
  try {
    unlinkSync(lockFile(promptEvolutionId));
  } catch {
    // Absent file = already released; never throw into a caller.
  }
}

/** Why staging could not initialize a record, or null when it succeeded. */
export type ComparisonInitIssue = 'corrupted' | 'io_error' | 'in_progress' | 'write_failed';

/** Outcome of preparing a candidate's comparison record for a limited trial. */
export interface ComparisonInitResult {
  /** The usable record, or null when one could not be established. */
  record: ComparisonRecord | null;
  /** Non-null when the caller must hold the candidate back instead of staging it. */
  issue: ComparisonInitIssue | null;
}

/**
 * Establish the comparison record a candidate needs before its limited trial
 * starts. Written `done` (not `in_progress`) because a live trial accumulates
 * one run at a time and each intermediate state is a legitimate, readable
 * result — unlike a shadow run, where a partial record means a crashed batch.
 *
 * A new record is written ONLY when the file genuinely does not exist. A
 * corrupt, unreadable or in-progress file is reported through `issue` and left
 * exactly as it is: those states may hold real measured runs, and "could not
 * read it" is not evidence that there is nothing to lose. The previous version
 * routed all three through `readComparisonRecord`'s null and overwrote them
 * with an empty record, silently destroying the evidence the trial exists to
 * collect.
 *
 * @param seed - Identity of the candidate entering the trial. / 試行開始する候補の識別情報
 * @returns The usable record, or the reason staging must be held back. / 記録、または保留理由
 */
function initializeComparisonRecord(seed: {
  promptEvolutionId: number;
  role: string;
  modelName?: string | null;
  budgetUsd?: number | null;
  createdAt: string;
}): ComparisonInitResult {
  const status = readComparisonRecordStatus(seed.promptEvolutionId);
  if (status.kind === 'ok') return { record: status.record, issue: null };
  if (status.kind !== 'not_found') {
    log.warn(
      { promptEvolutionId: seed.promptEvolutionId, kind: status.kind },
      '[prompt-comparison] Existing comparison record is unusable — preserved, staging held back',
    );
    return { record: null, issue: status.kind };
  }

  const record: ComparisonRecord = {
    promptEvolutionId: seed.promptEvolutionId,
    role: seed.role,
    modelName: seed.modelName ?? '',
    budgetUsd: seed.budgetUsd ?? 0,
    createdAt: seed.createdAt,
    status: 'done',
    sampleTaskIds: [],
    arms: [],
    summary: null,
    knowledgeSnapshotHash: null,
    // The trial's scope is built up from the tasks that actually receive the
    // candidate arm, so it starts empty rather than null (null = role-wide).
    stagedTaskIds: [],
  };
  return writeComparisonRecord(record)
    ? { record, issue: null }
    : { record: null, issue: 'write_failed' };
}

/**
 * Append one live trial run to a candidate's comparison record and recompute
 * the summary. Best-effort: a failure here costs one sample, never the phase.
 *
 * A `candidate`-arm run whose `injected` flag is false is REFUSED — the arm
 * assignment alone does not prove the intervention reached the prompt, and
 * counting such a run would let a candidate be judged on runs it never
 * influenced. A run whose executionId is already recorded is likewise refused,
 * so a provider-fallback retry of the same phase cannot double-count.
 *
 * @param promptEvolutionId - Candidate under trial. / 試行中の候補ID
 * @param arm - Arm the phase ran under. / 実行したアーム
 * @param run - The completed run. / 完了した実行
 * @returns True when the run was appended and persisted. / 追記・保存できたら true
 */
function appendComparisonRun(
  promptEvolutionId: number,
  arm: ComparisonArm,
  run: ComparisonRun,
): boolean {
  const manifest = readTrialManifest(promptEvolutionId);
  if (manifest || run.assignmentId) {
    const slot = manifest?.slots.find((s) => s.id === run.assignmentId);
    if (
      !slot ||
      slot.taskId !== run.taskId ||
      slot.arm !== arm ||
      run.controlVersion !== manifest?.controlVersion
    )
      return false;
  }
  if (arm === 'candidate' && run.injected !== true) {
    log.warn(
      { promptEvolutionId, executionId: run.executionId },
      '[prompt-comparison] Refused a candidate-arm run with no confirmed injection',
    );
    return false;
  }
  const record = readComparisonRecord(promptEvolutionId);
  if (!record) {
    log.warn(
      { promptEvolutionId },
      '[prompt-comparison] No comparison record to append to — run dropped',
    );
    return false;
  }
  const already = record.arms.some((cell) =>
    cell.runs.some(
      (r) =>
        r.executionId === run.executionId ||
        (!!run.assignmentId && r.assignmentId === run.assignmentId),
    ),
  );
  if (already) return false;

  // Only the `with`-knowledge cells feed buildComparisonSummary; live trial
  // runs always carry the shared-knowledge injection the product ships with,
  // so the `without` cells stay empty by design.
  let cell = record.arms.find((c) => c.arm === arm && c.knowledge === 'with');
  if (!cell) {
    cell = { arm, knowledge: 'with', runs: [] };
    record.arms.push(cell);
  }
  cell.runs.push(run);

  if (!record.sampleTaskIds.includes(run.taskId)) record.sampleTaskIds.push(run.taskId);
  if (arm === 'candidate' && record.stagedTaskIds && !record.stagedTaskIds.includes(run.taskId)) {
    record.stagedTaskIds.push(run.taskId);
  }
  record.summary = buildComparisonSummary(record.arms);
  return writeComparisonRecord(record);
}

/** Serialize all live outcome appends; a retry can never overwrite another result. */
export function recordComparisonRun(id: number, arm: ComparisonArm, run: ComparisonRun): boolean {
  return withAlphaLedgerLock(recordFile(id), () => appendComparisonRun(id, arm, run)) === true;
}

/** Serialize first creation with appends and scope changes, preserving existing evidence. */
export function initComparisonRecordForStaging(
  seed: Parameters<typeof initializeComparisonRecord>[0],
): ComparisonInitResult {
  const result = withAlphaLedgerLock(recordFile(seed.promptEvolutionId), () =>
    initializeComparisonRecord(seed),
  );
  return 'record' in result ? result : { record: null, issue: result.issue };
}
