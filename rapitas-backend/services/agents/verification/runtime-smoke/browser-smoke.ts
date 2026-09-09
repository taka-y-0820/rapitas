/**
 * runtime-smoke/browser-smoke
 *
 * Drives the app-under-test in a real browser (via playwright-worker-client,
 * a Node.js child process — see that file's header for why Bun can't do this
 * directly) and collects hard failure signals: uncaught page errors, console
 * errors, 5xx responses, and a screenshot per checked path (saved to the OS
 * temp dir so worktree diffs stay clean). Fails open when no browser is
 * available — tooling absence must not block every task.
 */
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createLogger } from '../../../../config/logger';
import { spawnPlaywrightWorker } from './playwright-worker-client';

const log = createLogger('runtime-smoke:browser');

/** Bounds the launch step — a hung/missing browser channel fails in seconds, not minutes. */
const BROWSER_LAUNCH_TIMEOUT_MS = 20_000;

/** Findings for one checked path. */
export interface PathFinding {
  failedRequests?: string[];
  pendingRequests?: string[];
  path: string;
  /** Main-document HTTP status (0 when navigation itself failed). */
  httpStatus: number;
  navigationError: string | null;
  pageErrors: string[];
  consoleErrors: string[];
  /** URLs that answered >= 500 while the page loaded. */
  serverErrors: string[];
  screenshotPath: string | null;
}

export interface SmokeRunResult {
  /** False when playwright/browser could not run at all (fail-open). */
  browserAvailable: boolean;
  unavailableReason?: string;
  findings: PathFinding[];
}

/** Per-page navigation timeout. */
const NAV_TIMEOUT_MS = 25_000;
/** Post-load settle time so async errors surface. */
const SETTLE_MS = 2_000;

/**
 * Run the browser smoke pass over the given paths.
 *
 * @param baseUrl - App base URL (port-substituted) / アプリのベースURL
 * @param paths - Paths to visit / 確認するパス
 * @param label - Artifact label (e.g. task id) / スクリーンショット名の識別子
 * @returns Structured findings / 構造化された所見
 */
export async function runBrowserSmoke(
  baseUrl: string,
  paths: string[],
  label: string,
  readiness: { readySelector?: string; readinessTimeoutMs?: number } = {},
): Promise<SmokeRunResult> {
  const worker = spawnPlaywrightWorker();

  try {
    await worker.launch({
      channels: ['msedge', 'chrome'],
      timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
      viewport: { width: 1280, height: 800 },
    });
  } catch (e) {
    await worker.close();
    return {
      browserAvailable: false,
      unavailableReason: `no system Edge/Chrome available: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
      findings: [],
    };
  }

  const artifactDir = join(tmpdir(), 'rapitas-runtime-smoke', label);
  await mkdir(artifactDir, { recursive: true }).catch(() => {});

  const findings: PathFinding[] = [];
  try {
    for (const path of paths) {
      const screenshotPath = join(
        artifactDir,
        `${path.replace(/[^a-zA-Z0-9]+/g, '_') || 'root'}.png`,
      );
      try {
        const result = await worker.checkPath({
          url: `${baseUrl}${path}`,
          timeoutMs: NAV_TIMEOUT_MS,
          settleMs: SETTLE_MS,
          ...readiness,
          screenshotPath,
        });
        findings.push({ path, ...result });
      } catch (e) {
        // A worker-level failure (e.g. the command timed out and the worker
        // was killed) — record it as a navigation error for this path rather
        // than losing the whole run; the worker is gone, so stop looping.
        findings.push({
          path,
          httpStatus: 0,
          navigationError: (e instanceof Error ? e.message : String(e)).slice(0, 300),
          pageErrors: [],
          consoleErrors: [],
          serverErrors: [],
          screenshotPath: null,
        });
        break;
      }
    }
  } finally {
    await worker.close();
  }

  log.info(
    { baseUrl, paths: paths.length, errors: findings.filter((f) => f.pageErrors.length).length },
    '[runtime-smoke] browser pass finished',
  );
  return { browserAvailable: true, findings };
}
