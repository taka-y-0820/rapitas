/**
 * verify-self-repair
 *
 * When the verify.md validator rejects a verifier's output (self-contradiction:
 * claims pass but body shows failures, or an explicit ❌ verdict), instead of
 * dead-ending the task at `blocked` this bounces the workflow BACK to the
 * implementer phase with the failure as feedback, so the runner re-runs
 * implement → verify automatically. Bounded by a per-task attempt cap (counted
 * from WorkflowTransition rows — no schema change); once exhausted the caller
 * blocks as before. Not responsible for spawning agents.
 *
 * Split into verify-self-repair-{budget,feedback,resume}.ts (task 764) — this
 * file keeps only the orchestration surface (attemptVerifyRepair /
 * hasFreshVerifyRejection / resolveImplementEntryStatus) that external callers
 * import.
 */
import { prisma } from '../../config/database';
import { commitVerifyRepair } from './verify-repair-commit';
import { createLogger } from '../../config/logger';
import { recordTransition } from './transition-recorder';
import { VERIFY_NON_CONVERGENCE_CAUSE } from './blocked-task-policy';
import {
  REPAIR_CAUSE,
  resolveMaxRepairs,
  countPriorRepairs,
  detectRepairNonConvergence,
  resolveRepairWindowStart,
} from './verify-self-repair-budget';
import { ensureRunnerResumes, resolveRepairCaller } from './verify-self-repair-resume';
import { attemptInvariantCutoff, INVARIANT_NON_CONVERGENCE_CAUSE } from './verify-invariant-repair';

const log = createLogger('workflow:verify-self-repair');

/** Transition cause recorded when a verdict is cut off as not repairable by the implementer. */
export const VERIFY_NON_REPAIRABLE_CAUSE = 'verify_repair_non_repairable';

/**
 * A verdict whose ONLY failing gate is the anti-tampering tripwire. The
 * implementer cannot make a protected path unprotected, so bouncing it back
 * repeats the identical failure: task 867 (2026-09-06) looped 8 times over
 * three hours on `tamper=NG(1)` with lint/type/test/format all green.
 *
 * @param reason - Verdict summary as recorded on the verify transition / 判定要約
 * @returns True when tamper is the sole failing gate / tamper 単独失敗なら true
 */
export function isTamperOnlyVerdict(reason: string): boolean {
  if (!/tamper=NG/.test(reason)) return false;
  return !/\b(lint|typecheck|test|format|coverage|scope|runtime|schema-change)=NG/.test(reason);
}

export interface VerifyRepairResult {
  /** True when the workflow was bounced back to implement (caller must NOT block). */
  bounced: boolean;
  /** The workflowStatus to set so the implementer re-runs (when bounced). */
  newStatus?: string;
  /** 1-based attempt number for this bounce. */
  attempt?: number;
  /**
   * True when the bounce was skipped because the workflow already moved past
   * the evaluated status (stale verdict — e.g. a re-verify passed meanwhile).
   * Callers must treat this as "do nothing": neither bounce NOR block.
   */
  stale?: boolean;
  /** True when this call already recorded its own terminal transition (non-convergence cutoff) — callers must skip their own `verify_validation_failed` record to avoid double-recording (task 705). */
  cutoffRecorded?: boolean;
}

/**
 * Resolve the implementer's ENTRY status for a task: `plan_approved` when a
 * plan.md exists (standard/comprehensive), else `research_done` (lightweight) —
 * matching buildTransitions(). Setting workflowStatus to this makes the runner
 * re-run implement → verify.
 *
 * @param taskId - Task id / タスクID
 * @returns The status to bounce to / 戻す先のstatus
 */
export async function resolveImplementEntryStatus(
  taskId: number,
): Promise<'plan_approved' | 'research_done'> {
  const plan = await prisma.workflowFile.findFirst({
    where: { taskId, fileType: 'plan' },
    select: { id: true },
  });
  return plan ? 'plan_approved' : 'research_done';
}

/**
 * Attempt a verify→implement self-repair bounce. Returns `bounced:false` (caller
 * should block) once the per-task attempt cap is reached, or when repairs are
 * disabled (RAPITAS_MAX_VERIFY_REPAIRS=0).
 *
 * @param taskId - Task being verified / 検証対象タスク
 * @param currentStatus - The workflowStatus at the time verify.md was saved / 現在のstatus
 * @param reason - Validator failure summary / 失敗要約
 * @param verifyContent - The rejected verify.md body / 却下されたverify.md
 * @returns Whether the workflow was bounced and to which status / 戻したか・戻し先
 */
