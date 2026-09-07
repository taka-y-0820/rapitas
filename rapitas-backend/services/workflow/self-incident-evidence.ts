/**
 * self-incident-evidence
 *
 * Evidence gathering + Markdown formatting for the self-incident watcher:
 * assembles one task's forensic snapshot (transition timeline, latest
 * session/execution state, live-execution and queue flags) from the DB and
 * renders it into a human-investigable concern body. Runs NO detection logic —
 * that lives in incident-signature-detectors; this module is the I/O boundary.
 */
import { prisma } from '../../config/database';
import { ACTIVE_EXEC } from './workflow-reconciler-requeue';
import type { RepeatLoopTransition } from './incident-signature-detectors';

/** One workflow transition rendered into the evidence timeline. */
export interface TransitionEvidenceRow {
  /** ISO timestamp of the transition. */
  createdAt: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  cause: string;
  phase: string | null;
}

/** Everything the detectors + formatter need to know about one task. */
export interface GatheredTaskState {
  taskId: number;
  title: string;
  /** Task row's updatedAt, epoch ms. */
  taskUpdatedAtMs: number;
  /** Up to 10 most recent transitions, OLDEST first (reading order). */
  timeline: TransitionEvidenceRow[];
  /** createdAt of the newest transition, or null when the task has none. */
  latestTransitionAtMs: number | null;
  /** cause of the newest transition, or null when the task has none. */
  latestTransitionCause: string | null;
  /** Transitions inside the repeat-loop window, for detectRepeatLoop. */
  windowedCauses: RepeatLoopTransition[];
  latestSessionId: number | null;
  latestSessionStatus: string | null;
  /** updatedAt of that session, epoch ms (null = no session). Feeds the Pattern A settle-window guard. */
  latestSessionUpdatedAtMs: number | null;
  latestExecutionId: number | null;
  latestExecutionStatus: string | null;
  /** True when any ACTIVE_EXEC-status execution exists for the task. */
  hasLiveExecution: boolean;
  /** True when any execution exists for the task, regardless of status. */
  hasAnyExecution: boolean;
  /** True when a queued/running/waiting_approval queue item exists. */
  hasActiveQueueItem: boolean;
}

/** Queue item statuses that mean the task is already on the auto-run path. */
const ACTIVE_QUEUE_STATUSES = ['queued', 'running', 'waiting_approval'];

/**
 * Collects one task's incident-evidence snapshot from the DB. Each query
 * falls back to a safe default on failure so partial evidence never aborts
 * the whole gathering (mirrors the reconciler's per-query `.catch()` style).
 *
 * @param task - Candidate task row (id/title/updatedAt). / 対象タスク行
 * @param nowMs - Current time (ms). / 現在時刻
 * @param windowMs - Repeat-loop lookback window (ms). / 反復ループ集計窓
 * @returns The gathered snapshot. / 収集済みスナップショット
 */
