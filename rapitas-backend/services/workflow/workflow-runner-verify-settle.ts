/**
 * workflow-runner-verify-settle
 *
 * Bounded wait for a `verify_done` task's async commit/PR/merge completion to
 * settle, so the runner does not misreport a transient `verify_done` as a
 * failure. Extracted from workflow-runner.ts (file-size split); contains no
 * scheduling or dispatch logic.
 */
import { resolveTaskWorkflowState } from '../task/task-resolver';
import { hasVerifyCompletionInFlight } from './verify-completion-inflight';

/**
 * Landed-PR check + self-heal, loaded lazily so this timing-only module keeps
 * no static DB-writing dependency (runner tests mock `../../config` alone).
 * Any failure yields false — the caller then falls through to `stuck`.
 *
 * A fresh verify-phase rejection (adversarial-review FAIL, bounce,
 * non-convergence cutoff, failed PR creation) vetoes the landed-artifact
 * completion: the jury's verdict owns the task's next step, and a PR merely
 * existing on record must not overrule it (task 755 — jury FAIL immediately
 * followed by settle force-completing from PR #537). Mirrors the same guard
 * already used by the HTTP/CLI epilogue (workflow-cli-executor-verify-gate.ts).
 *
 * @param taskId - Task about to be judged stuck. / stuck 判定直前のタスクID
 * @returns True when the task was completed from landed evidence. / 実在確認で完了した場合 true
 */
async function recoverFromLandedArtifact(taskId: number): Promise<boolean> {
  try {
    const { hasFreshVerifyRejection } = await import('./verify-self-repair');
    if (await hasFreshVerifyRejection(taskId).catch(() => false)) return false;
    const { recoverFromLandedArtifact: recover } =
      await import('./verify-settle-artifact-recovery');
    return await recover(taskId);
  } catch {
    return false;
  }
}

// Grace window for a `verify_done` task's async commit/PR/merge completion to
// settle before the runner judges it failed — prevents a transient "blocked"
// flash in the UI while the task is actually completing (observed: verify_done →
// completed took ~20-30s). Override with RAPITAS_VERIFY_SETTLE_MS.
export const VERIFY_SETTLE_TIMEOUT_MS = Number(process.env.RAPITAS_VERIFY_SETTLE_MS) || 60_000;

// Hard cap for the same wait when the commit/PR automation is still registered
// as in-flight. The base window above only bounds the case where nothing is
// running; a live pipeline is given until this cap so slow-but-healthy work
// (network-bound `gh pr create`, large test scopes) is never judged failed.
export const VERIFY_SETTLE_HARD_CAP_MS =
  Number(process.env.RAPITAS_VERIFY_SETTLE_CAP_MS) || 600_000;
export const VERIFY_SETTLE_POLL_MS = 2_000;

/**
 * Wait (bounded) for the post-verify completion automation (commit/PR/merge) to
 * settle a `verify_done` task, so a transient `verify_done` is not misreported as
 * a failure (which flashed a misleading "blocked" in the UI). The automation runs
 * async after verify.md is saved and usually finishes within ~20-30s.
 *
 * @param taskId - The task sitting at verify_done. / verify_done のタスクID
 * @param signal - Abort signal (auto-run stop). / 中断シグナル
 * @returns `completed` when it reached completed/done (or was completed here
 *   from a PR already on record), `moved` when it left verify_done for another
 *   phase (e.g. self-repair), `stuck` when it stayed verify_done past the grace
 *   window with no landed evidence (a real, persistent block). / 判定結果
 */
export async function waitForVerifyCompletion(
  taskId: number,
  signal: AbortSignal,
): Promise<'completed' | 'moved' | 'stuck'> {
  const deadline = Date.now() + VERIFY_SETTLE_TIMEOUT_MS;
  const hardDeadline = Date.now() + VERIFY_SETTLE_HARD_CAP_MS;
  const mergeDeadline = Date.now() + 90 * 60_000;
  // First check immediately — the automation often completes before this runs.
  for (;;) {
    const t = await resolveTaskWorkflowState(taskId);
    if (!t) return (await recoverFromLandedArtifact(taskId)) ? 'completed' : 'stuck';
    if (t.workflowStatus === 'completed' || t.status === 'done') return 'completed';
    if (t.workflowStatus !== 'verify_done') return 'moved';
    if (['blocked', 'failed', 'canceling', 'canceled', 'cancelled'].includes(t.status))
      return 'stuck';
    if (signal.aborted) return 'stuck';
    // Never call a task stuck WHILE its commit/PR automation is still
    // running: that work is unbounded (scoped tests, git push, `gh pr create`
    // over the network), so the fixed window was always a guess. Task 580's
    // pipeline needed 127s, the window expired at 60s, auto-run skipped a
    // task that then created PR #7 — a success parked as blocked. Keep
    // waiting while it is in flight, bounded by a hard cap so a wedged
    // pipeline still fails eventually.
    const stillWorking = hasVerifyCompletionInFlight(taskId) && Date.now() < hardDeadline;
    if (!stillWorking && Date.now() >= deadline) {
      const pendingMerge = await import('./verify-settle-artifact-recovery')
        .then(
          (m) =>
            typeof m.isAwaitingRequiredMerge === 'function' && m.isAwaitingRequiredMerge(taskId),
        )
        .catch(() => false);
      if (!(pendingMerge && Date.now() < mergeDeadline)) {
        // Last check before blocking: the registry is an in-memory inference,
        // but a PR row is a fact. Task 658 (task 660) sat unregistered while
        // its jury deliberated and was blocked 3.5 minutes before PR #458
        // landed — if the evidence of success is already on record, complete
        // the task from it instead of parking a success as blocked. A task
        // with no PR on record still fails here exactly as before.
        return (await recoverFromLandedArtifact(taskId)) ? 'completed' : 'stuck';
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, VERIFY_SETTLE_POLL_MS);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
