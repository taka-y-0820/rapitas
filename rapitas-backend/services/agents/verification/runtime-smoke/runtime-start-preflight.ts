/** Detect missing package scripts before a runtime process can be launched. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Recognizes only a simple package-manager command, optionally after `cd`.
 * Other shell syntax remains the launcher's responsibility; this is not a
 * command validator and must not reinterpret complex shell commands.
 */
const SIMPLE_RUN_SCRIPT_RE =
  /^\s*(?:cd\s+([\w./\\-]+)\s*&&\s*)?(?:npm|pnpm|bun)\s+run\s+([\w:.-]+)(?:\s+--\s+[^;&|\r\n]*)?\s*$/;

/**
 * Extract the package directory and script name from a simple
 * `[cd <dir> &&] <pm> run <script> [-- …]` start command.
 *
 * @param command - Runtime start command / 起動コマンド
 * @returns The package dir (relative) and script, or null for other syntax / 解析結果
 */
export function parseRuntimeStartScript(command: string): { dir: string; script: string } | null {
  const match = command.match(SIMPLE_RUN_SCRIPT_RE);
  if (!match) return null;
  return { dir: match[1] ?? '.', script: match[2] };
}

/**
 * Whether `dir/package.json` under `root` defines the start script.
 *
 * @param command - Runtime start command / 起動コマンド
 * @param root - Directory the command runs in / 実行ディレクトリ
 * @returns true/false, or null when the command is not a simple script or the
 *   manifest is unreadable / 判定不能なら null
 */
export async function hasRuntimeStartScript(
  command: string,
  root: string,
): Promise<boolean | null> {
  const parsed = parseRuntimeStartScript(command);
  if (!parsed) return null;
  const manifest = resolve(root, parsed.dir, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(manifest, 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    const script = pkg?.scripts?.[parsed.script];
    return typeof script === 'string' && script.trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * Harness drift: the worktree predates the runtime script the theme's main
 * checkout now ships. Verification cannot run there and the implementer
 * cannot fix it (the script arrives with the pre-PR base sync), so failing or
 * holding the gate only deadlocks the task — 2026-09-13, tasks 901 and 905
 * (branches 178 commits behind develop, no `dev:runtime`) were blocked at
 * "runtime=UNVERIFIED" on every completion attempt.
 *
 * @param command - Runtime start command / 起動コマンド
 * @param workdir - Task worktree / 対象 worktree
 * @param baseDir - The theme's main checkout, or null when unknown / 主チェックアウト
 * @returns A human-readable reason when the worktree lacks a script the base
 *   has; null otherwise / ドリフト理由
 */
export async function detectRuntimeHarnessDrift(
  command: string,
  workdir: string,
  baseDir: string | null,
): Promise<string | null> {
  if (!baseDir || resolve(baseDir) === resolve(workdir)) return null;
  const parsed = parseRuntimeStartScript(command);
  if (!parsed) return null;
  const inWorktree = await hasRuntimeStartScript(command, workdir);
  if (inWorktree !== false) return null;
  const inBase = await hasRuntimeStartScript(command, baseDir);
  if (inBase !== true) return null;
  return (
    `runtime検証は対象外（ハーネス差分）: この worktree の ${parsed.dir}/package.json に ` +
    `script "${parsed.script}" がありませんが、テーマの主チェックアウト (${baseDir}) には存在します。` +
    'ブランチがランタイム検証ハーネスより古いため、PR 作成前の base 同期後に再検証されます。'
  );
}

/**
 * Throw when the start command names a script the worktree does not define.
 *
 * @param command - Runtime start command / 起動コマンド
 * @param workdir - Directory the command runs in / 実行ディレクトリ
 * @throws {Error} When the manifest is unreadable or the script is missing / 未定義時
 */
export async function checkRuntimeStartScript(command: string, workdir: string): Promise<void> {
  const parsed = parseRuntimeStartScript(command);
  if (!parsed) return;
  const manifest = resolve(workdir, parsed.dir, 'package.json');
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(await readFile(manifest, 'utf8'));
  } catch (error) {
    throw new Error(`Runtime start preflight: cannot read ${manifest}`, { cause: error });
  }
  const script = pkg?.scripts?.[parsed.script];
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error(
      `Runtime start preflight: missing script "${parsed.script}" in ${manifest}. Sync the worktree or correct its runtime configuration before retrying.`,
    );
  }
}
