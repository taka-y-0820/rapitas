/**
 * concern-backlog routes
 *
 * HTTP API for the 懸念バックログ (Concern Backlog). Used by both the UI and by
 * AI agents (which file out-of-scope concerns via POST /concerns instead of
 * fixing them inline).
 */
import { Elysia, t } from 'elysia';
import { createLogger } from '../../config/logger';
import {
  submitConcern,
  listConcerns,
  setConcernStatus,
  deleteConcern,
  convertConcernToTask,
  getConcernStats,
  normalizeConcernType,
  normalizeConcernSeverity,
  type ConcernStatus,
  type ConcernType,
} from '../../services/memory/concern-backlog-service';
import { closeIssueForConcern } from '../../services/github/concern-bridge';

const log = createLogger('routes:concern-backlog');

export const concernBacklogRoutes = new Elysia()
  /** List concerns with optional filters. */
  .get(
    '/concerns',
    async ({ query }) => {
      const status = (query.status as ConcernStatus | 'all' | undefined) ?? 'open';
      const type = query.type ? normalizeConcernType(query.type) : undefined;
      const severity = query.severity ? normalizeConcernSeverity(query.severity) : undefined;
      const source = query.source || undefined;
      const themeId = query.themeId ? parseInt(query.themeId) : undefined;
      const limit = query.limit ? parseInt(query.limit) : 20;
      const offset = query.offset ? parseInt(query.offset) : 0;
      return listConcerns({ status, type, severity, source, themeId, limit, offset });
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        type: t.Optional(t.String()),
        severity: t.Optional(t.String()),
        source: t.Optional(t.String()),
        themeId: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    },
  )

  /** Concern statistics (counts by status / type). */
  .get('/concerns/stats', async () => getConcernStats())

  /** File a new concern (agents + users). */
  .post(
    '/concerns',
    async ({ body, set }) => {
      if (!body.title?.trim() || !body.detail?.trim()) {
        set.status = 400;
        return { error: 'タイトルと詳細は必須です' };
      }
      try {
        const filing = await submitConcern({
          title: body.title.trim(),
          detail: body.detail.trim(),
          type: normalizeConcernType(body.type),
          severity: normalizeConcernSeverity(body.severity),
          location: body.location?.trim() || undefined,
          originTaskId: body.originTaskId ?? undefined,
          themeId: body.themeId ?? undefined,
          source: body.source ?? 'user',
        });
        return { success: true, id: filing.id, outcome: filing.outcome, reason: filing.reason };
      } catch (err) {
        log.error({ err }, 'Failed to file concern');
        set.status = 500;
        return { error: '懸念の登録に失敗しました' };
      }
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1 }),
        detail: t.String({ minLength: 1 }),
        type: t.Optional(t.String()),
        severity: t.Optional(t.String()),
        location: t.Optional(t.String()),
        originTaskId: t.Optional(t.Number()),
        themeId: t.Optional(t.Number()),
        source: t.Optional(t.String()),
      }),
    },
  )

  /** Update a concern's status (dismiss / reopen). */
  .patch(
    '/concerns/:id',
    async ({ params, body, set }) => {
      const id = parseInt(params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        set.status = 400;
        return { error: 'Invalid ID' };
      }
      const status = body.status === 'dismissed' ? 'dismissed' : 'open';
      const ok = await setConcernStatus(id, status);
      if (!ok) {
        set.status = 404;
        return { error: '懸念が見つかりません' };
      }
      // Dismissing locally also closes the linked GitHub issue (best-effort).
      if (status === 'dismissed') await closeIssueForConcern(id);
      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ status: t.String() }),
    },
  )

  /** Delete a concern. */
  .delete(
    '/concerns/:id',
    async ({ params, set }) => {
      const id = parseInt(params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        set.status = 400;
        return { error: 'Invalid ID' };
      }
      const ok = await deleteConcern(id);
      if (!ok) {
        set.status = 404;
        return { error: '懸念が見つかりません' };
      }
      return { success: true };
    },
    { params: t.Object({ id: t.String() }) },
  )

  /** Convert a concern into a dedicated task. */
  .post(
    '/concerns/:id/convert-to-task',
    async ({ params, set }) => {
      const id = parseInt(params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        set.status = 400;
        return { error: 'Invalid ID' };
      }
      try {
        const taskId = await convertConcernToTask(id);
        if (taskId === null) {
          set.status = 404;
          return { error: '懸念が見つかりません' };
        }
        return { success: true, taskId };
      } catch (err) {
        log.error({ err, id }, 'Failed to convert concern to task');
        set.status = 400;
        return { error: err instanceof Error ? err.message : 'タスク化に失敗しました' };
      }
    },
    { params: t.Object({ id: t.String() }) },
  );

export type { ConcernType };
