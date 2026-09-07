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
 * Read a candidate's comparison record. An `in_progress` record (left behind
 * by a run interrupted before completion, e.g. a server restart) is treated
 * as absent — partial shadow-run data must never be surfaced as a result.
 *
 * @param promptEvolutionId - Candidate id. / 候補ID
 * @returns The completed record, or null when none/incomplete/corrupt. / 完了済み記録 or null
 */
export function readComparisonRecord(promptEvolutionId: number): ComparisonRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordFile(promptEvolutionId), 'utf8'));
    if (!isComparisonRecord(parsed)) return null;
    return parsed.status === 'in_progress' ? null : parsed;
  } catch {
    return null;
  }
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
    writeFileSync(file, JSON.stringify(record, null, 2));
    return true;
  } catch {
    return false;
  }
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

/**
 * Create the empty record a candidate needs before its limited trial starts.
 * Written `done` (not `in_progress`) because a live trial accumulates one run
 * at a time and each intermediate state is a legitimate, readable result —
 * unlike a shadow run, where a partial record means a crashed batch.
 *
 * Existing records are left untouched so a re-staged candidate keeps the runs
 * it already collected.
 *
 * @param seed - Identity of the candidate entering the trial. / 試行開始する候補の識別情報
 * @returns The record now on disk, or null when the write failed. / 保存済み記録 or null
 */
export function initComparisonRecordForStaging(seed: {
  promptEvolutionId: number;
  role: string;
  modelName?: string | null;
  budgetUsd?: number | null;
  createdAt: string;
}): ComparisonRecord | null {
  const existing = readComparisonRecord(seed.promptEvolutionId);
  if (existing) return existing;
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
  return writeComparisonRecord(record) ? record : null;
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
export function recordComparisonRun(
  promptEvolutionId: number,
  arm: ComparisonArm,
  run: ComparisonRun,
): boolean {
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
    cell.runs.some((r) => r.executionId === run.executionId),
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
