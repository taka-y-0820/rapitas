/**
 * CodexCliAgent — Types and Utilities
 *
 * Shared type definitions and platform utility for the CodexCliAgent module.
 * Not responsible for process spawning or output parsing.
 */

/** Configuration for the CodexCliAgent. */
export type CodexCliAgentConfig = {
  workingDirectory?: string;
  model?: string;
  timeout?: number;
  apiKey?: string;
  fullAuto?: boolean;
  yolo?: boolean;
  resumeSessionId?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Approval policy mirror of `--ask-for-approval`. When set, this overrides
   * the implicit policy from `--full-auto`. Use `never` for non-interactive
   * read-only investigation runs.
   */
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  /**
   * Path to which Codex should write its final assistant message via the
   * `-o / --output-last-message` flag. Used by research/plan/review phases
   * so the agent's output is captured as a file even though it cannot
   * modify the workspace.
   */
  outputLastMessageFile?: string;
  /**
   * When true, codex is treated as an investigation-only agent for the
   * current execution: skip `--full-auto`, use `--sandbox=read-only`, set
   * `--ask-for-approval=never`, and write final output via `-o` if
   * `outputLastMessageFile` is provided. The result is a Markdown report
   * with NO code changes possible at the OS level.
   */
  investigationMode?: boolean;
  /**
   * Which kind of artifact the investigation should produce. Drives the
   * positional headline given to `codex exec` so the agent knows whether
   * its final message must start with `# 調査レポート`, `# 実装計画`, or
   * `# レビュー指摘`. Defaults to `research` when omitted to preserve
   * the original behaviour of the researcher role.
   */
  investigationOutputType?: 'research' | 'plan' | 'review' | 'verify';
};

export { resolveCliPathAsync as resolveCliPath } from '../../../utils/common/cli-path-resolver';
