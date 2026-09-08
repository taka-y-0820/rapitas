/**
 * Auto-Merge Watcher
 *
 * Merges the PR of a completed task that opted into auto-merge
 * (AgentExecutionConfig.autoMergePR) — but ONLY after the PR's GitHub CI checks
 * are green ("検証通過＋動作も問題なし"). A CI-red PR is left open for review and
 * the task is flagged. NOT responsible for creating the PR (that is the
 * workflow auto-commit path) — only for the CI-gated merge step.
 *
 * Candidate discovery lives in auto-merge-candidates; check/merge-state reads in
 * auto-merge-checks; exhausted-budget parking (with head-change resume) in
 * auto-merge-exhaustion; CI-failure handling (update-branch, no-diff parking,
 * bounded self-repair) in auto-merge-ci-failure. This file owns the tick loop
 * and the merge decisions.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { mergePullRequest } from '../agents/orchestrator/git-operations/pr/branch-pr-ops';
import { recordTransition } from './transition-recorder';
import { handleCiFailure } from './auto-merge-ci-failure';
import { fileConflictResolutionTask } from '../github/conflict-task';
import { resolveIntegrationId } from '../github/pr-link';
import {
  blockingChecks,
  evaluateAutoMergeChecks,
  readPrChecks,
  readMergeState,
  readHeadSha,
} from './auto-merge-checks';
import { markExhausted } from './auto-merge-exhaustion';
import { notify } from './auto-merge-notify';
import { findCandidates, type Candidate } from './auto-merge-candidates';
import { countWithFailClosed } from '../../utils/database/fail-closed-count';

const log = createLogger('workflow:auto-merge-watcher');

/** Poll cadence. CI takes minutes, so a 60s tick is plenty. */
const POLL_INTERVAL_MS = 60_000;
/** Give up waiting for CI after this long and flag the PR for review. */
const PENDING_TIMEOUT_MS = 90 * 60 * 1000; // 90 min
/**
 * File a conflict-resolution task at most this many times for one PR before
 * giving up and blocking for manual review. Each re-file happens only AFTER the
 * prior conflict task finished without making the PR mergeable, so this bounds a
 * genuinely-unresolvable conflict instead of re-filing forever.
 */
const MAX_CONFLICT_RETRIES = 2;

/**
 * Mark a task row done/completed (idempotent). Used when the watcher is the one
 * that reaches a task's completion point under staged completion.
 */
async function completeTaskRow(taskId: number): Promise<void> {
  await prisma.task
    .update({
      where: { id: taskId },
      data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
    })
    .catch((err) => log.warn({ err, taskId }, '[auto-merge] completeTaskRow failed'));
}

/** Record a terminal auto-merge outcome so the candidate is not reprocessed. */
async function mark(taskId: number, cause: string, reason: string): Promise<void> {
  await recordTransition({
    taskId,
    fromStatus: 'completed',
    toStatus: 'completed',
    actor: 'system',
    cause,
    phase: 'verify',
    metadata: { reason },
  }).catch(() => {});
}

/**
 * Resolves the latest 'verification_unknown' marker for a task (see
 * verification-gate.ts's recordUnknownVerdictMarker) and decides whether it
 * still applies to the CURRENT PR head. Fail-open to 'pass' on any ambiguity
 * (no marker, unparsable metadata, or a stale headSha from a since-pushed
 * commit) — this is a SUPPLEMENTARY gate on the checkless-CLEAN fallback
 * only, not a general block, so an unresolved edge case must never freeze an
 * otherwise-normal merge.
 *
 * @param taskId - Candidate task id / 対象タスクID
 * @param currentHeadSha - The PR's current head commit SHA, or null if unknown / 現在のPR head SHA
 * @returns 'unknown' only when a marker matches the current head / 現行headに一致するマーカーがある場合のみunknown
 */
async function resolveVerificationVerdict(
  taskId: number,
  currentHeadSha: string | null,
): Promise<'pass' | 'unknown'> {
  const row = await prisma.workflowTransition
    .findFirst({
      where: { taskId, cause: 'verification_unknown' },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    })
    .catch(() => null);
  if (!row?.metadata) return 'pass';
  try {
    const meta = JSON.parse(row.metadata) as { headSha?: string };
    return meta.headSha && currentHeadSha && meta.headSha === currentHeadSha ? 'unknown' : 'pass';
  } catch {
    return 'pass';
  }
}

/**
 * Auto-Merge Watcher singleton. Started at boot; ticks on an interval.
 */
