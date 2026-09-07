/**
 * workflow-cli-executor-mock-state-spies
 *
 * Stable spies + resetWfMockState() for the workflow-cli-executor shared mock
 * state (split from workflow-cli-executor-mock-state.ts). resetWfMockState
 * lives here (not in -fields) so the import graph stays one-directional:
 * fields never imports spies.
 */
import { mock } from 'bun:test';

import type { AgentTaskLike, ExecutionOptionsLike } from './workflow-cli-executor-mock-state-types';
import {
  defaultTaskWithTheme,
  defaultTaskWorkflowState,
  defaultValidation,
  wf,
} from './workflow-cli-executor-mock-state-fields';

// ---------------------------------------------------------------------------
// Stable spies — the actual functions every mock.module factory exports.
// Declared once so `.mock.calls` assertions work no matter which file's
// registration is the "active" one for a given specifier.
// ---------------------------------------------------------------------------

export const spies = {
  resolveTaskWithTheme: mock(() => Promise.resolve(wf.taskWithTheme)),
  resolveTaskTitle: mock(() => Promise.resolve(wf.taskTitle)),
  resolveTaskWorkflowState: mock(() => Promise.resolve(wf.taskWorkflowState)),
  resolveLatestSessionWorktree: mock(() => Promise.resolve(wf.latestSessionWorktree)),
  canReuseWorktree: mock(() => wf.canReuseWorktree),
  isBackendPrimaryCheckout: mock(() => Promise.resolve(wf.isBackendPrimaryCheckout)),
  isPrimaryWorkTree: mock(() => Promise.resolve(wf.isPrimaryWorkTree)),
  createWorktree: mock(
    (
      base: string,
      branch: string,
      taskId?: number,
      repo?: string | null,
      baseBranch?: string | null,
    ) => wf.createWorktreeImpl(base, branch, taskId, repo, baseBranch),
  ),
  executeTask: mock((task: AgentTaskLike, options: ExecutionOptionsLike) =>
    wf.executeTaskImpl(task, options),
  ),
  readWorkflowFile: mock((taskId: number, fileType: string) =>
    wf.readWorkflowFileImpl(taskId, fileType),
  ),
  writeWorkflowFile: mock(() => Promise.resolve()),
  cleanupRootWorkflowFiles: mock(() => Promise.resolve()),
  extractMarkdownFromOutput: mock((output: string, fileType: string) =>
    wf.extractMarkdownFromOutputImpl(output, fileType),
  ),
  validateResearch: mock(() => wf.validateResearch),
  validatePlan: mock(() => wf.validatePlan),
  validateVerify: mock(() => wf.validateVerify),
  recordTransition: mock(() => Promise.resolve()),
  evaluateCompletionGate: mock((worktreePath: string | null | undefined, verifyContent: string) =>
    wf.evaluateCompletionGateImpl(worktreePath, verifyContent),
  ),
  writeBlockedStatusDurable: mock(() => Promise.resolve(true)),
  checkWorkflowInvariants: mock((taskId: number) => wf.checkWorkflowInvariantsImpl(taskId)),
  maybeAutoApprovePlan: mock((taskId: number, language: 'ja' | 'en') =>
    wf.maybeAutoApprovePlanImpl(taskId, language),
  ),
  generateFallbackBranchName: mock((title: string) => wf.generateFallbackBranchNameImpl(title)),
  generateBranchName: mock((title: string, description?: string, taskId?: number) =>
    wf.generateBranchNameImpl(title, description, taskId),
  ),
  applyResearchAssessedComplexity: mock((taskId: number, content: string) =>
    wf.applyResearchAssessedComplexityImpl(taskId, content),
  ),
  performAutoCommitAndPR: mock((taskId: number, verifyContent: string) =>
    wf.performAutoCommitAndPRImpl(taskId, verifyContent),
  ),
  appendEvent: mock(() => Promise.resolve()),
  gitExec: mock(() => wf.gitRevParseImpl()),

  // prisma
  taskUpdate: mock(() => Promise.resolve({})),
  taskUpdateMany: mock(() => Promise.resolve({ count: 0 })),
  taskFindUnique: mock(() => Promise.resolve(wf.taskHasLinkedPrRow)),
  agentSessionCreate: mock(() => Promise.resolve({ id: 100 })),
  agentSessionUpdate: mock(() => Promise.resolve({})),
  // Session finalization (executeCLIAgent's `finally` -> finalizePhaseSession)
  // is a CONDITIONAL updateMany, not an unconditional update.
  agentSessionUpdateMany: mock(() => Promise.resolve({ count: 1 })),
  gitHubPrFindFirst: mock(() => Promise.resolve(wf.linkedPrRow)),
  agentExecutionUpdateMany: mock(() => Promise.resolve({ count: 0 })),
  agentExecutionFindFirst: mock(() => Promise.resolve(null)),
  agentExecutionFindMany: mock((): Promise<{ id: number }[]> => Promise.resolve([])),
};

/**
 * Restore every config field and clear every spy's call history. Every split
 * test file must call this in its own `beforeEach`.
 */
export function resetWfMockState(): void {
  wf.taskWithTheme = defaultTaskWithTheme();
  wf.taskTitle = { id: 1, title: 'Test Task', description: null };
  wf.taskWorkflowState = defaultTaskWorkflowState();
  wf.latestSessionWorktree = null;
  wf.canReuseWorktree = false;
  wf.isBackendPrimaryCheckout = false;
  wf.isPrimaryWorkTree = false;
  wf.taskHasLinkedPrRow = null;
  wf.linkedPrRow = null;
  wf.createWorktreeImpl = async () => '/fake/worktree/new';
  wf.executeTaskImpl = async () => ({ success: true, output: 'agent output' });
  wf.gitRevParseImpl = async () => {
    throw new Error('not a git repository');
  };
  wf.readWorkflowFileImpl = async () => null;
  wf.extractMarkdownFromOutputImpl = () => null;
  wf.validateResearch = defaultValidation();
  wf.validatePlan = defaultValidation();
  wf.validateVerify = defaultValidation();
  wf.evaluateCompletionGateImpl = async () => ({ allow: true, reason: 'ok' });
  wf.checkWorkflowInvariantsImpl = async () => [];
  wf.maybeAutoApprovePlanImpl = async () => ({ newStatus: 'plan_created', autoApproved: false });
  wf.generateFallbackBranchNameImpl = () => 'feature/fallback-branch';
  wf.generateBranchNameImpl = async () => 'feature/fallback-branch-t1';
  wf.applyResearchAssessedComplexityImpl = async () => {};
  wf.performAutoCommitAndPRImpl = async () => ({
    requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
    autoPRResult: { success: true, prUrl: 'https://example.com/pr/1', prNumber: 1 },
  });

  for (const spy of Object.values(spies)) spy.mockClear();
}
