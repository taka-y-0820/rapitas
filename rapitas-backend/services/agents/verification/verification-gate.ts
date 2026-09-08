/**
 * verification-gate
 *
 * Shared hard gate around runAutomatedVerification, used by BOTH auto-PR paths
 * (post-execution-review and the verify.md-triggered performAutoCommitAndPR) so
 * neither can publish a PR when the agent introduced new lint/type errors.
 *
 * On a new failure it marks the task `blocked` (and the session `failed` with
 * the evidence) and returns ok:false. A verifier crash is unverifiable, not a
 * pass: publishing must wait until verification can run successfully.
 */
import { prisma } from '../../../config/database';
import { createLogger } from '../../../config/logger';
import {
  runAutomatedVerification,
  renderVerificationMarkdown,
  looksLikeBugFixTask,
  computeVerdict,
  type VerificationResult,
  type VerificationVerdict,
} from './automated-verifier';
import { readWorkflowFile } from '../../workflow/workflow-file-utils';
import { parsePlanFiles } from './scope-check';
import { parseSpecArray } from '../../../utils/common/spec-array';
import { submitConcern } from '../../memory/concern-backlog-service';
import { writeBlockedStatusDurable } from '../../workflow/durable-blocked-write';
import { resolvePreferredBaseBranch } from '../../task/task-resolver';
import { recordTransition } from '../../workflow/transition-recorder';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const log = createLogger('agents:verification-gate');

/**
 * Loads plan.md content for the scope check. Best-effort: a missing plan
 * (lightweight mode) or a resolution failure simply disables the scope check
 * rather than affecting the gate.
 *
 * @param taskId - Task whose plan to load / 対象タスク
 * @returns plan.md content or null / plan.md の内容
 */
async function loadPlanContent(taskId: number): Promise<string | null> {
  try {
    return (await readWorkflowFile(taskId, 'plan')) || null;
  } catch {
    return null;
  }
}

/**
 * Protected-path TEST files a plan-less (lightweight) task declares in its
 * own spec. The tamper tripwire otherwise fails every lightweight task that
 * touches a test under a protected directory — even when the operator wrote
 * that file into the task (task 867, 2026-09-06: 8 identical bounces). Only
 * `*.test.ts(x)` paths qualify; production gate code stays hard-blocked.
 *
 * @param specText - Title, description, goals, constraints, acceptance criteria joined / タスク仕様の文面
 * @returns Test-file paths to allow for the tamper check / tamper 許可パス
 */
export function protectedTestPathsFromSpec(specText: string): string[] {
  return parsePlanFiles(specText).filter((f) => /\.test\.tsx?$/.test(f));
}

export interface GateOutcome {
  /** True when verification permits publishing. Crashes never open the gate. */
  ok: boolean;
  /** The verification result, or null when the verifier could not run. */
  result: VerificationResult | null;
  /** Three-way verdict — 'unknown' means ok:true but not a confirmed pass (see automated-verifier.ts computeVerdict). */
  verdict: VerificationVerdict;
}

/** Tooling failures cannot establish correctness or justify code-repair retries. */
export function verificationCrashResult(): VerificationResult {
  return {
    ok: false,
    unverifiable: true,
    changedFiles: [],
    checks: [],
    summary:
      'Automated verification could not complete; restore the verifier and rerun verification.',
  };
}

/**
 * Files concerns for pre-existing test failures found during triage. Non-fatal:
 * failures to submit are logged and swallowed so the gate outcome is unaffected.
 * Uses dedupKey `test-baseline:<file>` (task-independent) so the same failing
 * test is filed only once regardless of how many tasks trigger verification.
 *
 * @param taskId - Task whose verification found the failures / 発見タスク
 * @param result - Verification result containing triage data / 検証結果
 */
async function reportPreExistingFailures(
  taskId: number,
  result: VerificationResult,
): Promise<void> {
  const testCheck = result.checks.find((c) => c.name === 'test');
  const preExisting = testCheck?.preExistingFailures;
  if (!preExisting || preExisting.length === 0) return;
  for (const file of preExisting) {
    await submitConcern({
      title: `既存テスト失敗: ${file}`,
      detail: `テストファイル \`${file}\` はエージェントの変更以前から失敗していました。タスク #${taskId} の検証中に検出されました。`,
      type: 'bug',
      severity: 'high',
      location: file,
      originTaskId: taskId,
      source: 'verification-triage',
      dedupKey: `test-baseline:${file}`,
    }).catch((err: unknown) =>
      log.warn({ err, file }, 'Failed to submit pre-existing failure concern (non-fatal)'),
    );
  }
}

/**
 * Files concerns for test failures whose attribution was INDETERMINATE (the
 * merge-base baseline comparison failed even after retries). The gate does
 * not block on these (task 659) — the concern backlog is where the signal
 * lands so a persistently broken baseline infra is still noticed. Kept
 * separate from reportPreExistingFailures: "known old breakage" and "could
 * not tell" carry different severities and wording. Non-fatal, and dedupKey
 * `test-triage-indeterminate:<file>` is task-independent so repeated infra
 * flakiness on the same file does not pile up concerns.
 *
 * @param taskId - Task whose verification hit the indeterminate triage / 発見タスク
 * @param result - Verification result containing triage data / 検証結果
 */
