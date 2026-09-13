import { sendAIMessage } from '../ai-client';
import { createLogger } from '../../config/logger';

const log = createLogger('branch-name-generator');

/**
 * Embed a task-id marker (`t<taskId>-`) right after the prefix of an
 * already-valid `<prefix>/<slug>` branch name, keeping the result within the
 * 50-character limit without ever truncating the marker itself.
 *
 * @param fullName - Valid `<prefix>/<slug>` branch name. / 妥当なブランチ名
 * @param taskId - Task ID to embed exactly once. / 一度だけ埋め込むタスクID
 * @returns Branch name in `<prefix>/t<taskId>-<slug>` form, ≤50 chars. / taskId込みのブランチ名
 */
function buildTaskBranchName(fullName: string, taskId: number): string {
  const slashIdx = fullName.indexOf('/');
  const prefix = fullName.substring(0, slashIdx);
  const slug = fullName.substring(slashIdx + 1);
  const head = `${prefix}/t${taskId}-`;
  // NOTE: The marker is never truncated — only the slug shrinks to fit the
  // 50-char limit. A minimum of 1 slug char keeps the "hyphen after prefix"
  // rule of isValidBranchName satisfied via the marker's trailing hyphen.
  const maxSlugLen = Math.max(1, 50 - head.length);
  const trimmedSlug = slug.substring(0, maxSlugLen).replace(/-+$/, '') || 'x';
  return `${head}${trimmedSlug}`;
}

/**
 * Check whether a branch name already contains the `t<taskId>` marker for the
 * given task. Used by worktree collision handling to avoid embedding the same
 * task id twice (the `...-t319-task-319` double-suffix bug).
 *
 * @param branchName - Branch name to inspect. / 検査するブランチ名
 * @param taskId - Task ID whose marker to look for. / 探すタスクIDマーカー
 * @returns True when `t<taskId>` appears as a whole segment. / マーカーが含まれればtrue
 */
export function hasTaskIdMarker(branchName: string, taskId: number): boolean {
  // Boundary chars prevent partial-number false positives (t31 vs t319).
  return new RegExp(`(?:^|[/-])t${taskId}(?:[/-]|$)`).test(branchName);
}

/**
 * Generate a safe branch name deterministically. AI translation remains
 * available only through the explicit `RAPITAS_AI_BRANCH_NAMES=1` opt-in.
 *
 * @param taskTitle - Task title used in the AI prompt. / AIプロンプト用タイトル
 * @param taskDescription - Optional task description for prompt context. / プロンプト補足用の説明
 * @param taskId - When given, embeds a `t<taskId>-` marker after the prefix (exactly once). / 指定時はprefix直後にtaskIdマーカーを一度だけ埋め込む
 * @returns Valid branch name; falls back to the deterministic generator on AI failure. / 妥当なブランチ名（AI失敗時は決定的フォールバック）
 */
export async function generateBranchName(
  taskTitle: string,
  taskDescription?: string,
  taskId?: number,
): Promise<string> {
  // Branch names are a constrained formatting problem, not a semantic coding
  // task. The deterministic path enforces the same safety/length/task-id
  // invariants without spending an agent/LLM call for every workflow. Keep an
  // explicit opt-in only for installations that value translated slugs more
  // than the token and latency saving.
  if (process.env.RAPITAS_AI_BRANCH_NAMES !== '1') {
    return generateFallbackBranchName(taskTitle, taskId);
  }

  try {
    const systemPrompt = `You are a Git branch name generator. Output ONLY a branch name, nothing else.

Rules:
- Prefix: feature/ (new feature), bugfix/ (bug fix), chore/ (other work)
- English only, lowercase kebab-case
- MUST have at least 2 words after the prefix, joined by hyphens (e.g., "add-auth" not "auth")
- Describe WHAT the task does in 2-5 words after the prefix
- Max 50 characters total
- If the input is in Japanese, translate the core meaning to English

Examples:
- Task: "ユーザー認証機能を追加" -> feature/add-user-authentication
- Task: "ログインボタンが動かないバグ" -> bugfix/fix-login-button
- Task: "依存関係の更新" -> chore/update-dependencies
- Task: "ダッシュボードにグラフ表示" -> feature/add-dashboard-charts
- Task: "APIレスポンスのキャッシュ実装" -> feature/add-api-response-cache
- Task: "メール通知の送信エラー修正" -> bugfix/fix-email-notification-error`;

    const userMessage = `Task title: "${taskTitle}"${taskDescription ? `\nTask description: "${taskDescription}"` : ''}\n\nGenerate a branch name:`;

    const response = await sendAIMessage({
      provider: 'ollama',
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt,
      maxTokens: 100,
    });

    let branchName = extractBranchName(response.content);

    // Sanitize and validate
    branchName = sanitizeBranchName(branchName);

    if (!isValidBranchName(branchName)) {
      throw new Error(`Generated branch name is invalid: ${branchName}`);
    }

    if (taskId != null) {
      // NOTE: taskId embedding is post-processing, NOT part of the AI prompt —
      // letting the LLM write the marker would risk it altering the id.
      const withMarker = buildTaskBranchName(branchName, taskId);
      if (!isValidBranchName(withMarker)) {
        // Treated like an AI failure: the catch below falls back with taskId intact.
        throw new Error(`Branch name with task-id marker is invalid: ${withMarker}`);
      }
      return withMarker;
    }

    return branchName;
  } catch (error) {
    log.error({ err: error }, 'Error generating branch name with AI');
    // Fallback: generate name from task title
    return generateFallbackBranchName(taskTitle, taskId);
  }
}

