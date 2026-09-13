/**
 * QuietVerification
 *
 * Keeps the verification gate from monopolising the host CPU: the child
 * processes it spawns run at BELOW_NORMAL priority and the heavy checks run
 * one after another instead of all at once. Owns only those two knobs; what
 * the checks do stays in automated-verifier.ts / test-triage.ts.
 *
 * Why: the gate ran lint, tsc, `bun test --isolate` and prettier through one
 * Promise.all while the agent CLI and the Next dev server were already busy,
 * and the operator saw the machine peg on every verify (2026-08-30). On
 * Windows a child inherits BELOW_NORMAL / IDLE from its parent, so lowering
 * the shell wrapper is enough to cover tsc and the bun workers it starts.
 */
import type { ChildProcess, SpawnOptions } from 'child_process';
import { observeCommand } from './command-evidence';
import { LOW_PRIORITY, lowerProcessPriority, spawnLowPriority } from '../process-priority';

/** node:os priority for verification children (Windows BELOW_NORMAL_PRIORITY_CLASS). */
export const VERIFY_CHILD_PRIORITY = LOW_PRIORITY;

/** `RAPITAS_VERIFY_PARALLEL=1|on|true` restores the old all-at-once check fan-out. Default sequential. */
export function areVerificationChecksSequential(): boolean {
  const raw = (process.env.RAPITAS_VERIFY_PARALLEL ?? '').trim().toLowerCase();
  return !(raw === 'on' || raw === '1' || raw === 'true');
}

/**
 * Lower a freshly spawned verification child to BELOW_NORMAL priority
 * (`RAPITAS_VERIFY_QUIET=off` keeps normal priority).
 *
 * @param pid - Child process id from `spawn()`. / spawn した子プロセスの pid
 * @param setPriority - Override for tests. / テスト用差し替え
 * @returns true when the priority was applied. / 適用できたら true
 */
export function lowerVerificationPriority(
  pid: number | undefined,
  setPriority?: (pid: number, priority: number) => void,
): boolean {
  return lowerProcessPriority(pid, 'RAPITAS_VERIFY_QUIET', setPriority);
}

/**
 * `spawn()` for verification commands at BELOW_NORMAL priority.
 *
 * @param command - Shell command line. / 実行するコマンド
 * @param options - Passed to `spawn()` unchanged. / spawn オプション
 * @returns The child process. / 子プロセス
 */
export function spawnQuiet(command: string, options: SpawnOptions): ChildProcess {
  const child = spawnLowPriority(command, [], options, 'RAPITAS_VERIFY_QUIET');
  observeCommand(command, options, child);
  return child;
}

/**
 * Run the per-project checks either sequentially (default) or all at once.
 *
 * Sequential order is light → heavy: lint and prettier together (cheap),
 * then tsc, then tests, so the two CPU-bound steps never overlap.
 *
 * @param checks - Thunks in the order lint, type, test, format. / 4 チェックの thunk
 * @returns Results in the same order. / 同じ順の結果
 */
export async function runProjectChecks<L, T, S, F>(checks: {
  lint: () => Promise<L>;
  type: () => Promise<T>;
  test: () => Promise<S>;
  format: () => Promise<F>;
}): Promise<[L, T, S, F]> {
  if (!areVerificationChecksSequential()) {
    return Promise.all([checks.lint(), checks.type(), checks.test(), checks.format()]);
  }
  const [lint, format] = await Promise.all([checks.lint(), checks.format()]);
  const type = await checks.type();
  const test = await checks.test();
  return [lint, type, test, format];
}
