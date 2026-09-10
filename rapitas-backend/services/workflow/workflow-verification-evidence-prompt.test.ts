import { describe, expect, test } from 'bun:test';
import {
  shellExitCodeSafetyRule,
  verificationEvidencePrompt,
} from './workflow-verification-evidence-prompt';

describe('shellExitCodeSafetyRule', () => {
  test.each(['ja', 'en'] as const)('mentions run-checked.cjs and pipe risk for %s', (language) => {
    const text = shellExitCodeSafetyRule(language);
    expect(text).toContain('run-checked.cjs');
    expect(text).toContain(language === 'ja' ? 'パイプ' : 'pipe');
    expect(text).toContain(language === 'ja' ? '終了コード' : 'exit code');
  });
});

describe('verificationEvidencePrompt', () => {
  test.each(['ja', 'en'] as const)('mentions runId identity for %s', (language) => {
    expect(verificationEvidencePrompt(language)).toContain('runId');
  });
});