/**
 * Extract the branch name portion from raw LLM output.
 */
export function extractBranchName(raw: string): string {
  let text = raw.trim();

  // Strip markdown code blocks
  text = text.replace(/```[^\n]*\n?/g, '').replace(/```/g, '');

  // Strip backticks
  text = text.replace(/`/g, '');

  // Take only the first line (in case LLM appended explanatory text)
  text = text.split('\n')[0].trim();

  // Remove surrounding quotes
  text = text.replace(/^["']+|["']+$/g, '');

  // Remove "branch name: xxx" style prefixes
  text = text.replace(/^(branch\s*name\s*[:：]\s*)/i, '');

  // Extract the portion starting with a valid prefix
  const prefixMatch = text.match(/((?:feature|bugfix|chore|fix|refactor|docs)\/[\w-]+)/);
  if (prefixMatch) {
    text = prefixMatch[1];
  }

  // Normalize fix/ to bugfix/
  if (text.startsWith('fix/')) {
    text = 'bugfix/' + text.slice(4);
  }

  // NOTE: If LLM returned no valid prefix, prepend feature/
  const validPrefixes = ['feature/', 'bugfix/', 'chore/', 'refactor/', 'docs/'];
  if (!validPrefixes.some((p) => text.startsWith(p))) {
    text = `feature/${text}`;
  }

  // NOTE: Ensure at least 2 words after prefix (isValidBranchName requires a hyphen)
  const slashIdx = text.indexOf('/');
  if (slashIdx >= 0) {
    const slug = text.substring(slashIdx + 1);
    if (slug && !slug.includes('-')) {
      text = `${text.substring(0, slashIdx + 1)}implement-${slug}`;
    }
  }

  return text.trim();
}

/**
 * Sanitize a branch name to a Git-compatible format.
 */
export function sanitizeBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\-\/]/g, '-') // Allow only Git-compatible characters
    .replace(/-+/g, '-') // Collapse consecutive hyphens
    .replace(/^-|-$/g, '') // Strip leading/trailing hyphens
    .substring(0, 50) // Enforce length limit
    .replace(/-$/, ''); // Re-check trailing hyphen after truncation
}

/**
 * Assert a caller-supplied git ref (branch name) is safe to pass to git.
 *
 * This is a SECURITY boundary, distinct from `isValidBranchName` (which
 * enforces the team's prefix convention). It rejects shell metacharacters and
 * path-traversal so a value threaded into git commands can never break out —
 * defense-in-depth alongside the array-form (`execFile`) git calls. Bare names
 * without the feature/ prefix are allowed here; only dangerous characters are
 * rejected.
 *
 * @param ref - Branch/base-branch value from a request. / リクエスト由来のブランチ名
 * @param field - Field name for the error message. / エラーメッセージ用のフィールド名
 * @throws {Error} When the ref contains unsafe characters. / 不正文字を含む場合
 */
export function assertSafeGitRef(ref: string, field = 'branchName'): void {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) {
    throw new Error(`Invalid ${field}: must be a non-empty string under 200 chars`);
  }
  // Git ref rules + shell safety: letters, digits, and a minimal punctuation
  // set. Excludes whitespace and every shell metacharacter (; & | $ ` ( ) < >
  // " ' \ * ? ~ ^ : [ { @ !). Also blocks '..' traversal and leading '-'
  // (which git would parse as an option).
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) {
    throw new Error(`Invalid ${field}: contains characters not allowed in a branch name`);
  }
}

