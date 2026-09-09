/**
 * WorkflowCliExecutorColdstartPrompt
 *
 * Short structured handoff prompt used ONLY when a phase cold-starts because
 * its only resumable session was exhausted by a prompt-too-long failure (task
 * 900). Keeps the role gate (systemPrompt), task info, workflowStatus, and
 * git/review constraints while dropping the accumulated `context` that grew
 * too large — the agent re-fetches research/plan/verify itself instead. Not
 * responsible for the full-context prompt — see workflow-cli-executor-prompt.ts.
 */
import type { RoleTransition } from './workflow-types';
import { buildAgentsMdSection, type AgentsMdReadResult } from './workflow-agents-md-context';

/** Inputs for {@link buildColdStartHandoffPrompt}. */
export interface ColdStartHandoffPromptParams {
  taskId: number;
  task: { title: string; description: string | null };
  systemPrompt: string;
  transition: RoleTransition;
  workflowStatus: string | null | undefined;
  /** Target repository's own AGENTS.md read result (task 892); omitted = no injection. */
  agentsMd?: AgentsMdReadResult;
  /** Short summary of the failure that triggered this cold-start. */
  priorFailureSummary?: string | null;
  language: 'ja' | 'en';
}

/**
 * Build a short structured handoff prompt for a prompt-too-long cold-start.
 * Deliberately excludes the accumulated `context` (verify.md repair history,
 * critic lessons, hypothesis ledger, knowledge base) that caused the original
 * session to overflow — the agent re-fetches the latest artifacts itself.
 *
 * @param params - Handoff prompt inputs. / 引継ぎプロンプト入力
 * @returns The assembled short prompt string. / 組み立て済みの短いプロンプト
 */
export function buildColdStartHandoffPrompt(params: ColdStartHandoffPromptParams): string {
  const { taskId, task, systemPrompt, transition, workflowStatus, agentsMd, priorFailureSummary } =
    params;
  const language = params.language;
  const isImplementationRole = transition.role === 'implementer';
  const port = process.env.PORT || '3001';

  const t =
    language === 'ja'
      ? {
          systemHeader: '## システム指示',
          title: '# 短い引継ぎ（入力長超過からの復旧）',
          lead: 'このフェーズは直前のセッションで入力長超過（Prompt is too long）により失敗しました。同じ蓄積済み文脈のまま --resume すると同じ失敗を繰り返すため、累積文脈を含まない新規セッションとして開始します。',
          taskHeader: '## タスク情報',
          titleLabel: 'タイトル',
          descLabel: '説明',
          noDesc: 'なし',
          statusHeader: '## 現在のワークフロー状態',
          statusBody: (s: string) =>
            `このタスクの現在の workflowStatus は \`${s}\` です。中断前と異なっている可能性があります。`,
          failureHeader: '## 直前の失敗理由',
          fetchHeader: '## 作業再開前に必ず行うこと',
          fetchBody: `既存の変更・成果物・レビュー制約は失われていません。作業を始める前に、必ず以下のAPIで最新の research/plan/verify を取得し、それに基づいて続行してください。

\`\`\`bash
curl http://127.0.0.1:${port}/workflow/tasks/${taskId}/files
\`\`\`

- 既に完了済みの作業を繰り返さないでください
- \`git status\` / \`git diff\` で未コミットの変更を確認し、既存の作業を壊さないでください
- plan.md のスコープ・レビュー待ちの制約は従前どおり有効です`,
          gitHeader: '## git 操作の制限（厳守）',
          gitBody:
            '今の作業ディレクトリはこのタスク専用の worktree で、ブランチは開いた PR に紐づいている場合があります。\n- **禁止**: `git push --force` / `git reset --hard` / `git stash` / `git clean` / ブランチの切替 / `.git` 設定の変更\n- **許可**: `git status` / `git diff` / `git log` / `git add` / 現在のブランチへの `git commit`',
        }
      : {
          systemHeader: '## System Instructions',
          title: '# Short Handoff (recovering from a prompt-too-long failure)',
          lead: 'This phase failed on its previous session with a prompt-too-long error. Resuming the same session with --resume would very likely repeat this failure, so this run starts a fresh session without the accumulated context that overflowed.',
          taskHeader: '## Task Info',
          titleLabel: 'Title',
          descLabel: 'Description',
          noDesc: 'none',
          statusHeader: '## Current Workflow Status',
          statusBody: (s: string) =>
            `This task's current workflowStatus is \`${s}\`. It may differ from what you expect.`,
          failureHeader: '## Prior Failure Reason',
          fetchHeader: '## Before you resume work',
          fetchBody: `Existing changes, artifacts, and review constraints are NOT lost. Before doing anything, fetch the latest research/plan/verify via the API below and continue from there.

\`\`\`bash
curl http://127.0.0.1:${port}/workflow/tasks/${taskId}/files
\`\`\`

- Do not repeat work that is already done.
- Check \`git status\` / \`git diff\` for uncommitted changes and do not clobber them.
- plan.md's scope and any pending-review constraints remain in effect.`,
          gitHeader: '## git restrictions (strict)',
          gitBody:
            'Your working directory is a task-dedicated worktree whose branch may back an OPEN pull request.\n- **Forbidden**: `git push --force` / `git reset --hard` / `git stash` / `git clean` / switching branches / changing `.git` config\n- **Allowed**: `git status` / `git diff` / `git log` / `git add` / `git commit` on the current branch',
        };

  let prompt = '';
  if (systemPrompt) prompt += `${t.systemHeader}\n${systemPrompt}\n\n`;
  prompt += `${t.title}\n\n${t.lead}\n\n`;
  prompt += `${t.taskHeader}\n- ${t.titleLabel}: ${task.title}\n- ${t.descLabel}: ${task.description || t.noDesc}\n\n`;
  if (workflowStatus) {
    prompt += `${t.statusHeader}\n${t.statusBody(workflowStatus)}\n\n`;
  }
  if (priorFailureSummary) {
    prompt += `${t.failureHeader}\n${priorFailureSummary}\n\n`;
  }
  prompt += `${t.fetchHeader}\n${t.fetchBody}\n\n`;
  if (isImplementationRole) {
    prompt += `${t.gitHeader}\n${t.gitBody}\n\n`;
  }
  prompt += buildAgentsMdSection(agentsMd ?? { content: null, truncated: false, readError: null }, {
    isInvestigationPhase: false,
    language,
  });

  return prompt;
}
