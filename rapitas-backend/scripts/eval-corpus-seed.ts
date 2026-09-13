/**
 * Eval Corpus Seeder
 *
 * Builds the private evaluation corpus: reads completed tasks from the APP
 * database, resolves each one's fix/base commit from git, classifies it, and
 * writes the frozen instance into the EVAL database.
 *
 * Two databases are open at once on purpose, and in a fixed order — the app
 * client is constructed with an explicit URL BEFORE `createEvalPrismaClient()`
 * redirects `DATABASE_URL`, so neither connection can silently become the
 * other.
 *
 * Run: RAPITAS_EVAL_DATABASE_URL=postgresql://.../rapitas_eval \
 *        bun run scripts/eval-corpus-seed.ts [--limit 400] [--reset]
 */
import { resolve } from 'path';
import { resolvePrismaClientCtor } from '../config/prisma-client-resolver';
import { assignSplit, EVAL_CATEGORIES } from '../services/eval-harness/corpus-classifier';
import {
  collectCorpusCandidates,
  createGitPort,
  type CompletedTaskRecord,
} from '../services/eval-harness/corpus-collector';
import {
  createEvalPrismaClient,
  disposeEvalPrismaClient,
} from '../services/eval-harness/eval-prisma-client';

/** Minimum corpus size the task requires; below this the seeder fails loudly. */
const MIN_CORPUS_SIZE = 30;

/** Per-category count below which a warning is printed. */
const MIN_PER_CATEGORY = 6;

/** Default number of completed tasks scanned. */
const DEFAULT_SCAN_LIMIT = 400;

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const scanLimit = Number.parseInt(flag('--limit') ?? String(DEFAULT_SCAN_LIMIT), 10);
const reset = argv.includes('--reset');
const repoDir = resolve(import.meta.dir, '..', '..');

/**
 * Reads completed tasks and their recovery/PR signals from the app database.
 *
 * @returns Completed task records / 完了タスクのレコード
 */
async function readCompletedTasks(): Promise<CompletedTaskRecord[]> {
  const appUrl = process.env.RAPITAS_APP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!appUrl) {
    console.error('[eval-seed] FATAL: DATABASE_URL (the app database) is not set.');
    process.exit(1);
  }

  const PrismaClient = resolvePrismaClientCtor();
  const app = new PrismaClient({ datasourceUrl: appUrl });

  try {
    const tasks = await app.task.findMany({
      where: { status: 'completed' },
      orderBy: { id: 'desc' },
      take: scanLimit,
      select: {
        id: true,
        title: true,
        description: true,
        workflowStatus: true,
        githubPrId: true,
      },
    });

    const taskIds = tasks.map((task) => task.id);
    const recoveries = await app.workflowTransition.findMany({
      where: { taskId: { in: taskIds }, fromStatus: 'blocked', toStatus: 'in_progress' },
      select: { taskId: true },
    });
    const recovered = new Set(recoveries.map((row) => row.taskId));

    const prs = await app.gitHubPullRequest.findMany({
      where: { linkedTaskId: { in: taskIds } },
      select: { linkedTaskId: true, prNumber: true },
    });
    const prByTask = new Map(prs.map((pr) => [pr.linkedTaskId, pr.prNumber]));

    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      workflowStatus: task.workflowStatus,
      prNumber: prByTask.get(task.id) ?? task.githubPrId ?? null,
      hasBlockedRecovery: recovered.has(task.id),
    }));
  } finally {
    await app.$disconnect();
  }
}

/** Seeds the corpus and reports what was accepted and dropped. */
async function main(): Promise<void> {
  const tasks = await readCompletedTasks();
  console.log(`[eval-seed] Scanned ${tasks.length} completed tasks from the app database.`);

  const { accepted, excluded } = await collectCorpusCandidates(tasks, createGitPort(repoDir));
  console.log(`[eval-seed] Resolved ${accepted.length}, excluded ${excluded.length}.`);

  const exclusionCounts = new Map<string, number>();
  for (const item of excluded) {
    exclusionCounts.set(item.reason, (exclusionCounts.get(item.reason) ?? 0) + 1);
  }
  for (const [reason, count] of exclusionCounts) {
    console.log(`[eval-seed]   excluded ${reason}: ${count}`);
  }

  const prisma = createEvalPrismaClient();
  if (reset) {
    const removed = await prisma.evalCorpusTask.deleteMany({});
    console.log(`[eval-seed] --reset removed ${removed.count} existing corpus rows.`);
  }

  let inserted = 0;
  for (const category of EVAL_CATEGORIES) {
    // Sorted by sourceTaskId so the split is reproducible across re-seeds.
    const members = accepted
      .filter((candidate) => candidate.classification.category === category)
      .sort((a, b) => a.sourceTaskId - b.sourceTaskId);

    if (members.length < MIN_PER_CATEGORY) {
      console.warn(
        `[eval-seed] WARNING: category ${category} has only ${members.length} candidates ` +
          `(want >= ${MIN_PER_CATEGORY}).`,
      );
    }

    for (const [index, candidate] of members.entries()) {
      const row = {
        sourceTaskId: candidate.sourceTaskId,
        category,
        split: assignSplit(index),
        classificationConfidence: candidate.classification.confidence,
        classificationMethod: candidate.classification.method,
        baseCommitSha: candidate.baseCommitSha,
        fixCommitSha: candidate.fixCommitSha,
        protectedTestFiles: JSON.stringify(candidate.protectedTestFiles),
        problemStatement: candidate.problemStatement,
        title: candidate.title,
      };
      await prisma.evalCorpusTask.upsert({
        where: { sourceTaskId: candidate.sourceTaskId },
        create: row,
        update: row,
      });
      inserted += 1;
    }

    const evalCount = members.filter((_, index) => assignSplit(index) === 'eval').length;
    console.log(
      `[eval-seed] ${category}: ${members.length} total (${evalCount} eval / ${members.length - evalCount} train)`,
    );
  }

  await disposeEvalPrismaClient();
  console.log(`[eval-seed] Corpus size: ${inserted}`);

  if (inserted < MIN_CORPUS_SIZE) {
    console.error(
      `[eval-seed] FAILED: corpus has ${inserted} rows, below the required ${MIN_CORPUS_SIZE}. ` +
        'Review the exclusion counts above before treating any metric as meaningful.',
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`[eval-seed] FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
