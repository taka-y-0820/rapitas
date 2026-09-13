/**
 * recall-yield-comparison
 *
 * Measures event-loop stall during synchronous vs. cooperative lexical-index
 * builds against the real knowledge base, and asserts the two builds produce
 * an identical index. Evidence artifact for task #929.
 *
 * Run from the repo root: `bun .supervisor/measurements/recall-yield-comparison.ts`
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../../rapitas-backend/config/database';
import {
  buildLexicalIndex,
  buildLexicalIndexAsync,
  type LexicalIndex,
  type LexicalRow,
} from '../../rapitas-backend/services/memory/recall/lexical-index';

const TICK_MS = 20;

/** Serialize an index (Map/Int32Array are not directly comparable via JSON.stringify). */
function serializeIndex(index: LexicalIndex): string {
  return JSON.stringify({
    docCount: index.docCount,
    unseenIdf: index.unseenIdf,
    docs: index.docs.map((d) => ({
      id: d.id,
      codes: Array.from(d.codes),
      forgettingStage: d.forgettingStage,
      validationStatus: d.validationStatus,
      themeId: d.themeId,
      category: d.category,
    })),
    idf: Array.from(index.idf.entries()).sort((a, b) => a[0] - b[0]),
  });
}

/** Measure the max event-loop lag (ms beyond the expected tick) while `fn` runs. */
async function measureMaxLag<T>(
  fn: () => Promise<T> | T,
): Promise<{ result: T; maxLagMs: number }> {
  let maxLag = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const delta = now - last;
    maxLag = Math.max(maxLag, delta - TICK_MS);
    last = now;
  }, TICK_MS);
  const result = await fn();
  clearInterval(timer);
  return { result, maxLagMs: Math.max(0, maxLag) };
}

async function main(): Promise<void> {
  const rows: LexicalRow[] = await prisma.knowledgeEntry.findMany({
    where: { validationStatus: { not: 'rejected' } },
    select: {
      id: true,
      title: true,
      content: true,
      forgettingStage: true,
      validationStatus: true,
      themeId: true,
      category: true,
    },
    orderBy: { id: 'asc' },
  });

  const sync = await measureMaxLag(() => buildLexicalIndex(rows));
  const cooperative = await measureMaxLag(() => buildLexicalIndexAsync(rows));

  const identical = serializeIndex(sync.result) === serializeIndex(cooperative.result);

  const report = {
    measuredAt: new Date().toISOString(),
    docs: rows.length,
    tickMs: TICK_MS,
    sync: { maxLagMs: sync.maxLagMs },
    cooperative: { maxLagMs: cooperative.maxLagMs },
    identical,
  };

  writeFileSync(
    new URL('./recall-yield-comparison.json', import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf-8',
  );

  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