export async function reportIndeterminateTriage(
  taskId: number,
  result: VerificationResult,
): Promise<void> {
  const testCheck = result.checks.find((c) => c.name === 'test');
  const indeterminate = testCheck?.indeterminateFailures;
  if (!indeterminate || indeterminate.length === 0) return;
  for (const file of indeterminate) {
    await submitConcern({
      title: `テスト失敗の帰責判定不能: ${file}`,
      detail: `テストファイル \`${file}\` はタスク #${taskId} の検証中に失敗しましたが、merge-base ベースライン worktree の作成/セットアップが再試行後も失敗したため、本変更に起因する失敗か既存の失敗かを判定できませんでした。ゲートはブロックしていません。ベースライン比較インフラ（worktree 作成 / setup-worktree.cjs）の健全性を確認してください。`,
      type: 'other',
      severity: 'medium',
      location: file,
      originTaskId: taskId,
      source: 'verification-triage',
      dedupKey: `test-triage-indeterminate:${file}`,
    }).catch((err: unknown) =>
      log.warn({ err, file }, 'Failed to submit indeterminate triage concern (non-fatal)'),
    );
  }
}

/**
 * Runs the automated lint/typecheck gate on a worktree.
 *
 * @param taskId - Task being verified / 検証対象タスク
 * @param worktreePath - The agent's git worktree / エージェントの worktree
 * @param sessionId - Session to fail on a gate block, if known / 失敗にするセッション
 * @returns Gate outcome (ok + result) / ゲート結果
 */
export async function runVerificationGate(
  taskId: number,
  worktreePath: string,
  sessionId?: number,
): Promise<GateOutcome> {
  const planContent = await loadPlanContent(taskId);
  // Bug-fix tasks must ship a reproducing/regression test: a fix that changes
  // no test is exactly the leaky gate SWT-Bench / UTBoost measured (R4).
  const task = await prisma.task
    .findUnique({
      where: { id: taskId },
      select: {
        title: true,
        description: true,
        goals: true,
        constraints: true,
        acceptanceCriteria: true,
      },
    })
    .catch(() => null);
  const requireTests = looksLikeBugFixTask(`${task?.title ?? ''}\n${task?.description ?? ''}`);
  const specText = [
    task?.title ?? '',
    task?.description ?? '',
    ...parseSpecArray(task?.goals),
    ...parseSpecArray(task?.constraints),
    ...parseSpecArray(task?.acceptanceCriteria),
  ].join('\n');
  const tamperAllowlist = planContent ? undefined : protectedTestPathsFromSpec(specText);
  // The worktree's ACTUAL fork point, not a guess — see automated-verifier.ts's
  // diffBaseRef doc comment (task 506: a guess-only base can land on a stale
  // branch and misread unrelated pre-existing commits as this task's own
  // out-of-scope/tampering changes, false-failing this HARD gate).
  // NOTE: theme.defaultBranch, not AgentExecutionConfig.targetBranch alone
  // (task 511: that table is empty for the autonomous pipeline) — see
  // resolvePreferredBaseBranch's doc comment.
  const preferredBaseBranch = await resolvePreferredBaseBranch(taskId);
  const result = await runAutomatedVerification(worktreePath, {
    planContent,
    tamperAllowlist,
    requireTests,
    preferredBaseBranch,
    taskId,
    acceptanceCriteria: parseSpecArray(task?.acceptanceCriteria),
    taskText: specText,
  }).catch((err): VerificationResult => {
    log.error({ err, taskId }, 'Automated verification crashed — blocking gate');
    return verificationCrashResult();
  });

  // Report pre-existing / indeterminate failures as concerns before the gate
  // verdict is applied. Runs regardless of ok/NG so concerns are filed even
  // when the gate passes (an indeterminate triage ALWAYS passes — task 659).
  await reportPreExistingFailures(taskId, result);
  await reportIndeterminateTriage(taskId, result);

  if (result.ok) {
    const verdict = computeVerdict(result.checks);
    await reportAdvisoryDowngrade(taskId, result, verdict);
    log.info({ taskId, summary: result.summary, verdict }, 'Automated verification passed');
    return { ok: true, result, verdict };
  }

  await blockTaskForVerification(taskId, result, sessionId);
  return { ok: false, result, verdict: 'fail' };
}

/**
 * Files a non-fatal advisory-downgrade concern when scope/acceptance checks
 * failed but the gate still passed (verdict:'unknown'). Skips entirely when
 * the verdict is not 'unknown' (indeterminate-only unknowns are already
 * covered by {@link reportIndeterminateTriage}, filed separately above).
 *
 * @param taskId - Task being verified / 検証対象タスク
 * @param result - The passing verification result / 検証結果
 * @param verdict - The computed three-way verdict / 三値判定
 */
