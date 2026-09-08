/**
 * runtime-smoke/runtime-check
 *
 * The Evaluator's "actually run it" stage: when a project opts in via
 * rapitas.runtime.json, start the app on a free port, drive it in a real
 * browser, and turn hard failures (won't start / uncaught page errors /
 * 5xx) into a failing VerificationCheck — which the existing verify-repair
 * loop bounces back to the implementer. Console errors are advisory only
 * (dev builds are noisy). Missing browser tooling leaves runtime verification incomplete.
 */
import { createLogger } from '../../../../config/logger';
import type { VerificationCheck } from '../automated-verifier';
import { resolveRuntimeConfig, substitutePort } from './runtime-config';
import { allocateFreePort, launchApp, waitForHealthy } from './app-launcher';
import { runBrowserSmoke, type SmokeRunResult } from './browser-smoke';

const log = createLogger('runtime-smoke');

/**
 * Launch-log signatures that mean the WORKTREE ENVIRONMENT is broken — not
 * the code under test. A backend-only change cannot fix "Turbopack rejects
 * the frontend node_modules symlink", so failing the gate on it sends the
 * implementer into an unfixable verify-repair loop (task 536: two wasted
 * repair cycles on an identical environmental failure). These fail OPEN,
 * matching the module's stated tooling-absence philosophy.
 */
export const ENV_FAILURE_RE =
  /points out of the filesystem root|TurbopackInternalError|Cannot find module '.*node_modules|ENOENT.*node_modules|EPERM.*node_modules|command not found|は、内部コマンドまたは外部コマンド/i;

/**
 * Recent environment failures per workdir. An environment failure is a
 * property of the WORKTREE, not of the change under test — once observed, it
 * will reproduce identically on every retry until someone repairs the
 * worktree. Without this cache, every verification pass in the completion
 * pipeline (implementer self-verify retries, verifier ground truth,
 * completion gate) re-paid the full launch timeout (~2 min each) before
 * reaching the same skip verdict — observed stretching task 537's completion
 * pipeline by tens of minutes.
 */
const recentEnvFailures = new Map<string, number>();
const ENV_FAILURE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Whether the launch logs show an environment/setup failure rather than an
 * app defect. Pure — exported for tests.
 *
 * @param logs - Captured launch output lines. / 起動ログ
 * @returns True when the failure is environmental. / 環境起因ならtrue
 */
export function looksLikeEnvironmentFailure(logs: string[]): boolean {
  return ENV_FAILURE_RE.test(logs.join('\n'));
}

/**
 * Normalize a `localhost` health/browse URL to `127.0.0.1`. Windows can
 * resolve `localhost` to the IPv6 loopback (`::1`) while the launched dev
 * server binds only IPv4, producing a connection failure that looks
 * identical to "app never started" in the logs. Pure — exported for tests.
 *
 * @param url - Candidate URL. / 対象URL
 * @returns The same URL with a `localhost` host replaced by `127.0.0.1`;
 *          any other host (including already-IP or external hosts) is
 *          returned unchanged. / 変換後URL
 */
export function normalizeLocalHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Pure verdict over smoke findings — the testable core.
 *
 * @param smoke - Browser pass result / ブラウザ確認の結果
 * @returns ok / errorCount / evidence lines / 判定結果
 */
export function evaluateSmokeFindings(smoke: SmokeRunResult): {
  ok: boolean;
  errorCount: number;
  lines: string[];
} {
  const lines: string[] = [];
  let errorCount = 0;
  for (const f of smoke.findings) {
    if (f.navigationError) {
      errorCount++;
      lines.push(`✗ ${f.path}: ページを開けない — ${f.navigationError}`);
      continue;
    }
    const hard = f.pageErrors.length + f.serverErrors.length;
    if (hard > 0) {
      errorCount += hard;
      lines.push(`✗ ${f.path}: HTTP ${f.httpStatus}`);
      for (const e of f.pageErrors.slice(0, 3)) lines.push(`    pageerror: ${e}`);
      for (const e of f.serverErrors.slice(0, 3)) lines.push(`    server: ${e}`);
    } else {
      lines.push(`✓ ${f.path}: HTTP ${f.httpStatus}`);
    }
    if (f.consoleErrors.length > 0) {
      lines.push(`    (console.error ×${f.consoleErrors.length} — 参考情報、ブロックしません)`);
    }
    if (f.screenshotPath) lines.push(`    screenshot: ${f.screenshotPath}`);
  }
  return { ok: errorCount === 0, errorCount, lines };
}

/**
 * Run the runtime smoke check for a worktree.
 *
 * @param workdir - Agent worktree root / worktree ルート
 * @param label - Artifact label, e.g. `task-123` / 成果物ラベル
 * @param taskId - Task whose Theme's runtimeConfigJson to prefer over a
 *   rapitas.runtime.json file, if set. / 対象タスクID
 * @returns A 'runtime' VerificationCheck, or null when the project has no
 *          runtime config or the feature is disabled / 対象外なら null
 */
