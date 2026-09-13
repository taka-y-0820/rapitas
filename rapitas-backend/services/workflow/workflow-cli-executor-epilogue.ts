/**
 * Workflow CLI Executor Epilogue
 *
 * Post-execution steps for a CLI phase run: harvests the agent's final
 * message into the workflow artifact, and resolves the resulting phase
 * status (advancing the workflow forward-only, delegating verify-specific
 * gating to workflow-cli-executor-verify-gate). Post-processing (cleanup,
 * AgentExecution flip, timeline, auto-advance) lives in
 * workflow-cli-executor-postprocess. Not responsible for prompt building or
 * working-directory resolution.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import type { AgentOrchestrator } from '../agents/agent-orchestrator';
import { resolveTaskWorkflowState } from '../task/task-resolver';
import {
  readWorkflowFile,
  writeWorkflowFile,
  extractMarkdownFromOutput,
} from './workflow-file-utils';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';
import { recordTransition, type TransitionActor } from './transition-recorder';
import { checkWorkflowInvariants } from './workflow-invariants';
import { maybeAutoApprovePlan } from './plan-auto-approve';
import { validateOutput, WF_STATUS_RANK } from './workflow-cli-executor-helpers';
import { resolveVerifyPhaseStatus } from './workflow-cli-executor-verify-gate';
import { requirementReplannedSince } from './requirement-replan-guard';

// NOTE: Same logger name as the executor body — keeps the observed log `name`
// field identical after the file split.
const log = createLogger('workflow-cli-executor');

type ExecuteTaskResult = Awaited<ReturnType<AgentOrchestrator['executeTask']>>;

/**
 * Harvest an investigation-phase agent's clean final message into the
 * workflow artifact (research/plan/verify.md), skipping the save when a
 * phase critic already rejected this artifact mid-run.
 *
 * @param params - Harvest inputs (task, transition, execute result, phase kind, start time) / ハーベスト入力一式
 */
export async function harvestInvestigationOutput(params: {
  taskId: number;
  transition: RoleTransition;
  result: ExecuteTaskResult;
  isInvestigationPhase: boolean;
  phaseStartedAt: Date;
}): Promise<void> {
  const { taskId, transition, result, isInvestigationPhase, phaseStartedAt } = params;
  if (await requirementReplannedSince(prisma, taskId, phaseStartedAt)) {
    log.info(
      { taskId },
      '[WorkflowCLIExecutor] Replan superseded this phase; skipping artifact harvest',
    );
    return;
  }

  // Investigation-mode result harvesting: if codex wrote to the temp file,
  // upload its contents to the workflow API server-side (codex itself
  // Investigation-phase harvest: capture stdout (result.output) and save it
  // to the workflow API as <outputFile>.md. codex `exec` writes the final
  // assistant message to stdout for any --sandbox mode, so this works
  // even with read-only sandbox where codex itself cannot write files.
  // Prefer the agent's CLEAN final message (stream-json `result` event) over
  // the raw outputBuffer. outputBuffer concatenates every streamed assistant
  // delta, tool-result display, and status line — which polluted research.md /
  // plan.md with mid-run narration ("研究レポートを書き出します…"), false-start
  // blocks, and tool dumps. finalMessage is just the final report.
  const rawInvestigation = result.finalMessage?.trim() || result.output?.trim();
  if (isInvestigationPhase && transition.outputFile && rawInvestigation) {
    // Never persist raw agent logs into the .md. When the agent crashes (e.g.
    // "Uncaught ReferenceError: Workflow is not defined") finalMessage is empty
    // and result.output is the full log-laden stdout buffer — extract the clean
    // report and quality-gate it. A null result (log-only output) means we write
    // NOTHING, so the phase fails cleanly instead of producing a poisoned file.
    const cleaned = extractMarkdownFromOutput(rawInvestigation, transition.outputFile);
    if (!cleaned) {
      log.warn(
        {
          taskId,
          role: transition.role,
          outputFile: transition.outputFile,
          rawChars: rawInvestigation.length,
          usedFinalMessage: !!result.finalMessage?.trim(),
        },
        '[WorkflowCLIExecutor] Agent output had no clean report (log-only) — skipping md write',
      );
    } else {
      // Critic-rejection guard: if the phase critic already REJECTED this
      // phase's artifact (rollback + archive) while the agent was finishing,
      // re-saving the agent's final message would RESURRECT the rejected
      // artifact byte-for-byte and flip the status forward again — exactly
      // how task 536's bounce loop never regenerated anything. Skip; the
      // bounced re-run produces the replacement.
      const { criticRejectedSince } = await import('./phase-critic/critic-rejection-guard');
      if (await criticRejectedSince(taskId, transition.outputFile, phaseStartedAt)) {
        log.warn(
          { taskId, role: transition.role, outputFile: transition.outputFile },
          '[WorkflowCLIExecutor] Critic rejected this artifact mid-phase — skipping harvest re-save (would resurrect the rejected content)',
        );
      } else {
        try {
          await writeWorkflowFile(taskId, transition.outputFile, cleaned);
          log.info(
            {
              taskId,
              role: transition.role,
              outputFile: transition.outputFile,
              chars: cleaned.length,
              usedFinalMessage: !!result.finalMessage?.trim(),
            },
            '[WorkflowCLIExecutor] Captured clean report and saved to workflow API',
          );
        } catch (captureErr) {
          log.warn(
            { err: captureErr, taskId, role: transition.role },
            '[WorkflowCLIExecutor] Failed to save report to workflow API',
          );
        }
      }
    }
  }
}

