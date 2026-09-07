/** Read measured attempts from one unambiguous execution log; never infer them from DB defaults. */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { AgentExecutionResult } from '../base-agent';

export async function readExecutionAttemptMetrics(
  executionId: number,
  sessionId: number,
  logDir = join(process.cwd(), 'logs', 'agent-executions'),
): Promise<AgentExecutionResult['attemptMetrics'] | null> {
  try {
    const names = (await readdir(logDir)).filter(
      (name) => name.startsWith(`exec-${executionId}-`) && name.endsWith('.log'),
    );
    if (names.length !== 1) return null;
    const content = await readFile(join(logDir, names[0]), 'utf8');
    const marker = /^\[STRUCTURED DATA \(JSON\)\]\r?$/gm;
    const matches = [...content.matchAll(marker)];
    const last = matches[matches.length - 1];
    if (!last) return null;
    const tail = content.slice(last.index! + last[0].length);
    const data = JSON.parse(tail.slice(tail.indexOf('{')));
    if (data.summary?.executionId !== executionId || data.summary?.sessionId !== sessionId)
      return null;
    let attempts: unknown[];
    if (data.attemptJournal !== undefined && !Array.isArray(data.attemptJournal)) return null;
    if (data.attemptJournal?.length) {
      attempts = [];
      const seen = new Set<string>();
      let pending: string | null = null;
      for (const boundary of data.attemptJournal) {
        if (!boundary || typeof boundary.attemptId !== 'string' || !boundary.attemptId) return null;
        if (boundary.kind === 'start') {
          if (pending !== null || seen.has(boundary.attemptId)) return null;
          seen.add(boundary.attemptId);
          pending = boundary.attemptId;
        } else if (boundary.kind === 'end') {
          if (
            pending !== boundary.attemptId ||
            !Array.isArray(boundary.attempts) ||
            !boundary.attempts.length
          )
            return null;
          attempts.push(...boundary.attempts);
          pending = null;
        } else return null;
      }
      if (pending !== null || !attempts.length) return null;
    } else {
      // Legacy fully saved results remain readable; incomplete new journals
      // never fall back to this summary and cannot hide a missing attempt.
      if (
        !['completed', 'failed', 'cancelled', 'interrupted', 'post_processing'].includes(
          data.summary?.status,
        )
      )
        return null;
      const measurement = data.attemptMeasurements?.at(-1);
      if (
        measurement?.settled !== true ||
        measurement?.executionId !== executionId ||
        measurement?.sessionId !== sessionId ||
        !Array.isArray(measurement.attempts) ||
        !measurement.attempts.length
      )
        return null;
      attempts = measurement.attempts;
    }
    for (const value of attempts) {
      const attempt = value as NonNullable<AgentExecutionResult['attemptMetrics']>[number];
      if (
        !attempt ||
        typeof attempt.success !== 'boolean' ||
        !(
          attempt.costUsd === null ||
          (typeof attempt.costUsd === 'number' &&
            Number.isFinite(attempt.costUsd) &&
            attempt.costUsd >= 0)
        ) ||
        !(
          attempt.executionTimeMs === null ||
          (typeof attempt.executionTimeMs === 'number' &&
            Number.isFinite(attempt.executionTimeMs) &&
            attempt.executionTimeMs >= 0)
        ) ||
        !(
          attempt.modelName === null ||
          (typeof attempt.modelName === 'string' && attempt.modelName.trim())
        )
      )
        return null;
    }
    return attempts as AgentExecutionResult['attemptMetrics'];
  } catch {
    return null;
  }
}
