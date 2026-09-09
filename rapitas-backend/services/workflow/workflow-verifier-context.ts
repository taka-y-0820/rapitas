/**
 * Workflow Verifier Context
 *
 * Assembles the prompt context string shared by the verifier and auto_verifier
 * roles (memory, lessons, hypothesis ledger, plan, worktree diff, measured
 * GROUND TRUTH verification). Does not build contexts for other roles.
 */
import { observeWorkflowStage } from './workflow-stage-timing';
import { prisma } from '../../config/database';
import { readWorkflowFile } from './workflow-file-utils';
import { buildMemoryContext } from './workflow-memory-context';
import { buildHypothesisContext } from './workflow-hypothesis-context';
import { buildCriticLessonsSection } from './phase-critic';
import { resolvePreferredBaseBranch } from '../task/task-resolver';
import { recordContextMetrics } from './workflow-context-metrics';
import type { VerifierTexts } from './workflow-role-prompts';

// NOTE: auto_verifier shares the verifier context — both must emit the validator-required
// headings, AND both must be measured: recordContextMetrics below is called with the
// dynamic `role` param (not a literal 'verifier'), so this shared builder runs once
// per buildRoleContext call regardless of which of the two role strings triggered it.

/**
 * Build the verifier / auto_verifier role's prompt context.
 *
 * @param taskId - Task id used to read prior artifacts and record metrics. / タスクID
 * @param role - Which of the two verifier roles is executing. / 実行中のロール
 * @param task - Task title and description. / タスクのタイトルと説明
 * @param language - Output language. / 出力言語
 * @param mode - Resolved workflow mode. / 解決済みワークフローモード
 * @param taskInfo - Pre-built task-info block. / タスク情報ブロック
 * @param texts - Verifier prompt texts for the language. / verifier用テキスト
 * @param styleRule - Report style rule block. / 文体ルールブロック
 * @returns Assembled verifier context string. / verifier用コンテキスト文字列
 */
