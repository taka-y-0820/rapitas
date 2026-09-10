/**
 * worker-message-handler ユニットテスト
 *
 * system-event の thinking_tokens 連続重複が outputBuffer/emitOutputInternal
 * へ何度も積み上がらず、直前と同一内容なら黙って吸収されること（初回・別バーストは
 * 通常通り通ること）を検証する。他の system-event（init/error等）は毎回そのまま
 * 通ること、重複抑制が thinking_tokens 以外に波及しないことも確認する。
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { handleWorkerMessage, type WorkerMessageContext } from './worker-message-handler';
import type { WorkerSystemEvent } from '../../../workers/output-parser-types';

function makeCtx(): WorkerMessageContext {
  return {
    logPrefix: '[Claude Code]',
    resumeSessionId: undefined,
    process: null,
    activeTools: new Map(),
    instructedModel: undefined,
    outputBuffer: '',
    finalResultText: '',
    claudeSessionId: null,
    detectedQuestion: {} as WorkerMessageContext['detectedQuestion'],
    hasFileModifyingToolCalls: false,
    workerArtifacts: [],
    workerCommits: [],
    workerResultUsage: null,
    onParseComplete: null,
    parserWorker: null,
    status: 'running',
    emitOutputInternal: mock(() => {}),
    emitQuestionDetectedInternal: mock(() => {}),
    killProcessForQuestionInternal: mock(() => {}),
  };
}

function systemEvent(subtype: string, displayOutput: string): WorkerSystemEvent {
  return { type: 'system-event', subtype, displayOutput };
}

describe('handleWorkerMessage — system-event thinking_tokens collapsing', () => {
  test('ongoing received activity remains observable at bounded intervals per execution', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const ctx = makeCtx();
      const other = makeCtx();
      const event = systemEvent('thinking_tokens', '[System: thinking_tokens]\n');
      handleWorkerMessage(ctx, event);
      clock.mockReturnValue(30_999);
      handleWorkerMessage(ctx, event);
      expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(1);
      handleWorkerMessage(other, event);
      expect(other.emitOutputInternal).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(31_000);
      handleWorkerMessage(ctx, event);
      expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(2);
      handleWorkerMessage(ctx, event);
      expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(100_000);
      // Passage of time alone does not fabricate an event.
      expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(2);
      expect(ctx.finalResultText).toBe('');
      expect(ctx.status).toBe('running');
    } finally {
      clock.mockRestore();
    }
  });

  test('a single thinking_tokens event appends and emits normally', () => {
    const ctx = makeCtx();
    handleWorkerMessage(ctx, systemEvent('thinking_tokens', '[System: thinking_tokens]\n'));
    expect(ctx.outputBuffer).toBe('[System: thinking_tokens]\n');
    expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(1);
  });

  test('consecutive identical thinking_tokens events collapse into one', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 10; i++) {
      handleWorkerMessage(ctx, systemEvent('thinking_tokens', '[System: thinking_tokens]\n'));
    }
    expect(ctx.outputBuffer).toBe('[System: thinking_tokens]\n');
    expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(1);
  });

  test('a new thinking burst after other output appends again (not permanently suppressed)', () => {
    const ctx = makeCtx();
    handleWorkerMessage(ctx, systemEvent('thinking_tokens', '[System: thinking_tokens]\n'));
    handleWorkerMessage(ctx, {
      type: 'assistant-message',
      displayOutput: 'some narrative text\n',
      toolUses: [],
    });
    handleWorkerMessage(ctx, systemEvent('thinking_tokens', '[System: thinking_tokens]\n'));

    expect(ctx.outputBuffer).toBe(
      '[System: thinking_tokens]\nsome narrative text\n[System: thinking_tokens]\n',
    );
    expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(3);
  });

  test('non-thinking system events (e.g. init) are never collapsed, even back-to-back', () => {
    const ctx = makeCtx();
    handleWorkerMessage(ctx, systemEvent('init', '[System: init]\n'));
    handleWorkerMessage(ctx, systemEvent('init', '[System: init]\n'));
    expect(ctx.outputBuffer).toBe('[System: init]\n[System: init]\n');
    expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(2);
  });

  test('an error system event still logs and appends despite the thinking_tokens guard', () => {
    const ctx = makeCtx();
    handleWorkerMessage(ctx, {
      type: 'system-event',
      subtype: 'error',
      displayOutput: '[System Error: boom]\n',
      errorMessage: 'boom',
    });
    expect(ctx.outputBuffer).toBe('[System Error: boom]\n');
    expect(ctx.emitOutputInternal).toHaveBeenCalledTimes(1);
  });
});
