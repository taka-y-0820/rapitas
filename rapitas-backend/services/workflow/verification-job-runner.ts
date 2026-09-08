/**
 * Verification Job Runner
 *
 * Splits the implementer self-verification flow into a fast synchronous part
 * (`beginVerificationRun` — fingerprint the worktree, mint a runId, persist
 * the start event) and a slow background part (`runVerificationGateAndRecord`
 * — actually run lint/typecheck/tests/runtime and persist the finish event).
 * The POST handler (workflow-handlers-verification.ts) awaits only the fast
 * part before responding; the slow part continues after the HTTP response
 * has been sent so a client disconnect (task 899: idleTimeout=30 on
 * index.ts) can no longer lose the result. Cache-identity logic
 * (`computeVerificationCacheKey`/`buildCacheInputs`) is unchanged from the
 * prior synchronous handler — moved here, not rewritten.
 */
import { createHash, randomUUID } from 'crypto';
import { readFile, lstat } from 'fs/promises';
import { join } from 'path';
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import {
  runAutomatedVerification,
  renderVerificationMarkdown,
  looksLikeBugFixTask,
} from '../agents/verification/automated-verifier';
import { resolveAcceptanceCriteria } from '../agents/verification/acceptance-self-check';
import { readWorkflowFile } from './workflow-file-utils';
import { resolvePreferredBaseBranch } from '../task/task-resolver';
import { runGitCommand } from '../github/git-exec';
import { recordJobStart, recordJobFinish } from './verification-job-store';

const log = createLogger('services:workflow:verification-job-runner');

/** Default cap on total untracked-file bytes hashed into the cache key. */
const DEFAULT_MAX_UNTRACKED_BYTES = 32 * 1024 * 1024;
/** Default cap on the number of untracked files hashed into the cache key. */
const DEFAULT_MAX_UNTRACKED_FILES = 500;

/** Inputs covered by the concurrent-change fingerprint. */
export interface VerificationCacheInputs {
  worktreePath: string;
  planContent?: string;
  acceptanceCriteria?: string[];
  requireTests: boolean;
  preferredBaseBranch?: string | null;
  taskText?: string;
}

/**
 * Fingerprint Git content and the supplied task inputs to detect changes
 * during verification. This is not a complete identity for external state
 * and must never authorize reuse of a completed verification result.
 * Structured path/content-digest pairs avoid ambiguous binary boundaries.
 *
 * @param inputs - Worktree and task inputs observed for this run.
 * @returns Fingerprint, or null when inputs cannot be identified.
 */
