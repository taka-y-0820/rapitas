/**
 * Loop Watcher
 *
 * The "notice" stage of the autonomous improvement loop: compares the two
 * most recent loop-metrics windows and files a concern for every signal
 * bucket that is BOTH loud enough (minimum sample) and not improving. The
 * existing concern→task pipeline then turns each into investigable work, so
 * measure→detect→file→fix closes without a human in the loop. Rules are
 * deliberately deterministic (no LLM) and dedup-keyed so a persisting
 * stagnation never piles up duplicate concerns.
 * Not responsible for computing metrics (loop-metrics.ts) or scheduling
 * (backlog-scheduler.ts).
 */
import { createLogger } from '../../config/logger';
import { submitConcern } from '../memory/concern-backlog-service';
import { computeLoopMetrics, type LoopMetricsWindow } from './loop-metrics';

const log = createLogger('self-improvement:loop-watcher');

/** A bucket must reach this count in the current window to be a signal. */
const MIN_SIGNAL = 3;

/** One stagnation rule: which counter, and how to describe it. */
interface WatchRule {
  /** Stable id — becomes the concern dedupKey suffix. */
  key: string;
  metric: keyof LoopMetricsWindow['counts'];
  title: string;
  /** What the ensuing investigation should look at. */
  hint: string;
}

const RULES: WatchRule[] = [
  {
    key: 'research-critic',
    metric: 'research_critic_failed',
    title: '品質ループ停滞: research 批評ゲートの失敗が減っていない',
    hint: 'critic-lessons の事前注入が効いていない可能性。蒸留された観点の内容と、直近の批評指摘の新規性(既知観点の再発か新種か)を突き合わせる。',
  },
  {
    key: 'verify-self-contradiction',
    metric: 'verify_repair_self_contradiction',
    title: '品質ループ停滞: verify.md の自己矛盾差し戻しが減っていない',
    hint: 'verifier への verify ストリーム注入(critic-lessons)と実測 GROUND TRUTH 注入の効果を検証。矛盾パターンの具体例を最近の差し戻しから採取する。',
  },
  {
    key: 'verify-diff-review',
    metric: 'verify_repair_diff_review',
    title: '品質ループ停滞: 敵対的差分レビューの差し戻しが減っていない',
    hint: '差し戻し理由がスコープ逸脱系なら diff base 解決(混入)を、計画欠落系なら implement ストリーム注入の内容を疑う。',
  },
  {
    key: 'ci-repair',
    metric: 'ci_repair',
    title: '品質ループ停滞: CI 差し戻しが減っていない',
    hint: 'ローカル verify ゲートと CI のチェック差分(format / generated-sync / テスト範囲)を、実際に落ちた CI ジョブのステップ名で照合する。',
  },
  {
    key: 'critic-exhausted',
    metric: 'research_critic_exhausted',
    title: '品質ループ停滞: 批評ゲートの再生成が収束せず素通しが多い',
    hint: '再生成しても同じ指摘で落ちるケース。buildCriticFeedback の注入内容が指摘に対応可能な形か、ゲート側の期待が過剰でないかを確認する。',
  },
];

/** Outcome of one rule evaluation (exported for tests via evaluateRules). */
export interface RuleFinding {
  key: string;
  title: string;
  detail: string;
}

/**
 * Compute a rate, avoiding division by zero.
 *
 * @param count - Numerator. / 分子
 * @param denominator - Denominator (execution volume). / 分母（実行量）
 * @returns The rate, or null when the denominator is zero. / 分母が0のときは null
 */
export function calcRate(count: number, denominator: number): number | null {
  return denominator > 0 ? count / denominator : null;
}

/**
 * Format a rate for display in a concern's detail text.
 *
 * @param rate - The rate, or null. / 率、または null
 * @returns A percentage string, or 'N/A' when null. / パーセント文字列、または 'N/A'
 */
export function formatPct(rate: number | null): string {
  return rate === null ? 'N/A' : `${(rate * 100).toFixed(2)}%`;
}

/**
 * Apply the stagnation rules to the newest two windows. Pure — the testable
 * core of the watcher. A rule fires when current >= MIN_SIGNAL AND either
 * the absolute count is not improving OR the rate against execution volume
 * (completed transitions) is worsening — a shrinking absolute count can
 * still hide a worsening rate when execution volume shrinks faster.
 *
 * @param current - Newest window. / 直近の窓
 * @param previous - The window before it. / その前の窓
 * @returns Concerns to file. / 起票すべき懸念
 */
export function evaluateRules(
  current: LoopMetricsWindow,
  previous: LoopMetricsWindow,
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const rule of RULES) {
    const cur = current.counts[rule.metric];
    const prev = previous.counts[rule.metric];
    if (cur < MIN_SIGNAL) continue;

    const curCompleted = current.counts.completed;
    const prevCompleted = previous.counts.completed;
    const curRate = calcRate(cur, curCompleted);
    const prevRate = calcRate(prev, prevCompleted);

    const absoluteWorsened = cur >= prev;
    const rateWorsened = curRate !== null && prevRate !== null && curRate > prevRate;
    if (!absoluteWorsened && !rateWorsened) continue;

    const reasons: string[] = [];
    if (absoluteWorsened) reasons.push('絶対件数');
    if (rateWorsened) reasons.push('率');

    findings.push({
      key: rule.key,
      title: rule.title,
      detail:
        `直近窓 (${current.from.slice(0, 10)}〜${current.to.slice(0, 10)}) で ${rule.metric} = ${cur} 件 / 完了 ${curCompleted} 件（${formatPct(curRate)}）` +
        `　前窓は ${prev} 件 / 完了 ${prevCompleted} 件（${formatPct(prevRate)}）` +
        `。悪化要因: ${reasons.join('・')}。\n\n` +
        `調査の起点: ${rule.hint}\n\n` +
        `メトリクスの全体は GET /backlog/loop-metrics で取得できます。`,
    });
  }
  return findings;
}

/**
 * Run one loop review: compute metrics, evaluate stagnation rules, and file
 * a deduplicated concern per firing rule.
 *
 * @returns Number of concerns filed. / 起票件数
 */
export async function runLoopReview(): Promise<number> {
  const metrics = await computeLoopMetrics({ windowCount: 2 });
  const [current, previous] = metrics.windows;
  if (!current || !previous) return 0;

  const findings = evaluateRules(current, previous);
  let filed = 0;
  for (const f of findings) {
    try {
      await submitConcern({
        title: f.title,
        detail: f.detail,
        type: 'refactor',
        severity: 'medium',
        source: 'loop_review',
        // Stable per-rule key: counts in the detail change every week, but a
        // persisting stagnation must UPDATE the picture via the open concern,
        // not file a new one beside it.
        dedupKey: `loop-review:${f.key}`,
      });
      filed++;
    } catch (err) {
      log.warn({ err, rule: f.key }, '[loop-watcher] failed to file concern');
    }
  }
  log.info(
    { filed, evaluated: RULES.length, window: `${current.from}..${current.to}` },
    '[loop-watcher] loop review complete',
  );
  return filed;
}
