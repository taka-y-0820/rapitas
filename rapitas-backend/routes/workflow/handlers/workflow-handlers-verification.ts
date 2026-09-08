/**
 * Workflow Handlers — Self-Verification
 *
 * POST /workflow/tasks/:taskId/run-verification — lets the IMPLEMENTER run the
 * exact deterministic gate (lint / typecheck / scoped tests / plan-scope) the
 * verify phase will later enforce, on its own worktree, BEFORE finishing.
 * A failure caught here is an in-phase fix (cheapest loop); the same failure
 * caught at verify is a full phase bounce (most expensive loop). Read-only
 * with respect to workflow state: no status transition, no file save.
 */
import { createHash } from 'crypto';
import { readFile, lstat } from 'fs/promises';
import { join } from 'path';
import { prisma } from '../../../config';
import { createLogger } from '../../../config/logger';
import {
  runAutomatedVerification,
  renderVerificationMarkdown,
  looksLikeBugFixTask,
} from '../../../services/agents/verification/automated-verifier';
import { resolveAcceptanceCriteria } from '../../../services/agents/verification/acceptance-self-check';
import { readWorkflowFile } from '../../../services/workflow/workflow-file-utils';
import { resolvePreferredBaseBranch } from '../../../services/task/task-resolver';
import { runGitCommand } from '../../../services/github/git-exec';

const log = createLogger('routes:workflow:self-verification');

/** Tasks with a verification currently running — one at a time per task. */
const inFlight = new Set<number>();

/** Successful run-verification response shape, cached per task. */
interface CachedVerificationResponse {
  success: true;
  ok: boolean;
  summary: unknown;
  markdown: string;
}

/** One task's most recent cached result, keyed by verification identity. */
interface CachedVerificationEntry {
  key: string;
  at: number;
  response: CachedVerificationResponse;
}

/**
 * Cached results, one per task. A client that disconnects mid-run (the
 * runtime-smoke stage alone can take ~130s) used to force a full re-run on
 * its next request even though nothing had changed — this lets an identical
 * verification identity return the already-measured result instead of
 * re-paying the whole gate.
 */
const resultCache = new Map<number, CachedVerificationEntry>();

/** How long a cached result stays valid. Overridable for tests/tuning. */
const CACHE_TTL_MS = Number(process.env.RAPITAS_SELFVERIFY_CACHE_TTL_MS) || 5 * 60 * 1000;

/** Default cap on total untracked-file bytes hashed into the cache key. */
const DEFAULT_MAX_UNTRACKED_BYTES = 32 * 1024 * 1024;
/** Default cap on the number of untracked files hashed into the cache key. */
const DEFAULT_MAX_UNTRACKED_FILES = 500;

/** Everything that determines whether a prior gate result is still valid. */
export interface VerificationCacheInputs {
  worktreePath: string;
  planContent?: string;
  acceptanceCriteria?: string[];
  requireTests: boolean;
  preferredBaseBranch?: string | null;
  taskText?: string;
}

/**
 * Derive a cache key from the worktree's actual content (not just its git
 * status codes) plus every input that feeds the gate, so a cached result can
 * only be reused when nothing an implementer could have changed has changed.
 *
 * `git status --porcelain` alone is unsafe: it reports change TYPE (`M`/`??`)
 * but never content, so re-editing an already-dirty tracked file to a
 * DIFFERENT value keeps producing the identical status line and therefore an
 * identical (wrong) key (task 897 supervisor repro: same `M app.txt` line
 * across two edits with different SHA256 content). `git diff HEAD` instead
 * emits the tracked working-tree's actual diff against HEAD — content-bearing
 * and provably distinct per edit — and untracked files (invisible to `diff`)
 * are separately enumerated and content-hashed.
 *
 * Untracked files are folded into the key as a `JSON.stringify`d
 * `[relPath, sha256hex]` array — NOT as raw `relPath + NUL + content + NUL`
 * concatenation. The naive delimiter scheme is ambiguous: a single untracked
 * file `a` containing the bytes `x\0b\0y` produces the exact same byte stream
 * as two untracked files `a='x'` and `b='y'` (both reduce to `a\0x\0b\0y\0`),
 * so they collided on an identical key (task 897 supervisor repro,
 * reconfirmed here against this file's own prior implementation: both states
 * hashed to `c8d9a2ee...`). Digesting each file's content to a fixed-length
 * hex string FIRST, then only ever concatenating path/digest pairs (never raw
 * content) into the framing, removes the ambiguity — no digest can itself
 * contain the array/string delimiters `JSON.stringify` uses.
 *
 * @param inputs - Worktree path plus every verification-affecting input
 *   (plan/acceptance/requireTests/base branch/task text). / 検証に影響する入力一式
 * @returns A sha256 hex digest identity, or null when a robust identity
 *          cannot be guaranteed (git unavailable, untracked read/stat
 *          failure, an untracked symlink, or content exceeding the
 *          safety-valve caps) — callers must treat null as "do not cache
 *          this request" rather than falling back to a weaker key. /
 *          取得不能時は null（キャッシュ回避）
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
 * identity. Called twice per request — before and after the gate runs — so
 * that a plan/task/acceptance-criteria edit made WHILE verification was in
 * flight (which can take minutes) is reflected in `keyAfter` and correctly
 * invalidates the cache write, not just an in-memory worktree re-hash of
 * variables captured before the run started.
 *
 * @param taskId - Task whose plan/acceptance/base branch to load. / 対象タスクID
 * @param worktreePath - Task's agent worktree. / worktreeパス
 * @returns Cache-identity inputs (also reused to build the gate's options). / 検証入力一式
 */
