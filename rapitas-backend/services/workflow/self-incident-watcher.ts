/**
 * self-incident-watcher
 *
 * Detection-only incident pass riding the workflow-reconciler's 60s cycle,
 * self-throttled to once per ~5 minutes: scans tasks updated within the last
 * 24h, runs the pure signature detectors over each one's gathered evidence,
 * and files a dedup-keyed concern per finding. A separate no-lookback scan
 * re-notifies tasks stuck on an unanswered intake question. NEVER repairs
 * state — the concern → task → workflow pipeline is the repair path (by design).
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { submitConcern, type ConcernSeverity } from '../memory/concern-backlog-service';
import { notifyIntakeQuestionPending } from '../communication/notification-service';
import { resolveSelfDevelopmentThemeId } from './self-development-theme';
import {
  detectStagnation,
  detectTriStateDesync,
  detectRepeatLoop,
  detectUnansweredQuestion,
  isRepairBounceCause,
  STAGNATION_THRESHOLD_MS,
  DESYNC_RECOVERY_SETTLE_MS,
  PATTERN_A_SETTLE_MS,
  REPEAT_LOOP_WINDOW_MS,
  REPEAT_LOOP_MIN_COUNT,
  INVARIANT_REPEAT_LOOP_MIN_COUNT,
  MANUAL_STOP_WITHDRAW_CAUSE,
} from './incident-signature-detectors';
import { gatherTaskState, formatIncidentDetail } from './self-incident-evidence';
import type { GatheredTaskState } from './self-incident-evidence';
import { inspectSupervisorSignatures } from './supervisor-incident-inspect';
import { resolveMaxRepairs } from './verify-self-repair-budget';
import { DEFAULT_MAX_CI_REPAIRS } from './blocked-task-policy';
import {
  resolveDisabledAutoRunThemeIds,
  resolveNonDevelopmentThemeIds,
  resolveWorkflowDisabledGlobally,
} from './self-incident-watch-gates';

const log = createLogger('self-incident-watcher');

/** Only tasks updated within this window are inspected (default 24h). */
export const CANDIDATE_LOOKBACK_MS =
  parseInt(process.env.RAPITAS_INCIDENT_LOOKBACK_MS ?? '', 10) || 24 * 60 * 60 * 1000;

/** Minimum interval between two watch passes (default 5m). */
export const WATCH_INTERVAL_MS =
  parseInt(process.env.RAPITAS_INCIDENT_WATCH_INTERVAL_MS ?? '', 10) || 5 * 60 * 1000;

/**
 * Defensive per-pass scan cap. Combined with `orderBy updatedAt asc`, an
 * overflow defers the FRESHEST tasks (least likely to be stagnant) to the
 * next pass rather than dropping the stalest ones.
 */
const MAX_CANDIDATES = 200;

/** Truncation limit for concern titles (long titles hurt task conversion). */
const TITLE_MAX_CHARS = 120;

// Process-local throttle (same pattern as the reconciler's `inFlight`): a
// restart resets it, which merely allows one early pass — harmless, since the
// watcher only detects (no state change) and dedupKey absorbs re-detections.
let lastRunMs = 0;

/**
 * Pure throttle decision: has enough time passed since the last watch pass?
 *
 * @param lastRunMs - When the previous pass ran (ms; 0 = never). / 前回実行時刻
 * @param nowMs - Current time (ms). / 現在時刻
 * @param intervalMs - Minimum interval (default 5m). / 最小間隔
 * @returns true when a new pass may run. / 実行してよいか
 */
export function shouldRunIncidentWatch(
  lastRunMs: number,
  nowMs: number,
  intervalMs: number = WATCH_INTERVAL_MS,
): boolean {
  return nowMs - lastRunMs >= intervalMs;
}

