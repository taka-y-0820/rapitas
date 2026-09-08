import { UserBehaviorService } from './user-behavior-service';
import { createLogger } from '../../config/logger';
import { memoryTaskQueue } from '../../services/memory';
import { scanAndRemind } from '../../services/memory/knowledge-reminder';
import { drainStaleConflicts } from '../../services/memory/contradiction-sweep';
import { revalidatePendingBacklog } from '../../services/memory/validation';
import { generateOptimizationRules } from '../../services/workflow/learning/workflow-learning-optimizer';
import { processAllPendingRecurrences } from '../../services/scheduling/recurring-task-service';
import { runScheduledTechDebtScan } from '../../services/misc/tech-debt-liquidator';
import { runProjectHealthScan } from '../../services/analytics/project-health-monitor';
import { generateWeeklyReview } from '../../services/ai/weekly-review-service';
import { prisma } from '../../config/database';

const log = createLogger('behavior-scheduler');

export class BehaviorScheduler {
  private static intervalIds: NodeJS.Timeout[] = [];

  /**
   * Start scheduler
   */
  static start() {
    log.info('[BehaviorScheduler] Starting behavior summary update scheduler');

    // NOTE: Consolidated from 11 separate setInterval calls into one to reduce
    // JS event-loop timer overhead (11 callbacks/min → 1). All original guards
    // (hour/minute/day-of-week/day-of-month) are preserved inside the single tick.
    const tick = setInterval(async () => {
      const now = new Date();
      const h = now.getHours();
      const m = now.getMinutes();
      const dow = now.getDay(); // 0=Sun … 6=Sat
      const dom = now.getDate();

      // Top of every hour: daily summary + recurring tasks
      if (m === 0) {
        log.info('[BehaviorScheduler] Updating daily behavior summary');
        await UserBehaviorService.updateBehaviorSummary(1, 'daily').catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Daily summary failed');
        });
        log.info(`[BehaviorScheduler] Processing recurring tasks at hour ${h}`);
        await processAllPendingRecurrences(prisma, h).catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Recurring task processing failed');
        });
      }

      // Midnight: weekly / monthly summary + knowledge consolidation
      if (h === 0 && m === 0) {
        log.info('[BehaviorScheduler] Updating weekly behavior summary');
        await UserBehaviorService.updateBehaviorSummary(1, 'weekly').catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Weekly summary failed');
        });
        if (dom === 1) {
          log.info('[BehaviorScheduler] Updating monthly behavior summary');
          await UserBehaviorService.updateBehaviorSummary(1, 'monthly').catch((err: Error) => {
            log.error({ err }, '[BehaviorScheduler] Monthly summary failed');
          });
        }
        log.info('[BehaviorScheduler] Triggering knowledge consolidation');
        await memoryTaskQueue.enqueue('consolidate', {}).catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Failed to enqueue consolidation');
        });
      }

      // 2 AM: forgetting sweep
      if (h === 2 && m === 0) {
        log.info('[BehaviorScheduler] Triggering forgetting sweep');
        await memoryTaskQueue.enqueue('forget_sweep', {}).catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Failed to enqueue forgetting sweep');
        });
      }

      // 3 AM: workflow optimization rules
      if (h === 3 && m === 0) {
        log.info('[BehaviorScheduler] Triggering workflow optimization rule generation');
        await generateOptimizationRules().catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Failed to generate optimization rules');
        });
      }

      // 4 AM: tech debt scan
      if (h === 4 && m === 0) {
        log.info('[BehaviorScheduler] Running autonomous tech debt scan');
        await runScheduledTechDebtScan().catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Tech debt scan failed');
        });
      }

      // 5 AM: stale-conflict drain — 'conflict' knowledge must be able to
      // recover (or die) without a human; otherwise recall trust-demotes a
      // growing share of the KB forever. Drains up to
      // RAPITAS_KB_CONFLICT_SWEEP_BUDGET (default 200) per night — the old
      // fixed 10/night let the backlog grow faster than it resolved.
      if (h === 5 && m === 0) {
        log.info('[BehaviorScheduler] Draining stale knowledge conflicts');
        await drainStaleConflicts().catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Conflict drain failed');
        });
      }

      // 5:30 AM: pending-backlog validation — reconsolidation and orphan
      // reversion return entries to 'pending' with nothing re-validating them,
      // so without a retroactive sweep the unvalidated share only grows.
      // Offset from the 5 AM drain so the two LLM-heavy sweeps don't overlap.
      if (h === 5 && m === 30) {
        log.info('[BehaviorScheduler] Validating pending knowledge backlog');
        await revalidatePendingBacklog().catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Pending-backlog validation failed');
        });
      }

      // 6 AM: project health monitoring
      if (h === 6 && m === 0) {
        log.info('[BehaviorScheduler] Running project health scan');
        await runProjectHealthScan().catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Project health scan failed');
        });
      }

      // Monday 7 AM: prompt evolution — detect underperforming workflow roles
      // (runner) and generate improvement proposals for human review on
      // /system-prompts (worker). Weekly cadence matches the runner's
      // min-sample window; nothing is applied without explicit approval.
      if (h === 7 && m === 0 && dow === 1) {
        log.info('[BehaviorScheduler] Running prompt evolution detection + proposal generation');
        await import('../../services/self-learning/prompt-evolution-runner')
          .then(({ runPromptEvolution }) => runPromptEvolution(prisma as never))
          .catch((err: Error) => {
            log.error({ err }, '[BehaviorScheduler] Prompt evolution detection failed');
          });
        await import('../../services/self-learning/prompt-evolution-worker')
          .then(({ generateProposalsForPending }) => generateProposalsForPending())
          .catch((err: Error) => {
            log.error({ err }, '[BehaviorScheduler] Prompt evolution proposal generation failed');
          });
      }

      // 7:05 daily: close the prompt-evolution loop unattended. Auto-approval
      // runs FIRST so an addendum approved today starts accruing its
      // post-approval window immediately. Daily (not weekly) because
      // experiment-lifecycle can raise a 'proposed' row at any time.
      if (h === 7 && m === 5) {
        await import('../../services/self-learning/prompt-evolution-auto-approve')
          .then(({ autoApproveEligibleProposals }) => autoApproveEligibleProposals())
          .catch((err: Error) => {
            log.error({ err }, '[BehaviorScheduler] Prompt evolution auto-approval failed');
          });
        await import('../../services/self-learning/prompt-evolution-settle')
          .then(({ settleApprovedEvolutions }) => settleApprovedEvolutions(prisma as never))
          .catch((err: Error) => {
            log.error({ err }, '[BehaviorScheduler] Prompt evolution settlement failed');
          });
      }

      // 9 AM: knowledge reminders + Monday weekly review
      if (h === 9 && m === 0) {
        log.info('[BehaviorScheduler] Triggering knowledge reminder scan');
        await scanAndRemind().catch((err: Error) => {
          log.error({ err }, '[BehaviorScheduler] Failed to scan knowledge reminders');
        });
        if (dow === 1) {
          log.info('[BehaviorScheduler] Triggering AI weekly review generation');
          await generateWeeklyReview(prisma).catch((err: Error) => {
            log.error({ err }, '[BehaviorScheduler] Weekly review generation failed');
          });
        }
      }
    }, 60_000);

    this.intervalIds.push(tick);

    // Initial execution (at server startup)
    this.runInitialUpdate();
  }

  /**
   * Execute initial update
   */
  private static async runInitialUpdate() {
    log.info('[BehaviorScheduler] Running initial behavior summary update');

    try {
      await UserBehaviorService.updateBehaviorSummary(1, 'daily');
      await UserBehaviorService.updateBehaviorSummary(1, 'weekly');
      await UserBehaviorService.updateBehaviorSummary(1, 'monthly');
      log.info('[BehaviorScheduler] Initial update completed');
    } catch (error) {
      log.error({ err: error }, '[BehaviorScheduler] Initial update failed');
    }
  }

  /**
   * Stop scheduler
   */
  static stop() {
    log.info('[BehaviorScheduler] Stopping behavior summary update scheduler');
    this.intervalIds.forEach((id) => clearInterval(id));
    this.intervalIds = [];
  }
}
