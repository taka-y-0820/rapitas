/**
 * Workflow Handlers — Self-Verification
 *
 * POST /workflow/tasks/:taskId/run-verification — lets the IMPLEMENTER run the
 * exact deterministic gate (lint / typecheck / scoped tests / plan-scope) the
 * verify phase will later enforce, on its own worktree, BEFORE finishing.
 * A failure caught here is an in-phase fix (cheapest loop); the same failure
 * caught at verify is a full phase bounce (most expensive loop). Read-only
 * with respect to workflow state: no status transition, no file save.
 */
import { prisma } from '../../../config';
import { createLogger } from '../../../config/logger';
import {
  runAutomatedVerification,
  renderVerificationMarkdown,
  looksLikeBugFixTask,
} from '../../../services/agents/verification/automated-verifier';
import { resolveAcceptanceCriteria } from '../../../services/agents/verification/acceptance-self-check';
import { readWorkflowFile } from '../../../services/workflow/workflow-file-utils';
import { resolvePreferredBaseBranch } from '../../../services/task/task-resolver';

const log = createLogger('routes:workflow:self-verification');

/** Tasks with a verification currently running — one at a time per task. */
const inFlight = new Set<number>();

/** Minimal Elysia context shape this handler needs. */
interface RunVerificationContext {
  params: { taskId: string };
  set: { status?: number | string };
}

/**
 * Run the automated verification gate on the task's agent worktree and return
 * the measured result. Does not mutate workflow state.
 *
 * @param ctx - Elysia handler context. / Elysiaハンドラコンテキスト
 * @returns Measured gate result, or an error payload. / 実測結果またはエラー
 */
export async function handleRunVerification(ctx: RunVerificationContext) {
  const taskId = parseInt(ctx.params.taskId);
  if (!Number.isFinite(taskId)) {
    ctx.set.status = 400;
    return { success: false, error: 'invalid taskId' };
  }
  if (inFlight.has(taskId)) {
    ctx.set.status = 429;
    return {
      success: false,
      error: '検証は既に実行中です。完了を待ってから再実行してください。',
    };
  }

  inFlight.add(taskId);
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
      ctx.set.status = 404;
      return {
        success: false,
        error: 'このタスクの worktree が見つかりません（エージェント実行前は検証できません）。',
      };
    }

    const [planContent, preferredBaseBranch, taskRow] = await Promise.all([
      readWorkflowFile(taskId, 'plan'),
      resolvePreferredBaseBranch(taskId),
      // Task text feeds the ADVISORY acceptance self-check + the bug-fix
      // coverage parity (task 617: the verify-side gate already forced
      // requireTests for bug fixes, but the implementer's self-check did not —
      // class-B bounces surfaced only AFTER implementation). Fail-open: a
      // missing task row just skips both extras.
      prisma.task
        .findUnique({
          where: { id: taskId },
          select: { title: true, description: true, acceptanceCriteria: true },
        })
        .catch(() => null),
    ]);
    const taskText = taskRow ? `${taskRow.title}\n${taskRow.description ?? ''}` : '';
    const acceptanceCriteria = taskRow ? resolveAcceptanceCriteria(taskRow) : [];
    const result = await runAutomatedVerification(session.worktreePath, {
      planContent: planContent ?? undefined,
      preferredBaseBranch,
      taskId,
      requireTests: looksLikeBugFixTask(taskText),
      acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : undefined,
      taskText: taskText || undefined,
    });
    log.info(
      { taskId, ok: result.ok, checks: result.checks.length },
      '[self-verification] gate run complete',
    );
    return {
      success: true,
      ok: result.ok,
      summary: result.summary,
      markdown: renderVerificationMarkdown(result),
    };
  } catch (err) {
    log.warn({ err, taskId }, '[self-verification] gate run failed');
    ctx.set.status = 500;
    return {
      success: false,
      error: `検証の実行に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    inFlight.delete(taskId);
  }
}