export async function attemptVerifyRepair(
  taskId: number,
  currentStatus: string | null,
  reason: string,
  verifyContent: string,
): Promise<VerifyRepairResult> {
  const max = await resolveMaxRepairs();
  if (max === 0) return { bounced: false };

  // A completed task is never rolled back — completion means a newer verify
  // already passed (typically with a PR); this verdict is stale by definition.
  if (currentStatus === 'completed') {
    log.warn(
      { taskId },
      '[verify-repair] Verdict targets an already-completed task — skipping stale bounce',
    );
    return { bounced: false, stale: true };
  }

  const evaluatedTask = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, workflowStatus: true, updatedAt: true },
  });
  if (
    !evaluatedTask ||
    evaluatedTask.status !== 'in-progress' ||
    evaluatedTask.workflowStatus === 'completed' ||
    (currentStatus === null && evaluatedTask.workflowStatus === 'verify_done') ||
    (currentStatus !== null && evaluatedTask.workflowStatus !== currentStatus)
  )
    return { bounced: false, stale: true };
  const evaluatedExecution = await prisma.agentExecution.findFirst({
    where: { session: { config: { taskId } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  const caller = resolveRepairCaller();
  const prior = await countPriorRepairs(taskId);
  if (prior >= max) {
    log.warn(
      { taskId, caller, prior, max },
      '[verify-repair] Repair attempts exhausted — caller should block',
    );
    return { bounced: false };
  }

  // Non-repairable cutoff: only the tamper tripwire failed. No implementer
  // run can change that verdict — escalate on the first sighting instead of
  // spending the whole repair budget on identical bounces.
  if (isTamperOnlyVerdict(reason)) {
    const detail =
      '検証失敗が tamper ゲート（保護パスの計画外変更）のみで、実装者には解消できません。保護パス配下の変更は plan.md（またはタスク仕様）に明記して承認するか、人が差分を確認してコミットしてください。';
    const taskRow = await prisma.task
      .findUnique({ where: { id: taskId }, select: { title: true, themeId: true } })
      .catch(() => null);
    try {
      const { escalateBlockedTask } = await import('./blocked-task-escalation');
      await escalateBlockedTask(
        prisma,
        { id: taskId, title: taskRow?.title ?? `#${taskId}`, themeId: taskRow?.themeId ?? null },
        'verify_no_convergence',
        Date.now(),
        detail,
        currentStatus ?? null,
      );
    } catch (err) {
      log.warn({ err, taskId }, '[verify-repair] Non-repairable escalation failed');
    }
    await recordTransition({
      taskId,
      fromStatus: currentStatus ?? null,
      toStatus: currentStatus ?? 'blocked',
      actor: 'system',
      cause: VERIFY_NON_REPAIRABLE_CAUSE,
      phase: 'verify',
      metadata: { reason },
    }).catch((err) =>
      log.warn({ err, taskId }, '[verify-repair] Failed to record non-repairable transition'),
    );
    log.warn({ taskId }, '[verify-repair] Tamper-only verdict — not repairable, cutting off');
    return { bounced: false, cutoffRecorded: true };
  }

  // Non-convergence cutoff (task 619): same criterion flagged 2+ times (not
  // necessarily consecutive, e.g. A→B→A) means treading water — escalate.
  const verdict = await detectRepairNonConvergence(taskId, reason);
  if (verdict.cutoff) {
    const detail = `受入基準${verdict.criterionIndex}が${verdict.count}回の差し戻しで一度も対応されていません。タスク分割または仕様の見直しが必要です。`;
    const taskRow = await prisma.task
      .findUnique({ where: { id: taskId }, select: { title: true, themeId: true } })
      .catch(() => null);
    try {
      // Dynamic import: keeps the escalation module out of this module's static graph.
      const { escalateBlockedTask } = await import('./blocked-task-escalation');
      await escalateBlockedTask(
        prisma,
        { id: taskId, title: taskRow?.title ?? `#${taskId}`, themeId: taskRow?.themeId ?? null },
        'verify_no_convergence',
        Date.now(),
        detail,
        currentStatus ?? null,
      );
    } catch (err) {
      log.warn({ err, taskId }, '[verify-repair] Non-convergence escalation failed');
    }
    // Recorded LAST so it is the latest transition — hasFreshVerifyRejection
    // reads only the newest row, and this cause must veto the executor epilogue.
    await recordTransition({
      taskId,
      fromStatus: currentStatus ?? null,
      toStatus: currentStatus ?? 'blocked',
      actor: 'system',
      cause: VERIFY_NON_CONVERGENCE_CAUSE,
      phase: 'verify',
      metadata: {
        criterionIndex: verdict.criterionIndex,
        count: verdict.count,
        reason,
      },
    }).catch((err) =>
      log.warn({ err, taskId }, '[verify-repair] Failed to record non-convergence transition'),
    );
    log.warn(
      { taskId, criterionIndex: verdict.criterionIndex, count: verdict.count },
      '[verify-repair] Repair loop not converging — cutting off (caller should block)',
    );
    return { bounced: false, cutoffRecorded: true };
  }
  // Task 755: recurring checkWorkflowInvariants violations (task #572) — see verify-invariant-repair.ts.
  const invariantWindow = await resolveRepairWindowStart(taskId);
  if (await attemptInvariantCutoff(taskId, currentStatus, reason, invariantWindow))
    return { bounced: false, cutoffRecorded: true };

  const committed = await commitVerifyRepair(prisma, {
    taskId,
    updatedAt: evaluatedTask.updatedAt,
    workflowStatus: evaluatedTask.workflowStatus,
    executionId: evaluatedExecution?.id ?? null,
    max,
    reason,
    verifyContent,
    caller,
  });
  if (!committed.committed) {
    log.info({ taskId, reason: committed.reason }, '[verify-repair] Repair admission held');
    return committed.reason === 'budget_exhausted' || committed.reason === 'repair_disabled'
      ? { bounced: false }
      : { bounced: false, stale: true };
  }
  const { attempt, newStatus } = committed;

  // Self-drive the re-run: a single/manual execution has no poller, so a
  // bounce would otherwise park the task at in-progress forever. Re-queue +
  // idempotently start the runner so implement→verify re-runs regardless of
  // launch mode.
  await ensureRunnerResumes(taskId, {
    updatedAt: committed.updatedAt,
    workflowStatus: newStatus,
    executionId: evaluatedExecution?.id ?? null,
  });

  log.info(
    { taskId, attempt, max, newStatus },
    '[verify-repair] Bounced verify failure back to implementer',
  );
  return { bounced: true, newStatus, attempt };
}

/**
 * Whether the most recent transition for this task is a fresh verify-phase
 * rejection (bounce / adversarial-review FAIL / non-convergence cutoff /
 * failed PR-creation — see rejectionCauses). The CLI executor's epilogue runs
 * AFTER the agent's HTTP verify.md save, so a bounce recorded during that save
 * must veto commit/PR/complete — without this, task 485's epilogue completed
 * seconds after the jury bounced it. The freshness window guards against stale
 * rows from a save that bypassed the HTTP handler.
 *
 * @param taskId - Task id / タスクID
 * @param windowMs - Max age for the rejection to count. / 有効期間
 * @returns True when completion must be skipped. / 完了処理を止めるべきか
 */
export async function hasFreshVerifyRejection(
  taskId: number,
  windowMs = 30 * 60_000,
): Promise<boolean> {
  const last = await prisma.workflowTransition
    .findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      select: { cause: true, createdAt: true },
    })
    .catch(() => null);
  if (!last) return false;
  // NOTE: VERIFY_NON_CONVERGENCE_CAUSE / INVARIANT_NON_CONVERGENCE_CAUSE also
  // count — a cutoff task (619, 794) must not be completed by a late epilogue
  // either. 'verify_pr_not_created' too: the HTTP gate already failed to
  // produce a PR, so without it here the epilogue retries the same doomed PR
  // attempt (task 673).
  const rejectionCauses = [
    REPAIR_CAUSE,
    'adversarial_review_failed',
    VERIFY_NON_CONVERGENCE_CAUSE,
    INVARIANT_NON_CONVERGENCE_CAUSE,
    'verify_pr_not_created',
  ];
  if (!rejectionCauses.includes(last.cause)) return false;
  return Date.now() - last.createdAt.getTime() <= windowMs;
}
