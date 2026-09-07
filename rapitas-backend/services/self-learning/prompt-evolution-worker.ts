/**
 * prompt-evolution-worker
 *
 * Completes the prompt-evolution pipeline that stopped at "pending": the
 * runner marks underperforming roles, this worker GENERATES a concrete
 * improvement addendum for each pending candidate (status → 'proposed'), the
 * candidate is reviewed (by a human on /system-prompts, or by the measured
 * limited trial in prompt-evolution-auto-approve), and approved addenda are
 * injected into that role's workflow context. The addendum always AUGMENTS the
 * engineered role prompt rather than replacing it.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { sendAIMessage } from '../../utils/ai-client';
import { readComparisonRecord, writeComparisonRecord } from './comparison/prompt-comparison-store';
import {
  validateAddendumQuality,
  type AddendumQualityReason,
} from './prompt-evolution-addendum-quality';

const log = createLogger('self-learning:prompt-evolution-worker');

/** Max pending candidates turned into proposals per run (LLM cost bound). */
const PROPOSAL_BATCH = 3;

/** Max addendum length injected into a role prompt (chars). */
export const MAX_ADDENDUM_CHARS = 1200;

/**
 * Quality-gate failures tolerated before a candidate is rejected outright.
 * LLM sampling varies, so one malformed generation is retried on the next
 * weekly run; an unbounded retry would pay LLM cost forever.
 */
const MAX_QUALITY_RETRIES = 2;

/**
 * Parse a row's evidenceJson into a mutable object. Unreadable evidence
 * yields an empty object so the caller's stamps are never lost to a parse error.
 *
 * @param raw - Stored evidenceJson. / 保存済みの証跡JSON
 * @returns Parsed object, or {} when unusable. / パース結果
 */
function parseEvidence(raw: string | null): Record<string, unknown> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* unreadable evidence — start fresh rather than dropping the stamp */
  }
  return {};
}

/**
 * Record a quality-gate failure on a pending candidate: keep it `pending` for
 * a retry, or reject it once the retry budget is spent.
 *
 * @param candidate - Row whose generated addendum failed the gate. / 不合格の候補行
 * @param reason - Which degradation was detected. / 検出された劣化種別
 */
async function recordQualityFailure(
  candidate: { id: number; evidenceJson: string | null },
  reason: AddendumQualityReason,
): Promise<void> {
  const evidence = parseEvidence(candidate.evidenceJson);
  const previous = typeof evidence.qualityRetries === 'number' ? evidence.qualityRetries : 0;
  const attempts = previous + 1;
  const exhausted = attempts > MAX_QUALITY_RETRIES;
  await prisma.promptEvolution.update({
    where: { id: candidate.id },
    data: {
      status: exhausted ? 'rejected' : 'pending',
      evidenceJson: JSON.stringify({
        ...evidence,
        qualityRetries: attempts,
        ...(exhausted ? { rejectionReason: reason } : {}),
      }),
    },
  });
  log.warn(
    { id: candidate.id, reason, attempts, rejected: exhausted },
    '[prompt-evolution] Addendum failed the quality gate',
  );
}

/**
 * Summarize the role's recent gate rejections as evidence for the generator.
 *
 * @param role - Workflow role (researcher/planner/...). / 対象ロール
 * @returns Cause → count lines, or '' when none. / 却下要因の要約
 */
