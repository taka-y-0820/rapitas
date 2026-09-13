/**
 * auto-run-selection
 *
 * Pure helper functions for the theme auto-run scheduler.
 * Selects the next eligible task for a given theme without side effects,
 * making the logic unit-testable without a live DB connection.
 */
import type { PrismaClient } from '../../../generated/prisma-postgres';

/** Minimum fields from Task used in selection logic. */
export interface SelectableTask {
  id: number;
  status: string;
  workflowStatus: string | null;
  priority: string;
  createdAt: Date;
  complexityScore?: number | null;
}

/**
 * Reason the selection returned no task. `all_blocked` = work EXISTS but every
 * task is stuck at status 'blocked' (a wedged loop, task 615) — distinct from
 * `all_done` (genuinely nothing left to do).
 */
export type NoTaskReason =
  | 'all_done'
  | 'all_blocked'
  | 'concurrency_limit'
  | 'awaiting_approval'
  /** The whole workflow is switched off; no task in any theme can be advanced. */
  | 'workflow_disabled_globally';

export type SelectionResult =
  | {
      found: true;
      taskId: number;
      /**
       * Task ids passed over because their plan files overlap an open auto-PR's
       * changed files (task 573 B). Present only when a LATER candidate was
       * selected instead; the all-overlap fallback picks the head without it.
       */
      deferred?: number[];
    }
  | { found: false; reason: NoTaskReason };

/**
 * Scope-overlap context for {@link selectNextTask} (task 573 B). `openPrFiles`
 * is the union of changed files across the theme's OPEN auto-created PRs;
 * `getPlanFiles` loads a candidate's plan file list (empty = no plan =
 * lightweight task, never deferred per spec).
 */
export interface ScopeOverlapContext {
  openPrFiles: string[];
  getPlanFiles: (taskId: number) => Promise<string[]>;
}

/** Auto-run concurrency constants (overridable via env). */
export const AUTO_RUN_GLOBAL_MAX_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.AUTO_RUN_GLOBAL_MAX_CONCURRENCY ?? '1', 10) || 1,
);
export const POLL_INTERVAL_MS = 12_000; // 12 s
export const COOLDOWN_MS = 3_000; // 3 s between task transitions
/**
 * Theme-level hang backstop: if a task stays the "current" task longer than
 * this, the scheduler force-stops it and skips ahead. Guards against a wedged
 * run burning tokens indefinitely (beyond WorkflowRunner's per-phase timeout).
 */
export const MAX_TASK_WALL_MS = Math.max(
  60_000,
  parseInt(process.env.AUTO_RUN_MAX_TASK_WALL_MS ?? '2700000', 10) || 2_700_000, // 45 min
);

/**
 * Task priority ordering for selection: lower number = runs first.
 * Stored priority is a STRING, so it must be ranked in JS — a SQL `desc` on the
 * string sorts alphabetically (urgent>medium>low>high), which is NOT priority order.
 */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * Resolve a priority string to its rank (higher priority → lower number).
 *
 * @param priority - Task priority string / タスク優先度
 * @returns Numeric rank; unknown/empty treated as medium / 数値ランク（不明はmedium扱い）
 */
export function priorityRank(priority: string | null | undefined): number {
  if (!priority) return PRIORITY_RANK.medium;
  const r = PRIORITY_RANK[priority.toLowerCase()];
  return r === undefined ? PRIORITY_RANK.medium : r;
}

/**
 * Learnable-band value score for priority ties (R6): prefer tasks whose
 * complexity sits in the band the theme can currently LEARN from — neither
 * trivial nor beyond its measured ability. Proposer rewards centered on an
 * intermediate success band drive the strongest self-improvement (AZR,
 * arXiv:2505.03335). The theme's recent success rate moves the target band:
 * succeeding often → reach for harder work; failing often → consolidate on
 * easier work. Pure and unit-testable.
 *
 * @param complexityScore - Task complexity 0-100 (null = not yet assessed). / 複雑度
 * @param themeSuccessRate - Recent completion rate 0-1 (null = no data). / 直近成功率
 * @returns Score in [-1, 0]; higher = closer to the learnable band. / 帯スコア
 */
export function valueBandScore(
  complexityScore: number | null | undefined,
  themeSuccessRate: number | null | undefined,
): number {
  if (themeSuccessRate == null) return 0; // no signal — keep legacy ordering
  const rate = Math.max(0, Math.min(1, themeSuccessRate));
  const target = 20 + 60 * rate; // 20 (struggling) … 80 (cruising)
  // Unassessed complexity = a fixed mid-distance penalty, so tasks with REAL
  // in-band evidence outrank unknowns, but unknowns still beat far-out-of-band.
  if (complexityScore == null) return -0.3;
  const c = Math.max(0, Math.min(100, complexityScore));
  return -Math.abs(c - target) / 100;
}

