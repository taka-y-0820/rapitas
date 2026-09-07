/**
 * prompt-evolution-runner
 *
 * 直近 7 日間のロール別成功率を集計し、閾値（既定 70%）を割ったロールについて
 * `PromptEvolution` レコードを作成する。生成された候補プロンプトは `Experiment` に
 * 接続され、A/B テスト終了時に `prompt-ops` が勝者を採用する。
 *
 * このランナーは GitHub Actions の cron ワークフロー
 * `.github/workflows/prompt-evolution-weekly.yml` から bun で起動される想定。
 * 失敗してもエージェント実行に影響しないよう、すべての例外は内部で握りつぶす。
 *
 * NOTE: 成功判定は AgentSession.status='completed' 単独では不十分 — verify /
 * adversarial ゲートに差し戻されたセッションも 'completed' のまま残るため、
 * gate 差し戻しが成功例として学習されていた。role-evidence と同じ
 * ROLE_TROUBLE_CAUSES（WorkflowTransition.cause）で差し戻しを失敗側に補正する。
 */

import { createLogger } from '../../config/logger';
import type { PrismaClient } from '../../generated/prisma-postgres';
import { ROLE_TROUBLE_CAUSES } from '../workflow/role-evidence';

const log = createLogger('self-learning:prompt-evolution-runner');

/** 評価対象期間（日数）。短すぎるとサンプル数不足、長すぎると最新の改善が反映されない。 */
const WINDOW_DAYS = 7;

/** これを下回ったロールが自動進化対象。0.7 は意図的に高め。 */
const SUCCESS_RATE_THRESHOLD = 0.7;

/** ロール毎に必要な最小サンプル数。これ未満だと統計的に判断不可能。 */
const MIN_SAMPLE_SIZE = 5;

export interface RoleEvaluation {
  role: string;
  totalRuns: number;
  successRuns: number;
  successRate: number;
  shouldEvolve: boolean;
  reason: string;
}

/**
 * メインエントリ。ロール毎に直近 7 日間の成功率を集計し、必要なら進化候補を作る。
 *
 * @param prisma - Prisma クライアント
 * @returns 各ロールの評価結果
 */
export async function runPromptEvolution(prisma: PrismaClient): Promise<RoleEvaluation[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const evaluations: RoleEvaluation[] = [];

  // NOTE: reviewer is retired (removal in progress elsewhere); auto_verifier is
  // the lightweight-mode verify role and has its own prompt to evolve.
  const roles: ReadonlyArray<string> = [
    'researcher',
    'planner',
    'implementer',
    'verifier',
    'auto_verifier',
  ];

  for (const role of roles) {
    try {
      const ev = await evaluateRole(prisma, role, since);
      evaluations.push(ev);
      if (ev.shouldEvolve) {
        await emitEvolutionCandidate(prisma, ev);
      }
    } catch (err) {
      log.warn({ err, role }, '[runner] role evaluation failed');
    }
  }

  log.info(
    {
      window: `${WINDOW_DAYS}d`,
      threshold: SUCCESS_RATE_THRESHOLD,
      evaluations: evaluations.map((e) => ({
        role: e.role,
        successRate: Number(e.successRate.toFixed(3)),
        evolved: e.shouldEvolve,
      })),
    },
    '[runner] prompt evolution cycle completed',
  );
  return evaluations;
}

/**
 * 直近 since 以降の AgentSession で mode=workflow-{role} のものを集計し、成功率を出す。
 *
 * ゲート対象ロール（ROLE_TROUBLE_CAUSES 参照）は status='completed' に加えて、
 * そのタスクにロールの成果物を差し戻す WorkflowTransition（verify_repair 等）が
 * 記録されていないことを成功の条件とする — role-evidence と同じ定義。
 */
