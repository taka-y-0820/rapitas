import type { QuestionWaitingState } from '../question-detection';
import type { WorkerResultUsageSnapshot } from './worker-message-handler';

/** Read/write state the resolver needs from the host agent. */
export interface ResolverContext {
  readonly logPrefix: string;
  readonly resumeSessionId: string | undefined;
  readonly continueConversation: boolean | undefined;

  // Buffers and accumulated state
  outputBuffer: string;
  /** Clean FINAL assistant message from the stream-json `result` event. */
  finalResultText: string;
  errorBuffer: string;
  lineBuffer: string;
  detectedQuestion: QuestionWaitingState;
  claudeSessionId: string | null;
  hasFileModifyingToolCalls: boolean;
  idleTimeoutForceKilled: boolean;
  wallClockTimeoutForceKilled: boolean;
  workerResultUsage: WorkerResultUsageSnapshot | null;

  // Mutated by the resolver
  status: string;

  // BaseAgent emit proxy
  emitOutputInternal(output: string, isError?: boolean): void;
}
