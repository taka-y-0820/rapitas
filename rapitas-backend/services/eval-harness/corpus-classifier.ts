/**
 * CorpusClassifier
 *
 * Assigns one of the five evaluation categories to a completed task, using
 * only signals that already exist in the app database and git history — the
 * `Task` model has no task-kind column, so the corpus is derived rather than
 * read.
 *
 * Pure module: no I/O. Gathering the inputs is `corpus-collector.ts`'s job.
 */

/** The five evaluation categories, in resolution priority order. */
export const EVAL_CATEGORIES = [
  'failure_recovery',
  'multi_service',
  'bug_fix',
  'feature',
  'investigation_only',
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/** Top-level directories that each count as a distinct service. */
export const SERVICE_DIRS = ['rapitas-backend', 'rapitas-frontend', 'rapitas-desktop'] as const;

/** Signals gathered for one candidate task. */
export interface ClassifierInput {
  /** `Task.id` in the app database. */
  taskId: number;
  title: string;
  /** `Task.workflowStatus` at collection time. */
  workflowStatus: string | null;
  /** Subject line of the resolved fix commit, or null when unresolved. */
  fixCommitSubject: string | null;
  /** Distinct top-level directories touched by the fix commit. */
  changedTopLevelDirs: string[];
  /** Number of files the fix commit changed. */
  changedFileCount: number;
  /** True when a `blocked` → `in_progress` WorkflowTransition exists. */
  hasBlockedRecovery: boolean;
}

/** Outcome of classification. */
export interface Classification {
  category: EvalCategory;
  /** 0..1 — how structural the firing signal was. */
  confidence: number;
  /** Stable identifier of the rule that fired, for auditing. */
  method: string;
}

/**
 * Counts how many of the three services the fix commit touched.
 *
 * @param dirs - Top-level directories touched / 変更されたトップレベルディレクトリ
 * @returns Number of distinct services / 触れたサービス数
 */
export function countTouchedServices(dirs: string[]): number {
  const seen = new Set<string>();
  for (const dir of dirs) {
    const normalized = dir.replace(/[\/]+$/, '');
    if ((SERVICE_DIRS as readonly string[]).includes(normalized)) seen.add(normalized);
  }
  return seen.size;
}

/**
 * Classifies a candidate task into exactly one evaluation category.
 *
 * Rules are evaluated in the fixed priority order
 * `failure_recovery > multi_service > bug_fix > feature > investigation_only`
 * so a task matching several rules always lands in the same bucket.
 *
 * @param input - Signals gathered for the task / タスクについて収集したシグナル
 * @returns The classification, or null when no rule fires / 分類結果（どのルールも合致しなければnull）
 */
export function classifyTask(input: ClassifierInput): Classification | null {
  const title = input.title.trim();

  // 1. failure_recovery — the task existed because earlier work broke or stalled.
  if (input.hasBlockedRecovery) {
    return { category: 'failure_recovery', confidence: 0.9, method: 'blocked_transition' };
  }
  if (title.includes('陳腐化') || title.includes('テスト修正')) {
    return { category: 'failure_recovery', confidence: 0.8, method: 'title_recovery_keyword' };
  }

  // 2. multi_service — the fix spanned two or more of backend/frontend/desktop.
  if (countTouchedServices(input.changedTopLevelDirs) >= 2) {
    return { category: 'multi_service', confidence: 0.9, method: 'multi_service_dirs' };
  }

  // 3. bug_fix
  if (/^\[Bug\]/i.test(title)) {
    return { category: 'bug_fix', confidence: 0.9, method: 'title_prefix_bug' };
  }
  if (input.fixCommitSubject?.startsWith('fix(')) {
    return { category: 'bug_fix', confidence: 0.7, method: 'commit_prefix_fix' };
  }

  // 4. feature
  if (/^\[(Idea|Feature)\]/i.test(title)) {
    return { category: 'feature', confidence: 0.9, method: 'title_prefix_feature' };
  }
  if (input.fixCommitSubject?.startsWith('feat(')) {
    return { category: 'feature', confidence: 0.7, method: 'commit_prefix_feat' };
  }

  // 5. investigation_only — completed with a verifiably empty diff.
  if (input.workflowStatus === 'completed' && input.changedFileCount === 0) {
    return { category: 'investigation_only', confidence: 0.6, method: 'completed_zero_diff' };
  }

  // NOTE: Deliberately no fallback bucket — guessing a category would silently
  // pollute the corpus, and an unclassified candidate is simply dropped.
  return null;
}

/**
 * Assigns the train/eval split deterministically.
 *
 * No RNG: a private evaluation set is only meaningful if re-seeding reproduces
 * the same membership. Every third task (by ascending `sourceTaskId` within a
 * category) becomes an eval instance, giving roughly a 2:1 train:eval ratio.
 *
 * @param indexWithinCategory - 0-based position after sorting by sourceTaskId / カテゴリ内の0始まりの位置
 * @returns "eval" or "train" / 評価用か学習用か
 */
export function assignSplit(indexWithinCategory: number): 'train' | 'eval' {
  return indexWithinCategory % 3 === 0 ? 'eval' : 'train';
}