export async function buildVerifierContext(
  taskId: number,
  role: 'verifier' | 'auto_verifier',
  task: { title: string; description: string | null },
  language: 'ja' | 'en',
  mode: 'lightweight' | 'standard' | 'comprehensive',
  taskInfo: string,
  texts: VerifierTexts,
  styleRule: string,
): Promise<string> {
  const plan = await readWorkflowFile(taskId, 'plan');
  let ctx = `${taskInfo}

## Verification and publication evidence
Report technical verification and downstream publication (push, CI, merge) separately. An unattempted publication step is pending, not a failed test and not completed. Use a pending marker for it; never claim 100% or M/M completion when the same checklist contains unfinished items. Include unfinished items in the denominator, or explicitly label a separate implementation-only count.
For each CI result, record the commit SHA it tested. A failure on an older commit is historical evidence, not the current commit's result; query the current PR head and checks. Unknown or pending checks remain unverified. Actual failing tests/checks must remain failures. A passing technical report does not authorize task completion before all required publication gates succeed.
Preserve command exit codes before formatting output: piping a command into tail and reading $? reports tail's status. Save the original command status and full output; do not claim success from the pipe's status.`;
  // Recall prior knowledge for the verifier too — failure lessons from
  // similar tasks tell it exactly which regressions to probe for.
  const verifierMemory = await observeWorkflowStage(taskId, 'context.buildMemoryContext', () =>
    buildMemoryContext(taskId, task, language),
  );
  if (verifierMemory) {
    ctx += `\n\n${verifierMemory}`;
  }
  // Cross-task learning loop: recurring verify.md rejections (measured-vs-
  // claimed contradictions, output-discipline violations) injected BEFORE
  // the report is written — the largest single bounce bucket historically.
  const verifyLessons = await observeWorkflowStage(
    taskId,
    'context.buildCriticLessonsSection',
    () => buildCriticLessonsSection('verify', language),
  );
  if (verifyLessons) {
    ctx += `\n\n${verifyLessons}`;
  }
  // Hypothesis ledger: the verifier is the ONLY phase that explicitly JUDGES
  // whether each open hypothesis's prediction held — its `## 仮説評価` verdicts
  // graduate (成立→validated) / refute (不成立→rejected) them. Without this the
  // directive never reached the verifier and the ledger never graduated
  // anything (every entry stuck at 検証待ち). Surfaces the open hypotheses (with
  // ids) the verifier must evaluate.
  const hypothesis = await buildHypothesisContext(taskId, language);
  if (hypothesis) {
    ctx += `\n\n${hypothesis}`;
  }
  if (plan) {
    ctx += `\n\n${texts.planHeader}\n\n${plan}`;
  }
  // Append the branch diff so the verifier reviews ACTUAL changes, using the
  // agent's worktree and getDiff's merge-base. (The old `git diff HEAD~1` at
  // process.cwd() was wrong: it diffed the main checkout, not the worktree,
  // and assumed exactly one commit.) Only run when a worktree session exists
  // — diffing the live checkout (cwd) is both wrong and expensive (it would
  // run a full per-file diff over the whole rapitas repo).
  let diffBlock = '';
  let groundTruthBlock = '';
  const diffSession = await prisma.agentSession
    .findFirst({
      where: { config: { taskId }, worktreePath: { not: null } },
      // Secondary `id` key breaks ties on identical createdAt timestamps —
      // otherwise which session diff gets shown to the verifier could
      // vary across identical re-runs.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { worktreePath: true },
    })
    .catch(() => null);
  if (diffSession?.worktreePath) {
    // The worktree's ACTUAL fork point, not a guess — see automated-verifier
    // .ts's diffBaseRef doc comment (task 506: a guess-only base can pull
    // unrelated pre-existing commits into "this task's diff", confusing both
    // the verifier's own review and the measured lint/typecheck gate below).
    // NOTE: theme.defaultBranch, not AgentExecutionConfig.targetBranch alone
    // (task 511: that table is empty for the autonomous pipeline).
    const preferredBaseBranchForContext = await resolvePreferredBaseBranch(taskId);
    try {
      const { getDiff } =
        await import('../agents/orchestrator/git-operations/core/diff-structured');
      const records = await getDiff(
        diffSession.worktreePath,
        undefined,
        preferredBaseBranchForContext,
      ).catch(() => []);
      const patches = records
        .map((r) => r.patch)
        .filter((p): p is string => !!p && p.trim().length > 0)
        .join('\n');
      const fallbackList = records
        .map((r) => `${r.status}\t${r.filename} (+${r.additions}/-${r.deletions})`)
        .join('\n');
      const diffText = patches || fallbackList;
      if (diffText.trim()) {
        diffBlock = `${texts.diffHeader}\n\n\`\`\`diff\n${diffText.substring(0, 50000)}\n\`\`\``;
        ctx += `\n\n${diffBlock}`;
      }
    } catch {
      // Continue even if diff retrieval fails — verify.md can still be written.
    }

    // GROUND TRUTH: run the SAME automated lint/typecheck/test gate the PR
    // pipeline uses, on the agent's worktree, and inject its REAL result. The
    // verifier was observed FABRICATING "全テスト通過 224/224" for work whose
    // tests actually fail (or that wasn't even committed) — self-reported test
    // results are unreliable. Anchoring verify.md to the measured result kills
    // the hallucination at the source AND stops the prose honesty-gate from
    // false-bouncing a genuinely-green change. Fail-soft: if the verifier
    // crashes/skips, the verifier falls back to self-report (status quo).
    try {
      const [
        { runAutomatedVerification, renderVerificationMarkdown },
        { resolveAcceptanceCriteria },
        planForGate,
        taskRowForGate,
      ] = await Promise.all([
        import('../agents/verification/automated-verifier'),
        import('../agents/verification/acceptance-self-check'),
        readWorkflowFile(taskId, 'plan'),
        // Acceptance criteria for the ADVISORY acceptance self-check (task
        // 617) — its criterion↔diff mapping rides the GROUND TRUTH block
        // into verify.md, persisting the correspondence for later audit.
        prisma.task
          .findUnique({ where: { id: taskId }, select: { acceptanceCriteria: true } })
          .catch(() => null),
      ]);
      const gateCriteria = resolveAcceptanceCriteria({
        acceptanceCriteria: taskRowForGate?.acceptanceCriteria ?? null,
        description: task.description,
      });
      const measured = await runAutomatedVerification(diffSession.worktreePath, {
        planContent: planForGate ?? undefined,
        preferredBaseBranch: preferredBaseBranchForContext,
        taskId,
        acceptanceCriteria: gateCriteria.length > 0 ? gateCriteria : undefined,
        taskText: `${task.title}\n${task.description ?? ''}`,
      }).catch(() => null);
      if (measured) {
        const header =
          language === 'ja'
            ? '# 自動検証の実測結果（worktree で実行済み・GROUND TRUTH）'
            : '# Automated verification — MEASURED on the worktree (GROUND TRUTH)';
        const rule =
          language === 'ja'
            ? `> **これは worktree に対し実際に実行した lint/型/テストの結果です（総合: ${measured.ok ? '✅ 合格' : '❌ 失敗'}）。** verify.md の「テスト結果」「品質メトリクス」「総合判定」はこの実測と矛盾してはならない。実測が ❌ なら verify.md も ❌ 検証失敗 とし、合格を捏造しないこと。実測が ✅ なら自信を持って合格と記載してよい。`
            : `> **These are lint/type/test results actually RUN on the worktree (overall: ${measured.ok ? '✅ pass' : '❌ fail'}).** verify.md's test-results / quality-metrics / overall verdict MUST NOT contradict this. If measured ❌, mark verify.md ❌ Fail — never fabricate a pass. If measured ✅, you may confidently report pass.`;
        groundTruthBlock = `${header}\n\n${rule}\n\n${renderVerificationMarkdown(measured)}`;
        ctx += `\n\n${groundTruthBlock}`;
      }
    } catch {
      // Fail-soft — verify.md can still be written from the agent's own checks.
    }
  }
  // Lightweight workflow has no plan.md — verify against the task/research
  // requirements instead of a plan checklist that doesn't exist.
  let verifierInstruction = texts.instruction;
  if (!plan) {
    // NOTE: the machine-parsed heading text (チェックリスト消化状況 / Checklist
    // status) must survive in no-plan mode — only its CONTENT description
    // changes. Renaming it (the old 要件の充足状況 replacement) produced
    // verify.md files the section validator rejected on lightweight tasks.
    verifierInstruction = verifierInstruction
      .replace('上記の計画と実装結果を検証し', '上記の実装結果を検証し')
      .replace(
        '## チェックリスト消化状況 (plan.md の各項目に ✅/❌)',
        '## チェックリスト消化状況 (計画なしタスク: タスク要件・調査内容に対する充足状況を ✅/❌ で記載)',
      )
      .replace(
        'Please verify the implementation plan and results above',
        'Please verify the implementation results above',
      )
      .replace(
        '## Checklist status (each plan item ✅/❌)',
        '## Checklist status (no plan: cover each task requirement with ✅/❌)',
      );
  }
  ctx += `\n\n${verifierInstruction}\n\n${styleRule}`;
  // prettier-ignore
  void recordContextMetrics(taskId, role, mode, { taskInfo, memory: verifierMemory, lessons: verifyLessons, hypothesis, plan, diff: diffBlock, groundTruth: groundTruthBlock, instruction: verifierInstruction, styleRule });
  return ctx;
}
