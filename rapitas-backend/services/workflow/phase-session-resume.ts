/**
 * PhaseSessionResume
 *
 * Resolves the Claude Code CLI session id that the NEXT run of the same
 * workflow role on the same task should continue via `--resume`, so a repair
 * bounce keeps the conversation it just had instead of cold-starting.
 * Not responsible for deciding whether a phase re-runs (the orchestrator does
 * that) nor for passing the id to the CLI (see task-executor / agent-factory).
 *
 * Measured 2026-08-18: 415 completed executions used 415 distinct CLI
 * sessions — zero reuse — rebuilding ~105,000 tokens of context per phase,
 * while 33 tasks bounced through verify_repair 52 times, each bounce re-running
 * the implementer from scratch (median 9.6 min).
 */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { classifySessionFailureReason } from '../agents/claude-code/failure-reason-markers';

const log = createLogger('workflow:phase-session-resume');

/** Roles whose re-runs benefit from continuing the previous conversation. */
const RESUMABLE_ROLES = new Set(['implementer', 'verifier']);

/**
 * How many recent runs of the role to consider. A task can accumulate several
 * sessions across worktree re-creations; only one of them was filed under the
 * directory we are about to run in, so look past the newest few.
 */
const CANDIDATE_LIMIT = 5;

/**
 * Map a working directory to the Claude Code CLI's per-project session folder.
 *
 * NOTE: This mirrors an INTERNAL CLI convention (observed 2026-08-18:
 * `C:\Projects\rapitas\.worktrees\task-643-93ba4c5c` →
 * `C--Projects-rapitas--worktrees-task-643-93ba4c5c`), so it is only ever used
 * to CONFIRM a session file exists. If the convention changes the lookup misses
 * and we simply cold-start, which is exactly today's behaviour.
 *
 * @param cwd - Absolute working directory of the run. / 実行の作業ディレクトリ
 * @returns Absolute path to the CLI's session folder. / CLIセッション保存フォルダ
 */
export function claudeProjectDirFor(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[:\\/.]/g, '-'));
}

/**
 * Whether the CLI still holds the transcript for `sessionId` under `cwd`.
 * A `--resume` against a pruned session fails the run, so this is checked
 * before the id is ever handed to the CLI.
 *
 * @param cwd - Working directory the session was recorded in. / 記録時の作業ディレクトリ
 * @param sessionId - Claude CLI session id. / CLIセッションID
 * @returns true when the transcript file is present. / トランスクリプトがあれば true
 */
