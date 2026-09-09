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
import { isVerificationWorktreeRoot } from '../../../services/workflow/verification-worktree';

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
const startingJobs = new Map<
  number,
  Promise<{ response: Awaited<ReturnType<typeof launchVerification>>; status?: number | string }>
>();

/** Share initialization, including its failure, without exposing an unpersisted placeholder ID. */
export async function handleRunVerification(ctx: RunVerificationContext) {
  const taskId = Number(ctx.params.taskId);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    ctx.set.status = 400;
    return { success: false, error: 'invalid taskId' };
  }
  const existing = startingJobs.get(taskId);
  if (existing) {
    const result = await existing;
    ctx.set.status = result.status;
    return result.response;
  }
  const starting = launchVerification(ctx).then((response) => ({
    response,
    status: ctx.set.status,
  }));
  startingJobs.set(taskId, starting);
  try {
    return (await starting).response;
  } finally {
    if (startingJobs.get(taskId) === starting) startingJobs.delete(taskId);
  }
}

async function launchVerification(ctx: RunVerificationContext) {
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

  // The handler shares this launch promise until a durable runId exists.
  // runningJobs contains only real job IDs, never preparation placeholders.
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

    if (!(await isVerificationWorktreeRoot(session.worktreePath))) {
      ctx.set.status = 409;
      return {
        success: false,
        error:
          '検証対象の worktree が削除済みか Git ルートと一致しません。worktree を復旧してから再実行してください。',
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