/**
 * Recent completion rate for a theme's terminal top-level tasks (done vs
 * blocked), used to position the learnable band. Returns null with fewer than
 * 3 samples so selection keeps its legacy ordering until there is signal.
 *
 * @param prisma - Prisma client instance
 * @param themeId - Theme to measure / 対象テーマ
 * @returns Success rate 0-1, or null when data is insufficient. / 直近成功率
 */
export async function recentThemeSuccessRate(
  prisma: PrismaClient,
  themeId: number,
): Promise<number | null> {
  try {
    const recent = await prisma.task.findMany({
      where: { themeId, parentId: null, status: { in: ['done', 'completed', 'blocked'] } },
      orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 10,
      select: { status: true },
    });
    if (recent.length < 3) return null;
    const done = recent.filter((t) => t.status === 'done' || t.status === 'completed').length;
    return done / recent.length;
  } catch {
    return null;
  }
}

/**
 * Return the number of auto-run queue items currently active (queued/running/waiting_approval).
 * A non-null themeId marks an item as belonging to the auto-run scheduler.
 *
 * @param prisma - Prisma client instance
 * @returns count of active auto-run items / アクティブな自動実行キューアイテム数
 */
export async function getGlobalAutoRunActiveCount(prisma: PrismaClient): Promise<number> {
  return prisma.workflowQueueItem.count({
    where: {
      themeId: { not: null },
      status: { in: ['queued', 'running', 'waiting_approval'] },
    },
  });
}

/**
 * Return all active auto-run queue items (queued/running/waiting_approval) for a specific theme.
 *
 * @param prisma - Prisma client instance
 * @param themeId - Theme ID / テーマID
 * @returns array of active queue item records / アクティブなキューアイテムの配列
 */
export async function getThemeActiveQueueItems(
  prisma: PrismaClient,
  themeId: number,
): Promise<Array<{ id: number; taskId: number; status: string }>> {
  return prisma.workflowQueueItem.findMany({
    where: {
      themeId,
      status: { in: ['queued', 'running', 'waiting_approval'] },
    },
    select: { id: true, taskId: true, status: true },
  });
}

/**
 * Path-boundary-safe file match: equal, or one is the other's `/`-suffix.
 * Suffix matching absorbs repo-relative vs package-relative depth differences
 * (`rapitas-backend/services/a.ts` vs `services/a.ts`) without the false
 * positive of a bare endsWith (`foo/ab.ts` must NOT match `b.ts`).
 */
function fileMatches(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * Open-PR files that overlap the plan's file list (task 573 B). Both sides are
 * normalized to `/` separators; plan DIRECTORY tokens (trailing `/`) are
 * excluded on purpose — directory-granularity matching on shared dirs like
 * `services/` would defer every candidate and starve the theme. Pure.
 *
 * @param planFiles - parsePlanFiles output for a candidate's plan / 計画のファイル一覧
 * @param openPrFiles - Union of open auto-PR changed files / オープンPRの変更ファイル
 * @returns The overlapping open-PR file paths (deduped) / 重複ファイル一覧
 */
export function overlappingFiles(planFiles: string[], openPrFiles: string[]): string[] {
  const plan = planFiles
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f.length > 0 && !f.endsWith('/'));
  const out = new Set<string>();
  for (const prFile of openPrFiles) {
    const pr = prFile.replace(/\\/g, '/');
    if (plan.some((p) => fileMatches(p, pr))) out.add(pr);
  }
  return [...out];
}

/**
 * Whether a candidate's plan files overlap any open auto-PR's changed files.
 * Pure wrapper over {@link overlappingFiles}.
 *
 * @param planFiles - parsePlanFiles output for a candidate's plan / 計画のファイル一覧
 * @param openPrFiles - Union of open auto-PR changed files / オープンPRの変更ファイル
 * @returns True when at least one file overlaps / 重複があればtrue
 */
export function hasScopeOverlap(planFiles: string[], openPrFiles: string[]): boolean {
  return overlappingFiles(planFiles, openPrFiles).length > 0;
}

/**
 * Determine whether a task should be skipped (was blocked by a previous failure).
 * A task is blocked when its status was explicitly set to 'blocked' by the scheduler.
 *
 * @param taskStatus - Task status string / タスクステータス
 * @returns true if the task should be skipped / スキップすべきならtrue
 */
