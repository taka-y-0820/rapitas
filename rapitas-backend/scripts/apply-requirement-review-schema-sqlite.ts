import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prefix = '--database=';
const databasePath = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
if (!databasePath) throw new Error(`Missing ${prefix}<path>`);

const sqlPath = resolve(
  import.meta.dir,
  '../prisma/schema-changes/20260911010000_add_requirement_review_claims.sqlite.sql',
);
const sql = readFileSync(sqlPath, 'utf8');
const statements = sql
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);
for (const statement of statements) {
  if (!/^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(statement)) {
    throw new Error(`Refusing non-additive SQLite schema statement: ${statement.slice(0, 80)}`);
  }
}

const db = new Database(resolve(databasePath));
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
const protectedTables = () =>
  db
    .query<SchemaRow, []>(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'RequirementReviewClaim%'
         AND name NOT LIKE 'RequirementReviewRetryRequest%'
       ORDER BY type, name`,
    )
    .all();
const rowCounts = (schema: SchemaRow[]) =>
  Object.fromEntries(
    schema
      .filter((row) => row.type === 'table')
      .map((row) => {
        const quoted = row.name.replace(/"/g, '""');
        const count = db
          .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM "${quoted}"`)
          .get();
        return [row.name, count?.count ?? 0];
      }),
  );

try {
  const schemaBefore = protectedTables();
  const countsBefore = rowCounts(schemaBefore);
  db.transaction(() => db.exec(sql))();
  const schemaAfter = protectedTables();
  const countsAfter = rowCounts(schemaAfter);
  if (JSON.stringify(schemaAfter) !== JSON.stringify(schemaBefore)) {
    throw new Error('An unrelated SQLite schema object changed');
  }
  if (JSON.stringify(countsAfter) !== JSON.stringify(countsBefore)) {
    throw new Error('An unrelated SQLite table row count changed');
  }
  for (const table of ['RequirementReviewClaim', 'RequirementReviewRetryRequest']) {
    const exists = db
      .query<
        { count: number },
        [string]
      >(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table)?.count;
    if (exists !== 1) throw new Error(`Required table was not created: ${table}`);
  }
  console.log(JSON.stringify({ database: resolve(databasePath), preserved: countsBefore }));
} finally {
  db.close();
}
