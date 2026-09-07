/**
 * PromptEvolutionSettle
 *
 * Closes the prompt-evolution loop. An approved addendum is injected into a
 * role's prompt (getApprovedRoleAddendum) but, until now, nothing ever
 * measured whether the role got better: every row stayed "approved" forever
 * and completedCount was 0 (autonomy audit 2026-09-06). This module scores
 * the role over the sessions that ran AFTER approval with the same success
 * definition the runner used to flag the role, records the delta, and
 * retires an addendum that made things worse. Not responsible for proposing
 * or approving addenda.
 */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { createLogger } from '../../config/logger';
import { evaluateRole, type RoleEvaluation } from './prompt-evolution-runner';
import { readComparisonRecord, updateComparisonScope } from './comparison/prompt-comparison-store';

const log = createLogger('self-learning:prompt-evolution-settle');

/**
 * Whether a candidate that PASSED its measured comparison may be promoted to a
 * full rollout without a human click. Default ON; set
 * RAPITAS_PROMPT_AUTO_PROMOTE=false to opt out.
 *
 * Shared with prompt-evolution-auto-approve so the limited trial's adoption
 * step and this module's staged promotion are gated by the SAME switch rather
 * than two copies that can drift apart.
 *
 * NOTE: this was opt-in (`=== 'true'`) and therefore off in every real
 * deployment, which meant a candidate could clear the comparison gate and then
 * sit `staged` forever — the loop looked complete but never closed. The safety
 * property lives in the EVIDENCE gate (decideComparisonVerdict: minimum
 * sample, significance floor, baseline-relative cost/duration tolerance), not
 * in a flag nobody sets; its sibling `autoApproveEnabled` is opt-out for the
 * same reason.
 * / 実測比較を通過した候補の無人昇格（既定オン。'false' 明示でオプトアウト）
 *
 * @returns True when unattended promotion is enabled. / 無人昇格が有効なら true
 */
export function autoPromoteEnabled(): boolean {
  return process.env.RAPITAS_PROMPT_AUTO_PROMOTE !== 'false';
}

/**
 * Whether an addendum text reads as a pure addition rather than an
 * instruction to remove/replace existing agent behavior. The addendum
 * mechanism itself only ever APPENDS to the engineered role prompt (see
 * module doc) — `beforePrompt` is never populated to diff against — so this
 * is a conservative textual guard against an LLM-authored addendum that
 * tells the agent to strip out existing behavior, not a full diff.
 *
 * @param addendum - Approved addendum text. / 承認済み追記文
 * @returns True when no deletion-signal keywords are present. / 削除を示す語が無ければtrue
 */
export function isPureAddendum(addendum: string): boolean {
  return !/削除|除去|取り除|remove|delete/i.test(addendum);
}

/** Sessions after approval needed before a verdict — below this the sample is noise. */
export const SETTLE_MIN_RUNS = 5;
/** Success-rate drop (absolute) at which an addendum is reverted. */
export const SETTLE_REGRESSION_THRESHOLD = -0.05;

export type SettleVerdict = 'insufficient' | 'completed' | 'reverted';

/**
 * Pure decision: given the pre-approval rate and the post-approval evaluation.
 *
 * @param beforeRate - Success rate that triggered the evolution / 承認前の成功率
 * @param after - Post-approval evaluation of the role / 承認後の評価
 * @param minRuns - Minimum post-approval runs / 判定に必要な実行数
 * @param regressionThreshold - Delta at or below which the addendum is reverted / 差し戻し閾値
 * @returns Verdict and the measured delta / 判定と差分
 */
export function decideSettlement(
  beforeRate: number,
  after: Pick<RoleEvaluation, 'totalRuns' | 'successRate'>,
  minRuns: number = SETTLE_MIN_RUNS,
  regressionThreshold: number = SETTLE_REGRESSION_THRESHOLD,
): { verdict: SettleVerdict; delta: number } {
  if (after.totalRuns < minRuns) return { verdict: 'insufficient', delta: 0 };
  const delta = Number((after.successRate - beforeRate).toFixed(4));
  return { verdict: delta <= regressionThreshold ? 'reverted' : 'completed', delta };
}

interface ApprovedRow {
  id: number;
  basePromptKey: string | null;
  evidenceJson: string | null;
  afterPrompt: string;
}

interface Evidence {
  successRate?: number;
  approvedAt?: string;
  [key: string]: unknown;
}

