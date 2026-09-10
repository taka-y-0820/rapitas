/** Detect missing package scripts before a runtime process can be launched. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Recognizes only a simple package-manager command, optionally after `cd`.
 * Other shell syntax remains the launcher's responsibility; this is not a
 * command validator and must not reinterpret complex shell commands.
 */
export async function checkRuntimeStartScript(command: string, workdir: string): Promise<void> {
  const match = command.match(
    /^\s*(?:cd\s+([\w./\\-]+)\s*&&\s*)?(?:npm|pnpm|bun)\s+run\s+([\w:.-]+)(?:\s+--\s+[^;&|\r\n]*)?\s*$/,
  );
  if (!match) return;
  const manifest = resolve(workdir, match[1] ?? '.', 'package.json');
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(await readFile(manifest, 'utf8'));
  } catch (error) {
    throw new Error(`Runtime start preflight: cannot read ${manifest}`, { cause: error });
  }
  const script = pkg?.scripts?.[match[2]];
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error(
      `Runtime start preflight: missing script "${match[2]}" in ${manifest}. Sync the worktree or correct its runtime configuration before retrying.`,
    );
  }
}