async function buildCacheInputs(
  taskId: number,
  worktreePath: string,
): Promise<VerificationCacheInputs> {
  const [planContent, preferredBaseBranch, taskRow] = await Promise.all([
    readWorkflowFile(taskId, 'plan'),
    resolvePreferredBaseBranch(taskId),
    // Fail-open: a missing task row just skips both requireTests-forcing and
    // acceptance criteria (see the original single-read version's comment).
    prisma.task
      .findUnique({
        where: { id: taskId },
        select: { title: true, description: true, acceptanceCriteria: true },
      })
      .catch(() => null),
  ]);
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

/** Minimal Elysia context shape this handler needs. */
interface RunVerificationContext {
  params: { taskId: string };
  set: { status?: number | string };
}

/**
 * Run the automated verification gate on the task's agent worktree and return
 * the measured result. Does not mutate workflow state.
 *
 * @param ctx - Elysia handler context. / Elysiaハンドラコンテキスト
 * @returns Measured gate result, or an error payload. / 実測結果またはエラー
 */
export async function handleRunVerification(ctx: RunVerificationContext) {
  const taskId = parseInt(ctx.params.taskId);
  if (!Number.isFinite(taskId)) {
    ctx.set.status = 400;
    return { success: false, error: 'invalid taskId' };
  }
  if (inFlight.has(taskId)) {
    ctx.set.status = 429;
    return {
      success: false,
      error: '検証は既に実行中です。完了を待ってから再実行してください。',
    };
  }

  // Reserved synchronously, before the first await, so two requests that
  // both pass the `inFlight.has` check above cannot both proceed — the prior
  // version added this AFTER the session lookup's await, leaving a window
  // where concurrent requests could both be admitted (task 897 supervisor
  // finding). Every exit path below is inside this try/finally so the slot
  // is always released, including the 404 (no worktree) early return.
  inFlight.add(taskId);
  try {
    const session = await prisma.agentSession
      .findFirst({
        where: { config: { taskId }, worktreePath: { not: null } },
        // Same tie-break as the verifier context: newest session, id as tiebreaker.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { worktreePath: true },
      })
      .catch(() => null);
    if (!session?.worktreePath) {
      ctx.set.status = 404;
      return {
        success: false,
        error: 'このタスクの worktree が見つかりません（エージェント実行前は検証できません）。',
      };
    }

    const cacheInputsBefore = await buildCacheInputs(taskId, session.worktreePath);
    const verificationOptions = {
      planContent: cacheInputsBefore.planContent,
      preferredBaseBranch: cacheInputsBefore.preferredBaseBranch,
      taskId,
      requireTests: cacheInputsBefore.requireTests,
      acceptanceCriteria: cacheInputsBefore.acceptanceCriteria,
      taskText: cacheInputsBefore.taskText,
    };

    const keyBefore = await computeVerificationCacheKey(cacheInputsBefore);
    if (keyBefore) {
      const cached = resultCache.get(taskId);
      if (cached && cached.key === keyBefore && Date.now() - cached.at < CACHE_TTL_MS) {
        log.info(
          { taskId, ageMs: Date.now() - cached.at },
          '[self-verification] returning cached result — verification identity unchanged',
        );
        return { ...cached.response, cached: true };
      }
    }

    const result = await runAutomatedVerification(session.worktreePath, verificationOptions);
    log.info(
      { taskId, ok: result.ok, checks: result.checks.length },
      '[self-verification] gate run complete',
    );
    const response: CachedVerificationResponse = {
      success: true,
      ok: result.ok,
      summary: result.summary,
      markdown: renderVerificationMarkdown(result),
    };

    // Re-derived AFTER the gate ran (which can take minutes — the
    // runtime-smoke stage alone is ~130s) so an edit made WHILE verification
    // was running invalidates the result instead of caching a now-stale
    // pass. Re-fetched from the DB/workflow-file store, not just re-hashing
    // the SAME in-memory `cacheInputsBefore` object — a plan.md/acceptance
    // criteria/base-branch change mid-run would otherwise go undetected since
    // those variables never change on their own (task 897 supervisor
    // finding: rehashing unchanged in-memory values cannot detect concurrent
    // DB-side input changes).
    const cacheInputsAfter = await buildCacheInputs(taskId, session.worktreePath);
    const keyAfter = await computeVerificationCacheKey(cacheInputsAfter);
    if (keyBefore && keyBefore === keyAfter) {
      resultCache.set(taskId, { key: keyBefore, at: Date.now(), response });
    } else {
      log.warn(
        { taskId, hadKeyBefore: !!keyBefore, hadKeyAfter: !!keyAfter },
        '[self-verification] worktree/identity changed during verification (or identity unavailable) — result not cached',
      );
    }
    return { ...response, cached: false };
  } catch (err) {
    log.warn({ err, taskId }, '[self-verification] gate run failed');
    ctx.set.status = 500;
    return {
      success: false,
      error: `検証の実行に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    inFlight.delete(taskId);
  }
}
