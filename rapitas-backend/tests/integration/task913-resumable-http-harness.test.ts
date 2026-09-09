/**
 * Task 913 — resumable/interrupted execution HTTP harness
 *
 * Mounts the REAL production router composition (registerAllRoutes) plus the
 * extracted `/health` handler against a throwaway SQLite database, then
 * drives scenarios (a)/(b)/(c) and a DB-query-failure injection through
 * in-process `app.handle()` HTTP requests — never a live socket, and never
 * index.ts's scheduler/recovery/auto-run warmup (those are only started by
 * index.ts's own top-level code, which this file never imports). Not part of
 * the default `bun test` run (see bunfig.toml pathIgnorePatterns) — run
 * explicitly:
 *   bun test --isolate tests/integration/task913-resumable-http-harness.test.ts
 *
 * DATABASE_URL MUST be set before ANY module in the dependency chain below is
 * imported — config/database.ts constructs the `prisma` singleton at
 * module-eval time, and ESM static imports hoist regardless of where they
 * appear in a file. Every DB-touching module here is therefore loaded via a
 * dynamic `await import()` performed inside beforeAll, after the env var is
 * set.
 *
 * Tests within a describe block run in file declaration order (this project
 * does not enable --shuffle) — scenarios (a)/(b)/(c) intentionally build on
 * the cumulative raw-count total left by earlier scenarios rather than
 * resetting the DB between them, matching how task658/execution2806 coexist
 * with unrelated rows in the real operational database.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Elysia app instance; typing it exactly would require importing elysia
// statically, which would defeat the DATABASE_URL-before-import ordering
// this file depends on. `any` is allowed in test files (eslint-shared.mjs).
let app: any;
// Shared prisma client resolved dynamically after DATABASE_URL is set.
let prisma: any;
let tmpDir: string;

let scenarioAExecId: number;
let scenarioBExecId: number;
let scenarioCTaskId: number;
let scenarioCOldExecId: number;
let scenarioCNewExecId: number;
let scenarioCNewSessionId: number;
// Captured module namespace object, restored verbatim via mock.module in the
// failure-injection describe block's afterAll.
let realResumableExecutionModule: any;

async function handle(path: string): Promise<{ status: number; body: any }> {
  const response = await app.handle(new Request(`http://localhost${path}`));
  const body = await response.json();
  return { status: response.status, body };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-task913-'));
  const dbPath = resolve(join(tmpDir, 'harness.sqlite'));

  // Isolation guard — fail loudly rather than silently touch the operational
  // DB or the repo if path resolution ever produces something unexpected.
  const resolvedTmpdir = resolve(tmpdir());
  if (!dbPath.toLowerCase().startsWith(resolvedTmpdir.toLowerCase())) {
    throw new Error(`Refusing to run: harness DB path escaped the OS temp dir: ${dbPath}`);
  }
  if (/rapitas-backend|\.worktrees/i.test(dbPath)) {
    throw new Error(`Refusing to run: harness DB path looks like it is inside the repo: ${dbPath}`);
  }

  process.env.DATABASE_URL = `file:${dbPath}`;

  const { ensureDesktopSqliteDatabase } = await import('../../config/desktop-sqlite');
  await ensureDesktopSqliteDatabase();

  const dbModule = await import('../../config/database');
  prisma = dbModule.prisma;

  const { Elysia } = await import('elysia');
  const { registerAllRoutes } = await import('../../register-routes');
  const { handleTopLevelHealthCheck } = await import('../../routes/system/top-level-health-route');

  app = new Elysia();
  registerAllRoutes(app);
  app.get('/health', handleTopLevelHealthCheck);
});

afterAll(async () => {
  // Disconnect first — an open SQLite file handle blocks deletion on Windows.
  await prisma.$disconnect();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only — a leftover OS-temp-dir file is not a test failure.
  }
});

describe('sanity — isolated empty DB', () => {
  test('GET /health reflects an empty database, not the operational one', async () => {
    const { status, body } = await handle('/health');
    expect(status).toBe(200);
    expect(body.database).toBe('connected');
    expect(body.interruptedExecutionsHistoryCount).toBe(0);
    expect(body.interruptedExecutionsDegraded).toBe(false);
    expect(body.status).toBe('healthy');
  });
});

describe('scenario (a) — task658/execution2806 equivalent: terminal task, old interrupted row', () => {
  test('seeds a done task with a stale interrupted execution', async () => {
    const task = await prisma.task.create({
      data: { title: 'task913-harness-scenario-a', status: 'done' },
    });
    const config = await prisma.developerModeConfig.create({ data: { taskId: task.id } });
    const session = await prisma.agentSession.create({
      data: { configId: config.id, status: 'failed' },
    });
    const execution = await prisma.agentExecution.create({
      data: {
        sessionId: session.id,
        command: 'implement',
        status: 'interrupted',
        claudeSessionId: 'harness-a',
      },
    });
    scenarioAExecId = execution.id;
  });

  test('GET /agents/system-status excludes the terminal-task interruption from the operational count', async () => {
    const { body } = await handle('/agents/system-status');
    expect(body.interruptedExecutions).toBe(0);
    expect(body.interruptedExecutionsHistoryCount).toBe(1);
    expect(body.status).not.toBe('interrupted_executions');
  });

  test('GET /agents/resumable-executions returns an empty list', async () => {
    const { status, body } = await handle('/agents/resumable-executions');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  test('GET /agents/interrupted-executions returns the row but flags it non-resumable', async () => {
    const { body } = await handle('/agents/interrupted-executions');
    const row = body.find((r: any) => r.id === scenarioAExecId);
    expect(row).toBeDefined();
    expect(row.isResumableCandidate).toBe(false);
  });
});

describe('scenario (b) — non-terminal task, genuinely resumable interrupted row', () => {
  test('seeds an in-progress task with an interrupted execution', async () => {
    const task = await prisma.task.create({
      data: { title: 'task913-harness-scenario-b', status: 'in-progress' },
    });
    const config = await prisma.developerModeConfig.create({ data: { taskId: task.id } });
    const session = await prisma.agentSession.create({
      data: { configId: config.id, status: 'interrupted' },
    });
    const execution = await prisma.agentExecution.create({
      data: {
        sessionId: session.id,
        command: 'implement',
        status: 'interrupted',
        claudeSessionId: 'harness-b',
      },
    });
    scenarioBExecId = execution.id;
  });

  test('GET /agents/system-status counts it as an operational interruption', async () => {
    const { body } = await handle('/agents/system-status');
    expect(body.interruptedExecutions).toBe(1);
    expect(body.interruptedExecutionsHistoryCount).toBe(2);
    expect(body.status).toBe('interrupted_executions');
  });

  test('GET /agents/resumable-executions includes it', async () => {
    const { body } = await handle('/agents/resumable-executions');
    expect(body.map((r: any) => r.id)).toContain(scenarioBExecId);
  });

  test('GET /agents/interrupted-executions flags it resumable', async () => {
    const { body } = await handle('/agents/interrupted-executions');
    const row = body.find((r: any) => r.id === scenarioBExecId);
    expect(row.isResumableCandidate).toBe(true);
  });
});

describe('scenario (c) — old interrupted execution superseded by a live one on the same task', () => {
  afterAll(async () => {
    // Remove the injected entry so it cannot leak into any test that runs
    // later in the same process (this file's own DB-failure describe block
    // below, or a future --path-ignore-patterns="" run alongside other files).
    const { AgentOrchestrator } = await import('../../services/agents/agent-orchestrator');
    const orchestrator = AgentOrchestrator.getInstance(prisma) as unknown as {
      activeAgents: Map<number, unknown>;
    };
    orchestrator.activeAgents.delete(scenarioCNewExecId);
  });

  test('seeds an old interrupted execution plus a live running one, and registers the live one on the real AgentOrchestrator singleton', async () => {
    const task = await prisma.task.create({
      data: { title: 'task913-harness-scenario-c', status: 'in-progress' },
    });
    scenarioCTaskId = task.id;
    // DeveloperModeConfig.taskId is @unique — the old and new sessions share one config row.
    const config = await prisma.developerModeConfig.create({ data: { taskId: task.id } });

    const oldSession = await prisma.agentSession.create({
      data: { configId: config.id, status: 'interrupted' },
    });
    const oldExecution = await prisma.agentExecution.create({
      data: {
        sessionId: oldSession.id,
        command: 'implement',
        status: 'interrupted',
        claudeSessionId: 'harness-c-old',
      },
    });
    scenarioCOldExecId = oldExecution.id;

    const newSession = await prisma.agentSession.create({
      data: { configId: config.id, status: 'running' },
    });
    scenarioCNewSessionId = newSession.id;
    const newExecution = await prisma.agentExecution.create({
      data: { sessionId: newSession.id, command: 'implement', status: 'running' },
    });
    scenarioCNewExecId = newExecution.id;

    // Register the "live" execution directly on the real AgentOrchestrator
    // singleton — the same instance getCurrentActiveExecutionIds() reads via
    // AgentOrchestrator.getInstance(prisma) (services/agents/resumable-execution
    // /current-active-task-ids.ts). No CLI agent is started; this mirrors the
    // injection technique already used by agent-orchestrator.stop.test.ts.
    const { AgentOrchestrator } = await import('../../services/agents/agent-orchestrator');
    const orchestrator = AgentOrchestrator.getInstance(prisma) as unknown as {
      activeAgents: Map<
        number,
        {
          agent: { stop: () => Promise<void> };
          executionId: number;
          sessionId: number;
          taskId: number;
          state: {
            executionId: number;
            sessionId: number;
            agentId: string;
            taskId: number;
            status: string;
            startedAt: Date;
            output: string;
          };
          lastOutput: string;
          lastSavedAt: Date;
        }
      >;
    };
    orchestrator.activeAgents.set(scenarioCNewExecId, {
      agent: { stop: () => Promise.resolve() },
      executionId: scenarioCNewExecId,
      sessionId: scenarioCNewSessionId,
      taskId: scenarioCTaskId,
      state: {
        executionId: scenarioCNewExecId,
        sessionId: scenarioCNewSessionId,
        agentId: 'harness',
        taskId: scenarioCTaskId,
        status: 'running',
        startedAt: new Date(),
        output: '',
      },
      lastOutput: '',
      lastSavedAt: new Date(),
    });
  });

  test('GET /agents/system-status does not double-count the old interrupted row under the now-live task', async () => {
    const { body } = await handle('/agents/system-status');
    // Only scenario (b)'s row remains an operational interruption; scenario
    // (c)'s old row is excluded because its task now has a live execution.
    expect(body.interruptedExecutions).toBe(1);
    expect(body.interruptedExecutionsHistoryCount).toBe(3);
  });

  test('GET /agents/resumable-executions excludes the old row but includes the live one', async () => {
    const { body } = await handle('/agents/resumable-executions');
    const ids = body.map((r: any) => r.id);
    expect(ids).not.toContain(scenarioCOldExecId);
    expect(ids).toContain(scenarioCNewExecId);
  });

  test('GET /agents/interrupted-executions flags the old row non-resumable', async () => {
    const { body } = await handle('/agents/interrupted-executions');
    const row = body.find((r: any) => r.id === scenarioCOldExecId);
    expect(row.isResumableCandidate).toBe(false);
  });
});

describe('DB-query-failure injection — raw count succeeds, resumable computation fails', () => {
  // Runs LAST: mock.module is process-global in bun (confirmed empirically —
  // it retroactively patches bindings already captured by consumers imported
  // earlier in this file, e.g. the routers mounted in beforeAll above), so
  // this fault injection must not run before scenarios (a)/(b)/(c).
  afterAll(() => {
    mock.module('../../services/agents/resumable-execution', () => realResumableExecutionModule);
  });

  test('mocks getCurrentActiveExecutionIds only, leaving isResumableInterrupted/getLiveTaskIdsForActiveExecutions real', async () => {
    realResumableExecutionModule = await import('../../services/agents/resumable-execution');
    mock.module('../../services/agents/resumable-execution', () => ({
      ...realResumableExecutionModule,
      getCurrentActiveExecutionIds: () =>
        Promise.reject(new Error('harness: forced failure (task 913 fault injection)')),
    }));
  });

  test('GET /agents/system-status reports interrupted_executions_unknown, never healthy, with the raw count intact', async () => {
    const { body } = await handle('/agents/system-status');
    expect(body.interruptedExecutionsHistoryCount).toBe(3);
    expect(body.interruptedExecutionsDegraded).toBe(true);
    expect(body.status).toBe('interrupted_executions_unknown');
    expect(body.status).not.toBe('healthy');
  });
});
