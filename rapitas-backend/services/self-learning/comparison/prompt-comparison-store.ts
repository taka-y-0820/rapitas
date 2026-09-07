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
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { ComparisonRecord } from './prompt-comparison-types';

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
