/**
 * Workflow Handlers — Self-Verification
 *
 * POST /workflow/tasks/:taskId/run-verification — lets the IMPLEMENTER start
 * the exact deterministic gate (lint / typecheck / scoped tests / plan-scope)
 * the verify phase will later enforce, on its own worktree, BEFORE finishing.
 * Returns immediately with a `runId` and `pollUrl`; the gate itself runs in
 * the background (verification-job-runner.ts) and its result is retrieved via
 * `GET run-verification/:runId` or `GET run-verification/latest`
 * (workflow-handlers-verification-status.ts). This split exists because the
 * gate can take minutes while `index.ts`'s Bun server `idleTimeout: 30`
 * closes the connection well before that — a synchronous POST here would
 * repeatedly disconnect the caller and lose the result (task 899 supervisor
 * finding). Read-only with respect to workflow state: no status transition,
 * no file save.
 */
import { createLogger } from '../../../config/logger';
import {
  beginVerificationRun,
  runVerificationGateAndRecord,
} from '../../../services/workflow/verification-job-runner';
import { prisma } from '../../../config';

const log = createLogger('routes:workflow:self-verification');

/** Tasks with a verification job currently running in this process — taskId → runId. One at a time per task. */
const runningJobs = new Map<number, string>();

/** Minimal Elysia context shape this handler needs. */
interface RunVerificationContext {
  params: { taskId: string };
  set: { status?: number | string };
}

/** Build the GET status URL for a verification job. */
export function buildPollUrl(taskId: number, runId: string): string {
  return `/workflow/tasks/${taskId}/run-verification/${runId}`;
}

/**
 * Start (or return the already-running) verification job for a task and
 * respond immediately — never waits for the gate itself to finish.
 *
 * @param ctx - Elysia handler context. / Elysiaハンドラコンテキスト
 * @returns `{runId, status, pollUrl}`, or an error payload. / ジョブ起動結果またはエラー
 */
export async function handleRunVerification(ctx: RunVerificationContext) {
  const taskId = parseInt(ctx.params.taskId);
  if (!Number.isFinite(taskId)) {
    ctx.set.status = 400;
    return { success: false, error: 'invalid taskId' };
  }

  const existingRunId = runningJobs.get(taskId);
  if (existingRunId) {
    return {
      success: true,
      runId: existingRunId,
      status: 'running',
      pollUrl: buildPollUrl(taskId, existingRunId),
      idempotent: true,
    };
  }

  // Reserved synchronously, before the first await, so two requests that
  // both miss the `runningJobs.get` check above cannot both proceed — this
  // mirrors the prior in-flight guard's ordering (task 897 supervisor
  // finding: a reservation placed AFTER an await leaves a race window).
  // The placeholder is replaced with the real runId once beginVerificationRun
  // resolves; every exit path below removes the reservation on failure.
  const PENDING = '__pending__';
  runningJobs.set(taskId, PENDING);
  try {
    const session = await prisma.agentSession
      .findFirst({
        where: { config: { taskId }, worktreePath: { not: null } },
        // Same tie-break as the verifier context: newest session, id as tiebreaker.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { worktreePath: true },
      })
      .catch(() => null);
    if (!session?.worktreePath) {
      runningJobs.delete(taskId);
      ctx.set.status = 404;
      return {
        success: false,
        error: 'このタスクの worktree が見つかりません（エージェント実行前は検証できません）。',
      };
    }

    const { runId, cacheInputsBefore, keyBefore } = await beginVerificationRun(
      taskId,
      session.worktreePath,
    );
    runningJobs.set(taskId, runId);

    // Fire-and-forget: the response below returns BEFORE this promise
    // settles. It keeps running after the HTTP response is sent, so a client
    // disconnect (idleTimeout, --max-time, background-tool observation
    // timeout) cannot lose the result — it is recorded via
    // verification-job-store regardless of connection state.
    runVerificationGateAndRecord(taskId, runId, session.worktreePath, cacheInputsBefore, keyBefore)
      .catch((err) => {
        log.warn({ err, taskId, runId }, '[self-verification] background gate run failed');
      })
      .finally(() => {
        if (runningJobs.get(taskId) === runId) runningJobs.delete(taskId);
      });

    return {
      success: true,
      runId,
      status: 'running',
      pollUrl: buildPollUrl(taskId, runId),
    };
  } catch (err) {
    runningJobs.delete(taskId);
    log.warn({ err, taskId }, '[self-verification] failed to start verification job');
    ctx.set.status = 500;
    return {
      success: false,
      error: `検証ジョブの起動に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
