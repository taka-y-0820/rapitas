/**
 * ExperimentStore
 *
 * File-backed persistence for the single active experiment plus an append-only
 * terminal history. Lives in RAPITAS_DATA_DIR (default ~/.rapitas) because
 * schema changes are prohibited — same mechanism as retro-settings-store. All
 * operations are best-effort: a failed read degrades to "no experiment", a
 * failed write never crashes a request or the completion path. The active
 * file's existence IS the "at most one concurrent experiment" invariant.
 */
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type {
  ActiveExperiment,
  ExperimentHistoryEntry,
  ExperimentMetrics,
  ExperimentOutcome,
} from './experiment-types';

function dataDir(): string {
  return process.env.RAPITAS_DATA_DIR?.trim() || join(homedir(), '.rapitas');
}

function activeFile(): string {
  return join(dataDir(), '.experiment-active.json');
}

function historyFile(): string {
  return join(dataDir(), '.experiment-history.jsonl');
}

/** Minimal shape check so a hand-edited/corrupt file degrades to null. */
function isActiveExperiment(value: unknown): value is ActiveExperiment {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<ActiveExperiment>;
  return (
    typeof v.id === 'string' &&
    typeof v.hypothesisId === 'number' &&
    typeof v.role === 'string' &&
    typeof v.addendum === 'string' &&
    typeof v.targetN === 'number' &&
    v.status === 'running' &&
    Array.isArray(v.treatmentTaskIds) &&
    v.controlMetrics !== null &&
    typeof v.controlMetrics === 'object'
  );
}

/**
 * Read the active experiment, or null when none is running (absent, unreadable
 * or malformed file all degrade to null — fail-open).
 *
 * @returns The active experiment or null. / アクティブ実験 or null
 */
export function readActiveExperiment(): ActiveExperiment | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(activeFile(), 'utf8'));
    return isActiveExperiment(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist the active experiment (create or overwrite).
 *
 * @param experiment - Experiment state to persist. / 保存する実験状態
 * @returns True when the write succeeded. / 書込成功なら true
 */
export function writeActiveExperiment(experiment: ActiveExperiment): boolean {
  try {
    const file = activeFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(experiment, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the active experiment file. From the next task on, the intervention
 * addendum is no longer injected — this IS the rollback mechanism (the
 * intervention never reaches PromptEvolution status 'approved').
 */
export function clearActiveExperiment(): void {
  try {
    unlinkSync(activeFile());
  } catch {
    // Absent file = already cleared; never throw into a caller.
  }
}

/**
 * Append a terminal experiment record to the history JSONL (observability).
 *
 * @param experiment - The experiment as it ended. / 終了時点の実験
 * @param outcome - Terminal outcome. / 終端結果
 * @param treatmentMetrics - Treatment metrics at judgement (null if aborted). / 実験窓指標
 */
export function appendExperimentHistory(
  experiment: ActiveExperiment,
  outcome: ExperimentOutcome,
  treatmentMetrics: ExperimentMetrics | null,
): void {
  try {
    const entry: ExperimentHistoryEntry = {
      experiment,
      outcome,
      treatmentMetrics,
      endedAt: new Date().toISOString(),
    };
    const file = historyFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // History is observability only — losing a line must not fail the loop.
  }
}

/**
 * List terminal experiment records, newest first (best-effort; empty on any
 * read failure). Malformed lines are skipped.
 *
 * @param limit - Max records to return. / 取得上限
 * @returns History entries, newest first. / 履歴(新しい順)
 */
export function listExperimentHistory(limit = 50): ExperimentHistoryEntry[] {
  try {
    const lines = readFileSync(historyFile(), 'utf8').split('\n');
    const entries: ExperimentHistoryEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ExperimentHistoryEntry;
        if (parsed && typeof parsed === 'object' && parsed.experiment) entries.push(parsed);
      } catch {
        continue;
      }
    }
    return entries.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * The intervention addendum to inject into a role's prompt, or null when no
 * experiment is running or the role does not match. Async signature so the
 * orchestrator call site can treat it like the approved-addendum fetch.
 *
 * @param role - Workflow role about to run. / 実行直前のロール
 * @returns Addendum text or null. / 介入文 or null
 */
export async function getActiveExperimentAddendum(role: string): Promise<string | null> {
  return (await getActiveExperimentInjection(role))?.addendum ?? null;
}

/** An active experiment's intervention text together with the experiment it belongs to. */
export interface ExperimentInjection {
  /** Active experiment id (`exp_<hypothesisId>_<startedAtEpoch>`). */
  experimentId: string;
  /** Hypothesis under test. */
  hypothesisId: number;
  /** Intervention text to append to the role prompt. */
  addendum: string;
}

/**
 * Same selection as getActiveExperimentAddendum, but also reports WHICH
 * experiment the text belongs to.
 *
 * The orchestrator logs the injection from this, so the experiment path leaves
 * the same audit trail as the prompt-evolution paths — which candidate, which
 * version, which task. Recording only taskId/role left no way to tell what a
 * given run actually saw. Kept as a separate reader so this module stays
 * dependency-free (no logger import), same policy as experiment-types.ts.
 *
 * @param role - Workflow role about to run. / 実行直前のロール
 * @returns Injection detail or null. / 注入情報 or null
 */
export async function getActiveExperimentInjection(
  role: string,
): Promise<ExperimentInjection | null> {
  const experiment = readActiveExperiment();
  if (!experiment || experiment.role !== role) return null;
  const addendum = experiment.addendum.trim();
  if (!addendum) return null;
  return { experimentId: experiment.id, hypothesisId: experiment.hypothesisId, addendum };
}