export function claudeSessionExists(cwd: string, sessionId: string): boolean {
  try {
    return existsSync(join(claudeProjectDirFor(cwd), `${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

/** Inputs needed to decide whether a phase may resume a prior CLI session. */
export interface PhaseResumeQuery {
  taskId: number;
  /** Workflow role about to run (implementer / verifier / ...). */
  role: string;
  /** Working directory this phase will run in. */
  workingDirectory: string;
  /** Agent type resolved for this phase. */
  agentType?: string | null;
}

/**
 * Positional convenience wrapper over {@link resolvePhaseResumeSessionId} that
 * returns `undefined` (not `null`) so it drops straight into ExecutionOptions.
 * Exists so the call site in the oversized workflow-cli-executor stays one line.
 *
 * @param taskId - Task about to run a phase. / 実行するタスク
 * @param role - Workflow role. / ロール
 * @param workingDirectory - Directory the phase runs in. / 実行ディレクトリ
 * @param agentType - Resolved agent type. / エージェント種別
 * @returns Session id to resume, or undefined. / 再開するID、無ければ undefined
 */
export async function resumeSessionIdFor(
  taskId: number,
  role: string,
  workingDirectory: string,
  agentType?: string | null,
): Promise<string | undefined> {
  return (
    (await resolvePhaseResumeSessionId({ taskId, role, workingDirectory, agentType })) ?? undefined
  );
}

/**
 * Why a phase is about to cold-start (or resumed anyway despite a prior
 * failure). `resumed` covers BOTH the plain resume case and the
 * auth/transient-recoverable case — workflow-cli-executor.ts only branches on
 * `prompt_too_long_exhausted` to pick the short structured handoff prompt.
 */
export type PhaseResumeColdStartReason =
  | 'resumed'
  | 'no_prior_session'
  | 'prompt_too_long_exhausted'
  | 'other_failure_exhausted'
  | 'transcript_missing'
  | 'lookup_error';

/** Full decision: the session id (or null) plus why. */
export interface PhaseResumeDecision {
  sessionId: string | null;
  coldStartReason: PhaseResumeColdStartReason;
}

/**
 * Resolve the CLI session id this phase should resume, plus why (so a
 * `prompt_too_long_exhausted` cold-start can switch to a short structured
 * handoff prompt instead of the full context — task 900).
 *
 * Every guard below exists because resuming the WRONG session is worse than
 * cold-starting: the CLI would replay another task's or another role's
 * conversation into this phase.
 *
 * @param q - Task, role, working directory and agent type. / タスク・ロール・作業ディレクトリ・エージェント種別
 * @returns Session id to pass as `--resume` (or null) plus the cold-start reason. / 再開ID（無ければnull）とコールドスタート理由
 */
export async function resolvePhaseResumeDecision(
  q: PhaseResumeQuery,
): Promise<PhaseResumeDecision> {
  const noSession = (coldStartReason: PhaseResumeColdStartReason): PhaseResumeDecision => ({
    sessionId: null,
    coldStartReason,
  });

  if (process.env.RAPITAS_PHASE_SESSION_RESUME === '0') return noSession('no_prior_session');
  // Only the Claude CLI takes a `--resume <uuid>` of this shape; codex and
  // gemini have their own session/checkpoint identifiers.
  if (q.agentType && q.agentType !== 'claude-code') return noSession('no_prior_session');
  if (!RESUMABLE_ROLES.has(q.role)) return noSession('no_prior_session');
  if (!q.workingDirectory) return noSession('no_prior_session');

  try {
    // NOTE: Deliberately NOT filtered on AgentSession.worktreePath. That column
    // is cleared when a task's worktree is cleaned up (measured 2026-08-18:
    // populated for only 72% of implementer sessions and 4% of planner ones,
    // and session 2654 lost its value between two reads minutes apart), so
    // matching on it silently disabled this optimisation. The on-disk check
    // below is the STRONGER test anyway: the CLI itself filed the transcript
    // under the cwd, so its presence proves the session belongs to this
    // directory regardless of what the DB column says.
    const candidates = await prisma.agentExecution.findMany({
      where: {
        status: 'completed',
        claudeSessionId: { not: null },
        session: { mode: `workflow-${q.role}`, config: { taskId: q.taskId } },
      },
      orderBy: { id: 'desc' },
      take: CANDIDATE_LIMIT,
      select: { id: true, claudeSessionId: true },
    });

    // Tracks the reason a candidate was excluded, so the final "give up"
    // return (below the loop) still reports WHY instead of a generic
    // no_prior_session — carried across candidates so the LAST exclusion
    // reason wins if every candidate is disqualified for different reasons.
    let disqualifyReason: PhaseResumeColdStartReason | null = null;

    for (const candidate of candidates) {
      const sessionId = candidate.claudeSessionId;
      if (!sessionId || !claudeSessionExists(q.workingDirectory, sessionId)) continue;
      // A session whose most recent resume already FAILED may still be exhausted:
      // task 894 (2026-09-08) hit "Prompt is too long" on --resume and the
      // runner retried the identical resume three times before blocking.
      // Auth/transient failures are recoverable (re-authenticating or a
      // provider blip doesn't poison the session), so only prompt_too_long
      // and unclassified failures stay excluded (task 900).
      const failedResume = await prisma.agentExecution.findFirst({
        where: { claudeSessionId: sessionId, status: 'failed' },
        orderBy: { id: 'desc' },
        select: { id: true, errorMessage: true },
      });
      if (failedResume) {
        const reason = classifySessionFailureReason(failedResume.errorMessage);
        if (reason === 'auth' || reason === 'transient') {
          log.info(
            {
              taskId: q.taskId,
              role: q.role,
              sessionId,
              failedExecutionId: failedResume.id,
              reason,
            },
            '[phase-resume] Prior resume failed for a recoverable reason (auth/transient) — still eligible to resume',
          );
          return { sessionId, coldStartReason: 'resumed' };
        }
        disqualifyReason =
          reason === 'prompt_too_long' ? 'prompt_too_long_exhausted' : 'other_failure_exhausted';
        log.info(
          { taskId: q.taskId, role: q.role, sessionId, failedExecutionId: failedResume.id, reason },
          '[phase-resume] Prior resume of this session failed — cold-starting',
        );
        continue;
      }
      log.info(
        { taskId: q.taskId, role: q.role, sessionId, previousExecutionId: candidate.id },
        '[phase-resume] Resuming the previous CLI session for this role',
      );
      return { sessionId, coldStartReason: 'resumed' };
    }

    if (candidates.length > 0) {
      log.info(
        { taskId: q.taskId, role: q.role, examined: candidates.length },
        '[phase-resume] No prior CLI transcript under this directory — cold-starting',
      );
    }
    return noSession(
      disqualifyReason ?? (candidates.length > 0 ? 'transcript_missing' : 'no_prior_session'),
    );
  } catch (err) {
    // Never let this optimisation block a phase from running.
    log.warn(
      { err, taskId: q.taskId, role: q.role },
      '[phase-resume] Lookup failed — cold-starting',
    );
    return noSession('lookup_error');
  }
}

/**
 * Resolve the CLI session id this phase should resume, or null to cold-start.
 * Thin wrapper over {@link resolvePhaseResumeDecision} for callers that only
 * need the session id (kept so its 8 pre-existing tests need no changes).
 *
 * @param q - Task, role, working directory and agent type. / タスク・ロール・作業ディレクトリ・エージェント種別
 * @returns Session id to pass as `--resume`, or null. / `--resume` に渡すID、無ければ null
 */
export async function resolvePhaseResumeSessionId(q: PhaseResumeQuery): Promise<string | null> {
  return (await resolvePhaseResumeDecision(q)).sessionId;
}
