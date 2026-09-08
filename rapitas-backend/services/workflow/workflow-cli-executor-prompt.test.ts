/**
 * workflow-cli-executor-prompt テスト
 *
 * buildCliAgentPrompt への AGENTS.md 注入部分のみを対象とする単体テスト。
 * 既存の後方互換（agentsMd未指定）、investigation/implementationの文言分岐、
 * 警告文言の注入を検証する。
 */
import { describe, it, expect } from 'bun:test';
import { buildCliAgentPrompt } from './workflow-cli-executor-prompt';
import type { RoleTransition } from './workflow-types';

const baseParams = {
  taskId: 892,
  language: 'ja' as const,
  systemPrompt: '',
  context: '',
};

function transitionFor(
  role: RoleTransition['role'],
  outputFile: RoleTransition['outputFile'],
): RoleTransition {
  return { role, outputFile, nextStatus: 'in_progress' };
}

describe('buildCliAgentPrompt — AGENTS.md注入', () => {
  it('agentsMd未指定なら従来通りセクションを注入しない（後方互換）', () => {
    const prompt = buildCliAgentPrompt({
      ...baseParams,
      transition: transitionFor('implementer', null),
    });
    expect(prompt).not.toContain('対象リポジトリ自身のAGENTS.md');
  });

  it('researcherロールでは投資フェーズ文言（実行不要）を含む', () => {
    const prompt = buildCliAgentPrompt({
      ...baseParams,
      transition: transitionFor('researcher', 'research'),
      agentsMd: { content: 'スキーマ変更禁止', truncated: false, readError: null },
    });
    expect(prompt).toContain('対象リポジトリ自身のAGENTS.md');
    expect(prompt).toContain('実行不要');
    expect(prompt).toContain('スキーマ変更禁止');
  });

  it('implementerロールでは実装フェーズ文言（違反しないこと）を含む', () => {
    const prompt = buildCliAgentPrompt({
      ...baseParams,
      transition: transitionFor('implementer', null),
      agentsMd: { content: 'スキーマ変更禁止', truncated: false, readError: null },
    });
    expect(prompt).toContain('違反しないこと');
    expect(prompt).toContain('質問として差し戻す');
  });

  it('readErrorが非nullなら⚠️警告セクションを含む', () => {
    const prompt = buildCliAgentPrompt({
      ...baseParams,
      transition: transitionFor('implementer', null),
      agentsMd: { content: null, truncated: false, readError: 'EACCES' },
    });
    expect(prompt).toContain('⚠️');
    expect(prompt).toContain('EACCES');
  });

  it('AGENTS.mdが不在（content:null, readError:null）ならセクションを注入しない', () => {
    const prompt = buildCliAgentPrompt({
      ...baseParams,
      transition: transitionFor('implementer', null),
      agentsMd: { content: null, truncated: false, readError: null },
    });
    expect(prompt).not.toContain('対象リポジトリ自身のAGENTS.md');
  });
});
