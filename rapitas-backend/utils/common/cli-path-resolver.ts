/**
 * cli-path-resolver
 *
 * Async, shared resolution of CLI binary absolute paths on Windows (`where <name>`),
 * with process-lifetime caching and in-flight de-duplication. Not responsible for
 * spawning or supervising the resolved process — see each provider's process-manager.
 */
import { exec } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { createLogger } from '../../config/logger';

const execAsync = promisify(exec);
const logger = createLogger('cli-path-resolver');

/** Elapsed resolution time above which a WARN is logged (see event-loop-lag correlation). */
const SLOW_RESOLVE_WARN_MS = 1000;
/** Matches the previous execSync `timeout` option so behavior is unchanged. */
const WHERE_TIMEOUT_MS = 5000;

// Process-lifetime cache for resolved CLI paths (string only — see inFlight below
// for pending promises). The PATH does not change during a server run, so both
// hits and the fallback are memoized. A restart re-probes naturally.
const cliPathCache = new Map<string, string>();

// De-dups concurrent resolutions of the same cliName so async callers racing at
// startup (multiple providers probing `isAvailable()` at once) trigger a single
// `where` subprocess instead of one per caller.
const inFlight = new Map<string, Promise<string>>();

/** Runs `where <name>` and returns the first existing resolved path, or null. */
async function tryWhere(name: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`where ${name}`, {
      encoding: 'utf8',
      timeout: WHERE_TIMEOUT_MS,
      windowsHide: true,
    });
    const resolved = stdout.trim().split(/\r?\n/)[0];
    return resolved && existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

async function resolveUncached(cliName: string): Promise<string> {
  const startedAt = Date.now();

  // NOTE: npm global bins on Windows are .cmd shims. `where claude` fails when the npm
  // bin directory is not yet in the bun process's PATH (inherited from the parent shell),
  // but `where claude.cmd` succeeds because cmd.exe always resolves shims. Try the bare
  // name first, then fall back to the .cmd shim before giving up.
  const resolved =
    (await tryWhere(cliName)) ??
    (!cliName.endsWith('.cmd') ? await tryWhere(`${cliName}.cmd`) : null);

  const result = resolved ?? cliName;
  if (resolved) {
    logger.info(`[resolveCliPathAsync] Resolved ${cliName} -> ${resolved}`);
  } else {
    // NOTE: Both `where {name}` and `where {name}.cmd` failed. spawn({ shell: true })
    // still works because cmd.exe re-resolves the PATH at execution time.
    logger.warn(`[resolveCliPathAsync] Failed to resolve ${cliName}, using relative path`);
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > SLOW_RESOLVE_WARN_MS) {
    logger.warn({ cliName, elapsedMs }, '[resolveCliPathAsync] slow CLI path resolution');
  }

  return result;
}

/**
 * Resolves the absolute path of a CLI command on Windows.
 * Falls back to the original name if PATH resolution fails.
 * Memoized for the process lifetime; concurrent calls for the same cliName share one `where` run.
 *
 * @param cliName - CLI binary name or path to resolve / 解決するCLIバイナリ名またはパス
 * @returns Absolute path on Windows, original name on other platforms / Windowsでは絶対パス、他のプラットフォームでは元の名前
 */
export async function resolveCliPathAsync(cliName: string): Promise<string> {
  if (process.platform !== 'win32') return cliName;

  const cached = cliPathCache.get(cliName);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(cliName);
  if (pending) return pending;

  const promise = resolveUncached(cliName).finally(() => {
    inFlight.delete(cliName);
  });
  inFlight.set(cliName, promise);

  const result = await promise;
  cliPathCache.set(cliName, result);
  return result;
}

/**
 * Resolves the effective Claude Code CLI path from environment or platform defaults.
 *
 * @returns Resolved absolute or relative CLI path / 解決されたCLIパス
 */
export async function getClaudePathAsync(): Promise<string> {
  const isWindows = process.platform === 'win32';
  const baseClaudePath = process.env.CLAUDE_CODE_PATH || (isWindows ? 'claude.cmd' : 'claude');
  return resolveCliPathAsync(baseClaudePath);
}

/** Clears the resolved-path cache and in-flight map. Test-only. */
export function __resetCliPathCacheForTests(): void {
  cliPathCache.clear();
  inFlight.clear();
}
