/**
 * process-runner-close-result.test
 *
 * Direct unit tests for `isSuccessfulClose`/`buildCloseResult`, split out of
 * process-runner.ts (task #879). Covers the code x turnFailed combinations
 * and the hasQuestion-priority regression without spawning any process.
 */
import { describe, test, expect } from 'bun:test';
import { createInitialWaitingState } from '../question-detection';
import type { ProcessRunnerState } from './process-runner';
import { buildCloseResult, isSuccessfulClose } from './process-runner-close-result';
import type { AgentArtifact, GitCommitInfo } from '../base-agent';

function makeState(overrides: Partial<ProcessRunnerState> = {}): ProcessRunnerState {
  return {
    process: null,
    outputBuffer: '',
    errorBuffer: '',
    lineBuffer: '',
    detectedQuestion: createInitialWaitingState(),
    activeTools: new Map(),
    codexSessionId: null,
    actualModel: null,
    status: 'running',
    turnFailed: false,
    turnFailureMessage: null,
    activeCodexCommands: new Map(),
    ...overrides,
  };
}

const noArtifacts = (): AgentArtifact[] => [];
const noCommits = (): GitCommitInfo[] => [];

describe('isSuccessfulClose', () => {
  test('code 0 and turnFailed false is successful', () => {
    expect(isSuccessfulClose(0, makeState({ turnFailed: false }))).toBe(true);
  });

  test('code 0 and turnFailed true is not successful', () => {
    expect(isSuccessfulClose(0, makeState({ turnFailed: true }))).toBe(false);
  });

  test('non-zero code and turnFailed false is not successful', () => {
    expect(isSuccessfulClose(1, makeState({ turnFailed: false }))).toBe(false);
  });

  test('null code is not successful', () => {
    expect(isSuccessfulClose(null, makeState({ turnFailed: false }))).toBe(false);
  });
});

describe('buildCloseResult', () => {
  test('code 0 without turnFailed resolves success:true (regression)', () => {
    const result = buildCloseResult(0, makeState(), {}, Date.now(), noArtifacts, noCommits);
    expect(result.success).toBe(true);
    expect(result.errorMessage).toBeUndefined();
  });

  test('code 0 with turnFailed and a message builds a Codex-turn-failed error', () => {
    const state = makeState({ turnFailed: true, turnFailureMessage: 'context window exceeded' });
    const result = buildCloseResult(0, state, {}, Date.now(), noArtifacts, noCommits);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('Codexターンが失敗しました: context window exceeded');
  });

  test('code 0 with turnFailed and no message uses the fallback error text', () => {
    const state = makeState({ turnFailed: true, turnFailureMessage: null });
    const result = buildCloseResult(0, state, {}, Date.now(), noArtifacts, noCommits);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('Codexターンが失敗しました (turn.failed イベントを受信)');
  });

  test('non-zero code does not duplicate the turnFailed message', () => {
    const state = makeState({ turnFailed: true, turnFailureMessage: 'context window exceeded' });
    const result = buildCloseResult(1, state, {}, Date.now(), noArtifacts, noCommits);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('プロセスがコード 1 で終了しました');
    expect(result.errorMessage).not.toContain('Codexターンが失敗しました');
  });

  test('a pending question takes priority over turnFailed (existing behavior)', () => {
    const state = makeState({
      turnFailed: true,
      turnFailureMessage: 'context window exceeded',
      detectedQuestion: {
        hasQuestion: true,
        question: 'どちら?',
        questionType: 'tool_call',
      },
    });
    const result = buildCloseResult(0, state, {}, Date.now(), noArtifacts, noCommits);
    expect(result.waitingForInput).toBe(true);
    expect(result.success).toBe(true);
  });
});
