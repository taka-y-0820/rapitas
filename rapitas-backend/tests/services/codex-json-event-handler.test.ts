import { describe, expect, mock, test } from 'bun:test';
import { createInitialWaitingState } from '../../services/agents/question-detection';
import type {
  ProcessRunnerCallbacks,
  ProcessRunnerState,
} from '../../services/agents/codex-cli-agent/process-runner';

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { processJsonEvent } =
  await import('../../services/agents/codex-cli-agent/json-event-handler');

function createHarness() {
  const emitted: string[] = [];
  const sessionIds: string[] = [];
  const state: ProcessRunnerState = {
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
  };
  const callbacks: ProcessRunnerCallbacks = {
    emitOutput: (text) => emitted.push(text),
    emitQuestionDetected: () => {},
    onSessionId: (sessionId) => sessionIds.push(sessionId),
    onQuestionDetected: () => {},
    onStatusChange: (status) => {
      state.status = status;
    },
    logPrefix: '[Codex]',
  };

  return { state, callbacks, emitted, sessionIds };
}

describe('codex json-event-handler', () => {
  test('captures Codex 0.125 thread.started as resumable session id', () => {
    const h = createHarness();

    processJsonEvent(
      { type: 'thread.started', thread_id: '019ddcde-c04a-7b60-923a-fed5acf26038' },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.codexSessionId).toBe('019ddcde-c04a-7b60-923a-fed5acf26038');
    expect(h.sessionIds).toEqual(['019ddcde-c04a-7b60-923a-fed5acf26038']);
    expect(h.emitted).toEqual([]);
  });

  test('emits current Codex error events to the live output buffer', () => {
    const h = createHarness();

    processJsonEvent(
      { type: 'error', message: 'stream disconnected before completion' },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toContain('[Error] stream disconnected before completion');
    expect(h.emitted.join('')).toContain('[Error] stream disconnected before completion');
  });

  test('emits turn.failed without pre-resolving runner status', () => {
    const h = createHarness();

    processJsonEvent(
      {
        type: 'turn.failed',
        error: { message: 'thread/start failed' },
      },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toContain('[Result: failed]');
    expect(h.state.outputBuffer).toContain('thread/start failed');
    expect(h.state.status).toBe('running');
    expect(h.state.turnFailed).toBe(true);
    expect(h.state.turnFailureMessage).toBe('thread/start failed');
  });

  test('a second turn.failed does not overwrite the first failure message', () => {
    const h = createHarness();

    processJsonEvent(
      { type: 'turn.failed', error: { message: 'first failure' } },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );
    processJsonEvent(
      { type: 'turn.failed', error: { message: 'second failure' } },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.turnFailed).toBe(true);
    expect(h.state.turnFailureMessage).toBe('first failure');
  });

  test('item.completed with agent_message text appends it to the output buffer', () => {
    const h = createHarness();

    processJsonEvent(
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: '最終回答のテキストです' },
      },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toContain('最終回答のテキストです');
    expect(h.emitted.join('')).toContain('最終回答のテキストです');
  });

  test('item.started for an unrecognized item.type is ignored without throwing or producing output', () => {
    const h = createHarness();

    processJsonEvent(
      { type: 'item.started', item: { type: 'reasoning' } },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toBe('');
    expect(h.emitted).toEqual([]);
  });

  test('item.updated is always a full no-op regardless of item.type', () => {
    const h = createHarness();
    h.state.activeCodexCommands.set('cmd-1', { command: 'ls -la', startedAt: Date.now() });

    processJsonEvent(
      { type: 'item.updated', item: { type: 'command_execution', id: 'cmd-1' } },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toBe('');
    expect(h.emitted).toEqual([]);
    expect(h.state.activeCodexCommands.has('cmd-1')).toBe(true);
  });

  test('item.completed with an unrecognized item.type produces no display output', () => {
    const h = createHarness();

    processJsonEvent(
      { type: 'item.completed', item: { type: 'reasoning', text: 'internal thought' } },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toBe('');
    expect(h.emitted).toEqual([]);
  });

  test('item.started with command_execution registers the command and shows a start line', () => {
    const h = createHarness();

    processJsonEvent(
      { type: 'item.started', item: { type: 'command_execution', id: 'cmd-1', command: 'ls -la' } },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toContain('[Command] ls -la を開始しました');
    expect(h.state.activeCodexCommands.get('cmd-1')).toMatchObject({ command: 'ls -la' });
  });

  test('item.completed with command_execution and exit_code 0 shows a success line and clears the Map', () => {
    const h = createHarness();
    h.state.activeCodexCommands.set('cmd-1', { command: 'ls -la', startedAt: Date.now() });

    processJsonEvent(
      {
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd-1', command: 'ls -la', exit_code: 0 },
      },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toContain('[Command Done] ls -la');
    expect(h.state.outputBuffer).toContain('exit 0');
    expect(h.state.activeCodexCommands.has('cmd-1')).toBe(false);
  });

  test('item.completed with command_execution and a non-zero exit_code shows a failed line without affecting turnFailed', () => {
    const h = createHarness();
    h.state.activeCodexCommands.set('cmd-1', { command: 'npm test', startedAt: Date.now() });

    processJsonEvent(
      {
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd-1', command: 'npm test', exit_code: 1 },
      },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toContain('[Command Failed] npm test');
    expect(h.state.outputBuffer).toContain('exit 1');
    expect(h.state.turnFailed).toBe(false);
  });

  test('item.completed with command_execution missing exit_code falls back to item.status', () => {
    const h = createHarness();

    processJsonEvent(
      {
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd-2', command: 'git status', status: 'failed' },
      },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toContain('[Command Failed] git status');
  });

  test('item.completed with command_execution and no matching item.started omits the duration but still shows the command', () => {
    const h = createHarness();

    processJsonEvent(
      {
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd-missing', command: 'echo hi', exit_code: 0 },
      },
      h.state,
      h.callbacks,
      {},
      '[Codex]',
    );

    expect(h.state.outputBuffer).toContain('[Command Done] echo hi (exit 0)');
  });
});