export async function evaluateRole(
  prisma: PrismaClient,
  role: string,
  since: Date,
  scopeTaskIds?: number[],
): Promise<RoleEvaluation> {
  const sessions = await prisma.agentSession.findMany({
    where: {
      mode: `workflow-${role}`,
      createdAt: { gte: since },
      status: { in: ['completed', 'failed'] },
      // Limits the post-approval measurement to a candidate's staged tasks
      // (prompt-comparison / stagedTaskIds) instead of the whole role. When
      // scopeTaskIds is undefined, the where clause is unchanged from before.
      ...(scopeTaskIds ? { config: { taskId: { in: scopeTaskIds } } } : {}),
    },
    select: { status: true, config: { select: { taskId: true } } },
  });

  // Gate-rejection lookup: tasks whose transitions indict this role's output.
  // Missing outcome evidence must skip evaluation, not become successful training data.
  const troubleCauses = ROLE_TROUBLE_CAUSES[role] ?? [];
  const taskIds = [
    ...new Set(
      sessions.map((s) => s.config?.taskId).filter((id): id is number => typeof id === 'number'),
    ),
  ];
  let troubledTasks = new Set<number>();
  if (troubleCauses.length > 0 && taskIds.length > 0) {
    const troubleRows = await prisma.workflowTransition.findMany({
      where: {
        taskId: { in: taskIds },
        cause: { in: troubleCauses },
        createdAt: { gte: since },
      },
      select: { taskId: true },
      distinct: ['taskId'],
    });
    troubledTasks = new Set(troubleRows.map((t) => t.taskId));
  }

  const total = sessions.length;
  const success = sessions.filter((s) => {
    if (s.status !== 'completed') return false;
    const taskId = s.config?.taskId;
    return !(typeof taskId === 'number' && troubledTasks.has(taskId));
  }).length;
  const rate = total === 0 ? 1 : success / total;
  const enoughSamples = total >= MIN_SAMPLE_SIZE;
  const shouldEvolve = enoughSamples && rate < SUCCESS_RATE_THRESHOLD;
  return {
    role,
    totalRuns: total,
    successRuns: success,
    successRate: rate,
    shouldEvolve,
    reason: !enoughSamples
      ? `insufficient samples (${total} < ${MIN_SAMPLE_SIZE})`
      : shouldEvolve
        ? `success_rate ${(rate * 100).toFixed(1)}% < ${SUCCESS_RATE_THRESHOLD * 100}% threshold`
        : `success_rate ${(rate * 100).toFixed(1)}% above threshold`,
  };
}

/**
 * 進化候補を `PromptEvolution` レコードとして書き込む。
 * 候補プロンプト生成自体は LLM への呼び出しを伴うため、本ランナーでは
 * 「進化が必要である」マークだけを残し、実プロンプト生成は別 worker が拾う。
 */
async function emitEvolutionCandidate(prisma: PrismaClient, ev: RoleEvaluation): Promise<void> {
  // PromptEvolution model がある前提。フィールド構成はリポジトリ標準に合わせて
  // basePromptKey + status='pending' で記録する。
  // NOTE: feature-detected via an unknown-cast rather than `any` — the model may
  // be absent from an older/regenerated client, so callers must null-check
  // `create` before use anyway; `unknown` keeps that check type-safe.
  const promptEvolutionDelegate = (
    prisma as unknown as {
      promptEvolution?: { create: (args: unknown) => Promise<unknown> };
    }
  ).promptEvolution;
  if (!promptEvolutionDelegate || typeof promptEvolutionDelegate.create !== 'function') {
    log.warn('[runner] PromptEvolution model unavailable in current schema; skip emit');
    return;
  }
  await promptEvolutionDelegate.create({
    data: {
      basePromptKey: `workflow_role_${ev.role}`,
      reason: ev.reason,
      status: 'pending',
      evidenceJson: JSON.stringify({
        windowDays: WINDOW_DAYS,
        totalRuns: ev.totalRuns,
        successRuns: ev.successRuns,
        successRate: ev.successRate,
      }),
    },
  });
  log.info(`[runner] queued PromptEvolution for role=${ev.role} (${ev.successRate.toFixed(3)})`);
}

/**
 * CLI エントリ: `bun run services/self-learning/prompt-evolution-runner.ts` で実行。
 * GitHub Actions cron からはこれが呼ばれる。
 */
async function main(): Promise<void> {
  const { prisma } = await import('../../config');
  try {
    const results = await runPromptEvolution(prisma as never);
    const evolved = results.filter((r) => r.shouldEvolve);
    // eslint-disable-next-line no-console
    console.log(
      `[prompt-evolution] window=${WINDOW_DAYS}d, evolved=${evolved.length}/${results.length}`,
    );
    process.exit(0);
  } catch (err) {
    log.error({ err }, '[runner] fatal error');
    process.exit(1);
  }
}

// Entry guard (Bun): only run main() when invoked directly (e.g. by the weekly
// GitHub Actions cron). NOTE: previously compared import.meta.url to a hand-built
// `file://${argv[1]}` string, which never matched on Windows (file:///C:/... vs
// file://C:/...), so `bun run runner.ts` was a silent no-op there. import.meta.main
// is cross-platform and already used by other scripts in this repo.
if (import.meta.main) {
  main();
}
