/**
 * SettingsTypes
 *
 * Type definitions, constants, and pure utility functions shared across
 * all settings route handlers.
 *
 * Not responsible for database access or HTTP routing.
 */

// ============================================================================
// Request body interfaces
// ============================================================================

/** Body for PATCH /settings */
export interface UserSettingsUpdateBody {
  developerModeDefault?: boolean;
  aiTaskAnalysisDefault?: boolean;
  autoResumeInterruptedTasks?: boolean;
  autoExecuteAfterCreate?: boolean;
  autoGenerateTitle?: boolean;
  autoGenerateTitleDelay?: number;
  autoCreateAfterTitleGeneration?: boolean;
  autoApprovePlan?: boolean;
  autoComplexityAnalysis?: boolean;
  /** Per-theme cap on auto-created backlog tasks (0 = disabled). */
  autoCreateFromBacklogLimit?: number;
  /** Dev: restart backend when auto-run runs dry to apply committed fixes. */
  restartOnAutoRunDry?: boolean;
  /** Max verify->implement self-repair cycles before a task is blocked (0 = off). */
  verifyRepairLimit?: number;
  /** Minutes of no-progress before a task is flagged stalled on the execution dashboard (default 5). */
  executionStallThresholdMinutes?: number;
  /** Minutes of no new filing after auto-run runs dry before it is stopped (0 = off). */
  idleStopMinutes?: number;
  /** Local "HH:MM" the nightly backlog self-refill window opens ('' = self-refill off). */
  selfRefillWindowStart?: string;
  /** Dev: auto-restart when merged-but-inactive commits are detected on origin (file-backed, no DB column). */
  autoRestartOnMergedCode?: boolean;
  /** Process retrospective on task completion (file-backed, no DB column; default ON). */
  retroReviewEnabled?: boolean;
  /** Strict merge barrier: hold the next auto-run task until the theme's open auto-PR merges (file-backed, no DB column; default OFF). */
  mergeBarrierEnabled?: boolean;
  /** UI locale pushed by the desktop app; agent prompts follow it (file-backed, no DB column). */
  uiLocale?: 'ja' | 'en';
  defaultAiProvider?: string;
  defaultCategoryId?: number | null;
  activeMode?: string;
  /** Global off-switch for the multi-phase workflow (see Task.workflowDisabled for the per-task equivalent). */
  workflowDisabledGlobally?: boolean;
}

/** Body for POST /settings/api-key */
export interface ApiKeyBody {
  apiKey: string;
  provider?: string;
}

/** Body for POST /settings/model */
export interface ModelConfigBody {
  model?: string;
  provider?: string;
}

// ============================================================================
// Provider maps
// ============================================================================

/** Maps provider IDs to their encrypted API-key column names. */
export const PROVIDER_COLUMNS = {
  claude: 'claudeApiKeyEncrypted',
  chatgpt: 'chatgptApiKeyEncrypted',
  gemini: 'geminiApiKeyEncrypted',
} as const;

/** Maps provider IDs to their default-model column names. */
export const PROVIDER_MODEL_COLUMNS = {
  claude: 'claudeDefaultModel',
  chatgpt: 'chatgptDefaultModel',
  gemini: 'geminiDefaultModel',
} as const;

export type ApiProvider = keyof typeof PROVIDER_COLUMNS;

/**
 * Returns true if the given string is a recognised provider ID.
 *
 * @param provider - String to test / テストする文字列
 * @returns Whether the string is a valid ApiProvider / 有効なApiProviderかどうか
 */
export function isValidProvider(provider: string): provider is ApiProvider {
  return provider in PROVIDER_COLUMNS;
}

// ============================================================================
// API response types
// ============================================================================

/** Shape of Anthropic models list response. */
export interface ClaudeModelsResponse {
  models: Array<{
    id: string;
    display_name?: string;
  }>;
}

/** Shape of OpenAI models list response. */
export interface OpenAIModelsResponse {
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
}

