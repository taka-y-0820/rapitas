/**
 * Phase Critic Eval Results Snapshot
 *
 * Persists the outcome of `scripts/eval-phase-critic.ts` (the opt-in, live-LLM
 * research/plan critic comparison eval — task 911) to a single JSON snapshot,
 * mirroring the RAPITAS_DATA_DIR + never-throw conventions of
 * eval-judge-results.ts. The eval only runs when RAPITAS_EVAL_PHASE_CRITIC=1
 * is set, so this file is written locally/manually and read by the metrics UI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Per-fixture outcome recorded by a single eval run. */
export interface PhaseCriticEvalCaseResult {
  /** Fixture name (from scripts/eval-phase-critic.ts FIXTURES) / フィクスチャ名 */
  name: string;
  /**
   * Verdict the fixture was labelled with / 期待される判定. 'unknown' covers
   * a forced-truncation fixture whose content would satisfy every criterion —
   * the truncated&&pass→unknown safety rule (phase-critic.ts) makes 'pass'
   * unreachable there by design, so 'unknown' is the correct expectation.
   */
  expectedVerdict: 'pass' | 'fail' | 'unknown';
  /** Verdict the critic actually returned / 実際の判定 */
  gotVerdict: 'pass' | 'fail' | 'unknown';
  /** Whether gotVerdict === expectedVerdict / 一致したか */
  ok: boolean;
  /** Highest lens severity reported / 最大深刻度 */
  severity: number;
  /** Whether the critic's input was head+tail truncated for this fixture / 入力が切断されたか */
  inputTruncated: boolean;
  /** Whether every lens returned a verdict (missing on historical snapshots). */
  evaluationComplete?: boolean;
  /** Configured model requested, which may differ from the CLI's reported model. */
  requestedModel?: string;
  /** Exact assembled user input identity for reproducing this evaluation. */
  inputChars?: number;
  inputSha256?: string;
  /** Milliseconds the critique call took / 所要時間 */
  elapsedMs: number;
}

/** One full phase-critic-eval run, persisted as the latest snapshot. */
export interface PhaseCriticEvalResult {
  /** ISO timestamp the run completed / 実行完了時刻 */
  timestamp: string;
  /** AI provider judged with / 使用したプロバイダ */
  provider: string;
  /** Per-fixture breakdown / フィクスチャ毎の結果 */
  cases: PhaseCriticEvalCaseResult[];
  /** Share of the narrow (true-defect) fixtures correctly failed / 未達検出率 */
  detectionRate: number;
  /** Share of the adequate/control fixtures incorrectly failed / 誤差し戻し率 */
  falseBounceRate: number;
}

/** Directory holding the daily logs (shares RAPITAS_DATA_DIR with the central logger). */
function getLogsDir(): string {
  const override = process.env.RAPITAS_DATA_DIR;
  const base = override && override.trim().length > 0 ? override : join(homedir(), '.rapitas');
  return join(base, 'logs');
}

/**
 * Absolute path of the latest phase-critic-eval snapshot file.
 *
 * @returns Snapshot JSON path / スナップショットファイルのパス
 */
export function getPhaseCriticEvalResultPath(): string {
  return join(getLogsDir(), 'eval-phase-critic-latest.json');
}

/**
 * Overwrites the latest phase-critic-eval snapshot with a new run's result.
 * Never throws — a failed write must not fail the eval script itself.
 *
 * @param result - The completed run's result / 完了した実行結果
 */
export function writePhaseCriticEvalResult(result: PhaseCriticEvalResult): void {
  try {
    mkdirSync(getLogsDir(), { recursive: true });
    writeFileSync(getPhaseCriticEvalResultPath(), JSON.stringify(result, null, 2), 'utf-8');
  } catch {
    // Observability must never crash the eval it observes.
  }
}

/**
 * Reads the latest phase-critic-eval snapshot. Never throws; returns null
 * when the eval has never run (file missing) or the file is unreadable/corrupt.
 *
 * @returns The latest run's result, or null / 直近の実行結果、なければnull
 */
export function readPhaseCriticEvalResult(): PhaseCriticEvalResult | null {
  try {
    const p = getPhaseCriticEvalResultPath();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as PhaseCriticEvalResult;
  } catch {
    return null;
  }
}
