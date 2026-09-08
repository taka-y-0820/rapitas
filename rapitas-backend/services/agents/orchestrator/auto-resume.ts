/**
 * Auto Resume
 *
 * Automatically resumes interrupted executions — the missing link between
 * "the recovery pass marked this run interrupted" and "work actually
 * continues". Previously a HUMAN had to click the resume banner, so any
 * restart/crash stalled the autonomous pipeline until someone noticed.
 * Reuses the exact resume flow the manual button drives
 * (resume-completion.ts → orchestrator.resumeInterruptedExecution), so
 * semantics are identical to a user click. Guarded: bounded attempts per
 * execution, freshness window, and never when a newer execution already
 * took the task over. Not responsible for detecting interruptions
 * (stale-execution-recovery.ts) or the resume itself (execution-resume.ts).
 */
import { prisma } from '../../../config/database';
import { createLogger } from '../../../config/logger';
import { isTaskExecutionLocked } from '../task-execution-lock';

const log = createLogger('orchestrator:auto-resume');

/** Marker execution-resume.ts appends to output on every resume attempt. */
const RESUME_MARKER = '[再開] 中断された作業を再開します';
/** Max automatic resumes per execution — beyond this, a human (or the phase
 * retry machinery) must decide; unbounded auto-resume of a crashing run
 * would loop forever. */
const MAX_AUTO_RESUMES = 2;
/** Only resume interruptions younger than this — a days-old session has
 * stale context and the workflow has usually moved on via artifact reuse. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Cap per invocation — a mass interruption should not fan out uncontrolled. */
const MAX_PER_PASS = 3;

/**
 * Whether automatic resume is enabled. The UserSettings toggle
 * (`autoResumeInterruptedTasks`, UI: 中断タスクの自動再開) is the single
 * authority; RAPITAS_AUTO_RESUME=0/false/off is an emergency env kill switch
 * on top of it.
 */
