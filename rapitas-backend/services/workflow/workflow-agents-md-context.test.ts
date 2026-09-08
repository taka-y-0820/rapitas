/**
 * workflow-agents-md-context テスト
 *
 * readAgentsMdConstraints の不在/正常/切り詰め/読込例外の4分岐と、
 * buildAgentsMdSection の純粋関数としての分岐（未指定/investigation/implementation/警告）を検証する。
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readAgentsMdConstraints,
  buildAgentsMdSection,
  type AgentsMdReadResult,
} from './workflow-agents-md-context';

describe('readAgentsMdConstraints', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('AGENTS.md が存在しない場合は content:null, readError:null を返す', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agents-md-test-'));
    const result = readAgentsMdConstraints(dir);
    expect(result).toEqual({ content: null, truncated: false, readError: null });
  });

  it('正常に読み込めた場合は本文を content に格納する', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agents-md-test-'));
    writeFileSync(path.join(dir, 'AGENTS.md'), '## 禁止事項\nスキーマ変更禁止', 'utf8');
    const result = readAgentsMdConstraints(dir);
    expect(result.content).toBe('## 禁止事項\nスキーマ変更禁止');
    expect(result.truncated).toBe(false);
    expect(result.readError).toBeNull();
  });

  it('空ファイルは不在扱いになる', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agents-md-test-'));
    writeFileSync(path.join(dir, 'AGENTS.md'), '   \n  ', 'utf8');
    const result = readAgentsMdConstraints(dir);
    expect(result).toEqual({ content: null, truncated: false, readError: null });
  });

  it('8000文字超過時は切り詰めて truncated:true を返す', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agents-md-test-'));
    const big = 'a'.repeat(9000);
    writeFileSync(path.join(dir, 'AGENTS.md'), big, 'utf8');
    const result = readAgentsMdConstraints(dir);
    expect(result.truncated).toBe(true);
    expect(result.content?.length).toBe(8000);
    expect(result.readError).toBeNull();
  });

  it('読込例外時は readError にメッセージを格納する', () => {
    // AGENTS.md をディレクトリとして作成し、readFileSync に EISDIR を起こさせる
    // （fs のモック差し替えは import 束縛に反映されないため、実際のI/O例外を使う）。
    dir = mkdtempSync(path.join(tmpdir(), 'agents-md-test-'));
    mkdirSync(path.join(dir, 'AGENTS.md'));
    const result = readAgentsMdConstraints(dir);
    expect(result.content).toBeNull();
    expect(result.readError).toBeTruthy();
    expect(result.readError).toContain('EISDIR');
  });
});

describe('buildAgentsMdSection', () => {
  const emptyResult: AgentsMdReadResult = { content: null, truncated: false, readError: null };

  it('AGENTS.md不在（content:null, readError:null）ならセクションを注入しない', () => {
    expect(buildAgentsMdSection(emptyResult, { isInvestigationPhase: true, language: 'ja' })).toBe(
      '',
    );
  });

  it('investigationフェーズでは「実行不要」の文言を含む', () => {
    const result: AgentsMdReadResult = {
      content: '禁止: スキーマ変更',
      truncated: false,
      readError: null,
    };
    const section = buildAgentsMdSection(result, { isInvestigationPhase: true, language: 'ja' });
    expect(section).toContain('実行不要');
    expect(section).toContain('禁止: スキーマ変更');
    expect(section).toContain('ユーザー指示を優先');
  });

  it('implementationフェーズでは「違反しないこと」の文言を含む', () => {
    const result: AgentsMdReadResult = {
      content: '禁止: スキーマ変更',
      truncated: false,
      readError: null,
    };
    const section = buildAgentsMdSection(result, { isInvestigationPhase: false, language: 'ja' });
    expect(section).toContain('違反しないこと');
    expect(section).toContain('質問として差し戻す');
  });

  it('truncated:true のときは省略注記を含む', () => {
    const result: AgentsMdReadResult = {
      content: 'x'.repeat(100),
      truncated: true,
      readError: null,
    };
    const section = buildAgentsMdSection(result, { isInvestigationPhase: false, language: 'ja' });
    expect(section).toContain('一部省略');
  });

  it('readError が非nullなら⚠️警告文言を含む', () => {
    const result: AgentsMdReadResult = { content: null, truncated: false, readError: 'EACCES' };
    const section = buildAgentsMdSection(result, { isInvestigationPhase: false, language: 'ja' });
    expect(section).toContain('⚠️');
    expect(section).toContain('EACCES');
    expect(section).toContain('読込失敗');
  });

  it('英語モードでも同等の分岐を持つ', () => {
    const result: AgentsMdReadResult = {
      content: 'no schema changes',
      truncated: false,
      readError: null,
    };
    const section = buildAgentsMdSection(result, { isInvestigationPhase: true, language: 'en' });
    expect(section).toContain('Reference only');
    expect(section).toContain('no schema changes');
  });
});
