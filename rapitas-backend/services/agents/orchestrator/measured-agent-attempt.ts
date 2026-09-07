/** Flush per-call boundaries so an interrupted executor leaves a diagnosable pending attempt. */
import { randomUUID } from 'crypto';
import type { AgentExecutionResult } from '../base-agent';
import type { ExecutionFileLogger } from '../execution-file-logger';
import { executionAttemptMetrics } from './execution-attempt-metrics';

export async function runMeasuredAgentAttempt(
  execute: () => Promise<AgentExecutionResult>,
  logger: ExecutionFileLogger,
  canStart: () => boolean,
): Promise<AgentExecutionResult> {
  const attemptId = randomUUID();
  const persist = async (
    kind: 'start' | 'end',
    attempts?: AgentExecutionResult['attemptMetrics'],
  ) => {
    try {
      logger.log('INFO', 'recovery', 'execution_attempt_boundary', { attemptId, kind, attempts });
      await logger.flush();
    } catch {
      /* Measurement faults must not change the task outcome; collectors withhold missing evidence. */
    }
  };
  await persist('start');
  try {
    const result: AgentExecutionResult = canStart()
      ? await execute()
      : {
          success: false,
          output: '',
          failureType: 'cancelled',
          errorMessage: 'Execution cancelled before CLI start',
        };
    await persist('end', executionAttemptMetrics(result));
    return result;
  } catch (error) {
    await persist('end', [
      { success: false, costUsd: null, executionTimeMs: null, modelName: null },
    ]);
    throw error;
  }
}
