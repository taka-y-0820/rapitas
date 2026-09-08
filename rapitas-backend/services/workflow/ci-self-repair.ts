/**
 * ci-self-repair
 *
 * When a completed task's PR fails its GitHub CI, bounce the task BACK to the
 * implementer with the failing checks as feedback and re-enqueue it, so the
 * workflow re-runs implement → verify → auto-commit, pushes the fix to the SAME
 * PR branch (updating the PR), and CI re-runs. The AutoMergeWatcher then merges
 * once CI goes green. Bounded by a per-task attempt cap counted from
 * WorkflowTransition rows (cause `ci_repair`) — no schema change. Mirrors
 * verify-self-repair, but triggered by CI failure AFTER completion rather than a
 * self-contradicting verify.md DURING the workflow.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { readWorkflowFile, writeWorkflowFile } from './workflow-file-utils';
import { recordTransition } from './transition-recorder';
import { WorkflowQueueService } from './workflow-queue';
import { countWithFailClosed } from '../../utils/database/fail-closed-count';
import { ghPath, readPrChecks, readHeadSha } from './auto-merge-checks';
import { DEFAULT_MAX_CI_REPAIRS } from './blocked-task-policy';

const execAsync = promisify(exec);
const log = createLogger('workflow:ci-self-repair');

/** WorkflowTransition.cause used to count + identify CI-repair bounces. */
export const CI_REPAIR_CAUSE = 'ci_repair';

/**
 * WorkflowTransition.cause recorded when the post-repair re-enqueue fails for
 * a reason OTHER than a race (`already in the queue`). Before this cause
 * existed, that failure left `task.status='in-progress'` with nobody holding a
 * `WorkflowQueueItem` — an orphan that only `requeueOrphanTasks` (45-minute
 * poll, `workflow-reconciler-requeue.ts`) would eventually notice (task 786 /
 * #785: the 16:50:13 reconciler_requeue matched this exact enqueue-failure
 * shape). Reverting `status` to 'todo' immediately lets the next reconcile
 * pass (60s) pick it back up instead of waiting 45 minutes.
 */
export const ENQUEUE_FAILED_CAUSE = 'workflow_queue_enqueue_failed';

/** Per-check tail budget for CI log excerpts injected into the feedback. */
const MAX_LOG_LINES_PER_CHECK = 50;
/** Total byte budget (across all checks) for CI log excerpts. */
const MAX_LOG_EXCERPT_BYTES = 8 * 1024;

/** PR coordinates for reading CI logs. Optional — omitted by direct/test callers. */
export interface CiRepairContext {
  cwd: string;
  prNumber: number;
}

export interface CiRepairResult {
  /** True when the task was bounced for a fix (watcher must keep watching, NOT block). */
  bounced: boolean;
  /** 1-based attempt number for this bounce. */
  attempt?: number;
}

/** Count how many CI-repair bounces this task has already had. */
async function countPriorRepairs(taskId: number): Promise<number> {
  return countWithFailClosed(
    prisma.workflowTransition.count({ where: { taskId, cause: CI_REPAIR_CAUSE } }),
    DEFAULT_MAX_CI_REPAIRS,
    log,
    { taskId },
    'ci-repair',
  );
}

/**
 * The implementer's ENTRY status: `plan_approved` when a plan.md exists, else
 * `research_done` (lightweight). Setting workflowStatus here makes the runner
 * re-run implement → verify.
 */
async function resolveImplementEntryStatus(
  taskId: number,
): Promise<'plan_approved' | 'research_done'> {
  const plan = await prisma.workflowFile
    .findFirst({ where: { taskId, fileType: 'plan' }, select: { id: true } })
    .catch(() => null);
  return plan ? 'plan_approved' : 'research_done';
}

/**
 * Fetch the failed-step log tails for the given failing checks via the gh CLI.
 * Fully fail-open: any gh error (per check or for the whole listing) degrades to
 * a smaller — possibly empty — excerpt, never an exception. The excerpt exists
 * because a bounced implementer previously got only check NAMES, leaving it
 * blind to CI-only failures it cannot reproduce locally (task 537 / PR #339).
 *
 * @param cwd - Repo working directory / リポジトリ作業ディレクトリ
 * @param prNumber - PR number / PR番号
 * @param failedChecks - Names of the failing checks. / 失敗チェック名
 * @returns Markdown sections (max 50 lines/check, 8KB total), '' when nothing
 *   could be fetched. / ログ抜粋（取得不能時は空文字列）
 */