/**
 * Check whether a branch name follows Git naming conventions.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.length > 50) return false;

  // Check for valid prefix
  const validPrefixes = ['feature/', 'bugfix/', 'chore/', 'refactor/', 'docs/'];
  if (!validPrefixes.some((prefix) => name.startsWith(prefix))) {
    return false;
  }

  // Branch name must have at least 2 words (one hyphen) after the prefix
  const prefixEnd = name.indexOf('/');
  const slug = name.substring(prefixEnd + 1);
  if (!slug.includes('-')) return false;

  // Git naming rules: disallow special characters, spaces, consecutive dots, etc.
  const invalidChars = /[\s~^:?*\[\\@{;`"'<>|]/;
  if (invalidChars.test(name)) return false;

  // Disallow consecutive dots, leading/trailing dots or hyphens
  if (
    name.includes('..') ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.startsWith('-') ||
    name.endsWith('-')
  ) {
    return false;
  }

  return true;
}

/**
 * Generate a fallback branch name when AI generation fails.
 *
 * @param taskTitle - Task title to derive prefix and slug from. / prefixとslugの導出元タイトル
 * @param taskId - When given, embeds a `t<taskId>-` marker after the prefix (exactly once). / 指定時はprefix直後にtaskIdマーカーを一度だけ埋め込む
 * @returns Deterministic valid branch name. / 決定的で妥当なブランチ名
 */
export function generateFallbackBranchName(taskTitle: string, taskId?: number): string {
  const sanitizedTitle = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Keep only alphanumeric and spaces
    .trim()
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .substring(0, 40); // Length limit (accounting for feature/ prefix)

  // Default to feature/ prefix
  let prefix = 'feature/';

  // Determine prefix based on keywords
  const bugKeywords = ['fix', 'bug', 'error', '修正', 'バグ', 'エラー'];
  const choreKeywords = [
    'refactor',
    'update',
    'clean',
    'remove',
    'delete',
    '更新',
    '削除',
    'リファクタ',
  ];

  // Keep the historical entries above for compatibility, but use correctly
  // encoded Japanese keywords for current task titles.
  bugKeywords.push('修正', 'バグ', 'エラー', '不具合', '障害');
  choreKeywords.push('更新', '削除', '整理', 'リファクタ');

  const titleLower = taskTitle.toLowerCase();
  if (bugKeywords.some((keyword) => titleLower.includes(keyword))) {
    prefix = 'bugfix/';
  } else if (choreKeywords.some((keyword) => titleLower.includes(keyword))) {
    prefix = 'chore/';
  }

  // NOTE: Ensure at least 2 words after prefix — single-word slugs are rejected by isValidBranchName().
  const containsNonAscii = /[^\x00-\x7F]/.test(taskTitle);
  let slug = containsNonAscii
    ? buildJapaneseSlug(taskTitle)
    : sanitizedTitle || buildJapaneseSlug(taskTitle);
  if (!slug.includes('-')) {
    const verbMap: Record<string, string> = {
      'feature/': 'implement',
      'bugfix/': 'fix',
      'chore/': 'update',
    };
    slug = `${verbMap[prefix] || 'implement'}-${slug}`;
  }

  const branchName = sanitizeBranchName(`${prefix}${slug}`);
  if (taskId != null) {
    return buildTaskBranchName(branchName, taskId);
  }
  return branchName;
}

/** Convert common Japanese engineering intent into deterministic English tokens. */
function buildJapaneseSlug(title: string): string {
  const actionRules: Array<[string[], string]> = [
    [['修正', '不具合', 'バグ', 'エラー', '障害', '競合解消'], 'fix'],
    [['改善', '最適化'], 'improve'],
    [['分割', '切り出し'], 'split'],
    [['追加', '導入', '作成'], 'add'],
    [['削除', '廃止'], 'remove'],
    [['更新', '移行'], 'update'],
    [['整理', 'リファクタ'], 'refactor'],
    [['検証', '確認', 'テスト'], 'verify'],
  ];
  const targetRules: Array<[string[], string]> = [
    [['ワークフロー', 'workflow'], 'workflow'],
    [['ブランチ'], 'branch'],
    [['モデル'], 'model'],
    [['トークン'], 'tokens'],
    [['コスト', '費用'], 'cost'],
    [['認証', 'ログイン'], 'authentication'],
    [['画面', '表示', 'UI'], 'ui'],
    [['データベース', 'DB'], 'database'],
    [['API'], 'api'],
    [['通知'], 'notification'],
    [['設定'], 'config'],
    [['実行', 'executor'], 'execution'],
    [['検証', 'テスト'], 'tests'],
    [['ログ'], 'logging'],
    [['集計', 'メトリクス', '統計'], 'metrics'],
    [['サブタスク'], 'subtasks'],
    [['タスク'], 'task'],
    [['エージェント'], 'agent'],
    [['ファイル'], 'files'],
    [['プロセス'], 'process'],
    [['スケジューラ', 'スケジュール'], 'scheduler'],
  ];

  const action = actionRules.find(([words]) => words.some((word) => title.includes(word)))?.[1];
  const targets = targetRules
    .filter(([words]) => words.some((word) => title.includes(word)))
    .map(([, token]) => token)
    .filter((token, index, all) => all.indexOf(token) === index)
    .slice(0, 3);

  return [action ?? 'update', ...(targets.length > 0 ? targets : ['task'])].join('-');
}