export async function gatherTaskState(
  task: { id: number; title: string; updatedAt: Date },
  nowMs: number,
  windowMs: number,
): Promise<GatheredTaskState> {
  const recentTransitions = await prisma.workflowTransition
    .findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        fromStatus: true,
        toStatus: true,
        actor: true,
        cause: true,
        phase: true,
        createdAt: true,
      },
    })
    .catch(
      () =>
        [] as {
          fromStatus: string | null;
          toStatus: string;
          actor: string;
          cause: string;
          phase: string | null;
          createdAt: Date;
        }[],
    );

  const windowed = await prisma.workflowTransition
    .findMany({
      where: { taskId: task.id, createdAt: { gte: new Date(nowMs - windowMs) } },
      select: { cause: true, createdAt: true, actor: true, invariantViolation: true },
    })
    .catch(
      () => [] as { cause: string; createdAt: Date; actor: string; invariantViolation: boolean }[],
    );

  const latestSession = await prisma.agentSession
    .findFirst({
      where: { config: { taskId: task.id } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        agentExecutions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true },
        },
      },
    })
    .catch(() => null);

  const liveExec = await prisma.agentExecution
    .findFirst({
      where: { session: { config: { taskId: task.id } }, status: { in: ACTIVE_EXEC } },
      select: { id: true },
    })
    .catch(() => null);

  // Status-agnostic twin of liveExec: spans ALL sessions (latestSession only
  // sees the newest one), so a reset task's old executions still count.
  const anyExec = await prisma.agentExecution
    .findFirst({
      where: { session: { config: { taskId: task.id } } },
      select: { id: true },
    })
    .catch(() => null);

  const activeQueueItem = await prisma.workflowQueueItem
    .findFirst({
      where: { taskId: task.id, status: { in: ACTIVE_QUEUE_STATUSES } },
      select: { id: true },
    })
    .catch(() => null);

  return {
    taskId: task.id,
    title: task.title,
    taskUpdatedAtMs: task.updatedAt.getTime(),
    // findMany returned newest-first; the timeline reads oldest-first.
    timeline: [...recentTransitions].reverse().map((t) => ({
      createdAt: t.createdAt.toISOString(),
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      actor: t.actor,
      cause: t.cause,
      phase: t.phase,
    })),
    latestTransitionAtMs: recentTransitions[0]?.createdAt.getTime() ?? null,
    latestTransitionCause: recentTransitions[0]?.cause ?? null,
    windowedCauses: windowed.map((t) => ({
      cause: t.cause,
      createdAtMs: t.createdAt.getTime(),
      actor: t.actor,
      invariantViolation: t.invariantViolation ?? false,
    })),
    latestSessionId: latestSession?.id ?? null,
    latestSessionStatus: latestSession?.status ?? null,
    latestSessionUpdatedAtMs: latestSession?.updatedAt?.getTime() ?? null,
    latestExecutionId: latestSession?.agentExecutions[0]?.id ?? null,
    latestExecutionStatus: latestSession?.agentExecutions[0]?.status ?? null,
    hasLiveExecution: liveExec !== null,
    hasAnyExecution: anyExec !== null,
    hasActiveQueueItem: activeQueueItem !== null,
  };
}

/**
 * Renders a gathered snapshot into the concern body (Markdown). Pure — the
 * caller supplies the explanation and threshold description per signature.
 *
 * @param args.state - Gathered snapshot. / 収集済みスナップショット
 * @param args.explanation - What was detected and why it matters. / 検出内容の説明
 * @param args.thresholdDescription - The threshold that fired. / 発火した閾値の説明
 * @param args.detectedAtIso - Detection time (ISO). / 検出時刻
 * @param args.evidenceLines - Signature-specific evidence bullet lines; when
 *   given, rendered as a `## 検出証拠` section (omitted = no section, keeping
 *   the original three signatures byte-identical). / シグネチャ固有の証拠行
 * @returns Markdown concern body. / 懸念本文
 */
export function formatIncidentDetail(args: {
  state: GatheredTaskState;
  explanation: string;
  thresholdDescription: string;
  detectedAtIso: string;
  evidenceLines?: string[];
}): string {
  const { state } = args;

  const evidenceSection =
    args.evidenceLines && args.evidenceLines.length > 0
      ? ['## 検出証拠', ...args.evidenceLines.map((line) => `- ${line}`), '']
      : [];

  const timelineLines =
    state.timeline.length > 0
      ? state.timeline.map(
          (t) =>
            `- ${t.createdAt} — ${t.fromStatus ?? '(初回)'} → ${t.toStatus}` +
            ` (actor: ${t.actor}, cause: ${t.cause}${t.phase ? `, phase: ${t.phase}` : ''})`,
        )
      : ['(遷移履歴なし)'];

  const sessionLines =
    state.latestSessionId === null && state.latestExecutionId === null
      ? ['(セッションなし)']
      : [
          `- 最新セッション: #${state.latestSessionId ?? '-'} status=${state.latestSessionStatus ?? '-'}`,
          `- 最新実行: #${state.latestExecutionId ?? '-'} status=${state.latestExecutionStatus ?? '-'}`,
          `- 実行中エージェント: ${state.hasLiveExecution ? 'あり' : 'なし'}`,
          `- アクティブなキュー項目: ${state.hasActiveQueueItem ? 'あり' : 'なし'}`,
        ];

  return [
    '## 概要',
    args.explanation,
    '',
    '## 対象タスク',
    `- #${state.taskId}「${state.title}」`,
    `- タスク最終更新: ${new Date(state.taskUpdatedAtMs).toISOString()}`,
    '',
    ...evidenceSection,
    '## 直近の遷移タイムライン(最大10件)',
    ...timelineLines,
    '',
    '## 関連セッション/実行の状態',
    ...sessionLines,
    '',
    '## 検出条件',
    `- 検出時刻: ${args.detectedAtIso}`,
    `- 閾値: ${args.thresholdDescription}`,
  ].join('\n');
}