export class AutoMergeWatcher {
  private static instance: AutoMergeWatcher;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  static getInstance(): AutoMergeWatcher {
    if (!AutoMergeWatcher.instance) AutoMergeWatcher.instance = new AutoMergeWatcher();
    return AutoMergeWatcher.instance;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    log.info('[auto-merge] Watcher started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Whether a tick (candidate evaluation / merge processing) is in flight.
   * The task-boundary restart governance consults this so a self-restart
   * never fires while a merge is mid-processing (quiescence condition c).
   * Ticks are short (12s-class), so a coinciding boundary is merely pushed
   * to the next one.
   *
   * @returns True while a tick is being processed / tick処理中はtrue
   */
  isMerging(): boolean {
    return this.ticking;
  }

  /** One pass: evaluate every candidate's CI and merge / block / wait. */
  async tick(): Promise<void> {
    if (this.ticking) return; // never overlap ticks
    this.ticking = true;
    try {
      const candidates = await findCandidates();
      const blocking = blockingChecks();
      for (const c of candidates) {
        try {
          await this.process(c, blocking);
        } catch (err) {
          log.warn({ err, taskId: c.taskId }, '[auto-merge] Candidate failed');
        }
      }
    } catch (err) {
      log.error({ err }, '[auto-merge] Tick error');
    } finally {
      this.ticking = false;
    }
  }

  /**
   * When a CI-green PR fails to merge because of a real CONFLICT (GitHub
   * mergeStateStatus DIRTY), automatically file the "PR #N の競合を解消" agent task
   * so auto-run resolves it on the PR branch — then a later tick re-merges the now
   * CLEAN PR with no human step. Deduped (one active task per PR) and bounded
   * (MAX_CONFLICT_RETRIES re-files before parking as exhausted for manual review).
   *
   * @param c - The auto-merge candidate. / 自動マージ候補
   * @param mergeError - The merge failure message (for the blocked note). / マージ失敗理由
   * @returns true when the conflict path handled this (caller returns). / 競合処理したか
   */
  private async handleMergeConflict(c: Candidate, mergeError?: string): Promise<boolean> {
    const ghState = await readMergeState(c.cwd, c.prNumber);
    // DIRTY is GitHub's "the PR has merge conflicts" state. Any other failure
    // (e.g. branch protection, permissions) is NOT a conflict — let the caller
    // block it for manual review.
    if (ghState !== 'DIRTY') return false;

    // FAIL CLOSED: a count error must not read as "0 prior conflict-filings" —
    // that would re-file a conflict-resolution task on every DB hiccup instead
    // of respecting MAX_CONFLICT_RETRIES, the exact unbounded re-filing this
    // bound exists to prevent (see the multi-day PR #287 spin noted below).
    const conflictAttempts = await countWithFailClosed(
      prisma.workflowTransition.count({
        where: { taskId: c.taskId, cause: 'auto_merge_conflict_filed' },
      }),
      MAX_CONFLICT_RETRIES,
      log,
      { taskId: c.taskId, prNumber: c.prNumber },
      'auto-merge-conflict-retries',
    );
    if (conflictAttempts >= MAX_CONFLICT_RETRIES) {
      // Park as exhausted (terminal until the PR head changes). A windowed
      // `auto_merge_blocked` mark here recycled forever: the 30-min retry window
      // re-admitted the candidate, the attempt cap re-hit, and the same
      // notification re-fired every cooldown for days (observed: task 363 / PR
      // #287 spinning 3+ days).
      await markExhausted(
        c.taskId,
        c.prNumber,
        c.cwd,
        `conflict unresolved after ${conflictAttempts} attempts: ${mergeError ?? ''}`,
      );
      await notify({
        taskId: c.taskId,
        type: 'auto_merge_conflict_unresolved',
        title: '自動マージ保留（競合未解消）',
        message: `PR #${c.prNumber} の競合が自動解消の上限まで解消できませんでした。手動で確認してください。競合を解消してpushすると自動マージを再開します。`,
      });
      return true;
    }

    // Need the PR's head branch + title to author the resolution instructions.
    // MUST scope by the repo behind c.cwd, not prNumber alone — RAPITAS tracks
    // multiple projects' PRs in one table, and prNumber collides across repos
    // (e.g. two different projects each having their own PR #8). An unscoped
    // findFirst previously picked whichever repo's row happened to match,
    // authoring instructions with a completely unrelated branch/title.
    const integrationId = await resolveIntegrationId(prisma, null, c.cwd);
    if (integrationId == null) {
      log.warn(
        { taskId: c.taskId, prNumber: c.prNumber, cwd: c.cwd },
        "[auto-merge] Could not resolve the GitHub integration for this candidate's repo — refusing to author conflict-resolution instructions from an unscoped PR lookup",
      );
      return false;
    }
    const prRow = await prisma.gitHubPullRequest
      .findFirst({
        where: { prNumber: c.prNumber, integrationId },
        select: { title: true, headBranch: true, baseBranch: true },
      })
      .catch(() => null);
    if (!prRow?.headBranch) {
      // Can't author instructions without the head branch — fall back to block.
      return false;
    }

    const themeRow = await prisma.task
      .findUnique({ where: { id: c.taskId }, select: { themeId: true } })
      .catch(() => null);

    const filed = await fileConflictResolutionTask(
      {
        prNumber: c.prNumber,
        title: prRow.title || c.taskTitle,
        baseBranch: prRow.baseBranch || c.baseBranch,
        headBranch: prRow.headBranch,
      },
      c.cwd,
      themeRow?.themeId ?? null,
    );

    if (filed.created) {
      // Non-terminal mark: bounds re-files AND lets the next tick re-merge.
      await mark(c.taskId, 'auto_merge_conflict_filed', `filed conflict task #${filed.taskId}`);
      await notify({
        taskId: c.taskId,
        type: 'auto_merge_conflict_filed',
        title: '競合を自動解消中',
        message: `PR #${c.prNumber} にマージ競合を検出。解消タスク#${filed.taskId}を自動起票しました。解消後に自動マージします。`,
      });
      log.info(
        { taskId: c.taskId, prNumber: c.prNumber, conflictTaskId: filed.taskId },
        '[auto-merge] Conflict detected — filed resolution task, will re-merge when CLEAN',
      );
      return true;
    }
    if (filed.taskId) {
      // An active conflict task is still resolving — wait, re-merge next tick.
      return true;
    }
    // Creation failed — let the caller block it.
    return false;
  }

  private async process(c: Candidate, blocking: Set<string>): Promise<void> {
    const checks = await readPrChecks(c.cwd, c.prNumber);
    if (checks === null) return; // transient gh error — retry next tick

    let state = evaluateAutoMergeChecks(checks, blocking);

    // No blocking CI checks reported (e.g. the branch has no CI configured, or only
    // advisory checks ran). 'unknown' would wait for CI that never arrives and then
    // time out → auto_merge_blocked, so a CLEAN, mergeable PR would never merge.
    // Defer to GitHub's authoritative merge state: only when GitHub itself reports
    // CLEAN (nothing blocking) do we treat it as pass. BLOCKED/BEHIND/DIRTY/UNKNOWN
    // keep waiting, so this never merges past a real pending/failed required check.
    if (state === 'unknown') {
      const ghState = await readMergeState(c.cwd, c.prNumber);
      if (ghState === 'CLEAN') {
        // checkless-CLEAN only confirms "no blocking CI is configured", not
        // that the change was actually verified — a verification verdict of
        // 'unknown' for THIS head must not be waved through by that alone
        // (see verification-gate.ts's computeVerdict / recordUnknownVerdictMarker).
        const headSha = await readHeadSha(c.cwd, c.prNumber);
        const verdict = await resolveVerificationVerdict(c.taskId, headSha);
        if (verdict === 'unknown') {
          await notify({
            taskId: c.taskId,
            type: 'auto_merge_awaiting_approval',
            title: '自動マージ保留（人の承認待ち）',
            message: `PR #${c.prNumber} は検証結果が判定不能(unknown)のため、CI未設定環境のCLEAN判定のみでは自動マージしません。内容を確認して手動で "gh pr ready" と "gh pr merge" を実行するか、CIを構成してください。`,
          });
          return;
        }
        state = 'pass';
        log.info(
          { taskId: c.taskId, prNumber: c.prNumber },
          '[auto-merge] No blocking CI checks; GitHub merge state CLEAN — treating as pass',
        );
      } else if (ghState === 'DIRTY' && c.mode === 'merge') {
        // A real merge conflict with no CI to wait on. Without this branch an
        // auto-run PR (which usually has NO CI configured) sits at 'unknown'
        // forever: the conflict path below is reached ONLY via state==='pass' →
        // mergePullRequest, so handleMergeConflict never runs and no resolution
        // task is ever filed (the user-reported "conflict auto-resolve does
        // nothing"). A conflict never clears by waiting — file the resolution task
        // now; a later tick re-merges once it pushes the fix and the PR goes CLEAN.
        log.info(
          { taskId: c.taskId, prNumber: c.prNumber },
          '[auto-merge] No blocking CI checks; GitHub merge state DIRTY — auto-filing conflict resolution',
        );
        if (await this.handleMergeConflict(c, 'merge state DIRTY (no CI checks)')) return;
        await mark(c.taskId, 'auto_merge_blocked', 'conflict unresolved (DIRTY, no CI)');
        return;
      }
    }

    if (state === 'pass') {
      // PR mode: CI is green and we DO NOT merge — completion is reaching green.
      if (c.mode === 'pr') {
        await completeTaskRow(c.taskId);
        await mark(c.taskId, 'pr_ci_completed', `PR #${c.prNumber} CI green`);
        await notify({
          taskId: c.taskId,
          type: 'pr_ci_completed',
          title: 'CI通過で完了',
          message: `PR #${c.prNumber} のCIが通過したためタスクを完了にしました（マージは手動）。`,
        });
        log.info(
          { taskId: c.taskId, prNumber: c.prNumber },
          '[auto-merge] PR CI green — task completed (no merge, pr mode)',
        );
        return;
      }

      const res = await mergePullRequest(c.cwd, c.prNumber, c.threshold, c.baseBranch);
      if (res.success) {
        // Under staged completion the task is still in-progress at verify_done;
        // completing on merge is the merge-mode completion point. Idempotent for
        // the legacy path where the task was already done.
        await completeTaskRow(c.taskId);
        // Sync the LOCAL PR mirror to merged. The watcher merged on GitHub, but
        // nothing else updates the local GitHubPullRequest row (there is no webhook
        // in dev), so it kept showing 'open' even though the PR was merged — the
        // "PR won't merge" the user saw was actually a stale local state.
        // MUST scope by the repo behind c.cwd: prNumber collides across the
        // repos sharing this table, so an unscoped update also flipped ANOTHER
        // project's same-numbered open PR to merged, silently removing it from
        // its own auto-merge candidacy. Fail-closed on an unresolvable
        // integration — a stale-open local row self-heals on the next GitHub
        // sync, a clobbered foreign row does not.
        const syncIntegrationId = await resolveIntegrationId(prisma, null, c.cwd).catch(() => null);
        if (syncIntegrationId == null) {
          log.warn(
            { taskId: c.taskId, prNumber: c.prNumber, cwd: c.cwd },
            "[auto-merge] Could not resolve this candidate's GitHub integration — skipping the local PR mirror sync to avoid clobbering another repo's same-numbered PR",
          );
        } else {
          await prisma.gitHubPullRequest
            .updateMany({
              where: { integrationId: syncIntegrationId, prNumber: c.prNumber, state: 'open' },
              data: { state: 'merged', updatedAt: new Date() },
            })
            .catch((err) =>
              log.warn(
                { err, prNumber: c.prNumber },
                '[auto-merge] Failed to sync local PR row to merged',
              ),
            );
        }
        await mark(c.taskId, 'auto_merged', `strategy=${res.mergeStrategy}`);
        await notify({
          taskId: c.taskId,
          type: 'auto_merge_success',
          title: '自動マージ完了',
          message: `PR #${c.prNumber} をCI通過後に自動マージしました（${res.mergeStrategy}）`,
        });
        log.info({ taskId: c.taskId, prNumber: c.prNumber }, '[auto-merge] Merged after CI pass');
      } else if (res.retriable) {
        // Head branch was behind base; mergePullRequest updated it. Do NOT mark
        // terminal — the branch update triggers a fresh CI run; the next tick
        // re-evaluates and merges once checks are green and the branch is current.
        log.info(
          { taskId: c.taskId, prNumber: c.prNumber, reason: res.error },
          '[auto-merge] Head behind base — updated branch, will retry next tick',
        );
      } else if (await this.handleMergeConflict(c, res.error)) {
        // A real merge conflict — handled by auto-filing a resolution task (or
        // waiting on an in-flight one / parking after the bound). Either way the
        // candidate is NOT marked terminal here so a later tick re-merges once the
        // conflict task pushes its fix and the PR goes CLEAN.
        return;
      } else {
        await mark(c.taskId, 'auto_merge_blocked', `merge failed: ${res.error}`);
        await notify({
          taskId: c.taskId,
          type: 'auto_merge_failed',
          title: '自動マージ失敗',
          message: `PR #${c.prNumber} はCI通過後のマージに失敗しました。手動で確認してください: ${res.error ?? ''}`,
        });
      }
      return;
    }

    if (state === 'fail') {
      // Delegated: base update for BEHIND branches, DIRTY-conflict delegation
      // (via the injected handleMergeConflict), no-diff parking, and the
      // bounded CI self-repair bounce all live in auto-merge-ci-failure.
      const failedChecks = checks
        .filter((ch) => blocking.has(ch.name) && (ch.bucket === 'fail' || ch.bucket === 'cancel'))
        .map((ch) => ch.name);
      await handleCiFailure(c, failedChecks, (cand, reason) =>
        this.handleMergeConflict(cand, reason),
      );
      return;
    }

    // pending / unknown — wait, unless we have waited too long.
    const since = c.completedAt?.getTime() ?? Date.now();
    if (Date.now() - since > PENDING_TIMEOUT_MS) {
      await mark(c.taskId, 'auto_merge_blocked', 'ci timeout');
      await notify({
        taskId: c.taskId,
        type: 'auto_merge_timeout',
        title: '自動マージ保留（CIタイムアウト）',
        message: `PR #${c.prNumber} のCIが時間内に完了しなかったため自動マージを保留しました。`,
      });
    }
  }
}