/** A candidate task row as selected by the watch query. */
interface CandidateTask {
  id: number;
  title: string;
  status: string;
  workflowStatus: string | null;
  updatedAt: Date;
  /** Theme the task belongs to (null = unthemed) — feeds the Pattern B auto-run gate. */
  themeId: number | null;
  /** Task-level workflow-disabled flag — feeds the stagnation isWorkflowManaged gate (#860). */
  workflowDisabled: boolean;
}

/** Formats + files one finding as a dedup-keyed concern. Never throws. */
async function fileFinding(args: {
  signature: string;
  task: CandidateTask;
  state: GatheredTaskState;
  title: string;
  explanation: string;
  thresholdDescription: string;
  severity: ConcernSeverity;
  nowMs: number;
  /** Signature-specific evidence bullets, rendered as `## 検出証拠`. */
  evidenceLines?: string[];
}): Promise<boolean> {
  try {
    // File against the theme that develops RAPITAS: these findings are about
    // rapitas' own workflow tables and code. Inheriting the origin task's theme
    // sent a state-inconsistency concern into the converter project, where the
    // promoted task could only report "対象コードなし" and exhaust its repair
    // budget (task 587). Falls back to the origin theme when unresolvable.
    const selfThemeId = await resolveSelfDevelopmentThemeId();
    await submitConcern({
      ...(selfThemeId != null ? { themeId: selfThemeId } : {}),
      title: args.title.slice(0, TITLE_MAX_CHARS),
      detail: formatIncidentDetail({
        state: args.state,
        explanation: args.explanation,
        thresholdDescription: args.thresholdDescription,
        detectedAtIso: new Date(args.nowMs).toISOString(),
        ...(args.evidenceLines ? { evidenceLines: args.evidenceLines } : {}),
      }),
      type: 'bug',
      severity: args.severity,
      originTaskId: args.task.id,
      source: 'self_incident_watch',
      // Per SIGNATURE, not per task. 「停滞: #646 が33分間停滞」 and
      // 「停滞: #624 が31分間停滞」 are one defect seen twice, and the fix is not
      // per task — keying on the task id turned four defect signatures into 41
      // open concerns (measured 2026-08-27), each promoting to its own task.
      // A dismissed or resolved concern no longer blocks, so a genuine
      // recurrence after triage still files again.
      dedupKey: `self-incident:${args.signature}`,
      // Aggregates same-signature refilings across tasks instead of one row
      // per detection (#801) — taskId is the instance-varying value the
      // signature itself deliberately excludes (see the dedupKey comment above).
      recurrencePolicy: {
        enabled: true,
        instanceValue: `taskId:${args.task.id}`,
        detectedAt: args.nowMs,
      },
    });
    return true;
  } catch (err) {
    log.warn(
      { err, taskId: args.task.id, signature: args.signature },
      '[self-incident] concern filing failed — continuing',
    );
    return false;
  }
}

/**
 * Runs all three detectors over one task and files a concern per finding.
 *
 * @param nonDevelopmentThemeIds - Themes with `isDevelopment === false`, resolved once per
 *   pass by the caller (task #860). / 非開発テーマID集合
 * @param workflowDisabledGlobally - `UserSettings.workflowDisabledGlobally`, resolved once per
 *   pass by the caller (task #860). / ワークフロー全体無効化フラグ
 * @param repairBounceMinCount - Dynamic repeat-loop threshold for verify_repair/ci_repair
 *   (task 837, resolved once per pass by the caller — see runSelfIncidentWatch). / 修復バウンス系の動的しきい値
 */
