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

describe('shell exit-code safety rule (task 916)', () => {
  test.each(['ja', 'en'] as const)(
    'is included in implementer and verifier prompts for %s',
    (language) => {
      const texts = buildRoleTexts(916, { title: 'Probe', description: null }, language);
      expect(texts.implementer.constraints).toContain('run-checked.cjs');
      expect(texts.verifier.instruction).toContain('run-checked.cjs');
      const pipeKeyword = language === 'ja' ? 'パイプ' : 'pipe';
      expect(texts.implementer.constraints).toContain(pipeKeyword);
      expect(texts.verifier.instruction).toContain(pipeKeyword);
    },
  );
});
