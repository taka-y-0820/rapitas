/**
 * workflow-cli-executor.resume-handoff.test
 *
 * Integration test (task 900): resolvePhaseResumeDecision's coldStartReason
 * decides whether executeCLIAgent sends the short structured handoff prompt
 * (buildColdStartHandoffPrompt) or the full-context prompt
 * (buildCliAgentPrompt), and the attempt-summary log carries all 9 fields
 * without leaking the prompt body.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  wf,
  spies,
  resetWfMockState,
  installWorkflowCliExecutorMocks,
} from '../../tests/helpers/workflow-cli-executor-mock-state';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';

installWorkflowCliExecutorMocks();

// resolvePhaseResumeDecision — controlled per test via `resumeDecisionResult`.
let resumeDecisionResult: { sessionId: string | null; coldStartReason: string } = {
  sessionId: null,
  coldStartReason: 'no_prior_session',
};
const resolvePhaseResumeDecisionMock = mock(() => Promise.resolve(resumeDecisionResult));
mock.module('./phase-session-resume', () => ({
  resolvePhaseResumeDecision: resolvePhaseResumeDecisionMock,
}));

// Distinguishable markers so the test can tell which builder produced the
// prompt handed to orchestrator.executeTask, without depending on either
// builder's real (much longer) output shape.
mock.module('./workflow-cli-executor-prompt', () => ({
  buildCliAgentPrompt: mock(() => 'FULL_CONTEXT_PROMPT_MARKER'),
}));
mock.module('./workflow-cli-executor-coldstart-prompt', () => ({
  buildColdStartHandoffPrompt: mock(() => 'COLDSTART_HANDOFF_PROMPT_MARKER'),
}));

// log.info spy — the shared install() registers a plain noopLogger (no
// `.mock.calls`); override with a spy-able one for this file only.
const logInfoSpy = mock(() => {});
mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: logInfoSpy, warn: () => {}, error: () => {}, debug: () => {} }),
  logger: { info: logInfoSpy, warn: () => {}, error: () => {}, debug: () => {} },
  getBackendLogFilePath: () => '',
}));

const { executeCLIAgent } = await import('./workflow-cli-executor');

const getOrCreateDevConfig = (): Promise<{ id: number }> => Promise.resolve({ id: 42 });
const task = { title: 'Finish the thing', description: 'desc' };
const agentConfig = { id: 1, agentType: 'claude-code', name: 'Agent', modelId: 'claude-sonnet-5' };

function implementerTransition(): RoleTransition {
  return { role: 'implementer', outputFile: null, nextStatus: 'verify_done' };
}

const noopAdvance = (): Promise<WorkflowAdvanceResult> =>
  Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' });

async function run(): Promise<WorkflowAdvanceResult> {
  return executeCLIAgent(
    1,
    task,
    agentConfig,
    'system prompt',
    'context',
    implementerTransition(),
    'ja',
    noopAdvance,
    getOrCreateDevConfig,
  );
}

describe('executeCLIAgent — resume/cold-start handoff (task 900)', () => {
  beforeEach(() => {
    resetWfMockState();
    resolvePhaseResumeDecisionMock.mockClear();
    logInfoSpy.mockClear();
    resumeDecisionResult = { sessionId: null, coldStartReason: 'no_prior_session' };
  });

  test('coldStartReason=prompt_too_long_exhausted → sends the short handoff prompt, not the full-context one', async () => {
    resumeDecisionResult = { sessionId: null, coldStartReason: 'prompt_too_long_exhausted' };

    await run();

    const [, options] = spies.executeTask.mock.calls[0] as [
      { description: string },
      Record<string, unknown>,
    ];
    expect(options).toBeDefined();
    const [callArgs] = spies.executeTask.mock.calls[0] as [{ description: string }];
    expect(callArgs.description).toBe('COLDSTART_HANDOFF_PROMPT_MARKER');
  });

  test('coldStartReason=resumed → sends the full-context prompt', async () => {
    resumeDecisionResult = { sessionId: 'session-abc', coldStartReason: 'resumed' };

    await run();

    const [callArgs] = spies.executeTask.mock.calls[0] as [{ description: string }];
    expect(callArgs.description).toBe('FULL_CONTEXT_PROMPT_MARKER');
  });

  test('coldStartReason=no_prior_session → sends the full-context prompt', async () => {
    resumeDecisionResult = { sessionId: null, coldStartReason: 'no_prior_session' };

    await run();

    const [callArgs] = spies.executeTask.mock.calls[0] as [{ description: string }];
    expect(callArgs.description).toBe('FULL_CONTEXT_PROMPT_MARKER');
  });

  test('resumeSessionId option carries the decision sessionId (undefined when null)', async () => {
    resumeDecisionResult = { sessionId: 'session-xyz', coldStartReason: 'resumed' };

    await run();

    const [, options] = spies.executeTask.mock.calls[0] as [unknown, { resumeSessionId?: string }];
    expect(options.resumeSessionId).toBe('session-xyz');
  });

  test('attempt-summary log carries all 9 fields and never the prompt body', async () => {
    resumeDecisionResult = { sessionId: null, coldStartReason: 'prompt_too_long_exhausted' };
    wf.executeTaskImpl = async () => ({
      success: true,
      output: 'agent output',
      modelName: 'claude-sonnet-5-actual',
    });

    await run();

    const summaryCall = logInfoSpy.mock.calls.find(
      (c) => c[1] === '[WorkflowCLIExecutor] Attempt summary',
    ) as [Record<string, unknown>, string] | undefined;
    expect(summaryCall).toBeDefined();
    const fields = summaryCall![0];
    expect(fields.taskId).toBe(1);
    expect(fields.role).toBe('implementer');
    expect(typeof fields.attemptId).toBe('number');
    expect(fields.promptChars).toBe('COLDSTART_HANDOFF_PROMPT_MARKER'.length);
    expect(fields.promptBytes).toBe(Buffer.byteLength('COLDSTART_HANDOFF_PROMPT_MARKER', 'utf8'));
    expect(fields.sessionReused).toBe(false);
    expect(fields.coldStartReason).toBe('prompt_too_long_exhausted');
    expect(fields.requestedModel).toBe('claude-sonnet-5');
    expect(fields.actualModel).toBe('claude-sonnet-5-actual');
    expect(fields.endReason).toBe('success');
    // Never the prompt body or its marker string leaking into the log record.
    expect(JSON.stringify(fields)).not.toContain('COLDSTART_HANDOFF_PROMPT_MARKER');
  });

  test('attempt-summary log endReason reflects failureType over generic failed', async () => {
    resumeDecisionResult = { sessionId: null, coldStartReason: 'no_prior_session' };
    wf.executeTaskImpl = async () => ({
      success: false,
      output: '',
      failureType: 'prompt_too_long',
      errorMessage: 'boom',
    });

    await run();

    const summaryCall = logInfoSpy.mock.calls.find(
      (c) => c[1] === '[WorkflowCLIExecutor] Attempt summary',
    ) as [Record<string, unknown>, string] | undefined;
    expect(summaryCall![0].endReason).toBe('prompt_too_long');
  });
});
