import { describe, expect, test } from 'bun:test';
import { buildRoleTexts } from './workflow-role-prompts';

describe('verification result lookup instructions', () => {
  test.each(['ja', 'en'] as const)(
    'expands the recovery URL for %s without an unresolved task placeholder',
    (language) => {
      const texts = buildRoleTexts(915, { title: 'Probe', description: null }, language);
      expect(texts.implementer.constraints).toContain(
        '/workflow/tasks/915/run-verification/latest',
      );
      expect(texts.implementer.constraints).not.toContain('${taskId}');
      expect(texts.implementer.constraints).toContain('runId');
      expect(texts.implementer.constraints).toContain('checks[].ran');
      expect(texts.verifier.instruction).toContain('checks[].ran');
    },
  );
});