/** Shape of Gemini models list response. */
export interface GeminiModelsResponse {
  models: Array<{
    name: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
}

// ============================================================================
// Fallback model lists
// ============================================================================

/** Fallback models used when dynamic fetching from provider APIs fails. */
export const FALLBACK_MODELS: Record<string, Array<{ value: string; label: string }>> = {
  claude: [
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  ],
  chatgpt: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'o1', label: 'o1' },
    { value: 'o1-mini', label: 'o1 Mini' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
  ],
  gemini: [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
    { value: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (Experimental)' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    { value: 'gemini-1.5-flash-8b', label: 'Gemini 1.5 Flash 8B' },
  ],
};

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates the API key format for the given provider.
 * Prevents saving obviously malformed keys without a live API round-trip.
 *
 * @param apiKey - The raw API key string / 生のAPIキー文字列
 * @param provider - Target provider / 対象プロバイダ
 * @returns Validation result with an optional error message / バリデーション結果（エラーメッセージ付き）
 */
export function validateApiKeyFormat(
  apiKey: string,
  provider: ApiProvider,
): { valid: boolean; error?: string } {
  const trimmed = apiKey.trim();

  if (!trimmed) {
    return { valid: false, error: 'APIキーを入力してください' };
  }

  if (trimmed.length < 10) {
    return { valid: false, error: 'APIキーが短すぎます（10文字以上必要です）' };
  }

  switch (provider) {
    case 'claude':
      if (!trimmed.startsWith('sk-ant-api')) {
        return {
          valid: false,
          error: 'Claude APIキーは「sk-ant-api」で始まる必要があります',
        };
      }
      break;
    case 'chatgpt':
      if (!trimmed.startsWith('sk-')) {
        return {
          valid: false,
          error: 'OpenAI APIキーは「sk-」で始まる必要があります',
        };
      }
      // Prevent accidental use of Claude API key
      if (trimmed.startsWith('sk-ant-api')) {
        return {
          valid: false,
          error: 'これはClaude APIキーです。OpenAI APIキーを入力してください',
        };
      }
      break;
    case 'gemini':
      if (!trimmed.startsWith('AIza')) {
        return {
          valid: false,
          error: 'Gemini APIキーは「AIza」で始まる必要があります',
        };
      }
      break;
  }

  return { valid: true };
}

// NOTE: Private-use ranges per RFC 1918 (IPv4) / RFC 4193 (IPv6 ULA), used to
// allow LAN-hosted Ollama instances while still rejecting public hosts.
// Deliberately EXCLUDES 169.254.0.0/16 (IPv4 link-local): that range contains
// 169.254.169.254, the AWS/GCP/Azure cloud-metadata endpoint. Ollama never
// runs there, so allowing it here would only hand an SSRF primitive a path to
// instance credentials.
const PRIVATE_IPV4_PATTERNS: RegExp[] = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/**
 * Whether `hostname` is loopback, a private/LAN IPv4 or IPv6 address, or a
 * `.local` mDNS name — the set of hosts a local Ollama server can plausibly
 * live on.
 *
 * @param hostname - Hostname or IP literal from a parsed URL / パース済みURLのホスト名
 * @returns True if the host is loopback/private/LAN / ホストがループバック/プライベート/LANならtrue
 */
export function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }
  if (host.endsWith('.local')) return true;
  if (PRIVATE_IPV4_PATTERNS.some((re) => re.test(host))) return true;
  // IPv6 unique local addresses (fc00::/7) only. IPv6 link-local (fe80::/10)
  // is deliberately excluded — same cloud-metadata-adjacent reasoning as the
  // IPv4 169.254.0.0/16 exclusion above (some cloud metadata services are
  // also reachable via link-local-scoped addresses).
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(host)) return true;
  return false;
}

/**
 * Validates a user-supplied Ollama base URL: must be http(s) and must point
 * at a loopback/private/LAN host. Ollama is a local service — accepting an
 * arbitrary public URL here would turn this settings field into a
 * server-side-request-forgery (SSRF) primitive (the backend fetches this URL
 * on the server's behalf).
 *
 * @param url - Raw URL string from the request body / リクエストボディの生URL文字列
 * @returns Validation result with an optional error message / バリデーション結果（エラーメッセージ付き）
 */
export function validateOllamaUrl(url: string): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'ollamaUrl は有効なURLである必要があります' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'ollamaUrl は http または https のURLである必要があります' };
  }
  if (!isLoopbackOrPrivateHost(parsed.hostname)) {
    return {
      valid: false,
      error: 'ollamaUrl はローカル/プライベートホストである必要があります（パブリックURLは不可）',
    };
  }
  return { valid: true };
}
