/**
 * PromptComparisonAlphaLedger
 *
 * Pre-registered error budget for unattended prompt adoption. One JSON file
 * (`<RAPITAS_DATA_DIR>/.prompt-comparisons/_alpha-ledger.json`) records, per
 * candidate, the order it entered a trial (`k`), how many looks it has spent
 * (`j`), and the sample size at the last look.
 *
 * Each candidate k and evaluation j receives TOTAL_ALPHA/[k(k+1)j(j+1)].
 * The series bounds total allocated budget. Valid inference additionally needs
 * predeclared sample checkpoints (or an anytime-valid test); allocation alone
 * does not make data-dependent monitoring valid. The supervisor's 0.116 figure
 * was an exact single-look null probability for the former descriptive gate,
 * not a measured repeated-look error rate.
 *
 * Not responsible for the test itself (prompt-comparison-adoption-gate) nor
 * for the comparison runs (prompt-comparison-store).
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { withAlphaLedgerLock, writeAlphaLedger } from './prompt-comparison-alpha-storage';

/** Family-wise false-adoption budget shared by every candidate, ever. */
export const TOTAL_ALPHA = 0.05;

/** One candidate's permanent place in the budget series. */
interface LedgerEntry {
  /** Registration order, 1-based. Assigned once, never re-assigned. */
  k: number;
  /** Looks spent so far. 0 until the first evaluation with real samples. */
  lastLookJ: number;
  /** Sample size at the last look — a re-read of the same samples is free. */
  lastLookSampleSize: number;
}

interface LedgerFile {
  nextK: number;
  entries: Record<string, LedgerEntry>;
}

/** Why the ledger could not be used. Mirrors prompt-comparison-store's vocabulary. */
export type LedgerIssue = 'corrupted' | 'io_error' | 'write_failed' | 'not_registered';

/** Result of reserving a candidate's share of the budget. */
export interface CandidateBudget {
  k: number;
  alphaK: number;
  issue: null;
}

/** Result of reserving one look's share of a candidate's budget. */
export interface EvaluationBudget {
  /** False when this evaluation saw no new samples — no budget was spent. */
  isNewLook: boolean;
  j: number;
  alphaKj: number;
  issue: null;
}

/** Returned instead of a budget when the ledger is unusable. */
export interface LedgerFailure {
  issue: LedgerIssue;
}

function dataDir(): string {
  const base = process.env.RAPITAS_DATA_DIR?.trim() || join(homedir(), '.rapitas');
  return join(base, '.prompt-comparisons');
}

function ledgerFile(): string {
  return join(dataDir(), '_alpha-ledger.json');
}

/** Shape check so a hand-edited or truncated ledger is refused, not trusted. */
function isLedgerFile(value: unknown): value is LedgerFile {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<LedgerFile>;
  if (
    !Number.isSafeInteger(v.nextK) ||
    v.nextK! < 1 ||
    !v.entries ||
    typeof v.entries !== 'object' ||
    Array.isArray(v.entries)
  )
    return false;
  const indices = new Set<number>();
  for (const [id, entry] of Object.entries(v.entries)) {
    if (
      !/^[1-9]\d*$/.test(id) ||
      !Number.isSafeInteger(Number(id)) ||
      !entry ||
      typeof entry !== 'object' ||
      !Number.isSafeInteger(entry.k) ||
      entry.k < 1 ||
      entry.k >= v.nextK! ||
      !Number.isSafeInteger(entry.lastLookJ) ||
      entry.lastLookJ < 0 ||
      !Number.isSafeInteger(entry.lastLookSampleSize) ||
      entry.lastLookSampleSize < 0 ||
      (entry.lastLookJ === 0) !== (entry.lastLookSampleSize === 0) ||
      entry.lastLookJ > entry.lastLookSampleSize ||
      indices.has(entry.k)
    )
      return false;
    indices.add(entry.k);
  }
  // Entries are never deleted: gaps mean historical budget was lost.
  return indices.size === v.nextK! - 1;
}

type LedgerRead = { file: LedgerFile; issue: null } | { file: null; issue: LedgerIssue };

/**
 * Read the ledger, distinguishing "no ledger yet" from "a ledger exists but is
 * unusable". Only the former may be replaced with a fresh one — overwriting a
 * corrupt ledger would silently re-issue k values that other candidates
 * already hold, and re-spend budget that was already spent.
 */
function readLedger(): LedgerRead {
  const file = ledgerFile();
  if (!existsSync(file)) return { file: { nextK: 1, entries: {} }, issue: null };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { file: null, issue: 'io_error' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { file: null, issue: 'corrupted' };
  }
  if (!isLedgerFile(parsed)) return { file: null, issue: 'corrupted' };
  return { file: parsed, issue: null };
}