export async function runRuntimeSmokeCheck(
  workdir: string,
  label = 'adhoc',
  taskId?: number,
): Promise<VerificationCheck | null> {
  if (process.env.RAPITAS_RUNTIME_VERIFY === '0') return null;

  const loaded = await resolveRuntimeConfig({ workdir, taskId });
  if (loaded === null) return null; // not opted in
  if (loaded.error || !loaded.config) {
    // A broken config is a REAL failure the implementer can fix.
    return {
      name: 'runtime',
      ran: true,
      ok: false,
      errorCount: 1,
      details: `runtime設定が不正です: ${loaded.error}`,
    };
  }
  const cfg = loaded.config;

  // Short-circuit: this worktree recently failed to launch for ENVIRONMENT
  // reasons — relaunching within the TTL just burns the full ready-timeout to
  // reach the identical skip verdict.
  const envFailedAt = recentEnvFailures.get(workdir);
  if (envFailedAt && Date.now() - envFailedAt < ENV_FAILURE_CACHE_TTL_MS) {
    log.info(
      { workdir, label, ageSec: Math.round((Date.now() - envFailedAt) / 1000) },
      '[runtime-smoke] recent environment failure cached — skipping without relaunch',
    );
    return {
      name: 'runtime',
      ran: false,
      ok: false,
      unverifiable: true,
      errorCount: 0,
      details:
        'runtime検証はスキップしました（この worktree は直近で環境起因の起動失敗を記録済み — 再起動試行は同一結果になるため省略）。',
    };
  }

  const port = await allocateFreePort();
  const baseUrl = normalizeLocalHost(substitutePort(cfg.url, port));
  const app = launchApp(substitutePort(cfg.start, port), workdir, port);
  try {
    const healthy = await waitForHealthy(
      `${baseUrl}${cfg.healthPath}`,
      cfg.readyTimeoutMs,
      { label },
      () => app.hasExited(),
    );
    if (!healthy) {
      const logs = app.logs();
      const tail = logs.slice(-25).join('\n');
      const exitNote = app.hasExited()
        ? `（プロセスは exitCode=${app.exitCode()} で終了済み）`
        : '';
      // Environment failures (broken worktree symlinks, missing tooling) are
      // not fixable by the implementer — hold as unverifiable with evidence instead
      // of bouncing the phase into an unfixable repair loop.
      if (looksLikeEnvironmentFailure(logs)) {
        recentEnvFailures.set(workdir, Date.now());
        log.warn(
          { workdir, label, exitCode: app.exitCode() },
          '[runtime-smoke] launch failed with an ENVIRONMENT signature — unverifiable; completion withheld',
        );
        return {
          name: 'runtime',
          ran: false,
          ok: false,
          unverifiable: true,
          errorCount: 0,
          details:
            `runtime検証は環境起因の起動失敗のためスキップしました（worktreeセットアップ問題 — 実装の欠陥ではありません）${exitNote}。` +
            `\n--- 起動ログ末尾 ---\n${tail}`,
        };
      }
      return {
        name: 'runtime',
        ran: true,
        ok: false,
        errorCount: 1,
        details:
          `アプリが ${cfg.readyTimeoutMs / 1000}s 以内に起動しませんでした ` +
          `(${baseUrl}${cfg.healthPath} 無応答)${exitNote}。\n--- 起動ログ末尾 ---\n${tail}`,
      };
    }

    const smoke = await runBrowserSmoke(baseUrl, cfg.checkPaths, label);
    if (!smoke.browserAvailable) {
      // HTTP readiness alone does not prove the configured browser checks.
      return {
        name: 'runtime',
        ran: false,
        ok: false,
        unverifiable: true,
        errorCount: 0,
        details: `起動確認のみ成功 (HTTP応答あり)。ブラウザ確認はスキップ: ${smoke.unavailableReason}`,
      };
    }

    const verdict = evaluateSmokeFindings(smoke);
    return {
      name: 'runtime',
      ran: true,
      ok: verdict.ok,
      errorCount: verdict.errorCount,
      details: verdict.lines.join('\n'),
    };
  } catch (err) {
    // Harness crash (not app failure) — fail open, never block on our own bug.
    log.warn({ err, workdir }, '[runtime-smoke] harness error — unverifiable; completion withheld');
    return {
      name: 'runtime',
      ran: false,
      ok: false,
      unverifiable: true,
      errorCount: 0,
      details: `runtime検証ハーネスの内部エラーによりスキップ: ${err instanceof Error ? err.message : err}`,
    };
  } finally {
    app.stop();
  }
}
