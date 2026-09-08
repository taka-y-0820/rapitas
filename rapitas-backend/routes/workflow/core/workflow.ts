/**
 * Workflow Routes
 *
 * Assembles Elysia route definitions for the workflow API.
 * Delegates all handler logic to workflow-handlers.ts.
 * Not responsible for business logic, file I/O, or git operations.
 */

import { Elysia, t } from 'elysia';
import { prisma } from '../../../config';
import {
  handleGetFiles,
  handleSaveFile,
  handleApprovePlan,
  handleUpdateStatus,
  handleAdvanceWorkflow,
  handleSetMode,
  handleSetWorkflowDisabled,
  handleAnalyzeComplexity,
  handleGetModes,
  handleResumeFromQuestion,
  handleAnswerWorkflowQuestion,
  handleRunVerification,
  handleRunVerificationStatus,
  handleRunVerificationLatest,
} from '../handlers/workflow-handlers';
import { handleRevisePlan } from '../handlers/workflow-handlers-plan-revision';
import {
  handleDryRun,
  handleDryRunHistory,
  handleDryRunDrift,
} from '../handlers/workflow-handlers-dry-run';
import { computeRepairIterationMetrics } from '../../../services/workflow/repair-iteration-metrics';

// Re-export helpers and types for consumers that import from this path
export {
  VALID_FILE_TYPES,
  VALID_WORKFLOW_STATUSES,
  resolveWorkflowDir,
  getFileInfo,
} from './workflow-helpers';
export type { WorkflowFileType } from './workflow-helpers';
export { performAutoCommitAndPR } from '../workflow-auto-commit';
export type { AutoCommitPRResult } from '../workflow-auto-commit';

// PUT /tasks/:taskId/files/:fileType accepts EITHER a raw markdown/text body
// (Content-Type: text/markdown or text/plain) OR a JSON object — see the
// NOTE in handleSaveFile (workflow-handlers-files.ts) for why the raw-text
// path exists (Windows shell encoding). The union mirrors both shapes so the
// route rejects non-string/non-object payloads while still accepting
// whichever form the caller sends; the 3MB cap bounds a single report body
// well above any real research/plan/verify markdown while still capping the
// route from unbounded-size payloads.
const workflowFileSaveBodySchema = t.Union([
  t.String({ maxLength: 3_000_000 }),
  t.Object({
    content: t.String({ maxLength: 3_000_000 }),
    language: t.Optional(t.String({ maxLength: 10 })),
  }),
]);