async function summarizeRoleTrouble(role: string): Promise<string> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.workflowTransition.findMany({
      where: { actor: role, createdAt: { gte: since } },
      select: { cause: true },
      take: 500,
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!r.cause || r.cause.startsWith('file_saved')) continue;
      counts.set(r.cause, (counts.get(r.cause) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([cause, n]) => `- ${cause}: ${n}回`)
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Generate improvement proposals for pending evolution candidates.
 * Each proposal is a bounded, imperative addendum for the role's prompt —
 * stored on the row (status 'proposed') and NEVER applied without approval.
 *
 * @param limit - Max candidates to process this run. / 1回の処理上限
 * @returns Number of proposals generated. / 生成件数
 */
export async function generateProposalsForPending(limit = PROPOSAL_BATCH): Promise<number> {
  const pending = await prisma.promptEvolution.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let generated = 0;

  for (const candidate of pending) {
    const role = candidate.basePromptKey?.replace(/^workflow_role_/, '') ?? '';
    if (!role) continue;
    try {
      const trouble = await summarizeRoleTrouble(role);
      const response = await sendAIMessage({
        messages: [
          {
            role: 'user',
            content: `あなたはAIエージェントのプロンプト改善の専門家です。
ワークフローの「${role}」ロールの成績が低下しています。

検出理由: ${candidate.reason ?? '(不明)'}
集計指標: ${candidate.evidenceJson ?? '(なし)'}
直近30日の検証ゲート却下要因:
${trouble || '(記録なし)'}

このロールの既存指示に「追記」する改善ガイダンスを書いてください。
制約:
- 最大8行の箇条書き、命令形、日本語
- 上記の却下要因を直接減らす具体的な行動指示のみ
- 一般論(「注意深く」等)は禁止。検証ゲートを通すための具体的手順を書く
- 出力は追記文のみ(前置き・見出し・説明は不要)`,
          },
        ],
        maxTokens: 512,
      });

      const addendum = response.content.trim().slice(0, MAX_ADDENDUM_CHARS);
      if (!addendum) continue;

      // A code fence, a list of questions, or a request for an instruction
      // file cannot be followed by an agent — such a candidate must never
      // reach 'proposed', where the auto-approval gate could pick it up.
      const quality = validateAddendumQuality(addendum);
      if (!quality.valid && quality.reason) {
        await recordQualityFailure(candidate, quality.reason);
        continue;
      }

      await prisma.promptEvolution.update({
        where: { id: candidate.id },
        data: {
          afterPrompt: addendum,
          improvement: addendum.split('\n')[0]?.slice(0, 200) ?? '',
          category: role,
          status: 'proposed',
        },
      });
      generated++;
      log.info(
        { id: candidate.id, role },
        '[prompt-evolution] Proposal generated — awaiting human approval on /system-prompts',
      );
    } catch (err) {
      log.warn({ err, id: candidate.id, role }, '[prompt-evolution] Proposal generation failed');
    }
  }
  return generated;
}

/**
 * Latest APPROVED addendum for a workflow role, for prompt injection.
 * Returns null when none — callers skip the section entirely.
 *
 * When the addendum's comparison record carries a non-null `stagedTaskIds`
 * (set via the `/stage` endpoint after a passing comparison), the addendum is
 * a LIMITED-APPLICATION candidate: it is only returned for tasks in that
 * list, so it can be measured on a handful of tasks before wider rollout. An
 * omitted task id cannot establish membership, so staged addenda are withheld.
 * No comparison record, or `stagedTaskIds: null`, falls back to the original
 * apply-to-every-task behavior.
 *
 * @param role - Workflow role name. / ロール名
 * @param taskId - Task about to run this role, for staged-scope filtering. / スコープ判定用タスクID
 * @returns The approved addendum text, or null. / 承認済み追記 or null
 */
export async function getApprovedRoleAddendum(
  role: string,
  taskId?: number,
): Promise<string | null> {
  return (await getApprovedRoleAddendumDetail(role, taskId))?.text ?? null;
}

/** An approved addendum together with the row it came from. */
export interface ApprovedAddendum {
  /** PromptEvolution row whose text is being injected. */
  promptEvolutionId: number;
  /** Addendum text, already truncated to MAX_ADDENDUM_CHARS. */
  text: string;
}

/**
 * Same selection as getApprovedRoleAddendum, but also reports WHICH row the
 * text came from so the injection can be logged against a specific candidate
 * version instead of an anonymous string.
 *
 * @param role - Workflow role name. / ロール名
 * @param taskId - Task about to run this role, for staged-scope filtering. / スコープ判定用タスクID
 * @returns The addendum and its row id, or null. / 追記と行ID or null
 */
export async function getApprovedRoleAddendumDetail(
  role: string,
  taskId?: number,
): Promise<ApprovedAddendum | null> {
  try {
    // 'completed' = settled and kept (prompt-evolution-settle.ts); it stays
    // injected. 'reverted' rows are excluded on purpose.
    const row = await prisma.promptEvolution.findFirst({
      where: { basePromptKey: `workflow_role_${role}`, status: { in: ['approved', 'completed'] } },
      orderBy: { id: 'desc' },
      select: { id: true, afterPrompt: true },
    });
    const text = row?.afterPrompt?.trim();
    if (!row || !text) return null;

    const comparison = readComparisonRecord(row.id);
    const stagedTaskIds = comparison?.stagedTaskIds ?? null;
    if (stagedTaskIds !== null && (taskId === undefined || !stagedTaskIds.includes(taskId))) {
      return null;
    }
    return { promptEvolutionId: row.id, text: text.slice(0, MAX_ADDENDUM_CHARS) };
  } catch {
    return null;
  }
}

function withApprovedAt(raw: string | null): string {
  return JSON.stringify({ ...parseEvidence(raw), approvedAt: new Date().toISOString() });
}

/** Statuses a review may act on: awaiting human review, or under limited trial. */
const REVIEWABLE_STATUSES = ['proposed', 'staged'];

/**
 * Approve or reject a proposed evolution. Approving retires any previously
 * approved addendum for the same role (exactly one active addendum per role,
 * so the injected guidance never stacks unboundedly).
 *
 * `staged` rows are reviewable too: that is the state a candidate sits in
 * while its limited trial accumulates comparison evidence, and the trial's
 * verdict (prompt-evolution-auto-approve) adopts or withdraws it through this
 * same one-addendum-per-role path. Any other status is already settled and is
 * refused.
 *
 * @param id - PromptEvolution row id. / 対象ID
 * @param approved - true=approve, false=reject. / 承認するか
 * @returns Whether the row existed and was updated. / 更新できたか
 */
export async function reviewProposal(id: number, approved: boolean): Promise<boolean> {
  const row = await prisma.promptEvolution.findUnique({
    where: { id },
    select: { id: true, status: true, basePromptKey: true, evidenceJson: true },
  });
  if (!row || !REVIEWABLE_STATUSES.includes(row.status)) return false;

  if (approved && row.basePromptKey) {
    await prisma.promptEvolution.updateMany({
      where: { basePromptKey: row.basePromptKey, status: { in: ['approved', 'completed'] } },
      data: { status: 'superseded' },
    });
  }
  if (approved && row.status === 'staged') {
    // Adopting a trialled candidate means it stops being limited to the tasks
    // the trial happened to touch. Done here rather than in the caller so the
    // unattended path and a human clicking approve on /system-prompts cannot
    // disagree about the rollout's scope.
    const comparison = readComparisonRecord(id);
    if (comparison && comparison.stagedTaskIds !== null) {
      writeComparisonRecord({ ...comparison, stagedTaskIds: null });
    }
  }
  // approvedAt anchors the post-approval measurement window
  // (prompt-evolution-settle.ts) — without it the loop never closes.
  const evidence = approved ? withApprovedAt(row.evidenceJson) : undefined;
  await prisma.promptEvolution.update({
    where: { id },
    data: {
      status: approved ? 'approved' : 'rejected',
      ...(evidence ? { evidenceJson: evidence } : {}),
    },
  });
  log.info({ id, approved }, '[prompt-evolution] Proposal reviewed');
  return true;
}

/**
 * List proposals awaiting human review (for the /system-prompts page).
 *
 * @returns Proposed rows, oldest first. / 承認待ち一覧
 */
export async function listProposals() {
  return prisma.promptEvolution.findMany({
    where: { status: 'proposed' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      basePromptKey: true,
      category: true,
      reason: true,
      afterPrompt: true,
      createdAt: true,
    },
  });
}