export async function computeVerificationCacheKey(
  inputs: VerificationCacheInputs,
): Promise<string | null> {
  const { worktreePath } = inputs;
  try {
    const [head, diff, untrackedRaw] = await Promise.all([
      runGitCommand(['rev-parse', 'HEAD'], worktreePath, { timeoutMs: 5_000, skipLog: true }),
      runGitCommand(['diff', 'HEAD'], worktreePath, { timeoutMs: 10_000, skipLog: true }),
      runGitCommand(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath, {
        timeoutMs: 5_000,
        skipLog: true,
      }),
    ]);
    const untrackedPaths = untrackedRaw.split('\0').filter(Boolean).sort();

    const maxBytes =
      Number(process.env.RAPITAS_SELFVERIFY_MAX_UNTRACKED_BYTES) || DEFAULT_MAX_UNTRACKED_BYTES;
    const maxFiles =
      Number(process.env.RAPITAS_SELFVERIFY_MAX_UNTRACKED_FILES) || DEFAULT_MAX_UNTRACKED_FILES;
    if (untrackedPaths.length > maxFiles) {
      log.warn(
        { worktreePath, files: untrackedPaths.length, maxFiles },
        '[self-verification] untracked file count exceeds cache safety valve — bypassing cache',
      );
      return null;
    }

    // lstat (not stat) so a symlink is detected as such rather than followed —
    // its target's identity cannot be safely tracked (Windows junction/symlink
    // resolution is complex and target changes aren't reflected here), so any
    // untracked symlink bypasses the cache entirely per the safety-valve
    // philosophy. Also totals size before reading full content so an
    // oversized set is rejected without paying to read every byte first.
    let totalBytes = 0;
    for (const relPath of untrackedPaths) {
      const st = await lstat(join(worktreePath, relPath));
      if (st.isSymbolicLink()) {
        log.warn(
          { worktreePath, relPath },
          '[self-verification] untracked symlink — identity cannot be guaranteed, bypassing cache',
        );
        return null;
      }
      totalBytes += st.size;
      if (totalBytes > maxBytes) {
        log.warn(
          { worktreePath, totalBytes, maxBytes },
          '[self-verification] untracked content exceeds cache safety valve — bypassing cache',
        );
        return null;
      }
    }

    const fileEntries: Array<[string, string]> = [];
    for (const relPath of untrackedPaths) {
      const content = await readFile(join(worktreePath, relPath));
      fileEntries.push([relPath, createHash('sha256').update(content).digest('hex')]);
    }

    const hash = createHash('sha256');
    const sep = Buffer.from([0]);
    hash.update(head);
    hash.update(sep);
    hash.update(diff);
    hash.update(sep);
    hash.update(JSON.stringify(fileEntries));
    hash.update(sep);
    hash.update(worktreePath);
    hash.update(sep);
    hash.update(inputs.planContent ?? '');
    hash.update(sep);
    hash.update(JSON.stringify(inputs.acceptanceCriteria ?? []));
    hash.update(sep);
    hash.update(String(inputs.requireTests));
    hash.update(sep);
    hash.update(inputs.preferredBaseBranch ?? '');
    hash.update(sep);
    hash.update(inputs.taskText ?? '');
    return hash.digest('hex');
  } catch (err) {
    log.warn(
      { err, worktreePath },
      '[self-verification] cache identity unavailable — bypassing cache for this request',
    );
    return null;
  }
}

/**
 * Load every DB-sourced input that feeds both the gate and the cache
 * identity. Called twice per job — before and after the gate runs — so
 * that a plan/task/acceptance-criteria edit made WHILE verification was in
 * flight (which can take minutes) is reflected in `keyAfter` and correctly
 * invalidates the measured result, not just an in-memory worktree re-hash of
 * variables captured before the run started.
 *
 * @param taskId - Task whose plan/acceptance/base branch to load. / 対象タスクID
 * @param worktreePath - Task's agent worktree. / worktreeパス
 * @returns Cache-identity inputs (also reused to build the gate's options). / 検証入力一式
 */
export async function buildCacheInputs(
  taskId: number,
  worktreePath: string,
): Promise<VerificationCacheInputs> {
  const [planContent, preferredBaseBranch, taskRow] = await Promise.all([
    readWorkflowFile(taskId, 'plan'),
    resolvePreferredBaseBranch(taskId),
    // Unavailable task inputs must not silently weaken the verification gate.
    prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true, description: true, acceptanceCriteria: true },
    }),
  ]);
  if (!taskRow) throw new Error('Verification task inputs are unavailable');
  const taskText = taskRow ? `${taskRow.title}\n${taskRow.description ?? ''}` : '';
  const acceptanceCriteria = taskRow ? resolveAcceptanceCriteria(taskRow) : [];
  return {
    worktreePath,
    planContent: planContent ?? undefined,
    acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : undefined,
    requireTests: looksLikeBugFixTask(taskText),
    preferredBaseBranch,
    taskText: taskText || undefined,
  };
}

/** Fast-path result of starting a verification job — everything the POST handler awaits. */
export interface BeginVerificationRunResult {
  runId: string;
  cacheInputsBefore: VerificationCacheInputs;
  keyBefore: string | null;
}

/**
 * Fingerprint the worktree, mint a runId, and persist the start event. This
 * is the ONLY part of a verification job the POST handler awaits — it must
 * stay fast (no gate execution) so the response returns well within
 * `index.ts`'s `idleTimeout: 30`.
 *
 * @param taskId - Task to verify. / 対象タスクID
 * @param worktreePath - Task's agent worktree. / worktreeパス
 * @returns The new job's runId and the inputs/fingerprint captured at start time. / 起動結果
 */