export async function isAutoResumeEnabled(): Promise<boolean> {
  const v = (process.env.RAPITAS_AUTO_RESUME || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  const settings = await prisma.userSettings.findFirst().catch(() => null);
  return settings?.autoResumeInterruptedTasks === true;
}

/**
 * Count prior resume attempts from the output markers (persisted across
 * restarts without a schema change — execution-resume appends the marker on
 * every attempt). Pure — exported for tests.
 *
 * @param output - Execution output buffer. / 実行出力
 * @returns Number of prior resume attempts. / 過去の再開回数
 */
export function countResumeAttempts(output: string | null | undefined): number {
  if (!output) return 0;
  return output.split(RESUME_MARKER).length - 1;
}

/** Decision for one candidate (exported for tests). */
export interface AutoResumeDecision {
  resume: boolean;
  reason: string;
}

/**
 * Decide whether an interrupted execution qualifies for automatic resume.
 * Pure — the testable core.
 *
 * @param exec - Candidate execution fields. / 候補実行
 * @param opts.now - Current time. / 現在時刻
 * @param opts.hasNewerExecution - A newer execution already exists for the task. / 後続実行の有無
 * @param opts.taskStatus - The owning task's status. `blocked`/`failed` are excluded — those states can only be exited by an explicit retry. / タスク状態(`blocked`/`failed`は自動再開の対象外)
 * @param opts.hasWorkingDirectory - Theme working directory configured. / 作業Dir設定有無
 * @param opts.hasActiveLock - The shared task-execution lock is already held for this task (another run is in flight). / 排他ロック保持中か
 * @returns Whether to resume, with the reason. / 判定と理由
 */
export function decideAutoResume(
  exec: { status: string; createdAt: Date; output: string | null },
  opts: {
    now: Date;
    hasNewerExecution: boolean;
    taskStatus: string | null;
    hasWorkingDirectory: boolean;
    hasActiveLock: boolean;
    themeRunAllowed?: boolean;
  },
): AutoResumeDecision {
  if (exec.status !== 'interrupted') return { resume: false, reason: `status=${exec.status}` };
  if (opts.themeRunAllowed === false)
    return { resume: false, reason: 'theme auto-run is stopped or paused' };
  if (!opts.hasWorkingDirectory) return { resume: false, reason: 'no themeWorkingDirectory' };
  if (opts.hasActiveLock) {
    return { resume: false, reason: 'a task-execution lock is already held for this task' };
  }
  // blocked/failed are the same "explicit retry only" states as
  // task-retry-handler.ts's RETRYABLE_STATUSES — auto-resuming them replays
  // a parked-before intent and causes transition_rejected loops (task #729).
  if (
    opts.taskStatus === 'done' ||
    opts.taskStatus === 'cancelled' ||
    opts.taskStatus === 'canceled' ||
    opts.taskStatus === 'canceling' ||
    opts.taskStatus === 'blocked' ||
    opts.taskStatus === 'failed'
  ) {
    return { resume: false, reason: `task ${opts.taskStatus}` };
  }
  if (opts.hasNewerExecution) {
    return { resume: false, reason: 'a newer execution already took over the task' };
  }
  const age = opts.now.getTime() - exec.createdAt.getTime();
  if (age > MAX_AGE_MS) return { resume: false, reason: `too old (${Math.round(age / 3600000)}h)` };
  const attempts = countResumeAttempts(exec.output);
  if (attempts >= MAX_AUTO_RESUMES) {
    return { resume: false, reason: `resume budget exhausted (${attempts} attempts)` };
  }
  return { resume: true, reason: 'ok' };
}

/**
 * Attempt automatic resume for a set of just-interrupted executions.
 * Fire-and-forget friendly: never throws; every skip is logged with its
 * reason so a stalled task is diagnosable from the log alone.
 *
 * @param executionIds - Executions the recovery pass just interrupted. / 中断された実行ID
 * @returns Number of resumes started. / 再開を開始した件数
 */
export async function autoResumeInterruptedExecutions(executionIds: number[]): Promise<number> {
  if (executionIds.length === 0 || !(await isAutoResumeEnabled())) return 0;

  let started = 0;
  for (const executionId of executionIds) {
    if (started >= MAX_PER_PASS) {
      log.warn(
        { remaining: executionIds.length - started },
        '[auto-resume] per-pass cap reached — remaining interruptions left for the banner',
      );
      break;
    }
    try {
      const execution = await prisma.agentExecution.findUnique({
        where: { id: executionId },
        include: {
          session: {
            include: {
              config: {
                include: {
                  task: {
                    select: {
                      id: true,
                      themeId: true,
                      title: true,
                      description: true,
                      status: true,
                      theme: { select: { name: true, workingDirectory: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      const task = execution?.session.config?.task;
      if (!execution || !task) {
        log.info({ executionId }, '[auto-resume] skip: execution/task not found');
        continue;
      }

      const newer = await prisma.agentExecution.findFirst({
        where: {
          id: { gt: execution.id },
          status: { in: ['running', 'pending', 'waiting_for_input', 'completed'] },
          session: { config: { taskId: task.id } },
        },
        select: { id: true },
      });

      const themeRun =
        task.themeId == null
          ? null
          : await prisma.themeAutoRun.findUnique({
              where: { themeId: task.themeId },
              select: { enabled: true, status: true },
            });
      const decision = decideAutoResume(execution, {
        now: new Date(),
        hasNewerExecution: !!newer,
        taskStatus: task.status,
        hasWorkingDirectory: !!task.theme?.workingDirectory,
        hasActiveLock: isTaskExecutionLocked(task.id),
        themeRunAllowed: !themeRun || (themeRun.enabled && themeRun.status === 'running'),
      });
      if (!decision.resume) {
        log.info({ executionId, taskId: task.id, reason: decision.reason }, '[auto-resume] skip');
        continue;
      }

      const workingDirectory = task.theme!.workingDirectory!;
      await prisma.task.update({
        where: { id: task.id },
        data: { status: 'in-progress', startedAt: new Date() },
      });
      await prisma.notification
        .create({
          data: {
            type: 'agent_execution_resumed',
            title: 'エージェント実行を自動再開',
            message: `「${task.title}」の中断された作業を自動的に再開しました（再開 ${countResumeAttempts(execution.output) + 1}/${MAX_AUTO_RESUMES} 回目）。`,
            link: `/tasks/${task.id}`,
          },
        })
        .catch(() => {});

      // Same fire-and-forget completion flow the manual resume button uses.
      // Dynamic import breaks the static cycle (resume-completion →
      // orchestrator-instance → agent-orchestrator → stale-execution-recovery
      // → this module).
      const { handleResumeCompletion } = await import('./resume-completion');
      handleResumeCompletion(
        execution.id,
        execution,
        {
          id: task.id,
          title: task.title,
          description: task.description,
          theme: task.theme,
        },
        workingDirectory,
        900_000,
      );
      started++;
      log.info(
        { executionId, taskId: task.id },
        '[auto-resume] resume started (session continuity via --resume when available)',
      );
    } catch (err) {
      log.error({ err, executionId }, '[auto-resume] attempt failed (non-fatal)');
    }
  }
  return started;
}