export function isTaskBlocked(taskStatus: string): boolean {
  return taskStatus === 'blocked';
}

/**
 * Whether a task is parked WAITING FOR A USER'S ANSWER, which
 * execute-post-handler stores as status 'blocked' — indistinguishable from a
 * real failure by status alone. Covers TWO distinct pause mechanisms:
 *  - a LIVE AskUserQuestion during an active session (most recent
 *    AgentExecution carries an unanswered `question`; once answered, a fresh
 *    execution with no question supersedes it), and
 *  - an intake/spec-clarification question.md saved via the Workflow API,
 *    which has no live session at all — its pause is recorded purely as
 *    `task.workflowStatus === 'awaiting_question'`. Missing this second case
 *    made the scheduler treat such a pause as a genuine failure, permanently
 *    parking the task at status 'blocked' even after the user answered (the
 *    answer only resets workflowStatus, not the stale 'blocked' status).
 * The scheduler uses this to HOLD (not advance) such a task, so it doesn't
 * treat the pause as a failure and spawn a second agent for the next task while
 * the answer-resume continues this one.
 *
 * @param prisma - Prisma client instance
 * @param taskId - Task to check / 確認対象タスク
 * @returns true when a live question or an intake question.md is pending / 未応答の質問（ライブまたはインテイク）があればtrue
 */
export async function isAwaitingUserAnswer(prisma: PrismaClient, taskId: number): Promise<boolean> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { workflowStatus: true },
  });
  if (task?.workflowStatus === 'awaiting_question') return true;

  const latest = await prisma.agentExecution.findFirst({
    where: { session: { config: { taskId } } },
    orderBy: { createdAt: 'desc' },
    select: { question: true },
  });
  return latest?.question != null && latest.question !== '';
}

/** Heartbeat freshness window for the hang backstop's liveness check. */
export const HANG_BACKSTOP_HEARTBEAT_MS = 5 * 60_000;

/**
 * Newest evidence that the task is still moving: its tenure start, its latest
 * workflow transition, or the latest heartbeat of any of its executions.
 *
 * The hang backstop must measure time SINCE PROGRESS, not tenure. Tenure alone
 * kills healthy multi-phase work — the implementer's own wall-clock cap (56 min)
 * already exceeds the 45-minute task wall, and even the liveness exemption has a
 * hole at the phase seam: task 585 was force-stopped 8 seconds after its
 * implementer committed a full implementation, in the 30-second gap before the
 * verifier's execution row appeared, at 48 minutes of tenure.
 *
 * @param prisma - Prisma client instance
 * @param taskId - Task to inspect. / 対象タスク
 * @param tenureStart - Epoch ms the task became the current task. / 現行タスクになった時刻
 * @returns Epoch ms of the most recent progress signal. / 直近の進捗時刻(ms)
 */

/**
 * Whether the task has a LIVE agent execution — running with a heartbeat fresh
 * within {@link HANG_BACKSTOP_HEARTBEAT_MS}. Used by the hang backstop to tell
 * "slow but progressing" apart from "wedged": task 563's healthy 31-minute
 * implementer (heartbeat updating every minute) was force-stopped at the
 * 45-minute whole-task wall because tenure was the ONLY signal. A stale-
 * heartbeat running row (zombie) still reads as not-live so the backstop
 * keeps catching genuine hangs.
 *
 * @param prisma - Prisma client instance
 * @param taskId - Task to check / 確認対象タスク
 * @returns true when a fresh-heartbeat running execution exists / 生きた実行があればtrue
 */
export async function resolveLastProgressAt(
  prisma: PrismaClient,
  taskId: number,
  tenureStart: number,
): Promise<number> {
  const [lastTransition, lastBeat] = await Promise.all([
    prisma.workflowTransition
      .findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
      .catch(() => null),
    prisma.agentExecution
      .findFirst({
        where: { session: { config: { taskId } }, heartbeatAt: { not: null } },
        orderBy: { heartbeatAt: 'desc' },
        select: { heartbeatAt: true },
      })
      .catch(() => null),
  ]);
  return Math.max(
    tenureStart,
    lastTransition?.createdAt?.getTime() ?? 0,
    lastBeat?.heartbeatAt?.getTime() ?? 0,
  );
}

/**
 * Whether the task has a LIVE agent execution — running with a heartbeat fresh
 * within {@link HANG_BACKSTOP_HEARTBEAT_MS}.
 *
 * @param prisma - Prisma client instance
 * @param taskId - Task to check / 確認対象タスク
 * @returns true when a fresh-heartbeat running execution exists / 生きた実行があればtrue
 */
