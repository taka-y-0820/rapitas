/**
 * automation-policy
 *
 * `autoCommit` / `autoCreatePR` / `autoMergePR` の有効値をタスク単位で解決する。
 * 解決順序:
 *   1. タスク個別の `Task.autoCommit/autoCreatePR/autoMergePR` (Prisma に追加されていれば)
 *   2. ワークフロー設定 (`WorkflowAutomationSettings`)（将来追加予定）
 *   3. 環境変数フォールバック (`RAPITAS_DEFAULT_AUTO_*`)
 *   4. ハードコード default（推奨フロー: commit=ON, createPR=ON, mergePR=OFF）
 *
 * 自動化判断は `routes/workflow/workflow-auto-commit.ts` がここを呼ぶことで一元化される。
 */

import type { PrismaClient } from '../../generated/prisma-postgres';
import { createLogger } from '../../config/logger';

const log = createLogger('workflow:automation-policy');

/**
 * Last-logged policy signature per task. `resolveAutomationPolicy` is called on a
 * hot path (the 60s auto-merge poll iterates every open PR), so logging on every
 * call floods the log with identical lines. We log only when a task's resolved
 * policy first appears or actually changes. / 解決ポリシーが変化した時だけログする。
 */
const lastLoggedPolicy = new Map<number, string>();

/**
 * The single "landing strategy" a task uses to reach completion, derived from
 * its automation policy. Completion is marked at a DIFFERENT point per mode:
 *  - `none`   → completed as soon as verify passes (no git automation).
 *  - `commit` → completed after commit+push to the theme's default branch.
 *  - `pr`     → completed after the created PR's CI goes green (NOT merged).
 *  - `merge`  → completed after the PR is merged into the default branch.
 *
 * Direct-to-default `commit` and PR-based `pr`/`merge` are mutually exclusive
 * landing strategies; a higher mode supersedes the lower ones.
 */
// @gen-guard-fallback: none
export const LANDING_MODES = ['merge', 'pr', 'commit', 'none'] as const;
export type LandingMode = (typeof LANDING_MODES)[number];

/**
 * Collapse a resolved policy into its single landing mode.
 * Precedence (higher supersedes lower): autoMergePR > autoCreatePR > autoCommit.
 *
 * @param policy - Resolved autoCommit/autoCreatePR/autoMergePR booleans. / 解決済み自動化フラグ
 * @returns The landing mode that decides where completion is marked. / 完了点を決める landing mode
 */
export function resolveLandingMode(policy: {
  autoCommit: boolean;
  autoCreatePR: boolean;
  autoMergePR: boolean;
}): LandingMode {
  if (policy.autoMergePR) return 'merge';
  if (policy.autoCreatePR) return 'pr';
  if (policy.autoCommit) return 'commit';
  return 'none';
}

/**
 * 解決後の自動化設定。verify_done → completed の自動進行をどこまで進めるかを表す。
 */
export interface ResolvedAutomationPolicy {
  /** verify_done 後に自動 commit するか */
  autoCommit: boolean;
  /** commit 後に自動で gh pr create するか */
  autoCreatePR: boolean;
  /** PR 作成後 CI 通過したら自動 merge するか */
  autoMergePR: boolean;
  /** どのソースで決まったかの診断情報 */
  source: {
    autoCommit: 'task' | 'user' | 'env' | 'default';
    autoCreatePR: 'task' | 'user' | 'env' | 'default';
    autoMergePR: 'task' | 'user' | 'env' | 'default';
  };
}

/**
 * タスク ID から自動化ポリシーを解決する。
 *
 * @param prisma - Prisma クライアント
 * @param taskId - 対象タスク ID
 * @returns 解決後の `autoCommit / autoCreatePR / autoMergePR` 値と source
 */
export async function resolveAutomationPolicy(
  prisma: PrismaClient,
  taskId: number,
): Promise<ResolvedAutomationPolicy> {
  // Task model にカラムが追加されたらここで読み出す。現状はスキーマ追加待ち。
  const task = (await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true },
  })) as {
    id: number;
    autoCommit?: boolean | null;
    autoCreatePR?: boolean | null;
    autoMergePR?: boolean | null;
  } | null;

  const envBoolean = (key: string): boolean | null => {
    const raw = process.env[key];
    if (raw === undefined) return null;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return null;
  };

  const envAutoCommit = envBoolean('RAPITAS_DEFAULT_AUTO_COMMIT');
  const envAutoCreatePR = envBoolean('RAPITAS_DEFAULT_AUTO_CREATE_PR');
  const envAutoMergePR = envBoolean('RAPITAS_DEFAULT_AUTO_MERGE_PR');

  // Global defaults set on the "タスク設定" page (UserSettings). These sit between
  // a per-task override and the env/hardcoded fallback.
  // A failed read is not an absent setting: falling back could silently disable
  // a required merge. Let publication/completion callers withhold and retry.
  const userSettings = (await prisma.userSettings.findFirst()) as {
    autoCommitDefault?: boolean | null;
    autoCreatePRDefault?: boolean | null;
    autoMergePRDefault?: boolean | null;
  } | null;

  const resolveOne = <T extends 'autoCommit' | 'autoCreatePR' | 'autoMergePR'>(
    key: T,
    userValue: boolean | null | undefined,
    envValue: boolean | null,
    fallback: boolean,
  ): { value: boolean; source: 'task' | 'user' | 'env' | 'default' } => {
    const taskValue = task?.[key];
    if (typeof taskValue === 'boolean') return { value: taskValue, source: 'task' };
    if (typeof userValue === 'boolean') return { value: userValue, source: 'user' };
    if (envValue !== null) return { value: envValue, source: 'env' };
    return { value: fallback, source: 'default' };
  };

  // Recommended default flow: commit + open a PR automatically so changes reach
  // git and are reviewable, but do NOT auto-merge — a human reviews/merges the
  // PR. Override globally on the タスク設定 page, per-task, or via
  // RAPITAS_DEFAULT_AUTO_* env vars.
  const ac = resolveOne('autoCommit', userSettings?.autoCommitDefault, envAutoCommit, true);
  const acpr = resolveOne('autoCreatePR', userSettings?.autoCreatePRDefault, envAutoCreatePR, true);
  const ampr = resolveOne('autoMergePR', userSettings?.autoMergePRDefault, envAutoMergePR, false);

  // Only log when this task's resolved policy is new or changed — avoids flooding
  // the log with one identical line per open PR on every 60s auto-merge poll.
  const signature = `${ac.value}:${acpr.value}:${ampr.value}:${ac.source}:${acpr.source}:${ampr.source}`;
  if (lastLoggedPolicy.get(taskId) !== signature) {
    lastLoggedPolicy.set(taskId, signature);
    log.debug(
      {
        taskId,
        autoCommit: ac.value,
        autoCreatePR: acpr.value,
        autoMergePR: ampr.value,
        sources: { autoCommit: ac.source, autoCreatePR: acpr.source, autoMergePR: ampr.source },
      },
      '[automation-policy] resolved policy',
    );
  }

  return {
    autoCommit: ac.value,
    autoCreatePR: acpr.value,
    autoMergePR: ampr.value,
    source: {
      autoCommit: ac.source,
      autoCreatePR: acpr.source,
      autoMergePR: ampr.source,
    },
  };
}
