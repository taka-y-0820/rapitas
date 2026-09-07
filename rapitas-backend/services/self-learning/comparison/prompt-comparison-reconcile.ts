/** Recover missed outcome appends from authoritative terminal sessions, never from assignment alone. */
import { prisma } from '../../../config/database';
import { classifyFailureCause } from './prompt-comparison-metrics';
import { readComparisonRecord, recordComparisonRun } from './prompt-comparison-store';
import { readTrialManifest } from './prompt-comparison-trial-manifest';

export interface TrialSessionSnapshot {
  id: number;
  status: string;
  mode: string | null;
  config: { taskId: number };
  agentExecutions: {
    id: number;
    status: string;
    modelName: string | null;
    costUsd: unknown;
    executionTimeMs: number | null;
    startedAt: Date | null;
    completedAt: Date | null;
    errorMessage: string | null;
  }[];
}

type SessionLoader = (ids: number[]) => Promise<TrialSessionSnapshot[]>;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

async function loadSessions(ids: number[]): Promise<TrialSessionSnapshot[]> {
  return prisma.agentSession.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      mode: true,
      config: { select: { taskId: true } },
      agentExecutions: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          modelName: true,
          costUsd: true,
          executionTimeMs: true,
          startedAt: true,
          completedAt: true,
          errorMessage: true,
        },
      },
    },
  });
}

export interface TrialRecoveryResult {
  recovered: number;
  pending: number;
  issues: { assignmentId: string; reason: string }[];
}

/**
 * The first bound session defines the trial attempt. A successful retry cannot
 * replace a failed/missing first attempt. No DB statuses or stored outcomes are
 * changed. Session/role/task and pre-execution injection proof must all agree.
 */
export async function reconcileTrialOutcomes(
  id: number,
  loader: SessionLoader = loadSessions,
): Promise<TrialRecoveryResult> {
  const result: TrialRecoveryResult = { recovered: 0, pending: 0, issues: [] };
  const manifest = readTrialManifest(id);
  const record = readComparisonRecord(id);
  if (!manifest || !record) return result;
  const recorded = new Set(record.arms.flatMap((cell) => cell.runs).map((run) => run.assignmentId));
  const missing = manifest.slots.filter((slot) => !recorded.has(slot.id));
  const ids = [
    ...new Set(missing.map((slot) => slot.sessionIds[0]).filter((sid) => sid !== undefined)),
  ];
  const sessions = new Map<number, TrialSessionSnapshot>();
  try {
    for (let offset = 0; offset < ids.length; offset += 100) {
      for (const session of await loader(ids.slice(offset, offset + 100)))
        sessions.set(session.id, session);
    }
  } catch {
    result.pending = missing.length;
    result.issues.push({ assignmentId: '*', reason: 'session_read_failed' });
    return result;
  }
  for (const slot of missing) {
    const fail = (reason: string) => result.issues.push({ assignmentId: slot.id, reason });
    const sid = slot.sessionIds[0];
    if (sid === undefined) {
      result.pending++;
      fail('session_not_bound');
      continue;
    }
    const session = sessions.get(sid);
    if (!session) {
      fail('session_missing');
      continue;
    }
    if (session.config.taskId !== slot.taskId || session.mode !== `workflow-${manifest.role}`) {
      fail('session_identity_mismatch');
      continue;
    }
    if (
      !TERMINAL.has(session.status) ||
      session.agentExecutions.some((e) => !TERMINAL.has(e.status))
    ) {
      result.pending++;
      continue;
    }
    const proof = slot.injectionProofs?.find((p) => p.sessionId === sid);
    if (
      !proof ||
      proof.controlVersion !== manifest.controlVersion ||
      (slot.arm === 'candidate' &&
        (!proof.injected || proof.injectedVersion !== manifest.candidateVersion)) ||
      (slot.arm === 'current' && proof.injected)
    ) {
      fail('injection_proof_missing_or_mismatched');
      continue;
    }
    const execution = session.agentExecutions[0];
    if (!execution) {
      fail('execution_missing');
      continue;
    }
    const durationMs =
      execution.executionTimeMs ??
      (execution.completedAt && execution.startedAt
        ? execution.completedAt.getTime() - execution.startedAt.getTime()
        : NaN);
    const costUsd = Number(execution.costUsd);
    if (
      !execution.modelName?.trim() ||
      execution.costUsd == null ||
      !Number.isFinite(costUsd) ||
      costUsd < 0 ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      fail('execution_metadata_incomplete');
      continue;
    }
    const success = session.status === 'completed' && execution.status === 'completed';
    const saved = recordComparisonRun(id, slot.arm, {
      assignmentId: slot.id,
      taskId: slot.taskId,
      executionId: execution.id,
      recoveredFromSessionId: sid,
      success,
      costUsd,
      durationMs,
      failureCause: success
        ? null
        : classifyFailureCause({
            status: session.status === 'cancelled' ? 'cancelled' : execution.status,
            errorMessage: execution.errorMessage,
          }),
      role: manifest.role,
      modelName: execution.modelName,
      injected: proof.injected,
      injectedVersion: proof.injectedVersion,
      controlVersion: proof.controlVersion,
    });
    if (saved) result.recovered++;
    else {
      // A concurrent live writer may have won; distinguish that from lost I/O.
      const now = readComparisonRecord(id);
      if (!now?.arms.some((c) => c.runs.some((r) => r.assignmentId === slot.id)))
        fail('outcome_write_failed');
    }
  }
  return result;
}
