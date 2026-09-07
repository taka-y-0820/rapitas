/**
 * workflow-cli-executor-mock-state-install
 *
 * installWorkflowCliExecutorMocks() — the single mock.module registration
 * entry point for the workflow-cli-executor split test suite (split from
 * workflow-cli-executor-mock-state.ts). Not responsible for the mutable state
 * or spies themselves; every factory delegates to `spies`.
 */
import { mock } from 'bun:test';
import { join } from 'path';

import { spies } from './workflow-cli-executor-mock-state-spies';

// mock.module resolves relative specifiers relative to the file that CALLS
// it — not relative to the module under test. Since this helper lives at
// tests/helpers/ but registers mocks for workflow-cli-executor.ts's (in
// services/workflow/) dependencies, every specifier below is resolved to an
// ABSOLUTE path anchored on the backend root so registration lands on the
// exact same resolved module the SUT imports, regardless of which directory
// calls installWorkflowCliExecutorMocks().
const BACKEND_ROOT = join(import.meta.dir, '..', '..');
const p = (rel: string): string => join(BACKEND_ROOT, rel);

/**
 * Register every mock.module override executeCLIAgent's module graph needs.
 * Idempotent-ish: safe to call from every split test file — later calls just
 * re-register equivalent factories (all delegating to the same `spies`
 * above), which is required so state control works regardless of which
 * file's registration bun keeps "active" (see file header).
 */
