/**
 * Loop Metrics
 *
 * First-class self-observability for the quality-improvement loop: computes
 * weekly buckets of bounce/repair signals from the append-only
 * WorkflowTransition event log (no schema needed). This is the measured basis
 * the loop-watcher compares across windows, and what a human reads to judge
 * whether an intervention (e.g. critic-lessons) actually moved the numbers.
 * Not responsible for judging stagnation or filing concerns — see
 * loop-watcher.ts.
 */
import { prisma } from '../../config/database';

/** Buckets a verify_repair reason falls into (mirrors the manual triage). */
export type RepairCategory =
  | 'self_contradiction' // verify.md contradicts the measured gate result
  | 'diff_review' // adversarial jury rejected the implementation diff
  | 'honest_failure' // verify.md honestly reports a failing implementation
  | 'auto_gate' // deterministic gate NG (lint/type/test/scope)
  | 'other';

/** One observation window's counts. */
export interface LoopMetricsWindow {
  /** Inclusive window start (ISO). */
  from: string;
  /** Exclusive window end (ISO). */
  to: string;
  counts: {
    research_critic_failed: number;
    research_critic_exhausted: number;
    plan_critic_failed: number;
    plan_critic_exhausted: number;
    verify_repair_total: number;
    verify_repair_self_contradiction: number;
    verify_repair_diff_review: number;
    verify_repair_honest_failure: number;
    verify_repair_auto_gate: number;
    verify_repair_other: number;
    ci_repair: number;
    completed: number;
  };
}

export interface LoopMetrics {
  /** Newest window FIRST. */
  windows: LoopMetricsWindow[];
  windowDays: number;
}

/** Transition causes the metrics read (plus completion arrivals). */
const BOUNCE_CAUSES = [
  'research_critic_failed',
  'research_critic_exhausted',
  'plan_critic_failed',
  'plan_critic_exhausted',
  'verify_repair',
  'ci_repair',
] as const;

/**
 * Classify a verify_repair transition's reason text (mirrors the manual
 * repair-cause triage this module replaces).
 *
 * @param reason - metadata.reason of a verify_repair transition. / 差し戻し理由
 * @returns The repair category. / 分類結果
 */
export function classifyRepairReason(reason: string | undefined | null): RepairCategory {
  if (!reason) return 'other';
  if (reason.startsWith('差分レビュー不合格')) return 'diff_review';
  if (reason.includes('self-contradicts')) return 'self_contradiction';
  if (reason.includes('explicitly marks')) return 'honest_failure';
  if (reason.startsWith('自動検証に失敗')) return 'auto_gate';
  return 'other';
}

/** A transition row as the bucketing core consumes it. */
export interface TransitionRowLite {
  cause: string | null;
  toStatus: string | null;
  metadata: string | null;
  createdAt: Date;
}

function emptyCounts(): LoopMetricsWindow['counts'] {
  return {
    research_critic_failed: 0,
    research_critic_exhausted: 0,
    plan_critic_failed: 0,
    plan_critic_exhausted: 0,
    verify_repair_total: 0,
    verify_repair_self_contradiction: 0,
    verify_repair_diff_review: 0,
    verify_repair_honest_failure: 0,
    verify_repair_auto_gate: 0,
    verify_repair_other: 0,
    ci_repair: 0,
    completed: 0,
  };
}

/**
 * Bucket transitions into rolling windows counting back from `now`. Pure —
 * the testable core of the metrics.
 *
 * @param rows - Transition rows (any order). / 対象遷移行
 * @param now - Window anchor (newest window ends here). / 窓の基準時刻
 * @param windowDays - Days per window. / 窓の日数
 * @param windowCount - Number of windows. / 窓の数
 * @returns Windows, newest first. / 新しい順の窓
 */
export function bucketTransitions(
  rows: TransitionRowLite[],
  now: Date,
  windowDays: number,
  windowCount: number,
): LoopMetricsWindow[] {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const windows: LoopMetricsWindow[] = [];
  for (let i = 0; i < windowCount; i++) {
    const to = new Date(now.getTime() - i * windowMs);
    const from = new Date(to.getTime() - windowMs);
    windows.push({ from: from.toISOString(), to: to.toISOString(), counts: emptyCounts() });
  }

  for (const row of rows) {
    const t = row.createdAt.getTime();
    const age = now.getTime() - t;
    if (age < 0 || age >= windowMs * windowCount) continue;
    const idx = Math.floor(age / windowMs);
    const counts = windows[idx]!.counts;

    // NOTE: This counts WorkflowTransition rows, not distinct tasks — a
    // reopened/resumed task's re-completion is counted again. Callers using
    // this as a denominator for an "accepted success rate" must account for
    // that (it is an execution-volume proxy, not a task count).
    if (row.toStatus === 'completed') counts.completed++;
    switch (row.cause) {
      case 'research_critic_failed':
        counts.research_critic_failed++;
        break;
      case 'research_critic_exhausted':
        counts.research_critic_exhausted++;
        break;
      case 'plan_critic_failed':
        counts.plan_critic_failed++;
        break;
      case 'plan_critic_exhausted':
        counts.plan_critic_exhausted++;
        break;
      case 'ci_repair':
        counts.ci_repair++;
        break;
      case 'verify_repair': {
        counts.verify_repair_total++;
        let reason: string | undefined;
        try {
          reason = (JSON.parse(row.metadata ?? '{}') as { reason?: string }).reason;
        } catch {
          // Malformed metadata → 'other'.
        }
        counts[`verify_repair_${classifyRepairReason(reason)}`]++;
        break;
      }
      default:
        break;
    }
  }
  return windows;
}

/**
 * Compute the loop metrics from the live WorkflowTransition log.
 *
 * @param opts.windowDays - Days per window (default 7). / 窓の日数
 * @param opts.windowCount - Number of windows (default 5). / 窓の数
 * @param opts.now - Anchor time, injectable for tests. / 基準時刻
 * @returns Weekly windows, newest first. / 新しい順の週次メトリクス
 */
export async function computeLoopMetrics(
  opts: { windowDays?: number; windowCount?: number; now?: Date } = {},
): Promise<LoopMetrics> {
  const windowDays = opts.windowDays ?? 7;
  const windowCount = opts.windowCount ?? 5;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * windowCount * 24 * 60 * 60 * 1000);

  const rows = await prisma.workflowTransition.findMany({
    where: {
      createdAt: { gte: since },
      OR: [{ cause: { in: [...BOUNCE_CAUSES] } }, { toStatus: 'completed' }],
    },
    select: { cause: true, toStatus: true, metadata: true, createdAt: true },
  });

  return { windows: bucketTransitions(rows, now, windowDays, windowCount), windowDays };
}
