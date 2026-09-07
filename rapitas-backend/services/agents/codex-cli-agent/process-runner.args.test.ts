/**
 * process-runner.args.test
 *
 * Covers the CLI-argument construction branches inside `spawnCodexProcess`
 * (implementation / yolo / sandbox / investigation / resume modes) and the
 * low-level spawn wiring (cwd, shell options, stdio, stdin, PID reporting,
 * synchronous spawn failure). Pure builder functions (`buildSpawnCommand`,
 * `buildProcessEnv`, `normalizeCodexModel`) are covered directly in
 * process-runner.spawn.test.ts; event-parsing coordination lives in
 * process-runner.events.test.ts / process-runner.timing.test.ts; close/error
 * handling lives in process-runner.errors.test.ts.
 *
 * `child_process.spawn` is mocked end-to-end — no real Codex CLI process is
 * ever spawned. `./types` is mocked so `resolveCliPath` never shells out to
 * `where codex.cmd` for real on this Windows test machine.
 *
 * NOTE: spawnCodexProcess computes `isWindows = process.platform === 'win32'`
 * internally and passes it to buildSpawnCommand, which only flattens args
 * into a single chcp-prefixed command string when isWindows is true. Every
 * assertion in this file checks `spawnCalls[0].command` as that flattened
 * string, so process.platform is pinned to 'win32' for the whole file —
 * without it, CI(Linux) got the unflattened `[codexPath, args]` array back
 * and every `command.toContain(...)` assertion failed (task #869).
 */