async function inspectTask(
  task: CandidateTask,
  nowMs: number,
  disabledAutoRunThemeIds: Set<number>,
  nonDevelopmentThemeIds: Set<number>,
  workflowDisabledGlobally: boolean,
  repairBounceMinCount: number,
): Promise<number> {
  const state = await gatherTaskState(task, nowMs, REPEAT_LOOP_WINDOW_MS);
  let filed = 0;

  // Structural dispatch gate (#860): a task that can never gain a live
  // execution/queue item — workflow disabled, non-development theme, or
  // theme auto-run disabled — is a legitimate indefinite wait, not
  // stagnation. Unthemed tasks fall through to `true` (managed) on purpose —
  // see incident-signature-detectors.ts's isWorkflowManaged JSDoc.
  const isWorkflowManaged =
    task.workflowDisabled || workflowDisabledGlobally
      ? false
      : task.themeId != null && nonDevelopmentThemeIds.has(task.themeId)
        ? false
        : task.themeId != null && disabledAutoRunThemeIds.has(task.themeId)
          ? false
          : true;

  const manuallyWithdrawn = state.latestTransitionCause === MANUAL_STOP_WITHDRAW_CAUSE;
  const stagnation = detectStagnation({
    taskStatus: task.status,
    workflowStatus: task.workflowStatus,
    // The freshest of the task row itself and its newest transition — either
    // one moving means the task is not idle.
    lastActivityAtMs: Math.max(state.taskUpdatedAtMs, state.latestTransitionAtMs ?? 0),
    hasLiveExecution: state.hasLiveExecution,
    hasAnyExecution: state.hasAnyExecution,
    hasActiveQueueItem: state.hasActiveQueueItem,
    isWorkflowManaged,
    manuallyWithdrawn,
    nowMs,
  });
  if (stagnation) {
    const staleMin = Math.round(stagnation.staleMs / 60_000);
    if (
      await fileFinding({
        signature: 'stagnation',
        task,
        state,
        title: '[自己検出] 停滞: 実行もキューも無いまま非終端タスクが放置される',
        explanation:
          `非終端タスク(status=${task.status}, workflowStatus=${task.workflowStatus ?? 'null'})が、` +
          `実行中エージェントもアクティブなキュー項目も無いまま${staleMin}分間更新されていません。`,
        thresholdDescription:
          `停滞閾値 ${Math.round(STAGNATION_THRESHOLD_MS / 60_000)}分` +
          `（実行なし・キューなし・正当な待機状態でない非終端タスクが対象）`,
        severity: 'medium',
        nowMs,
      })
    ) {
      filed++;
    }
  }

  // Pattern B's recovery grace scans the whole timeline, not just the newest
  // cause (#775): a live process's delayed save can land after a recovery
  // transition has already aged off the "latest" slot.
  const desync = detectTriStateDesync({
    taskStatus: task.status,
    workflowStatus: task.workflowStatus,
    latestSessionStatus: state.latestSessionStatus,
    latestExecutionStatus: state.latestExecutionStatus,
    recentTransitions: state.timeline.map((t) => ({
      cause: t.cause,
      createdAtMs: new Date(t.createdAt).getTime(),
    })),
    latestSessionUpdatedAtMs: state.latestSessionUpdatedAtMs,
    themeAutoRunEnabled: task.themeId != null ? !disabledAutoRunThemeIds.has(task.themeId) : null,
    manuallyWithdrawn,
    nowMs,
  });
  if (desync) {
    const signature =
      desync.kind === 'session_failed_execution_active'
        ? 'tristate-desync:session-failed-exec-active'
        : 'tristate-desync:todo-workflow-advanced';
    if (
      await fileFinding({
        signature,
        task,
        state,
        title: `[自己検出] 状態不整合: ${desync.detail}`,
        explanation:
          `Task/AgentSession/AgentExecution の状態が矛盾しています: ${desync.detail}。` +
          `（task.status=${task.status}, workflowStatus=${task.workflowStatus ?? 'null'}）`,
        thresholdDescription:
          desync.kind === 'todo_status_workflow_advanced'
            ? `即時判定（ただし回復遷移 reconciler_requeue/artifact_reuse_fastforward/task_retried から` +
              `${Math.round(DESYNC_RECOVERY_SETTLE_MS / 60_000)}分間は定着待ちとして除外）`
            : `即時判定（ただしセッション最終更新から${Math.round(PATTERN_A_SETTLE_MS / 1000)}秒間は` +
              `定着待ちとして除外）`,
        severity: 'high',
        nowMs,
      })
    ) {
      filed++;
    }
  }

  const loop = detectRepeatLoop({
    transitions: state.windowedCauses,
    nowMs,
    taskStatus: task.status,
    repairBounceMinCount,
  });
  if (loop) {
    // Which threshold actually fired (task 837): invariant path keeps its own
    // fixed threshold; general path uses the dynamic repair-bounce threshold
    // only for verify_repair/ci_repair, else the static REPEAT_LOOP_MIN_COUNT.
    const effectiveMinCount =
      loop.via === 'invariant'
        ? INVARIANT_REPEAT_LOOP_MIN_COUNT
        : isRepairBounceCause(loop.cause)
          ? repairBounceMinCount
          : REPEAT_LOOP_MIN_COUNT;
    if (
      await fileFinding({
        signature: `repeat-loop:${loop.cause}`,
        task,
        state,
        title: `[自己検出] 反復ループ: cause=${loop.cause} が短時間に繰り返される`,
        explanation:
          `直近${Math.round(REPEAT_LOOP_WINDOW_MS / 60_000)}分以内に同一cause(${loop.cause})の` +
          `遷移が${loop.count}回発生しています。同じ失敗と再試行を繰り返すループの疑いがあります。`,
        // Must state the threshold that actually fired (task 710) — which for
        // REPAIR_BOUNCE_CAUSES is now the budget-derived one, not the static min.
        thresholdDescription: `${Math.round(REPEAT_LOOP_WINDOW_MS / 60_000)}分以内に同一causeが${effectiveMinCount}回以上`,
        severity: 'high',
        nowMs,
      })
    ) {
      filed++;
    }
  }

  // Supervisor-derived signatures (cwd mismatch / false failure / false
  // force-stop / theme misplacement) share the same filing path via DI.
  filed += await inspectSupervisorSignatures({ task, state, nowMs, file: fileFinding });

  return filed;
}