function writeLedger(ledger: LedgerFile): boolean {
  return writeAlphaLedger(ledgerFile(), ledger);
}

/**
 * Budget for the k-th registered candidate.
 *
 * @param k - Registration order, 1-based. / 登録順
 * @returns alpha_k. / 候補あたりの総予算
 */
export function alphaForCandidate(k: number): number {
  return Number.isSafeInteger(k) && k > 0 ? TOTAL_ALPHA / (k * (k + 1)) : 0;
}

/**
 * Budget for the j-th look at a candidate holding alpha_k.
 *
 * @param alphaK - The candidate's total budget. / 候補の総予算
 * @param j - Look number, 1-based. / 評価回
 * @returns alpha_kj. / この評価回の予算
 */
export function alphaForLook(alphaK: number, j: number): number {
  return Number.isFinite(alphaK) &&
    alphaK > 0 &&
    alphaK <= TOTAL_ALPHA &&
    Number.isSafeInteger(j) &&
    j > 0
    ? alphaK / (j * (j + 1))
    : 0;
}

/**
 * Reserve a candidate's permanent share of the global budget, or return the
 * share it already holds.
 *
 * Idempotent by design: a restart, a re-evaluation, or a second staging attempt
 * must not hand the same candidate a second (larger) budget, which would break
 * the telescoping bound. The k is assigned once, at first staging, and kept.
 *
 * @param promptEvolutionId - Candidate id. / 候補ID
 * @returns The candidate's k and alpha_k, or the reason the ledger is unusable. / 予算 or 失敗理由
 */
export function assignCandidateBudget(promptEvolutionId: number): CandidateBudget | LedgerFailure {
  return withAlphaLedgerLock<CandidateBudget | LedgerFailure>(ledgerFile(), () => {
    const read = readLedger();
    if (!read.file) return { issue: read.issue };

    const key = String(promptEvolutionId);
    const existing = read.file.entries[key];
    if (existing) return { k: existing.k, alphaK: alphaForCandidate(existing.k), issue: null };

    if (
      !Number.isSafeInteger(promptEvolutionId) ||
      promptEvolutionId <= 0 ||
      read.file.nextK >= Number.MAX_SAFE_INTEGER
    )
      return { issue: 'corrupted' as const };
    const k = read.file.nextK;
    read.file.entries[key] = { k, lastLookJ: 0, lastLookSampleSize: 0 };
    read.file.nextK = k + 1;
    if (!writeLedger(read.file)) return { issue: 'write_failed' };
    return { k, alphaK: alphaForCandidate(k), issue: null };
  });
}

/**
 * Reserve the next look's share of a candidate's budget — but only when this
 * evaluation actually has new samples to look at.
 *
 * Polling the same sample set (the daily job runs whether or not any phase ran)
 * must not consume budget, otherwise a candidate's alpha would drain to nothing
 * while it waits for traffic. The sample size at the previous look is stored
 * BEFORE the verdict is examined, so the decision to spend a look never depends
 * on whether the result looked favourable.
 *
 * @param promptEvolutionId - Candidate id. / 候補ID
 * @param currentSampleSize - Comparable samples available now. / 現在の有効標本数
 * @returns The look's budget, or the reason it could not be reserved. / 評価回の予算 or 失敗理由
 */
export function resolveEvaluationBudget(
  promptEvolutionId: number,
  currentSampleSize: number,
): EvaluationBudget | LedgerFailure {
  return withAlphaLedgerLock<EvaluationBudget | LedgerFailure>(ledgerFile(), () => {
    const read = readLedger();
    if (!read.file) return { issue: read.issue };

    if (!Number.isSafeInteger(currentSampleSize) || currentSampleSize < 0)
      return { issue: 'corrupted' as const };
    const key = String(promptEvolutionId);
    const entry = read.file.entries[key];
    // A candidate with no reserved k was never staged through this ledger; it
    // has no budget to spend and must not borrow one.
    if (!entry) return { issue: 'not_registered' };

    const alphaK = alphaForCandidate(entry.k);
    if (currentSampleSize <= entry.lastLookSampleSize) {
      return {
        isNewLook: false,
        j: entry.lastLookJ,
        alphaKj: alphaForLook(alphaK, Math.max(1, entry.lastLookJ)),
        issue: null,
      };
    }

    const j = entry.lastLookJ + 1;
    entry.lastLookJ = j;
    entry.lastLookSampleSize = currentSampleSize;
    if (!writeLedger(read.file)) return { issue: 'write_failed' };
    return { isNewLook: true, j, alphaKj: alphaForLook(alphaK, j), issue: null };
  });
}
