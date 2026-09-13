/**
 * EvalPrismaClient
 *
 * Builds the ONE Prisma client the eval harness is allowed to use, after
 * `db-guard.ts` has proven the connection string points at a `*_eval`
 * database. Owns nothing else — query logic lives in the collector/runner.
 *
 * NOTE: `config/database.ts` is deliberately NOT imported anywhere in this
 * subsystem. That module builds and exports an app-database `prisma` singleton
 * as a top-level side effect, so importing it would open a connection to the
 * app database inside the very process that is supposed to be isolated from
 * it.
 */
import { applyEvalDatabaseUrl } from './db-guard';

/** A frozen corpus problem instance (mirrors `EvalCorpusTask`). */
export interface EvalCorpusTaskRow {
  id: number;
  sourceTaskId: number;
  category: string;
  split: string;
  classificationConfidence: number;
  classificationMethod: string;
  baseCommitSha: string;
  fixCommitSha: string;
  /** JSON-encoded string array. */
  protectedTestFiles: string;
  problemStatement: string;
  title: string;
}

/** One execution of one corpus task under one scenario (mirrors `EvalRun`). */
export interface EvalRunRow {
  id: number;
  runBatchId: string;
  corpusTaskId: number;
  scenario: string;
  attemptNumber: number;
  outcome: string;
  outcomeReason: string | null;
  failToPass: boolean | null;
  passToPass: boolean | null;
  humanInterventionCount: number;
  repairAttempts: number;
  faultInjectedAt: Date | null;
  stopToCompletionMs: number | null;
  costUsd: number | null;
  durationMs: number | null;
  ciResult: string | null;
  mergeAttempted: boolean;
  mergedRegressionDetected: boolean;
  metadata: string;
  startedAt: Date;
  completedAt: Date | null;
}

/** An aggregated metric slice (mirrors `EvalMetricSnapshot`). */
export interface EvalMetricSnapshotRow {
  id: number;
  runBatchId: string;
  category: string | null;
  scenario: string | null;
  sampleSize: number;
  firstAttemptAcceptRate: number | null;
  finalAcceptRate: number | null;
  falseCompletionRate: number | null;
  humanInterventionRate: number | null;
  avgRepairAttempts: number | null;
  stopToCompletionP95Ms: number | null;
  costUsdPerSuccess: number | null;
  durationMsPerSuccess: number | null;
  postMergeRegressionRate: number | null;
}

/** Minimal Prisma delegate surface the harness actually calls. */
export interface EvalDelegate<TRow> {
  create(args: { data: Record<string, unknown> }): Promise<TRow>;
  findMany(args?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Record<string, unknown>[];
    take?: number;
  }): Promise<TRow[]>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<TRow>;
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<TRow>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
  deleteMany(args?: { where?: Record<string, unknown> }): Promise<{ count: number }>;
}

/**
 * The eval-database client.
 *
 * NOTE: Typed structurally rather than as the generated `PrismaClient`. The
 * generated client under `generated/` is a build artifact that only gains the
 * `EvalCorpusTask`/`EvalRun`/`EvalMetricSnapshot` delegates after the next
 * `prisma generate` (run automatically by dev.js — CLAUDE.md forbids invoking
 * it by hand, and in a git worktree `generated/` is a symlink shared with the
 * main checkout). Depending on the generated types directly would therefore
 * make this subsystem uncompilable until an unrelated restart happened. The
 * interface above is the contract; the delegates are checked at runtime by
 * `createEvalPrismaClient`.
 */
export interface EvalPrismaClient {
  evalCorpusTask: EvalDelegate<EvalCorpusTaskRow>;
  evalRun: EvalDelegate<EvalRunRow>;
  evalMetricSnapshot: EvalDelegate<EvalMetricSnapshotRow>;
  $disconnect(): Promise<void>;
}

/** Delegate properties that must exist on the constructed client. */
const REQUIRED_DELEGATES = ['evalCorpusTask', 'evalRun', 'evalMetricSnapshot'] as const;

let cached: EvalPrismaClient | null = null;

/**
 * Creates (once per process) the eval-database Prisma client.
 *
 * @returns The eval-only Prisma client / 評価専用のPrismaクライアント
 * @throws {EvalDatabaseGuardError} When the connection string is missing or not a `*_eval` database / 接続文字列が未設定または`_eval`以外の場合
 * @throws {Error} When the generated client lacks the eval delegates (schema not yet pushed) / 評価モデルが未生成の場合
 */
export function createEvalPrismaClient(): EvalPrismaClient {
  if (cached) return cached;

  // Must happen before the resolver module is loaded: it reads DATABASE_URL at
  // module-evaluation time to pick the postgres vs sqlite generated client.
  applyEvalDatabaseUrl();

  const { resolvePrismaClientCtor } = require('../../config/prisma-client-resolver') as {
    resolvePrismaClientCtor: () => new () => unknown;
  };
  const PrismaClient = resolvePrismaClientCtor();
  const client = new PrismaClient() as unknown as EvalPrismaClient;

  const missing = REQUIRED_DELEGATES.filter(
    (name) => typeof (client as unknown as Record<string, unknown>)[name] !== 'object',
  );
  if (missing.length > 0) {
    throw new Error(
      `Eval Prisma client is missing delegates: ${missing.join(', ')}. ` +
        'prisma/schema/eval-harness.prisma has not been generated yet — restart the dev server ' +
        '(dev.js runs db push + generate on startup) and re-run.',
    );
  }

  cached = client;
  return client;
}

/**
 * Disposes the cached client. Test/CLI teardown only.
 */
export async function disposeEvalPrismaClient(): Promise<void> {
  if (!cached) return;
  const client = cached;
  cached = null;
  await client.$disconnect();
}
