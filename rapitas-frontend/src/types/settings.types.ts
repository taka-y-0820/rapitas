/**
 * settings.types
 *
 * Type definitions for user settings, API provider configuration, and active mode selection.
 */

export type ApiProvider = 'claude' | 'chatgpt' | 'gemini' | 'ollama';

export type ApiKeyStatus = {
  configured: boolean;
  maskedKey: string | null;
};

export type ActiveMode = 'development' | 'learning' | 'both';

export type UserSettings = {
  id: number;
  aiTaskAnalysisDefault: boolean;
  autoResumeInterruptedTasks: boolean;
  autoExecuteAfterCreate: boolean;
  autoGenerateTitle: boolean;
  autoGenerateTitleDelay: number;
  autoCreateAfterTitleGeneration: boolean;
  autoFetchTaskSuggestions: boolean;
  autoApprovePlan: boolean;
  autoApproveSubtaskPlan: boolean;
  autoComplexityAnalysis: boolean;
  /** Per-theme cap on auto-created backlog tasks when auto-run runs dry (0 = disabled). */
  autoCreateFromBacklogLimit?: number;
  /** Dev: restart the backend when auto-run runs dry to apply committed fixes. */
  restartOnAutoRunDry?: boolean;
  /** Max verify->implement self-repair cycles before a task is blocked (0 = off). */
  verifyRepairLimit?: number;
  /** Minutes of no-progress before a task is flagged stalled on the execution dashboard (default 5). */
  executionStallThresholdMinutes?: number;
  /** 枯渇後に新規起票が無いままこの分数が経過すると auto-run を停止する（0 = 無効）。 */
  idleStopMinutes?: number;
  /** バックログ自己補充を許可する夜間ウィンドウの開始時刻 "HH:MM"（'' = 自己補充無効）。 */
  selfRefillWindowStart?: string;
  /** マージ済みだが未活性のコード検知時、アイドル時に安全に自動再起動する。 */
  autoRestartOnMergedCode?: boolean;
  /** UI の言語。エージェントの文書・報告の出力言語がこれに追従する（ファイル保存、DB列なし）。 */
  uiLocale?: 'ja' | 'en';
  autoCommitDefault?: boolean;
  autoCreatePRDefault?: boolean;
  autoMergePRDefault?: boolean;
  mergeCommitThresholdDefault?: number;
  defaultCategoryId?: number | null;
  activeMode: ActiveMode;
  claudeApiKeyConfigured?: boolean;
  claudeApiKeyMasked?: string | null;
  chatgptApiKeyConfigured?: boolean;
  chatgptApiKeyMasked?: string | null;
  geminiApiKeyConfigured?: boolean;
  geminiApiKeyMasked?: string | null;
  claudeDefaultModel?: string | null;
  chatgptDefaultModel?: string | null;
  geminiDefaultModel?: string | null;
  defaultAiProvider?: ApiProvider | null;
  ollamaUrl?: string | null;
  ollamaDefaultModel?: string | null;
  titleGenerationProvider?: string | null;
  /**
   * When true, CLI agents are spawned with their permission-bypass flags
   * (`--dangerously-skip-permissions` for Claude Code, `--yolo` for Codex /
   * Gemini) so they never stop mid-execution to ask the user. Default true.
   */
  skipAgentPermissionPrompts?: boolean;
  /**
   * Global off-switch for the multi-phase workflow (research/plan/verify as
   * separately-saved artifacts + phase-critic gate). When true, new task
   * executions skip straight to a single direct-implementation pass — lint/
   * test verification, adversarial diff review, and the completion gate still
   * apply. See Task.workflowDisabled for the per-task equivalent.
   */
  workflowDisabledGlobally?: boolean;
  createdAt: string;
  updatedAt: string;
};