export async function beginVerificationRun(
  taskId: number,
  worktreePath: string,
): Promise<BeginVerificationRunResult> {
  const cacheInputsBefore = await buildCacheInputs(taskId, worktreePath);
  const keyBefore = await computeVerificationCacheKey(cacheInputsBefore);
  const runId = randomUUID();
  await recordJobStart(taskId, runId, keyBefore);
  return { runId, cacheInputsBefore, keyBefore };
}

/**
 * Run the automated verification gate on the task's worktree and persist the
 * finish event. Called WITHOUT being awaited by the POST handler — it keeps
 * running after the HTTP response has been sent, so a client disconnect
 * cannot lose the result. Never throws: any failure is captured and recorded
 * as a `failed` finish event instead.
 *
 * @param taskId - Task to verify. / 対象タスクID
 * @param runId - Job identifier from {@link beginVerificationRun}. / ジョブID
 * @param worktreePath - Task's agent worktree. / worktreeパス
 * @param cacheInputsBefore - Inputs captured at start time. / 開始時点の入力
 * @param keyBefore - Fingerprint captured at start time. / 開始時点の指紋
 */
export async function runVerificationGateAndRecord(
  taskId: number,
  runId: string,
  worktreePath: string,
  cacheInputsBefore: VerificationCacheInputs,
  keyBefore: string | null,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const verificationOptions = {
      planContent: cacheInputsBefore.planContent,
      preferredBaseBranch: cacheInputsBefore.preferredBaseBranch,
      taskId,
      requireTests: cacheInputsBefore.requireTests,
      acceptanceCriteria: cacheInputsBefore.acceptanceCriteria,
      taskText: cacheInputsBefore.taskText,
    };
    const result = await runAutomatedVerification(worktreePath, verificationOptions);
    log.info(
      { taskId, runId, ok: result.ok, checks: result.checks.length },
      '[self-verification] gate run complete',
    );
    const markdown = renderVerificationMarkdown(result);
    const durationMs = Date.now() - startedAt;

    // Re-derived AFTER the gate ran (which can take minutes — the
    // runtime-smoke stage alone is ~130s) so an edit made WHILE verification
    // was running invalidates the result instead of recording a now-stale
    // pass. Re-fetched from the DB/workflow-file store, not just re-hashing
    // the SAME in-memory `cacheInputsBefore` object — a plan.md/acceptance
    // criteria/base-branch change mid-run would otherwise go undetected since
    // those variables never change on their own (task 897 supervisor
    // finding: rehashing unchanged in-memory values cannot detect concurrent
    // DB-side input changes).
    const cacheInputsAfter = await buildCacheInputs(taskId, worktreePath);
    const keyAfter = await computeVerificationCacheKey(cacheInputsAfter);
    if (!keyBefore || !keyAfter || keyBefore !== keyAfter) {
      await recordJobFinish(taskId, runId, {
        status: 'completed',
        ok: false,
        unverifiable: true,
        summary:
          'Verification inputs changed or could not be identified; verification is unconfirmed.',
        markdown:
          '# Verification unconfirmed\nInputs changed or could not be identified during this run.\n\n' +
          markdown,
        durationMs,
        fingerprintAtFinish: keyAfter,
      });
      return;
    }
    await recordJobFinish(taskId, runId, {
      status: 'completed',
      ok: result.ok,
      unverifiable: false,
      checks: result.checks,
      summary: result.summary,
      markdown,
      durationMs,
      fingerprintAtFinish: keyAfter,
    });
  } catch (err) {
    log.warn({ err, taskId, runId }, '[self-verification] gate run failed');
    await recordJobFinish(taskId, runId, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    }).catch((finishErr) => {
      log.warn(
        { err: finishErr, taskId, runId },
        '[self-verification] failed to record job failure',
      );
    });
  }
}
