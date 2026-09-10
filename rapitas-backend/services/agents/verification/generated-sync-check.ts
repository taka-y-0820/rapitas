import type { VerificationCheck } from './automated-verifier';

/**
 * Prisma generated-artifact parity check (rapitas repo only). CI hard-fails
 * when `prisma/schema/*.prisma` changes without the regenerated
 * `prisma/schema.desktop/` + `src/generated/sqlite-init-sql.ts` committed —
 * the single biggest "local verify green → CI Lint Code red" cause. Pure
 * file-list logic: it checks that the generated artifacts changed ALONGSIDE
 * the schema, not that their content matches (CI still does that), so it
 * needs no prisma invocation in the worktree.
 *
 * @param allChanged - Every changed path in the worktree diff. / 全変更パス
 * @returns A 'generated-sync' check, or null when no schema changed. / チェック結果
 */
export function generatedSyncCheck(allChanged: string[]): VerificationCheck | null {
  const norm = allChanged.map((f) => f.replace(/\\/g, '/'));
  const schemaChanged = norm.filter((f) => /(^|\/)prisma\/schema\/[^/]+\.prisma$/.test(f));
  if (schemaChanged.length === 0) return null;
  const desktopChanged = norm.some((f) => f.includes('prisma/schema.desktop/'));
  const initSqlChanged = norm.some((f) => f.endsWith('src/generated/sqlite-init-sql.ts'));
  const ok = desktopChanged && initSqlChanged;
  return {
    name: 'generated-sync',
    ran: true,
    ok,
    errorCount: ok ? 0 : 1,
    details: ok
      ? 'generated-sync: schema change ships with regenerated sqlite artifacts'
      : `Prisma スキーマ変更 (${schemaChanged.join(', ')}) に SQLite 生成物の再生成が伴っていません。` +
        ` rapitas-backend で \`bun run db:prepare:sqlite\` を実行し、` +
        `prisma/schema.desktop/ と src/generated/sqlite-init-sql.ts を同じコミットに含めてください（CI がこの同期を hard-fail します）。`,
  };
}
