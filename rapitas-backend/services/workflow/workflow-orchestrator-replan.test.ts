import { beforeEach, expect, mock, test } from 'bun:test';
let status = 'research_done';
let reviewed = true;
const reuse = mock(async () => ({ status: 'research_done', advanced: false }));
mock.module('../../config', () => ({ prisma: {} }));
mock.module('../../config/logger', () => ({ createLogger: () => ({ info() {}, warn() {} }) }));
mock.module('../task/task-resolver', () => ({
  resolveTaskWithThemeAndCategory: async () => ({
    id: 1,
    status: 'in-progress',
    workflowStatus: status,
    workflowMode: 'lightweight',
  }),
}));
mock.module('./workflow-disabled', () => ({ resolveEffectiveWorkflowDisabled: async () => false }));
mock.module('./requirement-replan-context', () => ({
  readRequirementReplanAudit: async () => (reviewed ? {} : null),
  buildRequirementReplanContext: async () => '',
}));
mock.module('./workflow-mode-config', () => ({
  getModeSettings: async () => ({ includePlan: false }),
  buildTransitions: () => ({
    research_done: { role: 'implementer', outputFile: null, nextStatus: 'in_progress' },
  }),
}));
mock.module('./artifact-reuse-reconciler', () => ({ reconcileStatusFromExistingArtifacts: reuse }));
const { runPreflight } = await import('./workflow-orchestrator-preflight');
beforeEach(() => {
  status = 'research_done';
  reviewed = true;
  reuse.mockClear();
});
test('reviewed mismatch dispatches a planner in no-plan mode without reusing the rejected plan', async () => {
  const result = await runPreflight(1);
  expect(result.done).toBe(false);
  if (result.done) throw new Error('Unexpected hold');
  expect(result.transition).toEqual({
    role: 'planner',
    outputFile: 'plan',
    nextStatus: 'plan_created',
  });
  expect(reuse).not.toHaveBeenCalled();
});
test('replacement approval is required before no-plan mode can implement', async () => {
  status = 'plan_created';
  expect((await runPreflight(1)).done).toBe(true);
  status = 'plan_approved';
  const result = await runPreflight(1);
  expect(result.done).toBe(false);
  if (result.done) throw new Error('Approved replacement was blocked');
  expect(result.transition.role).toBe('implementer');
});
test('ordinary no-plan tasks retain their configured implementation path', async () => {
  reviewed = false;
  const result = await runPreflight(1);
  expect(result.done).toBe(false);
  if (result.done) throw new Error('Ordinary task was blocked');
  expect(result.transition.role).toBe('implementer');
  expect(reuse).toHaveBeenCalledTimes(1);
});
