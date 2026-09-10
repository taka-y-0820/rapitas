/**
 * Workflow Handlers / Plan Revision
 *
 * `POST /workflow/tasks/:taskId/revise-plan` — a human asks the PLANNER to make
 * a targeted change to plan.md instead of editing the document by hand.
 * Not responsible for making the edit; it records the instruction and rolls the
 * workflow back to the planning phase so the planner applies it.
 */

import { prisma } from '../../../config';
import { createLogger } from '../../../config/logger';
import { NotFoundError, ValidationError } from '../../../middleware/error-handler';
import { readWorkflowFile } from '../../../services/workflow/workflow-file-utils';
import { persistPlanRevision } from '../../../services/workflow/plan-revision-persistence';

const log = createLogger('routes:workflow:plan-revision');

/** Callers permitted to direct the planner, and how each is labelled. */
const REVISION_SOURCE_LABELS: Record<string, string> = {
  ui: 'ユーザー',
  operator: 'オペレーター',
};

/** Bounds the stored instruction; a revision request is a sentence, not a document. */
const MAX_INSTRUCTION_CHARS = 2000;

interface RevisePlanContext {
  params: { taskId: string };
  body?: { instruction?: string } | unknown;
  set: { status?: number };
  headers?: Record<string, string | undefined>;
}

/**
 * Best-effort re-dispatch so the planner picks the instruction up immediately
 * rather than waiting for the scheduler. Never throws — a rejected re-run (for
 * example a theme whose auto-run already owns the task) leaves the task at
 * research_done, where the normal dispatch path will reach it.
 *
 * @param taskId - Task to re-run. / 再実行するタスク
 */
async function triggerPlannerRerun(taskId: number): Promise<void> {
  try {
    const { WorkflowOrchestrator } =
      await import('../../../services/workflow/workflow-orchestrator');
    const result = await WorkflowOrchestrator.getInstance().advanceWorkflow(taskId);
    if (!result.success) {
      log.warn(
        { taskId, error: result.error },
        '[plan-revision] planner dispatch did not complete; leaving revision for recovery',
      );
    }
  } catch (err) {
    log.warn({ err, taskId }, '[plan-revision] auto re-run failed (non-fatal)');
  }
}

/**
 * Record a plan-revision instruction and send the workflow back to planning.
 *
 * Rolls back to `research_done` because that is the state the planner phase
 * runs FROM; plan.md is deliberately left in place so the planner can revise it
 * (workflow-plan-revision-context.ts feeds it back with the instruction), and
 * writeWorkflowFile archives the superseded version when the new one is saved.
 *
 * @param ctx - Elysia handler context with { instruction } body. / 指示ボディ
 * @returns The task id and the status it was rolled back to. / 反映後の状態
 * @throws {ValidationError} taskId 不正 / instruction 未指定 / 発行元ヘッダ不足
 * @throws {NotFoundError} タスクまたは plan.md が無い場合
 */
export async function handleRevisePlan({ params, body, set, headers }: RevisePlanContext): Promise<{
  taskId: number;
  ok: true;
  toStatus: 'research_done';
}> {
  const taskId = parseInt(params.taskId, 10);
  if (Number.isNaN(taskId)) {
    set.status = 400;
    throw new ValidationError('Invalid taskId');
  }

  // Directing the planner is a human act, the same class as answering a spec
  // question — an agent must not hand itself a revised plan. Mirrors the guard
  // on answer-question and on PUT /tasks/:id/status.
  const rawSource = headers?.['x-rapitas-source'];
  const source = typeof rawSource === 'string' ? rawSource.toLowerCase() : '';
  if (!REVISION_SOURCE_LABELS[source]) {
    log.warn(
      { taskId, source: rawSource ?? null },
      '[plan-revision] rejected: missing X-Rapitas-Source header (likely an agent shell-call)',
    );
    set.status = 400;
    throw new ValidationError(
      '計画の修正依頼には X-Rapitas-Source ヘッダ(ui|operator)が必要です。' +
        'エージェントが自身の計画を書き換えることは許可されていません。',
    );
  }

  const raw = (body as { instruction?: string })?.instruction;
  const instruction = typeof raw === 'string' ? raw.trim() : '';
  if (!instruction) {
    set.status = 400;
    throw new ValidationError('instruction is required');
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    set.status = 400;
    throw new ValidationError(`instruction must be ${MAX_INSTRUCTION_CHARS} characters or fewer`);
  }

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, workflowStatus: true, updatedAt: true },
  });
  if (!task) {
    set.status = 404;
    throw new NotFoundError('Task not found');
  }

  const plan = await readWorkflowFile(taskId, 'plan').catch(() => null);
  if (!plan) {
    set.status = 404;
    throw new NotFoundError('plan.md does not exist for this task');
  }

  await persistPlanRevision(prisma, task, instruction, REVISION_SOURCE_LABELS[source]);

  log.info(
    { taskId, source },
    '[plan-revision] recorded instruction; rolled back to research_done',
  );
  void triggerPlannerRerun(taskId);

  return { taskId, ok: true, toStatus: 'research_done' };
}