/**
 * Dedicated scan for tasks paused on an intake question. These CANNOT ride the
 * main candidate query: updatedAt freezes when the question is raised, so
 * after CANDIDATE_LOOKBACK_MS (24h) the task silently drops out of the
 * lookback — exactly the tasks this detector exists for (#578/#579 sat 4
 * days). No lookback here; the workflowStatus filter keeps the set small.
 * Re-notifies via createNotification only — filing a concern would promote
 * into a code-fix task that can only report "対象コードなし" (task 587 shape);
 * the sole fix for an unanswered question is a human answer.
 */
async function inspectAwaitingQuestionTasks(nowMs: number): Promise<number> {
  const candidates = await prisma.task
    .findMany({
      where: { parentId: null, workflowStatus: 'awaiting_question' },
      select: {
        id: true,
        title: true,
        status: true,
        workflowStatus: true,
        updatedAt: true,
        themeId: true,
        workflowDisabled: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: MAX_CANDIDATES,
    })
    .catch(() => [] as CandidateTask[]);

  let notified = 0;
  for (const task of candidates) {
    try {
      // Wait clock = when the question was raised, NOT task.updatedAt —
      // enrichment and other side channels touch updatedAt without answering.
      const raised = await prisma.workflowTransition.findFirst({
        where: { taskId: task.id, toStatus: 'awaiting_question' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      // Second guard besides the workflowStatus filter: an answered task must
      // never re-notify, even if its status lags behind the answer.
      const answered = await prisma.workflowTransition.findFirst({
        where: { taskId: task.id, cause: 'intake_question_answered' },
        select: { id: true },
      });
      const finding = detectUnansweredQuestion({
        workflowStatus: task.workflowStatus,
        taskStatus: task.status,
        questionRaisedAtMs: raised ? raised.createdAt.getTime() : null,
        hasAnsweredQuestion: answered !== null,
        nowMs,
      });
      if (!finding) continue;
      // Dedup lives in the helper: the same title+link window also covers the
      // intake gate's initial notice, so this is at most one notice per window.
      const created = await notifyIntakeQuestionPending({
        taskId: task.id,
        taskTitle: task.title,
        nowMs,
      });
      if (created) {
        notified++;
        log.info(
          { taskId: task.id, staleMs: finding.staleMs },
          '[self-incident] re-notified an unanswered intake question',
        );
      }
    } catch (err) {
      // One broken task must not starve the rest of the scan.
      log.warn(
        { err, taskId: task.id },
        '[self-incident] awaiting-question inspection failed — continuing',
      );
    }
  }
  return notified;
}

/**
 * Runs one self-incident watch pass (throttled). Scans tasks updated within
 * the lookback window, oldest first, and files evidence-backed concerns for
 * every detected signature; a second no-lookback scan re-notifies stale
 * unanswered intake questions. Detection only — no state is repaired here.
 *
 * @param nowMs - Current time (ms); injectable for tests. / 現在時刻
 * @returns Surfaced findings: concerns filed + question re-notifications (0 when throttled). / 起票＋通知の合計件数
 */
export async function runSelfIncidentWatch(nowMs: number = Date.now()): Promise<number> {
  if (!shouldRunIncidentWatch(lastRunMs, nowMs)) return 0;
  lastRunMs = nowMs;

  const candidates = await prisma.task
    .findMany({
      where: { parentId: null, updatedAt: { gte: new Date(nowMs - CANDIDATE_LOOKBACK_MS) } },
      select: {
        id: true,
        title: true,
        status: true,
        workflowStatus: true,
        updatedAt: true,
        themeId: true,
        workflowDisabled: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: MAX_CANDIDATES,
    })
    .catch(() => [] as CandidateTask[]);

  // Resolved once per pass (not per task) — feeds Pattern B's auto-run gate
  // and the stagnation isWorkflowManaged gate (#860).
  const candidateThemeIds = [
    ...new Set(candidates.map((t) => t.themeId).filter((id): id is number => id != null)),
  ];
  const [disabledAutoRunThemeIds, nonDevelopmentThemeIds, workflowDisabledGlobally] =
    await Promise.all([
      resolveDisabledAutoRunThemeIds(candidateThemeIds),
      resolveNonDevelopmentThemeIds(candidateThemeIds),
      resolveWorkflowDisabledGlobally(),
    ]);

  // Resolved once per pass, not per task (task 837, generalizes task 835's
  // verify_repair-only budget guard to also cover ci_repair): a task that
  // legitimately exhausts its verify_repair/ci_repair budget must not be
  // misreported as a repeat loop — see detectRepeatLoop's task-837 JSDoc
  // paragraph. Falls back to the default budget when the settings row is
  // missing/unreadable (see resolveMaxRepairs).
  const verifyRepairLimit = await resolveMaxRepairs();
  const repairBounceMinCount = Math.max(
    REPEAT_LOOP_MIN_COUNT,
    Math.max(verifyRepairLimit, DEFAULT_MAX_CI_REPAIRS) + 1,
  );

  let filed = 0;
  for (const task of candidates) {
    try {
      filed += await inspectTask(
        task,
        nowMs,
        disabledAutoRunThemeIds,
        nonDevelopmentThemeIds,
        workflowDisabledGlobally,
        repairBounceMinCount,
      );
    } catch (err) {
      // One broken task must not starve the rest of the scan.
      log.warn({ err, taskId: task.id }, '[self-incident] task inspection failed — continuing');
    }
  }

  // Runs AFTER the main loop: awaiting_question tasks age out of the 24h
  // lookback above, so they need their own no-lookback pass (see the fn doc).
  const notified = await inspectAwaitingQuestionTasks(nowMs);

  if (filed + notified > 0) {
    log.info(
      { filed, notified, candidates: candidates.length },
      '[self-incident] surfaced incident findings',
    );
  }
  return filed + notified;
}