function parseEvidence(raw: string | null): Evidence {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Evidence) : {};
  } catch {
    return {};
  }
}

/** Minimal Prisma surface the settlement needs (tests pass a fake). */
export interface SettlePrisma {
  promptEvolution: {
    findMany(args: unknown): Promise<ApprovedRow[]>;
    update(args: unknown): Promise<unknown>;
  };
}

/**
 * Settle every approved addendum that has enough post-approval evidence.
 *
 * Rows approved before this module existed carry no approvedAt; they are
 * stamped now (evidence starts accruing from today) rather than judged on
 * sessions that never saw the addendum.
 *
 * @param prisma - Prisma client / Prismaクライアント
 * @param evaluate - Role evaluator (the runner's, injectable for tests) / ロール評価関数
 * @param now - Clock, injectable for tests / 現在時刻
 * @returns Count of rows settled (completed or reverted) / 判定確定件数
 */
export async function settleApprovedEvolutions(
  prisma: SettlePrisma,
  evaluate: (
    prisma: PrismaClient,
    role: string,
    since: Date,
    scopeTaskIds?: number[],
  ) => Promise<Pick<RoleEvaluation, 'totalRuns' | 'successRate'>> = evaluateRole,
  now: () => Date = () => new Date(),
): Promise<number> {
  const rows = await prisma.promptEvolution.findMany({
    where: { status: 'approved' },
    select: { id: true, basePromptKey: true, evidenceJson: true, afterPrompt: true },
  });
  let settled = 0;
  for (const row of rows) {
    const role = row.basePromptKey?.replace(/^workflow_role_/, '');
    if (!role) continue;
    const evidence = parseEvidence(row.evidenceJson);
    if (!evidence.approvedAt) {
      await prisma.promptEvolution.update({
        where: { id: row.id },
        data: { evidenceJson: JSON.stringify({ ...evidence, approvedAt: now().toISOString() }) },
      });
      continue;
    }
    // A candidate limited to a comparison's stagedTaskIds is judged only on
    // those tasks — evaluating the whole role would dilute the signal with
    // tasks that never saw the addendum. Unstaged candidates (no comparison
    // record, or stagedTaskIds cleared) fall back to the original role-wide
    // evaluation.
    const comparison = readComparisonRecord(row.id);
    const stagedTaskIds = comparison?.stagedTaskIds ?? null;
    const beforeRate = typeof evidence.successRate === 'number' ? evidence.successRate : 0;
    let after: Pick<RoleEvaluation, 'totalRuns' | 'successRate'>;
    try {
      after = await evaluate(
        prisma as unknown as PrismaClient,
        role,
        new Date(evidence.approvedAt),
        stagedTaskIds ?? undefined,
      );
    } catch (err) {
      // Missing evidence must not become a verdict either way.
      log.warn({ err, id: row.id, role }, '[settle] post-approval evaluation failed — skipped');
      continue;
    }
    const { verdict, delta } = decideSettlement(beforeRate, after);
    if (verdict === 'insufficient') continue;
    await prisma.promptEvolution.update({
      where: { id: row.id },
      data: {
        status: verdict,
        performanceDelta: delta,
        evidenceJson: JSON.stringify({
          ...evidence,
          settledAt: now().toISOString(),
          beforeRate,
          afterRate: after.successRate,
          afterRuns: after.totalRuns,
        }),
      },
    });
    settled++;

    // Low-risk auto-promotion: only when a staged rollout was CONFIRMED good
    // in the field (verdict==='completed', not merely the initial shadow
    // comparison), the original comparison already called it 'improved', and
    // the addendum reads as a pure addition. Default OFF — without the env
    // var this block never runs, so a human must always clear stagedTaskIds.
    if (
      verdict === 'completed' &&
      stagedTaskIds !== null &&
      autoPromoteEnabled() &&
      comparison?.summary?.verdict === 'improved' &&
      isPureAddendum(row.afterPrompt)
    ) {
      if (!updateComparisonScope(comparison.promptEvolutionId, comparison.stagedTaskIds, null)) {
        continue;
      }
      log.info(
        { id: row.id, role },
        '[settle] Low-risk auto-promotion: staged candidate promoted to full rollout',
      );
    }

    log.info(
      { id: row.id, role, verdict, delta, afterRuns: after.totalRuns },
      '[settle] Prompt evolution settled',
    );
  }
  return settled;
}