export async function hasLiveExecution(prisma: PrismaClient, taskId: number): Promise<boolean> {
  const fresh = new Date(Date.now() - HANG_BACKSTOP_HEARTBEAT_MS);
  const live = await prisma.agentExecution
    .findFirst({
      where: {
        session: { config: { taskId } },
        status: 'running',
        heartbeatAt: { gte: fresh },
      },
      select: { id: true },
    })
    .catch(() => null);
  return live != null;
}

/**
 * Select the next task to execute for a given theme.
 *
 * Eligibility criteria:
 *  - status is 'todo' or 'in-progress' (not done/cancelled/archived/blocked/failed)
 *  - workflowStatus is not 'completed' or 'verify_done' (already finished)
 *  - not the currently-running task (avoid re-enqueuing)
 *
 * @param prisma - Prisma client instance
 * @param themeId - Theme whose tasks to search / 検索対象テーマ
 * @param order - 'priority' or 'created' ordering / 優先度順か作成日順
 * @param skipTaskIds - task IDs to skip (e.g. currently running) / スキップするタスクIDセット
 * @param globalActiveCount - current global auto-run active items count / グローバルアクティブ数
 * @param themeSuccessRate - Recent theme success rate for the learnable-band tiebreak (null = legacy ordering). / 直近成功率
 * @param scopeOverlap - Open-PR file context for overlap deferral; omitted = legacy behavior (task 573 B). / スコープ重複コンテキスト
 * @returns SelectionResult with taskId or reason why none was found / 選択結果
 */
