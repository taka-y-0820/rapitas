#!/usr/bin/env bun
/**
 * StubAgentCli
 *
 * The child process the eval harness runs INSTEAD of a real coding CLI. Each
 * fault scenario is reproduced here — as a real process that really exits,
 * really gets signalled, and really writes to a real worktree — so the
 * orchestrator under test sees the same process-level symptoms it would see in
 * production, deterministically.
 *
 * It never calls a model and never costs anything.
 *
 * Usage: bun run services/eval-harness/stub-agent-cli.ts --fault <scenario> --cwd <dir>
 */
import { writeFileSync } from 'fs';
import { join } from 'path';

/** Every fault the harness can inject, plus the no-fault control. */
export const FAULT_SCENARIOS = [
  'baseline',
  'cli_exit_after_stop',
  'stop_during_verification',
  'db_write_failure',
  'duplicate_callback',
  'response_lost_after_pr',
  'ci_failure',
  'process_restart',
] as const;

export type FaultScenario = (typeof FAULT_SCENARIOS)[number];

/** The seven scenarios that actually inject a fault (excludes `baseline`). */
export const INJECTED_FAULT_SCENARIOS = FAULT_SCENARIOS.filter(
  (s): s is Exclude<FaultScenario, 'baseline'> => s !== 'baseline',
);

/** File the stub writes so the harness has a non-empty, deterministic diff. */
export const STUB_MARKER_FILE = 'EVAL_STUB_MARKER.md';

/** Exit code the stub uses when it dies before producing any output. */
export const EXIT_CODE_EARLY_DEATH = 1;

/** Parsed stub arguments. */
export interface StubCliArgs {
  fault: FaultScenario;
  cwd: string;
  /** Milliseconds the stub idles before finishing, so a stop can land mid-run. */
  holdMs: number;
}

/**
 * Parses stub CLI arguments.
 *
 * @param argv - Argument list without the runtime/script entries / ランタイム・スクリプトを除いた引数列
 * @returns Parsed arguments with defaults applied / 既定値適用済みの引数
 * @throws {Error} When --fault names an unknown scenario / 未知のシナリオが指定された場合
 */
export function parseStubArgs(argv: string[]): StubCliArgs {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const fault = (get('--fault') ?? 'baseline') as FaultScenario;
  if (!FAULT_SCENARIOS.includes(fault)) {
    throw new Error(`Unknown --fault "${fault}". Expected one of: ${FAULT_SCENARIOS.join(', ')}`);
  }

  return {
    fault,
    cwd: get('--cwd') ?? process.cwd(),
    holdMs: Number.parseInt(get('--hold-ms') ?? '0', 10) || 0,
  };
}

/** How the stub is expected to terminate, per scenario. */
export interface StubTermination {
  /** Process exit code the harness should observe. */
  exitCode: number;
  /** Whether the stub writes the marker file before terminating. */
  writesMarker: boolean;
  /** Whether the stub emits any stdout before terminating. */
  emitsOutput: boolean;
}

/**
 * Describes how a scenario terminates, so the runner and the tests agree on
 * the expectation without re-running the process.
 *
 * @param fault - Scenario to describe / 対象シナリオ
 * @returns The expected termination shape / 期待される終了形態
 */
export function expectedTermination(fault: FaultScenario): StubTermination {
  // The CLI dies the instant it is asked to stop, before flushing anything —
  // the case where the orchestrator has a "started" record and no output.
  if (fault === 'cli_exit_after_stop') {
    return { exitCode: EXIT_CODE_EARLY_DEATH, writesMarker: false, emitsOutput: false };
  }
  // Killed by the runner partway through; the runner observes the signal, so
  // the code the stub would have returned is never used.
  if (fault === 'stop_during_verification' || fault === 'process_restart') {
    return { exitCode: 0, writesMarker: true, emitsOutput: true };
  }
  // Everything else completes normally at the process level; the fault is
  // injected around it (DB layer, callback layer, PR/CI layer).
  return { exitCode: 0, writesMarker: true, emitsOutput: true };
}

/**
 * Builds the JSON result line the stub prints on a normal finish.
 *
 * @param fault - Scenario being executed / 実行中のシナリオ
 * @returns A single-line JSON payload / 1行のJSONペイロード
 */
export function buildResultLine(fault: FaultScenario): string {
  return JSON.stringify({
    type: 'eval_stub_result',
    fault,
    success: true,
    filesChanged: [STUB_MARKER_FILE],
  });
}

/**
 * Runs the stub body for a scenario.
 *
 * @param args - Parsed arguments / 解析済みの引数
 * @returns The exit code the process should use / プロセスが使用すべき終了コード
 */
export async function runStub(args: StubCliArgs): Promise<number> {
  if (args.fault === 'cli_exit_after_stop') {
    // NOTE: No stdout at all, on purpose. A stub that printed first would let a
    // buggy orchestrator recover from the output instead of from the exit code,
    // which is exactly the failure mode this scenario exists to expose.
    return EXIT_CODE_EARLY_DEATH;
  }

  writeFileSync(
    join(args.cwd, STUB_MARKER_FILE),
    `# Eval stub marker\n\nscenario: ${args.fault}\n`,
    'utf8',
  );
  process.stdout.write(`${buildResultLine(args.fault)}\n`);

  if (args.holdMs > 0) {
    // Stay alive so `stop_during_verification` / `process_restart` have a
    // window in which to signal a genuinely running process.
    await new Promise((resolve) => setTimeout(resolve, args.holdMs));
  }

  return 0;
}

// Entry point — only when executed directly, so importing for tests is free of
// side effects.
if (import.meta.main) {
  runStub(parseStubArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      // process.stderr, not console: this module lives under services/, where
      // console statements are lint errors, but a stub that dies silently would
      // be indistinguishable from the fault it is meant to simulate.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[eval-stub] ${message}\n`);
      process.exit(EXIT_CODE_EARLY_DEATH);
    });
}