/**
 * Resolve the phase's resulting success/status/error after the agent run,
 * advancing the workflow status FORWARD only and delegating verify-specific
 * completion gating to resolveVerifyPhaseStatus.
 *
 * @param params - Epilogue inputs (task, transition, session, execute result, worktree, language) / エピローグ入力一式
 * @returns Effective success, resulting phase status, and phase error / 実効成功可否・フェーズステータス・エラー
 */
export async function runPhaseEpilogue(params: {
  taskId: number;
  transition: RoleTransition;
  session: { id: number };
  result: ExecuteTaskResult;
  resolvedWorktreePath: string | null;
  language: 'ja' | 'en';
  phaseStartedAt: Date;
}): Promise<{
  effectiveSuccess: boolean;
  phaseStatus: WorkflowAdvanceResult['status'];
  phaseError: string | undefined;
  superseded?: boolean;
}> {
  const { taskId, transition, session, result, resolvedWorktreePath, phaseStartedAt, language } =
    params;

  const updatedTask = await resolveTaskWorkflowState(taskId);
  const currentWfStatus = updatedTask?.workflowStatus || 'draft';
  if (await requirementReplannedSince(prisma, taskId, phaseStartedAt)) {
    log.info(
      { taskId, currentWfStatus },
      '[WorkflowCLIExecutor] Replan superseded this phase; skipping completion',
    );
    return {
      effectiveSuccess: false,
      phaseStatus: currentWfStatus as WorkflowAdvanceResult['status'],
      phaseError: 'Phase superseded by requirement replan',
      superseded: true,
    };
  }
  let effectiveSuccess = result.success;
  let phaseStatus = transition.nextStatus;
  let phaseError = effectiveSuccess ? undefined : result.errorMessage;

  if (transition.outputFile) {
    let fileContent = await readWorkflowFile(taskId, transition.outputFile);

    // A FAILED run may only be rescued by an artifact IT wrote. Task 901
    // (2026-09-13): the economy-tier verifier died on "Prompt is too long"
    // with 182 chars of output, the previous verify.md (⚠️ against an older
    // plan) was picked up here as this phase's output, "treated as success",
    // re-validated, and bounced the task into another self-repair round —
    // a loop with no new verification in it.
    if (!result.success && fileContent) {
      const artifact = await prisma.workflowFile
        .findFirst({
          where: { taskId, fileType: transition.outputFile },
          select: { updatedAt: true },
        })
        .catch(() => null);
      if (artifact && artifact.updatedAt.getTime() < phaseStartedAt.getTime()) {
        log.warn(
          {
            taskId,
            role: transition.role,
            outputFile: transition.outputFile,
            artifactUpdatedAt: artifact.updatedAt,
            phaseStartedAt,
          },
          '[WorkflowCLIExecutor] Agent failed and the existing artifact predates this phase — not reusing it',
        );
        fileContent = null;
      }
    }

    // Fallback: extract Markdown from raw output when agent did not save via API
    if (!fileContent && result.output && result.output.trim().length > 100) {
      // NOTE: A critic rejection archives the artifact, which makes
      // readWorkflowFile return null — without this guard the fallback would
      // re-extract the SAME rejected report from stdout and resurrect it,
      // defeating the harvest guard above through the back door.
      const { criticRejectedSince } = await import('./phase-critic/critic-rejection-guard');
      if (await criticRejectedSince(taskId, transition.outputFile, phaseStartedAt)) {
        log.warn(
          { taskId, role: transition.role, outputFile: transition.outputFile },
          '[WorkflowCLIExecutor] Critic rejected this artifact — skipping stdout-extraction fallback (would resurrect the rejected content)',
        );
      } else {
        log.info(
          `[WorkflowCLIExecutor] ${transition.outputFile}.md not found, extracting from output (${result.output.length} chars)`,
        );
        const extractedContent = extractMarkdownFromOutput(result.output, transition.outputFile);
        if (extractedContent) {
          try {
            await writeWorkflowFile(taskId, transition.outputFile, extractedContent);
            fileContent = extractedContent;
            log.info(
              `[WorkflowCLIExecutor] Saved extracted content (${extractedContent.length} chars)`,
            );
          } catch (fallbackErr) {
            // e.g. OpenSubtasksError from the choke-point guard — the phase
            // then reports no artifact instead of force-completing a parent.
            log.warn(
              { err: fallbackErr, taskId, outputFile: transition.outputFile },
              '[WorkflowCLIExecutor] Fallback save rejected by workflow-file guard',
            );
          }
        }
      }
    }

    if (fileContent) {
      // Structural validation: ensure the artifact has the required sections
      // so the next role isn't handed an under-specified document. We log the
      // result for observability but still advance — fail-soft for now.
      const validation = validateOutput(transition.outputFile, fileContent);
      if (!validation.ok) {
        log.warn(
          {
            taskId,
            role: transition.role,
            outputFile: transition.outputFile,
            missingSections: validation.missingSections,
            severity: validation.severity,
          },
          `[WorkflowCLIExecutor] ${validation.summary}`,
        );
      }

      // Code-grounded complexity: the research agent assessed the task AFTER
      // inspecting the repo and embedded a 0-100 score in research.md. Persist it
      // + re-select the mode (both directions) via the shared helper so the
      // auto-run and manual (HTTP) paths refine identically.
      if (transition.outputFile === 'research' && typeof fileContent === 'string') {
        try {
          const { applyResearchAssessedComplexity } = await import('./research-complexity');
          await applyResearchAssessedComplexity(taskId, fileContent);
        } catch (cErr) {
          log.warn(
            { err: cErr, taskId },
            '[WorkflowCLIExecutor] Failed to apply research-assessed complexity',
          );
        }
      }

      const isVerifyPhase = transition.outputFile === 'verify';
      const curRank = WF_STATUS_RANK[currentWfStatus] ?? 0;
      const nextRank = WF_STATUS_RANK[transition.nextStatus] ?? 0;

      if (isVerifyPhase) {
        phaseStatus = await resolveVerifyPhaseStatus({
          taskId,
          transition,
          session,
          currentWfStatus,
          fileContent,
          validation,
          resolvedWorktreePath,
        });
        if (phaseStatus === 'research_done') {
          return {
            effectiveSuccess: false,
            phaseStatus,
            phaseError: 'Phase superseded by requirement replan',
            superseded: true,
          };
        }
      } else if (
        currentWfStatus !== transition.nextStatus &&
        nextRank > curRank &&
        // A live question pause ranks 0, so the forward-only comparison alone
        // would advance right over it (task 551) — protect it explicitly.
        currentWfStatus !== 'awaiting_question'
      ) {
        // Advance FORWARD only. Never regress a status the HTTP handler already
        // advanced (e.g. plan auto-approved → plan_approved).
        await prisma.task.update({
          where: { id: taskId },
          data: { workflowStatus: transition.nextStatus },
        });
        // reconcileTaskStatusBeforeRun flips task.status off 'todo' before the
        // agent starts, but the startup reaper (lifecycle-manager) can revert
        // it back to 'todo' mid-run on a backend restart — the epilogue only
        // used to touch workflowStatus, so a restart landing in that window
        // left workflowStatus advanced while status stayed 'todo' (task #706).
        // Conditional on the DB row (not a caller snapshot) so 'blocked'/'done'
        // set concurrently by another actor is never clobbered.
        await prisma.task.updateMany({
          where: { id: taskId, status: 'todo' },
          data: { status: 'in-progress' },
        });
        const violations = await checkWorkflowInvariants(taskId);
        await recordTransition({
          taskId,
          fromStatus: currentWfStatus,
          toStatus: transition.nextStatus,
          actor: transition.role as TransitionActor,
          cause: `phase_completed:${transition.role}`,
          phase: transition.outputFile ?? transition.role,
          sessionId: session.id,
          metadata: {
            outputFile: transition.outputFile,
            chars: typeof fileContent === 'string' ? fileContent.length : 0,
          },
          invariantViolation: violations.length > 0,
          invariantMessage:
            violations.length > 0
              ? violations.map((v) => `${v.code}:${v.message}`).join(' | ')
              : undefined,
        });
        // Task 766: attempt missing_file self-repair AFTER the transition
        // above is recorded (auto-run path counterpart to status-transition.ts).
        const missingFileViolation = violations.find((v) => v.code === 'missing_file');
        if (missingFileViolation) {
          const { repairMissingFile } = await import('./invariant-repair');
          await repairMissingFile(taskId, missingFileViolation).catch((err) => {
            log.warn(
              { err, taskId },
              '[WorkflowCLIExecutor] repairMissingFile threw — failing open',
            );
            return { repaired: false as const };
          });
        }

        // Auto-approve plan when the user's settings allow it. Without
        // this, the orchestrator-driven planner phase would land on
        // `plan_created` and wait for a UI click — even when
        // `userSettings.autoApprovePlan = true` is enabled, because the
        // auto-approve helper used to live exclusively in the HTTP file
        // handler that the orchestrator path bypasses.
        if (transition.nextStatus === 'plan_created') {
          const approval = await maybeAutoApprovePlan(taskId, language).catch(() => null);
          if (approval?.autoApproved) {
            log.info(
              { taskId, reason: approval.reason },
              '[WorkflowCLIExecutor] Plan auto-approved after planner phase',
            );
            phaseStatus = 'plan_approved';
          }
        }
      } else {
        // Already at/past this phase's nextStatus (HTTP handler advanced it).
        phaseStatus = currentWfStatus as WorkflowAdvanceResult['status'];
      }
      if (!effectiveSuccess) {
        log.info(
          `[WorkflowCLIExecutor] Agent reported failure but ${transition.outputFile}.md exists, treating as success`,
        );
        effectiveSuccess = true;
      }
    } else if (currentWfStatus === 'awaiting_question') {
      // Not a failure: the agent found the request ambiguous and legitimately
      // saved question.md instead of transition.outputFile, pausing for the
      // user's answer. Without this branch, every such intake-question pause
      // was misreported as "file was not saved", which fed into the auto-run
      // scheduler's genuine-failure path (task.status -> 'blocked') even
      // though the task was only waiting on the user, not actually stuck.
      effectiveSuccess = true;
      phaseStatus = 'awaiting_question';
      phaseError = undefined;
      log.info(
        { taskId, role: transition.role, outputFile: transition.outputFile },
        '[WorkflowCLIExecutor] Agent paused for an intake question instead of saving the phase file — treating as a legitimate pause, not a failure',
      );
    } else {
      effectiveSuccess = false;
      phaseStatus = currentWfStatus as WorkflowAdvanceResult['status'];
      phaseError =
        `${transition.outputFile}.md was not saved. ` +
        'The workflow phase cannot be completed until the required file is written via the workflow API.';
      log.warn(
        {
          taskId,
          role: transition.role,
          outputFile: transition.outputFile,
          agentSuccess: result.success,
          outputLength: result.output?.length ?? 0,
        },
        '[WorkflowCLIExecutor] Required workflow file was not saved; treating phase as failed',
      );
    }
  } else if (
    effectiveSuccess &&
    currentWfStatus !== transition.nextStatus &&
    // NOTE: Same forward-only rule as the outputFile path above — but this
    // no-outputFile (implementer) epilogue historically had NO guard at all
    // and blindly stamped nextStatus. Observed twice on task 551: it clobbered
    // a live question pause (awaiting_question → in_progress, orphaning
    // question.md) and later un-did a legitimate completion (completed →
    // in_progress on a stale re-run). awaiting_question must be checked
    // explicitly because its rank is 0 — a rank comparison alone reads the
    // pause as "behind" and advances straight over it.
    currentWfStatus !== 'awaiting_question' &&
    (WF_STATUS_RANK[transition.nextStatus] ?? 0) > (WF_STATUS_RANK[currentWfStatus] ?? 0)
  ) {
    await prisma.task.update({
      where: { id: taskId },
      data: { workflowStatus: transition.nextStatus },
    });
    // Same status-desync backstop as the outputFile branch above (task #706)
    // — this no-outputFile (implementer) path advances workflowStatus too.
    await prisma.task.updateMany({
      where: { id: taskId, status: 'todo' },
      data: { status: 'in-progress' },
    });
    await recordTransition({
      taskId,
      fromStatus: currentWfStatus,
      toStatus: transition.nextStatus,
      actor: transition.role as TransitionActor,
      cause: `phase_completed:${transition.role}`,
      phase: transition.outputFile ?? transition.role,
      sessionId: session.id,
      metadata: { outputFile: transition.outputFile ?? null },
    });
  } else if (effectiveSuccess && currentWfStatus !== transition.nextStatus) {
    log.info(
      { taskId, role: transition.role, currentWfStatus, nextStatus: transition.nextStatus },
      '[WorkflowCLIExecutor] Skipping phase-completion status write — task is paused or already past this phase',
    );
  }

  return { effectiveSuccess, phaseStatus, phaseError };
}