async function fetchFailedCheckLogExcerpt(
  cwd: string,
  prNumber: number,
  failedChecks: string[],
): Promise<string> {
  const checks = await readPrChecks(cwd, prNumber).catch(() => null);
  if (!checks) return '';
  const linkByName = new Map(checks.filter((c) => c.link).map((c) => [c.name, c.link as string]));

  const sections: string[] = [];
  let usedBytes = 0;
  for (const name of failedChecks) {
    const link = linkByName.get(name);
    // Only GitHub Actions details URLs (.../actions/runs/<runId>/job/<jobId>)
    // carry a job id we can feed to `gh run view --job` — skip external CI apps.
    const jobId = link?.match(/\/job\/(\d+)/)?.[1];
    if (!jobId) continue;

    let stdout: string;
    try {
      ({ stdout } = await execAsync(`${ghPath()} run view --job ${jobId} --log-failed`, {
        cwd,
        encoding: 'utf8',
      }));
    } catch {
      continue; // fail-open per check — one unreadable job must not drop the rest
    }

    const tail = stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .slice(-MAX_LOG_LINES_PER_CHECK)
      .join('\n');
    if (!tail) continue;
    let section = `### ${name}\n\`\`\`\n${tail}\n\`\`\``;
    const bytes = Buffer.byteLength(section, 'utf8');
    if (usedBytes + bytes > MAX_LOG_EXCERPT_BYTES) {
      // Trim the overflowing section into the remaining budget, then stop.
      const remaining = MAX_LOG_EXCERPT_BYTES - usedBytes;
      if (remaining > 0) {
        section = `${Buffer.from(section, 'utf8').subarray(0, remaining).toString('utf8')}\n…(truncated)`;
        sections.push(section);
      }
      break;
    }
    usedBytes += bytes;
    sections.push(section);
  }
  return sections.join('\n\n');
}

/**
 * Append the CI failure to verify.md so the re-run implementer reads it as
 * verification feedback (the implementer context surfaces verify.md). This is a
 * verification/CI concern, not a user Q&A — keeping it out of question.md stops
 * it from polluting the Q&A tab. Best-effort.
 *
 * @param ciContext - PR coordinates for CI log excerpts (optional; when omitted
 *   the feedback keeps the legacy names-only format). / ログ抜粋用のPR情報（任意）
 */