export async function selectNextTask(
  prisma: PrismaClient,
  themeId: number,
  order: 'priority' | 'created',
  skipTaskIds: number[],
  globalActiveCount: number,
  themeSuccessRate: number | null = null,
  scopeOverlap?: ScopeOverlapContext,
): Promise<SelectionResult> {
  if (globalActiveCount >= AUTO_RUN_GLOBAL_MAX_CONCURRENCY) {
    return { found: false, reason: 'concurrency_limit' };
  }

  // The global off-switch disables phase progression for EVERY task, so the
  // per-task column below cannot catch it. Reported as its own reason rather
  // than as 'all_done': that path refills the backlog, which would file tasks
  // that are equally unable to run and quietly consume the promotion cap.
  //
  // Read through the INJECTED client, not the module-level one — this module is
  // called with a client by design, and reaching past it made the unit tests
  // open a real database connection (98s for one file).
  const globalSwitch = await prisma.userSettings
    .findFirst({ select: { workflowDisabledGlobally: true } })
    .catch(() => null);
  if (globalSwitch?.workflowDisabledGlobally) {
    return { found: false, reason: 'workflow_disabled_globally' };
  }

  const candidates = await prisma.task.findMany({
    where: {
      themeId,
      status: { in: ['todo', 'in-progress'] },
      // A 'todo' task is explicitly pending (incl. one reset to re-run a prior
      // run) — it MUST stay eligible regardless of a stale terminal
      // workflowStatus. The finished-state exclusion applies only to
      // 'in-progress' rows, to avoid re-picking one that is mid-finalization.
      // (A genuinely-done task has status 'done' and is already excluded above.)
      // Without the `status:'todo'` clause, a todo+verify_done task (status reset
      // for re-run, or a verify that didn't complete) was silently skipped and
      // the theme went idle with pending tasks still present.
      AND: [
        {
          OR: [
            { status: 'todo' },
            { workflowStatus: null },
            { workflowStatus: { notIn: ['completed', 'verify_done'] } },
          ],
        },
        {
          // A task parked on a question cannot progress until a human answers,
          // and the orchestrator refuses to dispatch it. Selection must agree
          // with the dispatcher: measured 2026-08-24, task 635 sat at
          // todo + awaiting_question, was selected, refused, cancelled and
          // re-selected — 106 queue items in 21 minutes. The `status:'todo'`
          // clause above deliberately ignores a stale workflowStatus, so
          // awaiting_question has to be excluded explicitly.
          //
          // The null branch is REQUIRED. `NOT { workflowStatus: 'x' }` compiles
          // to `NOT (workflowStatus = 'x')`, which is UNKNOWN — and therefore
          // false — for a NULL column. A freshly filed task has no
          // workflowStatus yet, so the bare NOT excluded every new task: with
          // 10 todo rows in theme 1, selection matched 0 and the theme spun
          // resumed→idle→resumed while its whole backlog sat there.
          OR: [{ workflowStatus: null }, { workflowStatus: { not: 'awaiting_question' } }],
        },
      ],
      // A workflow-disabled task cannot be advanced by the runner, which
      // refuses it with 「ワークフロー無効モードのため自動実行の対象外」. Selection
      // must agree with the dispatcher — exactly the lesson of the
      // awaiting_question clause above, and the same task taught it twice:
      // measured 2026-08-26, task 635 (workflowDisabled, priority high) was
      // selected, refused and released every ~20 seconds for ELEVEN HOURS.
      // Nothing else ran, and because the theme never reached 'all_done' the
      // backlog never refilled either — 121 open concerns sat untouched.
      workflowDisabled: false,
      id: skipTaskIds.length > 0 ? { notIn: skipTaskIds } : undefined,
      // Exclude subtasks — the theme scheduler drives top-level tasks only;
      // subtasks are handled by AIOrchestra.enqueueSubtasksForExecution().
      parentId: null,
    },
    // Stable createdAt order from the DB; priority is ranked in JS below.
    orderBy: [{ createdAt: 'asc' }],
    select: {
      id: true,
      status: true,
      workflowStatus: true,
      priority: true,
      createdAt: true,
      complexityScore: true,
    },
    take: 100,
  });

  // Filter out explicitly blocked tasks
  const eligible = candidates.filter((t) => !isTaskBlocked(t.status));

  if (eligible.length === 0) {
    // Blocked tasks are invisible to the candidate query above, so an extra
    // count is the ONLY way to tell "nothing left" from "work exists but every
    // task is wedged" (task 615). Fail-open to all_done on any error so the
    // new query can never break selection.
    let blockedCount = 0;
    try {
      blockedCount = await prisma.task.count({
        where: { themeId, status: 'blocked', parentId: null },
      });
    } catch {
      blockedCount = 0;
    }
    return { found: false, reason: blockedCount > 0 ? 'all_blocked' : 'all_done' };
  }

  // Highest priority first; priority TIES break by the learnable-band value
  // score (R6 — closest to the theme's current learning band wins), then by
  // creation order (oldest first). Done in JS because the stored priority is a
  // string and can't be SQL-ordered.
  if (order === 'priority') {
    eligible.sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      const band =
        valueBandScore(b.complexityScore, themeSuccessRate) -
        valueBandScore(a.complexityScore, themeSuccessRate);
      if (band !== 0) return band;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }
  // order === 'created' keeps the DB createdAt-asc order as-is.

  // Scope-overlap deferral (task 573 B): pick the FIRST candidate whose plan
  // files do not overlap an open auto-PR's changed files. A candidate without a
  // plan (lightweight) is never deferred. When EVERY candidate overlaps, fall
  // back to the head (starvation guard) and report no deferral.
  if (scopeOverlap && scopeOverlap.openPrFiles.length > 0) {
    const deferred: number[] = [];
    for (const candidate of eligible) {
      // A task already in progress owns a worktree with partial work; the
      // overlap deferral exists to keep NEW work off files an open auto-PR is
      // about to land, not to strand in-flight tasks. Observed 2026-09-13:
      // task 905 (plan_approved, mid verify-repair) was deferred every tick
      // behind 14 exhausted PRs while a fresh todo task was started instead.
      if (candidate.status === 'in-progress') {
        return deferred.length > 0
          ? { found: true, taskId: candidate.id, deferred }
          : { found: true, taskId: candidate.id };
      }
      const planFiles = await scopeOverlap.getPlanFiles(candidate.id).catch(() => []);
      if (planFiles.length === 0 || !hasScopeOverlap(planFiles, scopeOverlap.openPrFiles)) {
        return deferred.length > 0
          ? { found: true, taskId: candidate.id, deferred }
          : { found: true, taskId: candidate.id };
      }
      deferred.push(candidate.id);
    }
    return { found: true, taskId: eligible[0]!.id };
  }

  return { found: true, taskId: eligible[0]!.id };
}

/**
 * Determine if the currently-enqueued task for a theme is waiting for plan approval.
 * Returns true when the queue item status is 'waiting_approval'.
 *
 * @param queueItems - active queue items for the theme / テーマのアクティブキューアイテム
 * @returns true if ANY item is waiting_approval / waiting_approvalのアイテムがあればtrue
 */
export function hasItemAwaitingApproval(queueItems: Array<{ status: string }>): boolean {
  return queueItems.some((i) => i.status === 'waiting_approval');
}
