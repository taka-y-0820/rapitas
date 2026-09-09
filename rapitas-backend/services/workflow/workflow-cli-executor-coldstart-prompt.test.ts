/**
 * workflow-cli-executor-coldstart-prompt ユニットテスト
 *
 * systemPrompt保持／context非包含／workflowStatus包含／git制限（implementerのみ）
 * を検証する。
 */
import { describe, expect, test } from 'bun:test';
import { buildColdStartHandoffPrompt } from './workflow-cli-executor-coldstart-prompt';
import type { RoleTransition } from './workflow-types';

const task = { title: 'テストタスク', description: 'テスト用の説明' };

function implementerTransition(): RoleTransition {
  return { role: 'implementer', outputFile: null, nextStatus: 'verify_done' };
}
function verifierTransition(): RoleTransition {
  return { role: 'verifier', outputFile: 'verify', nextStatus: 'completed' };
}

describe('buildColdStartHandoffPrompt', () => {
  test('systemPrompt の内容が保持される', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'UNIQUE_ROLE_GATE_MARKER_12345',
      transition: implementerTransition(),
      workflowStatus: 'in_progress',
      language: 'ja',
    });
    expect(prompt).toContain('UNIQUE_ROLE_GATE_MARKER_12345');
  });

  test('巨大な context 文字列は含まれない（引数として受け取らない）', () => {
    const hugeContext = 'X'.repeat(50000);
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: implementerTransition(),
      workflowStatus: 'in_progress',
      language: 'ja',
    });
    expect(prompt).not.toContain(hugeContext);
    expect(prompt.length).toBeLessThan(5000);
  });

  test('workflowStatus が含まれる', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: implementerTransition(),
      workflowStatus: 'plan_approved',
      language: 'ja',
    });
    expect(prompt).toContain('plan_approved');
  });

  test('workflowStatus が null の場合はセクション自体を出力しない', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: implementerTransition(),
      workflowStatus: null,
      language: 'ja',
    });
    expect(prompt).not.toContain('現在のワークフロー状態');
  });

  test('研究/計画/verify を再取得する GET 指示を含む', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: implementerTransition(),
      workflowStatus: 'in_progress',
      language: 'ja',
    });
    expect(prompt).toContain('/workflow/tasks/900/files');
  });

  test('implementer ロールでは git 操作制限セクションを含む', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: implementerTransition(),
      workflowStatus: 'in_progress',
      language: 'ja',
    });
    expect(prompt).toContain('git push --force');
  });

  test('verifier ロールでは git 操作制限セクションを含まない', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: verifierTransition(),
      workflowStatus: 'in_progress',
      language: 'ja',
    });
    expect(prompt).not.toContain('git push --force');
  });

  test('priorFailureSummary が渡された場合は含まれる', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: implementerTransition(),
      workflowStatus: 'in_progress',
      priorFailureSummary: 'PROMPT_TOO_LONG_SUMMARY_MARKER',
      language: 'ja',
    });
    expect(prompt).toContain('PROMPT_TOO_LONG_SUMMARY_MARKER');
  });

  test('agentsMd の内容が渡された場合は含まれる', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: implementerTransition(),
      workflowStatus: 'in_progress',
      agentsMd: { content: 'AGENTS_MD_UNIQUE_MARKER', truncated: false, readError: null },
      language: 'ja',
    });
    expect(prompt).toContain('AGENTS_MD_UNIQUE_MARKER');
  });

  test('english language produces english section headers', () => {
    const prompt = buildColdStartHandoffPrompt({
      taskId: 900,
      task,
      systemPrompt: 'system',
      transition: implementerTransition(),
      workflowStatus: 'in_progress',
      language: 'en',
    });
    expect(prompt).toContain('Before you resume work');
  });
});
