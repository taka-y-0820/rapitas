/**
 * Multi-provider AI Client Utility
 *
 * Provides a unified interface for Claude / ChatGPT / Gemini.
 *
 * Submodules:
 * - types.ts: Type definitions and constants
 * - credentials.ts: API key management and authentication
 * - error-handler.ts: Error handling
 * - claude-provider.ts: Claude API calls
 * - chatgpt-provider.ts: OpenAI API calls
 * - gemini-provider.ts: Gemini API calls
 */

// --- Re-exports ---
export type { AIProvider, AIMessage, AIRequestOptions, AIResponse } from './types';
export { PROVIDER_NAMES } from './types';

export {
  isValidApiKeyFormat,
  getApiKeyForProvider,
  getDefaultModel,
  getDefaultProvider,
  isAnyApiKeyConfigured,
  getConfiguredProviders,
  getOllamaUrl,
} from './credentials';

export { formatApiError, handleApiError } from './error-handler';

export { callClaude, callClaudeStream } from './claude-provider';
export { callClaudeCli, callClaudeCliStream, isClaudeCliAvailable } from './claude-cli-provider';
export { callChatGPT, callChatGPTStream } from './chatgpt-provider';
export { callGemini, callGeminiStream } from './gemini-provider';
export { callOllama, callOllamaStream, checkOllamaConnection } from './ollama-provider';

// --- Unified API ---
import { type AIRequestOptions, type AIResponse, PROVIDER_NAMES } from './types';
import { getApiKeyForProvider, getDefaultModel, getDefaultProvider } from './credentials';
import { handleApiError } from './error-handler';
import { callClaude } from './claude-provider';
import { callClaudeCli, callClaudeCliStream } from './claude-cli-provider';
import { callChatGPT } from './chatgpt-provider';
import { callGemini } from './gemini-provider';
import { callOllama } from './ollama-provider';
import { callClaudeStream } from './claude-provider';
import { callChatGPTStream } from './chatgpt-provider';
import { callGeminiStream } from './gemini-provider';
import { callOllamaStream } from './ollama-provider';
import { getOllamaUrl } from './credentials';
import { ensureLocalLLM, isLocalLLMEnabled } from '../../services/local-llm';
import { createLogger } from '../../config';
import { buildRAGContext } from '../../services/memory/rag/context-builder';
import { incrementLlmCall } from '../llm-call-context';
import {
  generateCacheKey,
  getCachedResponse,
  setCachedResponse,
} from '../../services/local-llm/response-cache';

const log = createLogger('ai-client');

/**
 * Execute with a paid API provider (fallback target when Ollama fails).
 */