// NOTE: Each handler is wrapped in an arrow function so Elysia can infer
// the full context type. Passing the handler directly causes TS2345 because
// the handler's explicit parameter annotations are narrower than the
// InlineHandlerNonMacro type Elysia expects.
export const workflowRoutes = new Elysia({ prefix: '/workflow' })

  .get('/tasks/:taskId/files', (ctx) => handleGetFiles(ctx as Parameters<typeof handleGetFiles>[0]))

  .put(
    '/tasks/:taskId/files/:fileType',
    (ctx) => handleSaveFile(ctx as Parameters<typeof handleSaveFile>[0]),
    { body: workflowFileSaveBodySchema },
  )

  .post('/tasks/:taskId/approve-plan', (ctx) =>
    handleApprovePlan(ctx as Parameters<typeof handleApprovePlan>[0]),
  )

  /**
   * `awaiting_question` 状態から、質問発生前の status に復帰する。
   * ユーザーが question.md に回答を記入し終えた後、エージェント実行を再開する前に呼ぶ。
   */
  .post('/tasks/:taskId/resume-from-question', (ctx) =>
    handleResumeFromQuestion(ctx as Parameters<typeof handleResumeFromQuestion>[0]),
  )

  /**
   * ワークフローの質問（intake ゲートの `question.md` 等）にユーザーが回答する。
   * 回答を仕様(goals/説明)へ反映し、question.md をアーカイブして draft から再実行する。
   */
  .post('/tasks/:taskId/answer-question', (ctx) =>
    handleAnswerWorkflowQuestion(ctx as Parameters<typeof handleAnswerWorkflowQuestion>[0]),
  )

  /**
   * 人間が plan.md を手で書き換える代わりに、プランナーへ修正指示を出す。
   * 指示を記録し、計画フェーズまで巻き戻して部分改訂させる。
   */
  .post('/tasks/:taskId/revise-plan', (ctx) =>
    handleRevisePlan(ctx as Parameters<typeof handleRevisePlan>[0]),
  )

  .put('/tasks/:taskId/status', (ctx) =>
    handleUpdateStatus(ctx as Parameters<typeof handleUpdateStatus>[0]),
  )

  /**
   * Implementer self-verification: run the SAME deterministic gate the verify
   * phase enforces (lint/typecheck/scoped tests/plan-scope) on the task's
   * worktree, without any state transition. The only workflow endpoint the
   * implementer role is ALLOWED (and instructed) to call before finishing.
   */
  .post('/tasks/:taskId/run-verification', (ctx) =>
    handleRunVerification(ctx as Parameters<typeof handleRunVerification>[0]),
  )

  /**
   * Self-verification job status: `latest` MUST be registered before
   * `:runId` so the literal path segment `latest` is never captured as a
   * `runId` parameter, regardless of Elysia's internal route-matching order.
   */
  .get('/tasks/:taskId/run-verification/latest', (ctx) =>
    handleRunVerificationLatest(ctx as Parameters<typeof handleRunVerificationLatest>[0]),
  )

  .get('/tasks/:taskId/run-verification/:runId', (ctx) =>
    handleRunVerificationStatus(ctx as Parameters<typeof handleRunVerificationStatus>[0]),
  )

  /**
   * User-facing dry run: the same verify gate + completion gate + adversarial
   * jury the production verify pipeline runs, WITHOUT commit/PR/merge/status
   * transition. See services/workflow/dry-run-orchestrator.ts.
   */
  .post('/tasks/:taskId/dry-run', (ctx) => handleDryRun(ctx as Parameters<typeof handleDryRun>[0]))

  .get('/tasks/:taskId/dry-run/history', (ctx) =>
    handleDryRunHistory(ctx as Parameters<typeof handleDryRunHistory>[0]),
  )

  .get('/tasks/:taskId/dry-run/:reportId/drift', (ctx) =>
    handleDryRunDrift(ctx as Parameters<typeof handleDryRunDrift>[0]),
  )

  .post('/workflow/tasks/:taskId/advance', (ctx) =>
    handleAdvanceWorkflow(ctx as Parameters<typeof handleAdvanceWorkflow>[0]),
  )

  .post('/tasks/:taskId/set-mode', (ctx) =>
    handleSetMode(ctx as Parameters<typeof handleSetMode>[0]),
  )

  .post('/tasks/:taskId/set-workflow-disabled', (ctx) =>
    handleSetWorkflowDisabled(ctx as Parameters<typeof handleSetWorkflowDisabled>[0]),
  )

  .get('/tasks/:taskId/analyze-complexity', (ctx) =>
    handleAnalyzeComplexity(ctx as Parameters<typeof handleAnalyzeComplexity>[0]),
  )

  .get('/modes', (ctx) => handleGetModes(ctx as Parameters<typeof handleGetModes>[0]))

  /**
   * Read-only timeline of every workflow status transition for a task.
   * Backed by the append-only `WorkflowTransition` table populated by
   * `recordTransition()`. Use this to debug "why is the task in
   * unexpected state X?" without re-running the agents.
   */
  .get('/tasks/:taskId/transitions', async (ctx) => {
    const params = ctx.params as { taskId: string };
    const taskId = parseInt(params.taskId);
    if (!Number.isFinite(taskId)) {
      return { success: false, error: 'invalid taskId' };
    }
    const rows = await prisma.workflowTransition
      .findMany({
        where: { taskId },
        orderBy: { createdAt: 'asc' },
      })
      .catch(() => null);
    if (!rows) {
      return { success: false, error: 'failed to load transitions' };
    }
    const transitions = rows.map((r) => {
      let parsedMeta: unknown = {};
      try {
        parsedMeta = r.metadata ? JSON.parse(r.metadata) : {};
      } catch {
        parsedMeta = { raw: r.metadata };
      }
      return { ...r, metadata: parsedMeta };
    });
    return { success: true, taskId, count: transitions.length, transitions };
  })

  /**
   * Read-only per-repair-iteration metrics (task #672, MVP-limited scope):
   * dwell time (from WorkflowTransition timestamps) and change-set size (from
   * ActivityLog `auto_commit_created` rows) for each verify_repair/ci_repair
   * bounce. Test-pass-rate delta and learning velocity are intentionally NOT
   * computed here — no structured numeric test-result data exists in the
   * pipeline to derive them from (see repair-iteration-metrics.ts header).
   */
  .get('/tasks/:taskId/repair-iterations', async (ctx) => {
    const params = ctx.params as { taskId: string };
    const taskId = parseInt(params.taskId);
    if (!Number.isFinite(taskId)) {
      return { success: false, error: 'invalid taskId' };
    }
    const [transitionRows, commitRows] = await Promise.all([
      prisma.workflowTransition
        .findMany({
          where: { taskId },
          orderBy: { createdAt: 'asc' },
          select: { id: true, cause: true, createdAt: true },
        })
        .catch(() => null),
      prisma.activityLog
        .findMany({
          where: { taskId, action: 'auto_commit_created' },
          orderBy: { createdAt: 'asc' },
          select: { metadata: true, createdAt: true },
        })
        .catch(() => null),
    ]);
    if (!transitionRows || !commitRows) {
      return { success: false, error: 'failed to load repair iteration data' };
    }
    const commits = commitRows.map((row) => {
      let meta: { filesChanged?: number; additions?: number; deletions?: number } = {};
      try {
        meta = row.metadata ? JSON.parse(row.metadata) : {};
      } catch {
        meta = {};
      }
      return {
        createdAt: row.createdAt,
        filesChanged: meta.filesChanged,
        additions: meta.additions,
        deletions: meta.deletions,
      };
    });
    const iterations = computeRepairIterationMetrics(transitionRows, commits);
    return { success: true, taskId, iterations };
  });
