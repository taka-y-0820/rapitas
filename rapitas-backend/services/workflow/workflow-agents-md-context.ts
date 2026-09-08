/**
 * WorkflowAgentsMdContext
 *
 * Best-effort reader for a target repository's own AGENTS.md and the pure
 * builder for the prompt section injected from it. The file lives under the
 * theme's effectiveWorkDir, NOT rapitas' own repository — rapitas-specific
 * constraints (e.g. "never kill port 3001") must never be fixed onto other
 * themes (task 892 research.md premise #4). Not responsible for deciding
 * WHERE to inject the section — see workflow-cli-executor-prompt.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../config/logger';

const log = createLogger('workflow:agents-md-context');

/** Prompt-section length cap; keeps a large AGENTS.md from swamping the prompt. */
const MAX_CONTENT_CHARS = 8000;

/** Result of attempting to read a target repository's AGENTS.md. */
export interface AgentsMdReadResult {
  /** File content (possibly truncated), or null when the file does not exist. */
  content: string | null;
  /** True when content was cut to MAX_CONTENT_CHARS. */
  truncated: boolean;
  /** Error message when the file exists but could not be read; null otherwise. */
  readError: string | null;
}

/**
 * Best-effort reads `${workDir}/AGENTS.md`. Absence is a normal outcome (most
 * themes have no AGENTS.md) and is NOT an error — only a present-but-unreadable
 * file (permissions, etc.) sets readError, so callers can surface it instead of
 * silently treating "unreadable" the same as "absent" (task 892 requirement:
 * do not silently treat a failed read as success).
 *
 * @param workDir - Target repository's effective working directory. / 対象リポジトリの作業ディレクトリ
 * @returns The read outcome. / 読込結果
 */
export function readAgentsMdConstraints(workDir: string): AgentsMdReadResult {
  const filePath = path.join(workDir, 'AGENTS.md');
  if (!existsSync(filePath)) {
    return { content: null, truncated: false, readError: null };
  }
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return { content: null, truncated: false, readError: null };
    const truncated = raw.length > MAX_CONTENT_CHARS;
    return {
      content: truncated ? raw.slice(0, MAX_CONTENT_CHARS) : raw,
      truncated,
      readError: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, workDir }, '[agents-md-context] Failed to read AGENTS.md');
    return { content: null, truncated: false, readError: message };
  }
}

/** Language-specific fragments for {@link buildAgentsMdSection}. */
const TEXTS = {
  ja: {
    readErrorPrefix: '⚠️ AGENTS.md読込失敗',
    readErrorSuffix: '。制約不明。破壊的変更前にユーザー確認を。',
    header:
      '対象リポジトリ自身のAGENTS.md（rapitas自身のルールではない。ユーザーの明示的な指示と矛盾する場合はユーザー指示を優先する）',
    investigationNote:
      '参考情報であり、読み取り専用フェーズのため今すぐ実行不要。調査/計画に反映せよ。',
    implementationNote:
      '禁止事項に違反しないこと。違反が必要なら実装を進めず質問として差し戻すこと。',
    truncatedNote: '（一部省略）',
  },
  en: {
    readErrorPrefix: '⚠️ Failed to read AGENTS.md',
    readErrorSuffix: '. Constraints unknown — confirm with the user before destructive changes.',
    header:
      "The target repository's own AGENTS.md (NOT rapitas' own rules; if it conflicts with the user's explicit instruction, the user's instruction wins)",
    investigationNote:
      'Reference only — this is a read-only phase, no action needed now. Reflect it in your research/plan.',
    implementationNote:
      'Do not make changes that violate these prohibitions. If a violation is unavoidable, stop and escalate as a question instead of proceeding.',
    truncatedNote: '(truncated)',
  },
} as const;

/** Options controlling {@link buildAgentsMdSection}'s wording. */
export interface BuildAgentsMdSectionOptions {
  /** True for researcher/planner phases (read-only contract). */
  isInvestigationPhase: boolean;
  language: 'ja' | 'en';
}

/**
 * Builds the AGENTS.md prompt section from a read result. Pure function — no
 * I/O. Returns '' when there is nothing to inject (file absent, the normal
 * case for themes without an AGENTS.md).
 *
 * @param result - Output of readAgentsMdConstraints. / 読込結果
 * @param opts - Phase/language options. / フェーズ・言語オプション
 * @returns Prompt section, or '' when no injection is needed. / セクション文字列
 */
export function buildAgentsMdSection(
  result: AgentsMdReadResult,
  opts: BuildAgentsMdSectionOptions,
): string {
  const t = TEXTS[opts.language];
  if (result.content === null && result.readError === null) return '';
  if (result.readError !== null) {
    return `\n\n${t.readErrorPrefix}（${result.readError}）${t.readErrorSuffix}\n`;
  }
  const roleNote = opts.isInvestigationPhase ? t.investigationNote : t.implementationNote;
  const suffix = result.truncated ? t.truncatedNote : '';
  return `\n\n${t.header}\n${roleNote}\n---\n${result.content}\n---${suffix}\n`;
}
