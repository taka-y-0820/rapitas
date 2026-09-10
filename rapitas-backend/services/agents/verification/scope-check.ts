/**
 * scope-check
 *
 * Mechanically enforces the plan's file scope: compares the agent's FULL git
 * diff against the files listed in plan.md and fails the verification gate on
 * out-of-plan changes. Until now scope was prompt-instructed only ("do not
 * modify files outside the plan") — the most frequently broken constraint.
 * Skips entirely when there is no plan (lightweight mode) or the plan lists no
 * parseable paths (fail-open: a prose-only plan must not block everything).
 * Not responsible for running git or rendering reports.
 */
import type { VerificationCheck } from './automated-verifier';

/** Always-acceptable changes (mechanical side effects of legitimate work). */
const SCOPE_ALLOWLIST = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

/** File-like token: dotted extension at the end (with or without dir segments). */
const PATHISH_RE = /^[\w.@-]+(?:[/\\][\w.@[\]-]+)*\.[A-Za-z]{1,6}$/;
/** Explicit hidden files such as `.gitignore` have no conventional extension. */
const DOTFILE_RE = /^(?:[\w.@[\]-]+[/\\])*\.[\w-]+(?:\.[\w-]+)*$/;
/** Directory-like token: one or more path segments ending in a slash. */
const DIRISH_RE = /^[\w.@-]+(?:[/\\][\w.@-]+)*[/\\]$/;

/**
 * Extracts the file paths AND directory prefixes a plan.md references, used to
 * decide which changed files are "in scope". Plans phrase paths loosely, so we
 * accept three shapes from backtick-quoted tokens (the mandated format):
 *   - a bare path token (`path/to/file.ts`, `TaskCard.tsx`, optional `:line`);
 *   - a directory token (`services/memory/`) — a deliberate scope declaration;
 *   - a path EMBEDDED in a command/sentence token (`bun test a/b/file.ts`) —
 *     only sub-tokens that contain a separator are taken, so prose like
 *     `foo bar.ts` is NOT mistaken for a path.
 * The PARENT directory of every captured file is added too: plans routinely
 * name only a representative file (or its test) for a directory they intend to
 * edit. Directory granularity is intentional (see scope-check header). Pure and
 * unit-testable.
 *
 * @param planContent - plan.md text / plan.md の内容
 * @returns Unique normalized (forward-slash) paths + directory prefixes / 正規化済みパス・ディレクトリ一覧
 */
export function parsePlanFiles(planContent: string): string[] {
  const out = new Set<string>();
  const consider = (piece: string, requireSeparator: boolean): void => {
    const token = piece
      .trim()
      .replace(/:(\d+)(:\d+)?$/, '')
      .replace(/\\/g, '/');
    if (!token) return;
    if (requireSeparator && !token.includes('/')) return;
    if (PATHISH_RE.test(token) || DOTFILE_RE.test(token)) {
      out.add(token);
      const slash = token.lastIndexOf('/');
      if (slash > 0) out.add(token.slice(0, slash + 1)); // parent dir (keep trailing '/')
    } else if (DIRISH_RE.test(token)) {
      out.add(token);
    }
  };
  for (const m of planContent.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    if (/\s/.test(raw)) {
      // Multi-word token (command/sentence): only take separator-bearing pieces
      // so a prose bare filename (`foo bar.ts` → "bar.ts") is not captured.
      for (const piece of raw.split(/\s+/)) consider(piece, true);
    } else {
      consider(raw, false);
    }
  }
  return [...out];
}

/**
 * Whether a changed file is covered by the plan's scope (files + directories).
 * Plans write paths at varying depths (repo-relative vs package-relative), so a
 * changed file matches when it: lives under a plan DIRECTORY prefix (entry
 * ending in `/`); equals a plan path; ends with `/<plan path>`; or — for
 * bare-filename plan tokens — shares the basename.
 */
function isInPlan(changedFile: string, planFiles: string[]): boolean {
  const changed = changedFile.replace(/\\/g, '/');
  const changedBase = changed.split('/').pop() ?? changed;
  // Segment-safe containment helper for directory prefixes.
  const underDir = `/${changed}`;
  for (const plan of planFiles) {
    if (plan.endsWith('/')) {
      const dir = plan.replace(/\/+$/, '');
      if (dir && underDir.includes(`/${dir}/`)) return true;
      continue;
    }
    if (changed === plan) return true;
    if (plan.includes('/')) {
      if (changed.endsWith(`/${plan}`) || plan.endsWith(`/${changed}`)) return true;
    } else if (changedBase === plan) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates the out-of-plan check.
 *
 * @param allChangedFiles - EVERY changed path in the worktree (code or not) / 全変更ファイル
 * @param planFiles - Paths parsed from plan.md / plan.md記載のパス
 * @returns A check result, or null when not applicable (no plan paths) / 判定結果
 */
export function evaluateScopeCheck(
  allChangedFiles: string[],
  planFiles: string[],
): VerificationCheck | null {
  if (planFiles.length === 0) return null;

  const offending = allChangedFiles.filter((f) => {
    const base = f.replace(/\\/g, '/').split('/').pop() ?? f;
    if (SCOPE_ALLOWLIST.has(base)) return false;
    return !isInPlan(f, planFiles);
  });

  if (offending.length === 0) {
    return {
      name: 'scope',
      ran: true,
      ok: true,
      errorCount: 0,
      details: 'scope: all changes are within the plan',
    };
  }
  return {
    name: 'scope',
    ran: true,
    ok: false,
    errorCount: offending.length,
    details:
      `plan.md に記載のないファイルが変更されています（計画外変更）。` +
      `該当ファイルを revert するか、計画の意図に含まれるなら plan.md に追記してください:\n` +
      offending.slice(0, 40).join('\n'),
    // Structured list for the history-contamination classifier — capped like
    // `details` so downstream `git log` fan-out stays bounded.
    offendingFiles: offending.slice(0, 40),
  };
}