import { describe, test, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';
import { createInitialWaitingState } from '../question-detection';
import type { ProcessRunnerState } from './process-runner';

// ── child_process mock ──────────────────────────────────────────────────────

type MutableStream = EventEmitter & { setEncoding: (enc: string) => void };

function makeStream(): MutableStream {
  const em = new EventEmitter() as MutableStream;
  em.setEncoding = mock(() => {});
  return em;
}

/** Minimal stand-in for Node's ChildProcess, driven manually by tests. */
class MockChild extends EventEmitter {
  pid = 4242;
  killed = false;
  stdout = makeStream();
  stderr = makeStream();
  stdin = Object.assign(new EventEmitter(), {
    write: mock((_data: string) => {}),
    end: mock(() => {}),
    setDefaultEncoding: mock((_enc: string) => {}),
  });
  kill = mock((_signal?: string) => {
    this.killed = true;
  });
}

let spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let spawnedChildren: MockChild[] = [];

const mockSpawn = mock((command: string, args: string[], options: Record<string, unknown>) => {
  spawnCalls.push({ command, args, options });
  const child = new MockChild();
  spawnedChildren.push(child);
  return child as unknown as ChildProcess;
});

mock.module('child_process', () => ({
  spawn: mockSpawn,
  exec: mock(() => {}),
  execFile: mock(() => {}),
  execSync: mock(() => Buffer.from('')),
  execFileSync: mock(() => Buffer.from('')),
  spawnSync: mock(() => ({ status: 0, stdout: '', stderr: '' })),
  fork: mock(() => {}),
}));

const mockResolveCliPath = mock((cliName: string) => cliName);
mock.module('./types', () => ({
  resolveCliPath: mockResolveCliPath,
}));

const { spawnCodexProcess } = await import('./process-runner');

// ── test helpers ─────────────────────────────────────────────────────────────

// A plain setImmediate flush is enough when spawn() is reached synchronously,
// but `outputLastMessageFile` routes through a real `fs.mkdir` first (via
// dynamic import), which takes multiple event-loop turns — so poll instead
// of assuming a single tick suffices.
async function flush(): Promise<void> {
  for (let i = 0; i < 40 && spawnCalls.length === 0; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function makeState(): ProcessRunnerState {
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
  };
}

function makeCallbacks() {
  return {
    emitOutput: mock((_text: string, _isError?: boolean) => {}),
    emitQuestionDetected: mock(() => {}),
    onSessionId: mock((_id: string) => {}),
    onQuestionDetected: mock(() => {}),
    onStatusChange: mock((_status: string) => {}),
    logPrefix: '[test-agent]',
  };
}

const noArtifacts = () => [];
const noCommits = () => [];

const originalPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

beforeEach(() => {
  spawnCalls = [];
  spawnedChildren = [];
  mockSpawn.mockClear();
  mockResolveCliPath.mockClear();
});

// ── spawnCodexProcess: CLI argument construction ────────────────────────────

describe('spawnCodexProcess — argument construction', () => {
  test('implementation mode (default): --json, --cd, --full-auto, and the prompt appended', async () => {
    const state = makeState();
    spawnCodexProcess(
      {},
      'C:/work',
      'implement the feature',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const command = spawnCalls[0].command;
    expect(command).toContain('exec');
    expect(command).toContain('--json');
    expect(command).toContain('--cd C:/work');
    expect(command).toContain('--full-auto');
    expect(command).toContain('implement the feature');
    spawnedChildren[0].emit('close', 0);
  });

  test('applies model normalization when a model is configured (non-investigation mode)', async () => {
    const state = makeState();
    spawnCodexProcess(
      { model: 'gpt-4' },
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    expect(spawnCalls[0].command).toContain('-m gpt-5.5');
    spawnedChildren[0].emit('close', 0);
  });

  test('yolo mode: bypasses approvals and sandbox instead of --full-auto', async () => {
    const state = makeState();
    spawnCodexProcess(
      { yolo: true },
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    expect(spawnCalls[0].command).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(spawnCalls[0].command).not.toContain('--full-auto');
    spawnedChildren[0].emit('close', 0);
  });

  test('sandboxMode: passes --sandbox and --output-last-message when configured', async () => {
    const state = makeState();
    spawnCodexProcess(
      { sandboxMode: 'workspace-write', outputLastMessageFile: 'C:/tmp/out.txt' },
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    expect(spawnCalls[0].command).toContain('--sandbox workspace-write');
    expect(spawnCalls[0].command).toContain('--output-last-message C:/tmp/out.txt');
    expect(spawnCalls[0].command).not.toContain('--full-auto');
    spawnedChildren[0].emit('close', 0);
  });

  test('investigation mode: skips --json, forces read-only sandbox, and uses the research headline', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    spawnCodexProcess(
      { investigationMode: true },
      'C:/work',
      'investigate the bug',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const command = spawnCalls[0].command;
    expect(command).not.toContain('--json');
    expect(command).toContain('--sandbox read-only');
    expect(command).toContain('--skip-git-repo-check');
    expect(command).toContain('調査レポート');
    // The actual task prompt is written to stdin, not passed positionally.
    expect(command).not.toContain('investigate the bug');
    expect(spawnedChildren[0].stdin.write).toHaveBeenCalledWith('investigate the bug');
    spawnedChildren[0].emit('close', 0);
  });

  test.each([
    ['plan', '実装計画'],
    ['review', 'レビュー指摘'],
    ['verify', '検証結果'],
  ] as const)(
    'investigation mode headline for outputType=%s mentions %s',
    async (outputType, marker) => {
      const state = makeState();
      spawnCodexProcess(
        { investigationMode: true, investigationOutputType: outputType },
        'C:/work',
        'prompt',
        state,
        makeCallbacks(),
        Date.now(),
        noArtifacts,
        noCommits,
      );
      await flush();
      expect(spawnCalls[0].command).toContain(marker);
      spawnedChildren[0].emit('close', 0);
    },
  );

  test('resume mode: appends `resume <sessionId>` as the trailing positional', async () => {
    const state = makeState();
    spawnCodexProcess(
      { resumeSessionId: 'sess-abc-123' },
      'C:/work',
      'follow-up prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    expect(spawnCalls[0].command).toContain('resume sess-abc-123');
    spawnedChildren[0].emit('close', 0);
  });
});

// ── spawnCodexProcess: spawn wiring ──────────────────────────────────────────

describe('spawnCodexProcess — process wiring', () => {
  test('spawns with the working directory, shell, and hidden window options', async () => {
    const state = makeState();
    spawnCodexProcess(
      {},
      'C:/some/work/dir',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const { options } = spawnCalls[0];
    expect(options.cwd).toBe('C:/some/work/dir');
    expect(options.shell).toBe(true);
    expect(options.windowsHide).toBe(true);
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    spawnedChildren[0].emit('close', 0);
  });

  test('sets utf8 encoding on stdout/stderr and stores the child on state.process', async () => {
    const state = makeState();
    spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    expect(child.stdout.setEncoding).toHaveBeenCalledWith('utf8');
    expect(child.stderr.setEncoding).toHaveBeenCalledWith('utf8');
    expect(state.process).toBe(child as unknown as ChildProcess);
    child.emit('close', 0);
  });

  test('emits the PID via the emitOutput callback', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    expect(callbacks.emitOutput).toHaveBeenCalledWith(expect.stringContaining('4242'));
    spawnedChildren[0].emit('close', 0);
  });

  test('always ends stdin, even when there is nothing to write to it', async () => {
    const state = makeState();
    spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalled();
    child.emit('close', 0);
  });

  test('still ends stdin when writing the investigation-mode prompt throws', async () => {
    // NOTE: the child is created by spawn() itself, so the throwing write
    // implementation must be installed on the very instance spawn() returns.
    mockSpawn.mockImplementationOnce(
      (command: string, args: string[], options: Record<string, unknown>) => {
        spawnCalls.push({ command, args, options });
        const child = new MockChild();
        (child.stdin.write as ReturnType<typeof mock>).mockImplementation(() => {
          throw new Error('EPIPE');
        });
        spawnedChildren.push(child);
        return child as unknown as ChildProcess;
      },
    );
    const state = makeState();
    spawnCodexProcess(
      { investigationMode: true },
      'C:/work',
      'prompt body',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    expect(child.stdin.write).toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalled();
    child.emit('close', 0);
  });

  test('resolves with a failure result when spawn() throws synchronously', async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('ENOENT: codex not found');
    });
    const state = makeState();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    expect(result.errorMessage).toBe('ENOENT: codex not found');
  });
});
