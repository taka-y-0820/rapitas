/**
 * schema-change-gate
 *
 * Deterministic HARD gate that fails verification when a diff touches
 * `prisma/schema/*.prisma` without the plan declaring it. Task 883 showed an
 * implementer changing a Prisma schema inside a worktree in violation of the
 * target repository's AGENTS.md — the existing `scope` check is ADVISORY
 * (task 298 demotion) and does not stop completion on its own. This gate is
 * NOT excluded from computeOverallOk, so an unplanned schema change blocks
 * automated completion regardless of scope's advisory verdict. Not
 * responsible for reading AGENTS.md itself — see workflow-agents-md-context.ts.
 */
import type { VerificationCheck } from './automated-verifier';

/**
 * Matches only source schema files (`prisma/schema/*.prisma`), never the
 * generated `prisma/schema.desktop/` output. Intentionally duplicated from
 * the identical pattern in automated-verifier.ts's `generatedSyncCheck`
 * rather than exported from there, since this file already imports the
 * `VerificationCheck` type FROM automated-verifier.ts — exporting the regex
 * back would create a two-way module dependency. Same pattern as
 * plan-declared-files.ts's PATHISH_RE/DIRISH_RE duplication (see its NOTE).
 */
const PRISMA_SCHEMA_RE = /(^|\/)prisma\/schema\/[^/]+\.prisma$/;

/**
 * Whether a changed protected file is covered by the plan — same part-match
 * semantics as tamperCheck's `planned()` helper (exact / suffix / substring),
 * intentionally kept separate from tamperCheck's own allowlist-augmented plan
 * so a test-path allowance for the tamper threat model never accidentally
 * legitimizes a schema change (see plan.md's design rationale).
 */
function isPlanned(file: string, planFiles: string[]): boolean {
  const f = file.replace(/\\/g, '/').toLowerCase();
  return planFiles.some((p) => {
    const norm = p.replace(/\\/g, '/').toLowerCase();
    return f === norm || f.endsWith(`/${norm}`) || norm.endsWith(`/${f}`) || f.includes(norm);
  });
}

/**
 * Evaluates the schema-change hard gate.
 *
 * @param allChangedFiles - Every changed path in the worktree diff. / 全変更ファイル
 * @param planFiles - Paths parsed from plan.md, or null in plan-less mode. / 計画対象パス（軽量モードはnull）
 * @returns A 'schema-change' check, or null when no schema file changed. / 判定 or null
 */
export function schemaChangeGateCheck(
  allChangedFiles: string[],
  planFiles: string[] | null,
): VerificationCheck | null {
  const norm = allChangedFiles.map((f) => f.replace(/\\/g, '/'));
  const schemaChanged = allChangedFiles.filter((f, i) => PRISMA_SCHEMA_RE.test(norm[i]!));
  if (schemaChanged.length === 0) return null;

  const plan = planFiles ?? [];
  const unplanned = schemaChanged.filter((f) => !isPlanned(f, plan));
  const ok = unplanned.length === 0;
  return {
    name: 'schema-change',
    ran: true,
    ok,
    errorCount: unplanned.length,
    details: ok
      ? `schema-change: ${schemaChanged.length} 件の Prisma スキーマ変更はすべて plan.md に明記済み`
      : `plan.md に明記のない Prisma スキーマ変更を検出しました。worktree 内でのスキーマ変更は ` +
        `AGENTS.md で禁止されている場合があります。正当な変更であれば plan.md の変更予定ファイルに` +
        `このファイルを明記し、承認を得てから再実行してください:\n${unplanned.slice(0, 20).join('\n')}`,
  };
}
