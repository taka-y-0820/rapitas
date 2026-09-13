/**
 * Workflow Handlers — Self-Verification Status
 *
 * GET /workflow/tasks/:taskId/run-verification/:runId and
 * GET /workflow/tasks/:taskId/run-verification/latest — read-only lookups
 * over the TimelineEvent rows a verification job wrote (see
 * verification-job-store.ts). Never starts a new verification job; a GET
 * against a runId or task with no matching start event returns 404 rather
 * than falling back to launching one.
 */
import { createLogger } from '../../../config/logger';
import {
  getJobByRunId,
  getLatestJob,
  type VerificationJobRecord,
} from '../../../services/workflow/verification-job-store';

const log = createLogger('routes:workflow:self-verification-status');

/** Minimal Elysia context shape these handlers need. */
interface RunVerificationStatusContext {
  params: { taskId: string; runId: string };
  set: { status?: number | string };
}

interface RunVerificationLatestContext {
  params: { taskId: string };
  set: { status?: number | string };
}

/** Shape a derived job record into the status-specific response fields. */
function toResponse(record: VerificationJobRecord) {
  switch (record.status) {
    case 'running':
      return {
        success: true,
        runId: record.runId,
        operation: record.operation,
        worktreePath: record.worktreePath,
        revision: record.revision,
        commands: record.commands,
        status: 'running',
        startedAt: record.startedAt,
      };
    case 'completed':
      return {
        success: true,
        runId: record.runId,
        operation: record.operation,
        worktreePath: record.worktreePath,
        revision: record.revision,
        commands: record.commands,
        status: 'completed',
        ok: record.ok,
        unverifiable: record.unverifiable,
        checks: record.checks,
        summary: record.summary,
        markdown: record.markdown,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
      };
    case 'failed':
      return {
        success: true,
        runId: record.runId,
        operation: record.operation,
        worktreePath: record.worktreePath,
        revision: record.revision,
        commands: record.commands,
        status: 'failed',
        error: record.error,
        finishedAt: record.finishedAt,
      };
    case 'interrupted':
      return {
        success: true,
        runId: record.runId,
        operation: record.operation,
        worktreePath: record.worktreePath,
        revision: record.revision,
        commands: record.commands,
        status: 'interrupted',
        startedAt: record.startedAt,
        note: 'サーバープロセス再起動または長時間無応答のため中断と判定されました',
      };
    default:
      // Exhaustive switch above covers every VerificationJobRecord['status'];
      // this branch only guards a future status value added without updating
      // this function.
      return {
        success: true,
        runId: record.runId,
        operation: record.operation,
        worktreePath: record.worktreePath,
        revision: record.revision,
        commands: record.commands,
        status: record.status,
      };
  }
}

/**
 * Return one verification job's current state. Delegates to the `latest`
 * handler when `:runId` is literally `latest`, so route-registration order
 * cannot cause `latest` to be misread as a runId.
 *
 * @param ctx - Elysia handler context with `taskId`/`runId`. / Elysiaハンドラコンテキスト
 * @returns The job's state, or 404 when the runId is unknown. / ジョブ状態または404
 */
export async function handleRunVerificationStatus(ctx: RunVerificationStatusContext) {
  const taskId = parseInt(ctx.params.taskId);
  if (!Number.isFinite(taskId)) {
    ctx.set.status = 400;
    return { success: false, error: 'invalid taskId' };
  }
  if (ctx.params.runId === 'latest') {
    return handleRunVerificationLatest(ctx as RunVerificationLatestContext);
  }

  try {
    const record = await getJobByRunId(taskId, ctx.params.runId);
    if (!record) {
      ctx.set.status = 404;
      return { success: false, error: '指定された runId の検証ジョブが見つかりません' };
    }
    return toResponse(record);
  } catch (err) {
    log.warn({ err, taskId, runId: ctx.params.runId }, '[self-verification-status] lookup failed');
    ctx.set.status = 500;
    return {
      success: false,
      error: `検証ジョブ状態の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Return the most recently started verification job for a task. Never
 * starts a new job.
 *
 * @param ctx - Elysia handler context with `taskId`. / Elysiaハンドラコンテキスト
 * @returns The latest job's state, or 404 when no job exists for this task. / 最新ジョブ状態または404
 */
export async function handleRunVerificationLatest(ctx: RunVerificationLatestContext) {
  const taskId = parseInt(ctx.params.taskId);
  if (!Number.isFinite(taskId)) {
    ctx.set.status = 400;
    return { success: false, error: 'invalid taskId' };
  }

  try {
    const record = await getLatestJob(taskId);
    if (!record) {
      ctx.set.status = 404;
      return { success: false, error: 'このタスクの検証ジョブは存在しません' };
    }
    return toResponse(record);
  } catch (err) {
    log.warn({ err, taskId }, '[self-verification-status] latest lookup failed');
    ctx.set.status = 500;
    return {
      success: false,
      error: `検証ジョブ状態の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
