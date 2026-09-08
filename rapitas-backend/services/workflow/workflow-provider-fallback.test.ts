/**
 * workflow-provider-fallback.test
 *
 * End-to-end regression for hasProviderErrorInOutput() against the REAL
 * classifyAgentError() (no mock.module) — proves the `weak` gate added in
 * agent-error-classifier.ts actually stops a successful workflow phase
 * result (execution3874's plan prose discussing local HTTP 429 handling)
 * from being misclassified as a provider failure, while Codex's genuine
 * exit-0-with-quota-error output still triggers a fallback (task 898).
 */
import { describe, test, expect } from 'bun:test';
import { hasProviderErrorInOutput } from './workflow-provider-fallback';

describe('hasProviderErrorInOutput', () => {
  test('successful plan prose discussing HTTP 429 handling does not trigger fallback (execution3874 reproduction)', async () => {
    const planBody =
      '# 実装計画\n\nローカルでHTTP 429のハンドリングを実装する。上流サービスから429が返った場合はリトライする。';
    expect(await hasProviderErrorInOutput(planBody)).toBe(false);
  });

  test('Codex exit-0-with-quota-error output still triggers fallback (safety net preserved)', async () => {
    const codexOutput = "ERROR: You've hit your usage limit. try again at 1:19 PM";
    expect(await hasProviderErrorInOutput(codexOutput)).toBe(true);
  });

  test('empty blob does not trigger fallback', async () => {
    expect(await hasProviderErrorInOutput('')).toBe(false);
  });
});