export async function reportAdvisoryDowngrade(
  taskId: number,
  result: VerificationResult,
  verdict: VerificationVerdict,
): Promise<void> {
  if (verdict !== 'unknown') return;
  const advisoryNg = result.checks.filter(
    (c) => (c.name === 'scope' || c.name === 'acceptance') && c.ran && c.ok === false,
  );
  for (const c of advisoryNg) {
    await submitConcern({
      title: `検証結果 unknown（${c.name} advisory NG）: タスク #${taskId}`,
      detail: `タスク #${taskId} の検証で ${c.name} チェックが助言(advisory) NG を報告し、三値判定は 'unknown' になりました。ハードゲートは通過していますが、内容の確認を推奨します。詳細: ${c.details}`,
      type: 'other',
      severity: 'medium',
      location: c.name,
      originTaskId: taskId,
      source: 'verification-gate',
      dedupKey: `verify-unknown:${taskId}:${c.name}`,
    }).catch((err: unknown) =>
      log.warn(
        { err, taskId, check: c.name },
        'Failed to submit advisory-downgrade concern (non-fatal)',
      ),
    );
  }
}

/**
 * Records a `WorkflowTransition` marker (cause: verification_unknown) so
 * `AutoMergeWatcher` — a separate process/tick — can later resolve whether
 * the current PR head still carries an unresolved verdict. Fire-and-forget:
 * `recordTransition` never throws (see its doc comment), so no try/catch here.
 *
 * @param taskId - Task whose PR carries the unknown verdict / 対象タスク
 * @param gitCwd - Worktree to resolve HEAD sha from / worktree パス
 * @param source - Which auto-PR path recorded the marker / 記録元
 */
export async function recordUnknownVerdictMarker(
  taskId: number,
  gitCwd: string,
  source: 'workflow-auto-commit' | 'post-execution-review',
): Promise<void> {
  const headSha = await execAsync('git rev-parse HEAD', { cwd: gitCwd, timeout: 30_000 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => undefined);
  await recordTransition({
    taskId,
    fromStatus: 'in_progress',
    toStatus: 'in_progress',
    actor: 'system',
    cause: 'verification_unknown',
    phase: 'verify',
    metadata: { headSha, source },
  });
}

/**
 * Marks a task blocked (and its session failed with the verification evidence)
 * after the automated checks found new lint/type errors. Exposed so the retry
 * loop can use it once retries are exhausted.
 *
 * @param taskId - Task to block / ブロックするタスク
 * @param result - The failing verification result / 失敗した検証結果
 * @param sessionId - Session to fail, if known / 失敗にするセッション
 */
export async function blockTaskForVerification(
  taskId: number,
  result: VerificationResult,
  sessionId?: number,
): Promise<void> {
  log.error(
    { taskId, sessionId, summary: result.summary },
    'Automated verification failed — blocking',
  );
  // DURABLE WRITE: `status: 'blocked'` is the terminal action that actually
  // stops the self-repair retry loop (verification-retry.ts reads task status
  // via this same block path). A bare `.catch(() => warn)` here used to let
  // the write silently no-op, leaving the task looking un-blocked to any
  // downstream automation even though verification genuinely failed.
  await writeBlockedStatusDurable({
    taskId,
    log,
    source: 'verification-gate',
    notification: {
      title: '検証失敗タスクのブロック処理に失敗',
      message: `タスク #${taskId} は自動検証に失敗しましたが、ブロック状態として記録できませんでした。手動で確認してください。`,
    },
  });
  if (sessionId !== undefined) {
    await markSessionFailedDurable(sessionId, taskId, result);
  }
}

/**
 * Marks a session `failed` with the verification evidence, retrying once on
 * failure. Mirrors `writeBlockedStatusDurable`'s retry-once pattern: without
 * it, a swallowed write here left the session stuck `running` with no active
 * process even though the task itself was correctly blocked above.
 *
 * @param sessionId - Session to fail / 失敗にするセッション
 * @param taskId - Owning task, for log context / ログ用のタスクID
 * @param result - The failing verification result / 失敗した検証結果
 */
async function markSessionFailedDurable(
  sessionId: number,
  taskId: number,
  result: VerificationResult,
): Promise<void> {
  const data = {
    status: 'failed' as const,
    completedAt: new Date(),
    errorMessage: `自動検証に失敗しました（${result.summary}）。${result.unverifiable ? '検証環境の問題により正しさを確認できません。検証環境を復旧して再検証してください。' : '検証で問題が検出されました。'}worktree は保持しています。\n\n${renderVerificationMarkdown(result)}`,
  };
  const attempt = () =>
    prisma.agentSession
      .update({ where: { id: sessionId }, data })
      .then(() => true)
      .catch(() => false);

  if (await attempt()) return;
  log.warn({ taskId, sessionId }, 'Failed to mark session failed — retrying once');
  if (await attempt()) return;
  log.error(
    { taskId, sessionId },
    'Failed to mark session failed twice — session may remain stuck running',
  );
}