export function installWorkflowCliExecutorMocks(): void {
  mock.module(p('config/database'), () => ({
    prisma: prismaMock,
    ensureDatabaseConnection: () => Promise.resolve(),
  }));
  mock.module(p('config/logger'), () => ({
    createLogger: () => noopLogger,
    logger: noopLogger,
    getBackendLogFilePath: () => '',
  }));
  mock.module(p('config'), () => ({
    prisma: prismaMock,
    ensureDatabaseConnection: () => Promise.resolve(),
    createLogger: () => noopLogger,
    logger: noopLogger,
    getDbProvider: () => 'postgresql',
    getInsensitiveMode: () => 'default',
    getProjectRoot: () => '/fake/rapitas',
  }));

  const childProcessModule = () => ({
    exec: (cmd: string, optsOrCb: unknown, cb?: (err: Error | null, r?: unknown) => void) => {
      const callback = (typeof optsOrCb === 'function' ? optsOrCb : cb) as (
        err: Error | null,
        r?: unknown,
      ) => void;
      spies
        .gitExec()
        .then((r) => callback(null, r))
        .catch((e: Error) => callback(e));
    },
    // Not used by executeCLIAgent itself, but other modules transitively
    // reachable in the bun test process (e.g. process-tracker utilities)
    // import these from the same specifier — mirror them so mocking
    // child_process here never breaks an unrelated import elsewhere.
    execFile: () => {},
    execSync: () => Buffer.from(''),
    spawn: () => ({ on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } }),
    spawnSync: () => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
    fork: () => ({ on: () => {} }),
  });
  mock.module('child_process', childProcessModule);
  mock.module('node:child_process', childProcessModule);

  mock.module(p('services/agents/agent-orchestrator'), () => ({
    AgentOrchestrator: {
      getInstance: () => ({
        createWorktree: spies.createWorktree,
        executeTask: spies.executeTask,
      }),
    },
    createOrchestrator: () => ({}),
  }));

  mock.module(p('services/task/task-resolver'), () => ({
    resolveTaskWithTheme: spies.resolveTaskWithTheme,
    resolveTaskTitle: spies.resolveTaskTitle,
    resolveTaskWorkflowState: spies.resolveTaskWorkflowState,
    resolveTaskWithThemeAndCategory: mock(() => Promise.resolve(null)),
    resolveTaskForExecution: mock(() => Promise.resolve(null)),
    resolveTaskWorkingDirectory: mock(() => Promise.resolve(null)),
    resolveTaskThemeId: mock(() => Promise.resolve(null)),
    resolveTaskForComplexityAnalysis: mock(() => Promise.resolve(null)),
    resolveTaskSubtaskInfo: mock(() => Promise.resolve(null)),
    resolveTaskForPlanApproval: mock(() => Promise.resolve(null)),
    resolveTaskForAutoMerge: mock(() => Promise.resolve(null)),
    resolveTaskForLearning: mock(() => Promise.resolve(null)),
  }));

  mock.module(p('services/agents/agent-session-resolver'), () => ({
    resolveLatestFinishedSession: mock(() => Promise.resolve(null)),
    resolveSessionWithLatestExecution: mock(() => Promise.resolve(null)),
    resolveLatestSessionWorktree: spies.resolveLatestSessionWorktree,
  }));

  mock.module(p('services/workflow/workflow-file-utils'), () => ({
    resolveWorkflowDir: mock(() => Promise.resolve({ task: { id: 1 }, categoryId: 0, themeId: 1 })),
    readWorkflowFile: spies.readWorkflowFile,
    writeWorkflowFile: spies.writeWorkflowFile,
    archiveWorkflowFile: mock(() => Promise.resolve(false)),
    cleanupRootWorkflowFiles: spies.cleanupRootWorkflowFiles,
    looksLikeAgentLog: mock(() => false),
    sliceFromReportHeading: mock((t: string) => t),
    extractMarkdownFromOutput: spies.extractMarkdownFromOutput,
  }));

  mock.module(p('services/workflow/phase-output-validator'), () => ({
    looksLogPolluted: mock(() => false),
    validateResearch: spies.validateResearch,
    validatePlan: spies.validatePlan,
    validateVerify: spies.validateVerify,
    isReusableArtifact: mock(() => false),
  }));

  mock.module(p('services/workflow/transition-recorder'), () => ({
    recordTransition: spies.recordTransition,
  }));

  mock.module(p('services/workflow/completion-gate'), () => ({
    verifyJustifiesNoChange: mock(() => false),
    researchConcludesNoChange: mock(() => false),
    evaluateCompletionGate: spies.evaluateCompletionGate,
  }));

  mock.module(p('services/workflow/durable-blocked-write'), () => ({
    writeBlockedStatusDurable: spies.writeBlockedStatusDurable,
  }));

  mock.module(p('services/workflow/workflow-invariants'), () => ({
    normalizeWorkflowStatus: mock((s: string) => s),
    requiredWorkflowFiles: mock(() => []),
    previewMissingFilesForStatus: mock(() => Promise.resolve([])),
    checkWorkflowInvariants: spies.checkWorkflowInvariants,
  }));

  mock.module(p('services/workflow/plan-auto-approve'), () => ({
    resolveEffectiveAutoApprovePlan: mock(() => Promise.resolve(false)),
    maybeAutoApprovePlan: spies.maybeAutoApprovePlan,
  }));

  mock.module(p('services/agents/orchestrator/git-operations/worktree/worktree-usable'), () => ({
    canReuseWorktree: spies.canReuseWorktree,
    decideWorktree: mock(() => 'recreate'),
  }));

  mock.module(p('services/agents/orchestrator/git-operations/worktree/worktree-guard'), () => ({
    isPrimaryWorkTree: spies.isPrimaryWorkTree,
    ensureNotPrimaryWorkTree: mock(() => Promise.resolve()),
    isBackendPrimaryCheckout: spies.isBackendPrimaryCheckout,
    findConflictingWorktreeForBranch: mock(() => Promise.resolve(null)),
  }));

  mock.module(p('utils/common/branch-name-generator'), () => ({
    generateBranchName: spies.generateBranchName,
    extractBranchName: mock((s: string) => s),
    sanitizeBranchName: mock((s: string) => s),
    assertSafeGitRef: mock(() => {}),
    isValidBranchName: mock(() => true),
    hasTaskIdMarker: mock(() => false),
    generateFallbackBranchName: spies.generateFallbackBranchName,
  }));

  mock.module(p('services/workflow/research-complexity'), () => ({
    parseResearchComplexity: mock(() => null),
    applyResearchAssessedComplexity: spies.applyResearchAssessedComplexity,
  }));

  mock.module(p('routes/workflow/workflow-auto-commit'), () => ({
    performAutoCommitAndPR: spies.performAutoCommitAndPR,
    // Mirror the real pure classifier (task 485): base-branch errors and real
    // committed changes are NEVER a no-change completion.
    isNoChangeCompletion: (q: { errorBlob: string; filesChanged: number | undefined }) => {
      if (/base (?:sha|ref)|sha can't be blank|must be a branch/i.test(q.errorBlob)) return false;
      if (typeof q.filesChanged === 'number' && q.filesChanged > 0) return false;
      return (
        q.filesChanged === 0 ||
        /no commits between|nothing to commit|no changes added|変更がありません|差分がありません/i.test(
          q.errorBlob,
        )
      );
    },
  }));

  mock.module(p('services/memory/timeline'), () => ({
    appendEvent: spies.appendEvent,
    queryEvents: mock(() => Promise.resolve([])),
  }));
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

const prismaMock = {
  task: {
    update: spies.taskUpdate,
    updateMany: spies.taskUpdateMany,
    findUnique: spies.taskFindUnique,
  },
  agentSession: { create: spies.agentSessionCreate, update: spies.agentSessionUpdate },
  gitHubPullRequest: { findFirst: spies.gitHubPrFindFirst },
  agentExecution: {
    updateMany: spies.agentExecutionUpdateMany,
    findFirst: spies.agentExecutionFindFirst,
    findMany: spies.agentExecutionFindMany,
  },
};
