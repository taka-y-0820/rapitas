import { writeBlockedTask } from '../../../../services/workflow/blocked-task-write';
/**
 * execution/research-report-harvester
 *
 * Extracts the research report markdown from a research-mode agent's
 * stdout and validates it. On an inadequate report, handles the
 * blocked-marking side effects itself and signals the caller to stop.
 * Separated from research-phase-handler.ts to keep each file under 500 lines.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import {
  isIsolatedWorktree,
  validateResearchReport,
  extractFinalAgentMessage,
  sliceResearchReport,
} from './research-output-utils';

// Async git so the post-execution revert never blocks the single-threaded event
// loop. Synchronous execSync('git reset/clean', timeout 30s) here would freeze
// ALL HTTP requests (e.g. the UI's GET /tasks/:id) for up to 30s when a git op
// is slow/locked.
const execAsync = promisify(exec);

const log = createLogger('routes:agent-execution:research-report-harvester');

/** Parameters for harvestResearchReport. */
export interface HarvestResearchReportParams {
  result: { output?: string };
  taskIdNum: number;
  sessionId: number;
  executionDir: string;
}

/**
 * Harvest the agent's final research report from stdout and validate it.
 *
 * Returns the report markdown (possibly empty — the caller's save/blocked
 * branching handles the empty case). Returns `null` ONLY when the report was
 * non-empty but failed quality validation: in that case this function has
 * already reverted the isolated worktree (best-effort) and marked the
 * task blocked / session failed, so the caller must stop immediately.
 *
 * @param params - Research execution context / リサーチ実行コンテキスト
 * @returns Report markdown, or null after a validation reject / レポート本文（検証NG時はnull）
 */
export async function harvestResearchReport(
  params: HarvestResearchReportParams,
): Promise<string | null> {
  const { result, taskIdNum, sessionId, executionDir } = params;

  // Harvest the agent's final message from STDOUT only. We deliberately do
  // NOT use codex's --output-last-message flag because it would require
  // granting write permission to a path INSIDE the read-only sandbox.
  // codex exec always writes the final assistant message to stdout, which
  // we capture in result.output without any sandbox interaction. The
  // Rapitas backend (full permissions, outside sandbox) is the sole writer
  // for the persistent research.md / plan.md / verify.md files in
  // ~/.rapitas/workflows/.
  //
  // CRITICAL: stdout includes intermediate codex logs ("読み取りコマンドの一部
  // が実行ポリシーで弾かれた" etc.) BEFORE the final markdown report. We
  // slice from the LAST occurrence of `# 調査レポート` so the report header
  // is the first byte of the captured content, regardless of what codex
  // logged before it.
  const rawOutput = result.output ?? '';
  const stripped = result.output ? extractFinalAgentMessage(result.output) : '';
  const sliced = sliceResearchReport(stripped) || sliceResearchReport(rawOutput);
  const researchMarkdown: string = sliced ?? '';
  if (!researchMarkdown.trim()) {
    log.warn(
      { taskId: taskIdNum, rawChars: rawOutput.length, strippedChars: stripped.length },
      '[API] Research mode produced no extractable # 調査レポート section',
    );
  } else {
    log.info(
      {
        taskId: taskIdNum,
        rawChars: rawOutput.length,
        reportChars: researchMarkdown.length,
        source: 'stdout (sliced from last # 調査レポート)',
      },
      '[API] Research report sliced from stdout',
    );
  }

  // Validate quality: enforce minimum sections + length so a thin
  // "調査専用モードとして進めます" reply is rejected as inadequate.
  const validation = validateResearchReport(researchMarkdown);
  if (researchMarkdown.trim() && !validation.ok) {
    log.warn(
      {
        taskId: taskIdNum,
        chars: researchMarkdown.length,
        missing: validation.missingSections,
        reason: validation.reason,
      },
      '[API] Research report rejected as inadequate — marking blocked',
    );
    // Try a worktree revert just in case, then mark blocked. Only ever reset an
    // isolated worktree (never the main checkout), and do it async so a slow git
    // op cannot freeze the event loop.
    if (isIsolatedWorktree(executionDir)) {
      try {
        await execAsync('git reset --hard HEAD', { cwd: executionDir, timeout: 30000 });
        await execAsync('git clean -fd', { cwd: executionDir, timeout: 30000 });
      } catch {
        // intentionally ignore - best-effort cleanup
      }
    }
    await writeBlockedTask(prisma, taskIdNum).catch(() => {});
    await prisma.agentSession
      .update({
        where: { id: sessionId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: `調査レポートが不十分です: ${validation.reason}. 再実行してください。`,
        },
      })
      .catch(() => {});
    return null;
  }

  return researchMarkdown;
}
