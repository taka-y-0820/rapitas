#!/usr/bin/env bun
/**
 * shuffle-test.ts
 *
 * Shuffles the CI gate suite (scripts/ci-gate-tests.txt) with a seeded PRNG
 * and runs `bun test <files...>` to surface test order dependencies in the
 * SUPPORTED suite. Scoping to the gate manifest is deliberate: shuffling the
 * whole corpus made this job assert "every test file passes on Linux" — a
 * different (and unmet) claim that kept the job permanently red for reasons
 * unrelated to ordering; whole-corpus health lives in the advisory full
 * suite. Pass --all for the old exploratory whole-corpus shuffle (excluding
 * DB-dependent integration tests).
 *
 * Environment variables:
 *   TEST_SHUFFLE_SEED  Optional integer seed. Defaults to DEFAULT_SEED.
 *                      Supply the logged seed on failure to reproduce the same order.
 *
 * Usage:
 *   bun scripts/shuffle-test.ts            # gate manifest (CI mode)
 *   bun scripts/shuffle-test.ts --all      # whole corpus (exploratory)
 *   TEST_SHUFFLE_SEED=42 bun scripts/shuffle-test.ts
 */

import { readFileSync } from 'fs';
import { Glob } from 'bun';
import { relative, resolve } from 'path';
import { parseGateManifest, validateManifestFiles } from './gate-manifest-parser';

/** Fixed fallback seed used when TEST_SHUFFLE_SEED is not set. */
const DEFAULT_SEED = 20250101;

/**
 * Matches paths that belong to integration tests (DB-dependent, excluded from
 * shuffle), plus playwright-worker-client.test.ts — it spawns a real system
 * browser (msedge/chrome) and there is no browser-install step in the
 * `test-full-advisory` CI job, so it always fails there (task #869). See that
 * file's own header NOTE for the full rationale.
 */
export const INTEGRATION_EXCLUDE_PATTERN =
  /[/\\]tests[/\\]integration[/\\]|[/\\]runtime-smoke[/\\]playwright-worker-client\.test\.ts$/;

/**
 * Creates a Linear Congruential Generator (LCG) seeded PRNG.
 * Parameters from Numerical Recipes: a=1664525, c=1013904223, m=2^32.
 *
 * @param seed - Integer seed value / 初期シード値
 * @returns Function returning uniformly distributed floats in [0, 1)
 */
export function createLcgPrng(seed: number): () => number {
  // Coerce to unsigned 32-bit integer to keep state in range.
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Shuffles a copy of the array using the Fisher-Yates algorithm with the provided PRNG.
 *
 * @param arr - Source array to shuffle / シャッフル元配列（変更しない）
 * @param prng - Seeded PRNG returning floats in [0, 1) / シード付き乱数生成関数
 * @returns New shuffled array; the original is not mutated
 */
export function shuffleArray<T>(arr: readonly T[], prng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

/**
 * Removes entries whose path matches the given exclusion pattern.
 *
 * @param files - File path list to filter / フィルタ対象のファイルパスリスト
 * @param excludePattern - Regex for paths to remove / 除外するパスのパターン
 * @returns Filtered list with matching paths removed
 */
export function filterExcluded(files: string[], excludePattern: RegExp): string[] {
  return files.filter((f) => !excludePattern.test(f));
}

/**
 * Parses a seed integer from a raw string, falling back to DEFAULT_SEED on invalid input.
 *
 * @param raw - Raw string from environment variable, or undefined / 環境変数の生の文字列
 * @returns Parsed integer seed value
 */
export function parseSeed(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_SEED;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SEED;
}

/**
 * Globs all `*.test.ts` files under the backend root, excluding node_modules
 * and paths matching INTEGRATION_EXCLUDE_PATTERN.
 *
 * @param root - Absolute path to the backend root directory / バックエンドルートの絶対パス
 * @returns Sorted list of absolute file paths ready for shuffling
 */
export async function collectTestFiles(root: string): Promise<string[]> {
  const glob = new Glob('**/*.test.ts');
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: root, absolute: true })) {
    if (!file.includes('node_modules')) {
      files.push(file);
    }
  }
  // Sort before shuffling so the baseline is always deterministic.
  files.sort();
  return filterExcluded(files, INTEGRATION_EXCLUDE_PATTERN);
}

/**
 * Loads the CI gate manifest as absolute paths, failing loudly on drift so a
 * renamed/deleted gate file can't silently shrink the shuffled set.
 *
 * @param root - Backend root directory / バックエンドルート
 * @returns Absolute test file paths from the manifest
 */
function collectGateManifestFiles(root: string): string[] {
  const manifestPath = resolve(root, 'scripts', 'ci-gate-tests.txt');
  const entries = parseGateManifest(readFileSync(manifestPath, 'utf-8'));
  const missing = validateManifestFiles(entries, root);
  if (missing.length > 0) {
    console.error('[shuffle-test] Gate manifest lists missing files:');
    for (const m of missing) console.error(`  ${m}`);
    process.exit(1);
  }
  return entries.map((f) => resolve(root, f));
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, '..');
  const seed = parseSeed(process.env.TEST_SHUFFLE_SEED);
  const allMode = process.argv.includes('--all');

  const files = allMode ? await collectTestFiles(root) : collectGateManifestFiles(root);
  console.log(`[shuffle-test] scope: ${allMode ? 'whole corpus (--all)' : 'CI gate manifest'}`);

  if (files.length === 0) {
    console.warn('[shuffle-test] No test files found — exiting with success.');
    process.exit(0);
  }

  const prng = createLcgPrng(seed);
  const shuffled = shuffleArray(files, prng);

  console.log(`[shuffle-test] seed=${seed} files=${shuffled.length}`);
  console.log('[shuffle-test] First 5 files in shuffled order:');
  shuffled.slice(0, 5).forEach((f) => console.log(`  ${f}`));
  console.log('[shuffle-test] (Pass TEST_SHUFFLE_SEED=' + seed + ' to reproduce this order)\n');
  console.log('[shuffle-test] Running bun test in shuffled order...\n');

  // Relative paths keep argv small; on Windows the ~32k command-line limit
  // still can't fit ~700 paths in one spawn (ENAMETOOLONG), so batch there.
  // Linux/CI keeps the single spawn — maximum cross-file interaction surface.
  const relFiles = shuffled.map((f) => relative(root, f));
  const batches = process.platform === 'win32' ? chunkByArgLength(relFiles, 25_000) : [relFiles];
  if (batches.length > 1) {
    console.log(`[shuffle-test] Windows argv limit — running in ${batches.length} batches.\n`);
  }

  let exitCode = 0;
  for (const batch of batches) {
    const proc = Bun.spawn(['bun', 'test', '--isolate', ...batch], {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env },
    });
    const code = await proc.exited;
    // Keep running the remaining batches — a full failure list beats a
    // fail-fast partial one for an order-dependency hunt.
    if (code !== 0) exitCode = code;
  }
  process.exit(exitCode);
}

/**
 * Splits paths into batches whose joined argv length stays under the cap.
 *
 * @param files - Paths to batch / 分割対象のパス
 * @param maxChars - Max combined characters per batch / バッチあたりの上限文字数
 * @returns Ordered batches preserving the input order
 */
export function chunkByArgLength(files: readonly string[], maxChars: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const f of files) {
    if (current.length > 0 && length + f.length + 1 > maxChars) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(f);
    length += f.length + 1;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// NOTE: Guard prevents main() from running when this file is imported by unit tests.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[shuffle-test] Fatal error:', err);
    process.exit(1);
  });
}
