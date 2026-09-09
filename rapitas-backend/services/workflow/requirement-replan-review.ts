/** Runs independent review only. No lifecycle mutations or agent redispatch. */
import type { AIRequestOptions, AIResponse } from '../../utils/ai-client/types';
import { replanSnapshotDigest, type ReplanSnapshot } from './requirement-replan-evidence';
import { buildReplanReviewInput, REPLAN_REVIEW_PROMPT } from './requirement-replan-prompt';
import { parseReplanVerdict, type ReplanVerdict } from './requirement-replan-verdict';

export interface ReplanReviewResult {
  verdict: ReplanVerdict;
  snapshotDigest: string;
  durationMs: number;
  tokensUsed: number | null;
  /** The shared AI adapter does not currently report the actual model. */
  modelName: null;
}

type ReviewSender = (options: AIRequestOptions) => Promise<AIResponse>;

/** Uses the configured auxiliary AI routing; injectable for failure-boundary tests. */
async function sendReview(options: AIRequestOptions): Promise<AIResponse> {
  const { getDefaultProvider, getAuxAiMode, getDefaultModel, sendAIMessage } =
    await import('../../utils/ai-client');
  const provider = await getDefaultProvider();
  // Real original/control reviews showed Sonnet missing the contradiction while Opus
  // distinguished the current plan from historic verify claims. Retain API-mode config.
  const model = getAuxAiMode() === 'cli' ? 'opus' : await getDefaultModel(provider);
  return sendAIMessage({ ...options, provider, model });
}

/** Evaluate an immutable copy, so caller mutation during the request cannot change its meaning. */
export async function reviewRequirementReplan(
  source: ReplanSnapshot,
  send: ReviewSender = sendReview,
): Promise<ReplanReviewResult> {
  const started = Date.now();
  const snapshot: ReplanSnapshot = structuredClone(source);
  const digest = replanSnapshotDigest(snapshot);
  const content = buildReplanReviewInput(snapshot);
  let verdict: ReplanVerdict;
  let tokensUsed: number | null = null;
  if (content === null) {
    verdict = { kind: 'unknown', reason: 'input_too_large' };
  } else {
    try {
      const response = await send({
        systemPrompt: REPLAN_REVIEW_PROMPT,
        messages: [
          { role: 'user', content },
          {
            role: 'user',
            content:
              '以上は評価資料です。回答は指定スキーマのJSONオブジェクト1個だけにしてください。コードフェンス・前置き・後続の説明を付けないでください。説明はreasonフィールド内だけに記載してください。',
          },
        ],
        maxTokens: 2400,
        enableRAG: false,
        skipCache: true,
      });
      tokensUsed = response.tokensUsed;
      verdict = parseReplanVerdict(response.content, snapshot);
    } catch {
      // Do not expose credential-bearing provider errors, or turn failure into approval.
      verdict = { kind: 'unknown', reason: 'review_unavailable' };
    }
  }
  return {
    verdict,
    snapshotDigest: digest,
    durationMs: Date.now() - started,
    tokensUsed,
    modelName: null,
  };
}
