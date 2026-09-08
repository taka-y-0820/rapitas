/**
 * Post-Execution Review Helpers
 *
 * Support routines for the post-execution review pipeline: base-branch
 * resolution, worktree diff extraction, the AI review call, worktree cleanup,
 * and the terminal task-status writes.
 * Not responsible for the pipeline's ordering or its publication gates — see
 * post-execution-review.ts.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { sendAIMessage } from '../../../../utils/ai-client';
import { getLocalLLMStatus } from '../../../../services/local-llm';
import { AgentWorkerManager } from '../../../../services/agents/agent-worker-manager';

const log = createLogger('routes:post-execution-review');
const agentWorkerManager = AgentWorkerManager.getInstance();
// Async git so worktree revert/diff here never blocks the single-threaded
// event loop. Synchronous execSync('git ...') would freeze ALL HTTP requests
// (e.g. the UI's GET /tasks/:id) for up to the given timeout when a git op is
// slow/locked — the "Request timeout after 30001ms" this bug class produces
// (already fixed for execute-post-handler.ts's own copy of this logic; this
// file's copy was missed at the time).
export const execAsync = promisify(exec);

const REVIEW_PROMPT = `あなたはシニアコードレビュアーです。以下のgit diffをレビューしてください。

## タスク: {title}

## 変更差分
{diff}

以下のJSON形式で返してください（他のテキスト不要）:
{
  "approved": true/false,
  "summary": "変更内容の要約（1-2文）",
  "issues": ["問題点があれば記載"],
  "commitMessage": "適切なコミットメッセージ（conventional commits形式: feat/fix/refactor等）"
}

承認基準:
- コードが動作しそうか（明らかな構文エラーがないか）
- 意図しないファイルの削除や破壊的変更がないか
- 明確なバグの混入がないか
軽微なスタイル問題は承認してください。`;

/**
 * Resolve the PR base branch for a task: the task's theme defaultBranch, else
 * 'develop'. Mirrors the workflow-auto-commit / approval paths so auto-PRs target
 * the theme's intended branch instead of an auto-detected main.
 *
 * @param taskId - Task id / タスクID
 * @returns Base branch name / ベースブランチ名
 */
export async function resolveBaseBranch(taskId: number): Promise<string> {
  const task = await prisma.task
    .findUnique({ where: { id: taskId }, select: { theme: { select: { defaultBranch: true } } } })
    .catch(() => null);
  return task?.theme?.defaultBranch || 'develop';
}

/**
 * Get the worktree's git diff (staged + unstaged + untracked), truncated for AI review.
 *
 * @param dir - Worktree directory to inspect. / 対象worktreeディレクトリ
 * @returns Diff text, or an empty string when there is nothing / git failed. / 差分（無ければ空文字）
 */
export async function getDiff(dir: string): Promise<string> {
  try {
    // Staged + unstaged changes
    const { stdout: staged } = await execAsync('git diff --cached --stat', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
    });
    const { stdout: unstaged } = await execAsync('git diff --stat', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
    });
    const { stdout: untracked } = await execAsync('git ls-files --others --exclude-standard', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
    });

    // Get actual diff content (limited to prevent token overflow)
    const { stdout: diffContent } = await execAsync('git diff HEAD --no-color -U3', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });

    const parts = [staged, unstaged, untracked].filter(Boolean).join('\n');
    if (!parts.trim() && !diffContent.trim()) return '';

    // Truncate large diffs for AI review
    return diffContent.slice(0, 8000);
  } catch {
    return '';
  }
}

export interface ReviewResult {
  approved: boolean;
  summary: string;
  issues: string[];
  commitMessage: string;
}

/**
 * Run the AI code review on a diff.
 *
 * @param title - Task title used in the prompt. / タスクタイトル
 * @param diff - Diff to review. / レビュー対象の差分
 * @returns Parsed review verdict, or null when the call/parse failed. / レビュー結果（失敗時 null）
 */
export async function runAIReview(title: string, diff: string): Promise<ReviewResult | null> {
  try {
    const localStatus = await getLocalLLMStatus().catch(() => ({ available: false }));
    const useLocal = (localStatus as { available: boolean }).available;

    const prompt = REVIEW_PROMPT.replace('{title}', title).replace('{diff}', diff);

    const response = await sendAIMessage({
      provider: useLocal ? 'ollama' : 'claude',
      model: useLocal ? 'llama3.2' : 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as ReviewResult;
  } catch (err) {
    log.warn({ err }, 'AI review call failed');
    return null;
  }
}

/**
 * Remove the execution worktree and clear its session pointer.
 *
 * @param workDir - Parent repository of the worktree. / worktreeの親リポジトリ
 * @param executionDir - Worktree to remove. / 削除対象worktree
 * @param sessionId - Session whose worktreePath is cleared on success. / セッションID
 */
export async function cleanupWorktree(
  workDir: string,
  executionDir: string,
  sessionId: number,
): Promise<void> {
  try {
    const removed = await agentWorkerManager.removeWorktree(workDir, executionDir);
    if (removed) {
      await prisma.agentSession.update({ where: { id: sessionId }, data: { worktreePath: null } });
      log.info({ sessionId }, 'Worktree cleaned up');
    } else {
      log.warn({ sessionId }, 'removeWorktree refused or failed');
    }
  } catch (err) {
    log.warn({ err, sessionId }, 'Worktree cleanup failed');
  }
}

/**
 * Mark a task done with a completedAt timestamp.
 *
 * @param taskId - Task to complete. / 完了させるタスクID
 */
export async function markTaskDone(taskId: number): Promise<void> {
  try {
    await prisma.task.update({
      where: { id: taskId },
      data: { status: 'done', completedAt: new Date() },
    });
    log.info({ taskId }, 'Task marked as done');
  } catch (err) {
    log.warn({ err, taskId }, 'Failed to mark task as done');
  }
}