async function sendWithPaidProvider(options: AIRequestOptions): Promise<AIResponse> {
  const provider = await getDefaultProvider();
  const apiKey = await getApiKeyForProvider(provider);

  if (!apiKey) {
    throw new Error(
      `${PROVIDER_NAMES[provider]} APIキーが設定されていません。設定画面でAPIキーを設定してください。`,
    );
  }

  const model = options.model || (await getDefaultModel(provider));
  const maxTokens = options.maxTokens || 2048;

  switch (provider) {
    case 'claude':
      return await callClaude(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    case 'chatgpt':
      return await callChatGPT(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    case 'gemini':
      return await callGemini(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    default:
      throw new Error(`未対応のプロバイダーです: ${provider}`);
  }
}

/**
 * Execute streaming with a paid API provider (fallback target when Ollama fails).
 */
async function sendStreamWithPaidProvider(options: AIRequestOptions): Promise<ReadableStream> {
  const provider = await getDefaultProvider();
  const apiKey = await getApiKeyForProvider(provider);

  if (!apiKey) {
    throw new Error(
      `${PROVIDER_NAMES[provider]} APIキーが設定されていません。設定画面でAPIキーを設定してください。`,
    );
  }

  const model = options.model || (await getDefaultModel(provider));
  const maxTokens = options.maxTokens || 2048;

  switch (provider) {
    case 'claude':
      return callClaudeStream(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    case 'chatgpt':
      return callChatGPTStream(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    case 'gemini':
      return callGeminiStream(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    default:
      throw new Error(`未対応のプロバイダーです: ${provider}`);
  }
}

export type AuxAiMode = 'cli' | 'api' | 'off';

/**
 * Routing mode for auxiliary AI helper calls (naming, spec derivation, memory
 * upkeep, reviews, chat, …). Controls whether these run through the Claude Code
 * CLI (subscription, no per-token billing), the paid Anthropic API, or are
 * disabled entirely.
 *
 * - `cli` (default): delegate to the subscription-backed CLI. No paid API is hit.
 * - `api`: use the paid provider (legacy behavior / emergency escape hatch).
 * - `off`: disable auxiliary AI — callers degrade gracefully.
 *
 * @returns The resolved mode / 解決されたモード
 */
export function getAuxAiMode(): AuxAiMode {
  const v = (process.env.RAPITAS_AUX_AI || 'cli').toLowerCase();
  return v === 'api' || v === 'off' ? v : 'cli';
}

/**
 * Non-local generation target: subscription CLI in `cli` mode, else the paid API.
 * Used as the fallback when the local LLM is unavailable/disabled.
 */
async function runAuxNonLocal(options: AIRequestOptions): Promise<AIResponse> {
  if (getAuxAiMode() === 'cli') {
    return callClaudeCli(
      options.model,
      options.messages,
      options.systemPrompt,
      options.maxTokens || 2048,
    );
  }
  return sendWithPaidProvider(options);
}

/** Streaming counterpart of {@link runAuxNonLocal}. */
async function runAuxNonLocalStream(options: AIRequestOptions): Promise<ReadableStream> {
  if (getAuxAiMode() === 'cli') {
    return callClaudeCliStream(
      options.model,
      options.messages,
      options.systemPrompt,
      options.maxTokens || 2048,
    );
  }
  return sendStreamWithPaidProvider(options);
}

/**
 * Unified AI chat API (non-streaming).
 */
export async function sendAIMessage(options: AIRequestOptions): Promise<AIResponse> {
  if (process.env.RAPITAS_TASK901_MAINTENANCE === 'api')
    throw new Error('AI is held during API recovery');
  const auxMode = getAuxAiMode();
  if (auxMode === 'off') {
    throw new Error('補助AI機能は無効化されています (RAPITAS_AUX_AI=off)。');
  }
  const provider = options.provider || 'claude';

  // Local LLM (Ollama preferred -> llama-server -> paid API fallback)
  if (provider === 'ollama') {
    // Local LLM disabled by config (RAPITAS_ENABLE_LOCAL_LLM unset) is the
    // EXPECTED state, not a failure — route straight to the paid API without a
    // warning. Otherwise every memory/contradiction job logged a WARN per call.
    if (!isLocalLLMEnabled()) {
      const result = await runAuxNonLocal(options);
      incrementLlmCall();
      return result;
    }
    try {
      const ollamaUrl = await getOllamaUrl();
      const localLLM = await ensureLocalLLM(ollamaUrl, options.model);
      const maxTokens = options.maxTokens || 2048;

      // NOTE: RAG context injection — augments the small local model with relevant knowledge.
      let systemPrompt = options.systemPrompt;
      if (options.enableRAG) {
        try {
          const lastUserMsg = [...options.messages].reverse().find((m) => m.role === 'user');
          const query = lastUserMsg?.content.slice(0, 500) || '';
          if (query.length > 0) {
            const ragContext = await buildRAGContext(query, {
              limit: 3,
              minSimilarity: 0.5,
              themeId: options.ragThemeId,
            });
            if (ragContext.contextText.length > 0) {
              systemPrompt = ragContext.contextText + '\n\n---\n\n' + (systemPrompt || '');
              log.debug(
                { ragEntries: ragContext.entries.length },
                'RAG context injected for local LLM',
              );
            }
          }
        } catch (ragError) {
          // NOTE: RAG failure should not block the LLM call — degrade gracefully.
          log.warn({ err: ragError }, 'RAG injection failed, proceeding without context');
        }
      }

      // NOTE: Response cache — skip LLM call entirely on cache hit.
      if (!options.skipCache) {
        const cacheKey = generateCacheKey('ollama', localLLM.model, systemPrompt, options.messages);
        const cached = getCachedResponse(cacheKey);
        if (cached) {
          incrementLlmCall();
          return cached;
        }

        const response = await callOllama(
          localLLM.url,
          localLLM.model,
          options.messages,
          systemPrompt,
          maxTokens,
        );
        setCachedResponse(
          cacheKey,
          response.content,
          response.tokensUsed,
          'ollama',
          localLLM.model,
        );
        incrementLlmCall();
        return response;
      }

      const ollamaResult = await callOllama(
        localLLM.url,
        localLLM.model,
        options.messages,
        systemPrompt,
        maxTokens,
      );
      incrementLlmCall();
      return ollamaResult;
    } catch (error) {
      log.warn({ err: error }, 'Local LLM failed, falling back');
      const fallbackResult = await runAuxNonLocal(options);
      incrementLlmCall();
      return fallbackResult;
    }
  }

  // Delegate to the subscription CLI instead of any paid API when in `cli` mode.
  if (auxMode === 'cli') {
    const result = await callClaudeCli(
      options.model,
      options.messages,
      options.systemPrompt,
      options.maxTokens || 2048,
    );
    incrementLlmCall();
    return result;
  }

  const apiKey = await getApiKeyForProvider(provider);

  if (!apiKey) {
    throw new Error(
      `${PROVIDER_NAMES[provider]} APIキーが設定されていません。設定画面でAPIキーを設定してください。`,
    );
  }

  const model = options.model || (await getDefaultModel(provider));
  const maxTokens = options.maxTokens || 2048;

  try {
    let paidResult: Awaited<ReturnType<typeof callClaude>>;
    switch (provider) {
      case 'claude':
        paidResult = await callClaude(
          apiKey,
          model,
          options.messages,
          options.systemPrompt,
          maxTokens,
        );
        break;
      case 'chatgpt':
        paidResult = await callChatGPT(
          apiKey,
          model,
          options.messages,
          options.systemPrompt,
          maxTokens,
        );
        break;
      case 'gemini':
        paidResult = await callGemini(
          apiKey,
          model,
          options.messages,
          options.systemPrompt,
          maxTokens,
        );
        break;
      default:
        throw new Error(`未対応のプロバイダーです: ${provider}`);
    }
    incrementLlmCall();
    return paidResult;
  } catch (error) {
    handleApiError(error, provider);
  }
}

/**
 * Unified AI chat API (streaming).
 */
export async function sendAIMessageStream(options: AIRequestOptions): Promise<ReadableStream> {
  if (process.env.RAPITAS_TASK901_MAINTENANCE === 'api')
    throw new Error('AI is held during API recovery');
  const auxMode = getAuxAiMode();
  if (auxMode === 'off') {
    throw new Error('補助AI機能は無効化されています (RAPITAS_AUX_AI=off)。');
  }
  const provider = options.provider || 'claude';

  // Local LLM (Ollama preferred -> llama-server -> paid API fallback)
  if (provider === 'ollama') {
    // Disabled by config is the expected state — fall back silently (see sendAIMessage).
    if (!isLocalLLMEnabled()) {
      return await runAuxNonLocalStream(options);
    }
    try {
      const ollamaUrl = await getOllamaUrl();
      const localLLM = await ensureLocalLLM(ollamaUrl);
      const maxTokens = options.maxTokens || 2048;
      return await callOllamaStream(
        localLLM.url,
        localLLM.model,
        options.messages,
        options.systemPrompt,
        maxTokens,
      );
    } catch (error) {
      log.warn({ err: error }, 'Local LLM stream failed, falling back');
      return await runAuxNonLocalStream(options);
    }
  }

  // Delegate to the subscription CLI instead of any paid API when in `cli` mode.
  if (auxMode === 'cli') {
    return callClaudeCliStream(
      options.model,
      options.messages,
      options.systemPrompt,
      options.maxTokens || 2048,
    );
  }

  const apiKey = await getApiKeyForProvider(provider);

  if (!apiKey) {
    throw new Error(
      `${PROVIDER_NAMES[provider]} APIキーが設定されていません。設定画面でAPIキーを設定してください。`,
    );
  }

  const model = options.model || (await getDefaultModel(provider));
  const maxTokens = options.maxTokens || 2048;

  switch (provider) {
    case 'claude':
      return callClaudeStream(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    case 'chatgpt':
      return callChatGPTStream(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    case 'gemini':
      return callGeminiStream(apiKey, model, options.messages, options.systemPrompt, maxTokens);
    default:
      throw new Error(`未対応のプロバイダーです: ${provider}`);
  }
}
