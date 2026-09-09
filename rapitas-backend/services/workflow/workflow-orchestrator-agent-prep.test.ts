import { expect, mock, test } from 'bun:test';

const update = mock(async () => ({}));
mock.module('../../config', () => ({
  prisma: {
    workflowRoleConfig: {
      findUnique: async () => ({
        isEnabled: true,
        agentConfig: { id: 1, agentType: 'claude-code' },
      }),
    },
    task: { update },
  },
}));
mock.module('../../config/logger', () => ({ createLogger: () => ({ info() {} }) }));
mock.module('./workflow-file-utils', () => ({
  resolveWorkflowDir: async () => ({ path: '/unused' }),
  readWorkflowFile: async () => '# Previously rejected but structurally valid plan',
}));
mock.module('./workflow-context-builder', () => ({
  applyPlanModeDirective: (_role: string, prompt: string) => prompt,
}));
mock.module('./phase-output-validator', () => ({ isReusableArtifact: () => true }));
mock.module('./workflow-orchestrator-prompt', () => ({
  resolveSystemPromptContent: async () => '',
}));

const { prepareAgentAndPrompt } = await import('./workflow-orchestrator-agent-prep');

test('planner selected by preflight still executes when a reusable old plan exists', async () => {
  const result = await prepareAgentAndPrompt(
    913,
    { role: 'planner', outputFile: 'plan', nextStatus: 'plan_created' },
    'research_done',
  );
  expect(result.done).toBe(false);
  expect(update).not.toHaveBeenCalled();
});