async function writeCiFeedback(
  taskId: number,
  failedChecks: string[],
  detail: string,
  attempt: number,
  ciContext?: CiRepairContext,
): Promise<void> {
  try {
    const prior = (await readWorkflowFile(taskId, 'verify')) ?? '';
    const excerpt = ciContext
      ? await fetchFailedCheckLogExcerpt(ciContext.cwd, ciContext.prNumber, failedChecks).catch(
          () => '',
        )
      : '';
    const block = [
      `# CIからの差し戻し（自己修復 ${attempt} 回目）`,
      '',
      `作成されたPRのGitHub CIが失敗しました。失敗チェック: ${failedChecks.join(', ') || '(不明)'}`,
      '',
      '以下を厳守して **実装を修正** してください:',
      '- 失敗したチェックに対応するゲートをローカルで再現して直す（例: "Check Frontend"→フロントのテスト、"Lint Code"→lint/型、"Test Backend"/"Test SQLite"→バックエンドのテスト）。',
      '- `bun test --isolate` / `bunx tsc --noEmit` / lint / prettier をローカルで実行し、緑になるまで直す。',
      '- スコープ厳守（plan.md 記載外のファイルは変更しない）。テスト結果の改ざんは禁止。',
      '- plan.md 記載外のファイルに原因があっても、元の要件・受け入れ基準・停止/完了の不変条件・必須完了ゲートに関わる失敗は未達のまま扱う。懸念起票だけで免除したり、判定を成功へ書き換えたりしてはならない。計画の修正が必要なら理由と再現証拠を報告し、正規の再計画または保留へ進める。',
      '- 元の要件と無関係な既存失敗は POST /concerns に起票し、無関係と判断した根拠を verify.md に残す。ただし、必須チェックや完了ゲートの成功を代替するものではない。',
      // The ratchet's decisive NEW/GREW lines sit at the TOP of its listing and
      // the 50-line tail excerpt cuts them off — repairs kept fixing the wrong
      // thing (PR #537, PR #542). Local reproduction is exact, so demand it.
      ...(failedChecks.some((n) => n.includes('line limits'))
        ? [
            '- 「Enforce per-file line limits」の失敗はファイル肥大が原因。リポジトリルートで `node scripts/check-large-files.cjs` を実行し、`← NEW` / `← GREW` の付いたファイルを特定して **責務単位で分割し 300 行以下にする**（元ファイルは薄い re-export に保つ）。`.baselines/file-size.json` を書き換えて回避することは禁止。',
          ]
        : []),
      '',
      detail ? `## CI 失敗の詳細\n${detail.slice(0, 1500)}` : '',
      excerpt ? `## CI ログ抜粋（チェックごと最大50行、合計8KB上限）\n${excerpt}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const next = prior.trim() ? `${prior.trim()}\n\n---\n\n${block}` : block;
    await writeWorkflowFile(taskId, 'verify', next);
  } catch (err) {
    log.warn({ err, taskId }, '[ci-repair] Failed to write CI feedback to verify.md');
  }
}

/**
 * Attempt a CI-failure → implement self-repair bounce. Returns `bounced:false`
 * (caller should flag the PR for review) once the per-task cap is reached, or
 * when repairs are disabled (RAPITAS_MAX_CI_REPAIRS=0).
 *
 * @param taskId - Task whose PR failed CI. / CI失敗したPRのタスク
 * @param failedChecks - Names of the failing CI checks. / 失敗したチェック名
 * @param detail - Optional truncated failure detail for the agent. / 失敗詳細（任意）
 * @param ciContext - PR coordinates enabling CI log excerpts and head-SHA
 *   bookkeeping (optional; direct callers without a PR omit it). / PR情報（任意）
 * @returns Whether the task was bounced for a fix. / 修復のため差し戻したか
 */
export async function attemptCiRepair(
  taskId: number,
  failedChecks: string[],
  detail = '',
  ciContext?: CiRepairContext,
): Promise<CiRepairResult> {
  if (DEFAULT_MAX_CI_REPAIRS === 0) return { bounced: false };

  // Conflict-resolution tasks ("PR #N の競合を解消") must NOT be CI-repaired: their
  // job is to resolve a merge conflict, not to fix failing tests. Re-running the
  // agent finds no conflict left and cannot fix a CI bug, so bouncing it merely
  // UN-COMPLETES a finished task (the completed→plan_approved flip the user saw on
  // task 280). A CI failure on such a PR is a separate concern — leave the task
  // completed and let the caller flag the PR for review instead.
  const ctask = await prisma.task
    .findUnique({ where: { id: taskId }, select: { title: true, githubPrId: true } })
    .catch(() => null);
  if (ctask && ctask.githubPrId != null && /^PR #\d+ の競合を解消/.test(ctask.title ?? '')) {
    log.info(
      { taskId },
      '[ci-repair] Conflict-resolution task — skipping CI repair (re-run cannot fix CI; staying completed)',
    );
    return { bounced: false };
  }

  const prior = await countPriorRepairs(taskId);
  if (prior >= DEFAULT_MAX_CI_REPAIRS) {
    log.warn(
      { taskId, prior, max: DEFAULT_MAX_CI_REPAIRS },
      '[ci-repair] CI repair attempts exhausted — caller should flag for review',
    );
    return { bounced: false };
  }

  const attempt = prior + 1;
  const newStatus = await resolveImplementEntryStatus(taskId);

  await writeCiFeedback(taskId, failedChecks, detail, attempt, ciContext);

  // Record the head SHA being repaired so a later tick can detect a no-diff
  // re-run (head unchanged since this bounce = the implementer never pushed).
  const headSha = ciContext ? await readHeadSha(ciContext.cwd, ciContext.prNumber) : null;

  // Re-open the workflow: implementer entry status + non-terminal task status.
  await prisma.task
    .update({
      where: { id: taskId },
      data: { status: 'in-progress', workflowStatus: newStatus, updatedAt: new Date() },
    })
    .catch((err) => log.warn({ err, taskId }, '[ci-repair] Failed to reset task for re-run'));

  await recordTransition({
    taskId,
    fromStatus: 'completed',
    toStatus: newStatus,
    actor: 'system',
    cause: CI_REPAIR_CAUSE,
    phase: 'verify',
    metadata: {
      attempt,
      max: DEFAULT_MAX_CI_REPAIRS,
      failedChecks,
      ...(headSha ? { headSha } : {}),
    },
  });

  // Re-enqueue so the status-driven WorkflowRunner re-runs implement → verify.
  try {
    await WorkflowQueueService.getInstance().enqueue({ taskId, priority: 60 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already in the queue')) {
      // A tick raced us — fine, the existing queue item covers this run.
    } else {
      // enqueue() failed before a WorkflowQueueItem was created, so nobody will
      // ever dispatch this task — revert to 'todo' (keeping workflowStatus) so
      // the next reconcile pass (60s) re-queues it instead of the 45-minute
      // orphan sweep having to catch it.
      log.warn(
        { err, taskId },
        '[ci-repair] Failed to re-enqueue task — reverting to todo for immediate reconciler pickup',
      );
      await prisma.task
        .update({ where: { id: taskId }, data: { status: 'todo', updatedAt: new Date() } })
        .catch((updateErr) =>
          log.warn(
            { err: updateErr, taskId },
            '[ci-repair] Failed to revert status to todo after enqueue failure',
          ),
        );
      // fromStatus/toStatus record WORKFLOW status (schema.prisma:134-137), which
      // is unchanged here — only task.status flips ('in-progress' -> 'todo'), the
      // same convention as the sibling revert causes (see lifecycle-manager.ts's
      // agent_lifecycle_shutdown_revert). isWithinRecoveryGrace only keys off
      // `cause` + timestamp (incident-signature-detectors.ts:219-229), so this
      // does not affect Pattern-B exclusion. The actual task.status change is
      // recorded explicitly in metadata for audit-trail completeness.
      await recordTransition({
        taskId,
        fromStatus: newStatus,
        toStatus: newStatus,
        actor: 'system',
        cause: ENQUEUE_FAILED_CAUSE,
        phase: 'verify',
        metadata: {
          reason: 'enqueue_failed',
          error: msg,
          taskStatusFrom: 'in-progress',
          taskStatusTo: 'todo',
        },
      });
    }
  }

  log.info(
    { taskId, attempt, max: DEFAULT_MAX_CI_REPAIRS, newStatus, failedChecks },
    '[ci-repair] Bounced CI failure back to implementer',
  );
  return { bounced: true, attempt };
}
