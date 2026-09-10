/**
 * execution/execute-route
 *
 * POST /tasks/:id/execute — validates the task, acquires an execution lock,
 * delegates DB/worktree setup to execute-setup.ts, launches the agent worker
 * asynchronously, and returns immediately with the new session ID.
 *
 * Related modules:
 * - execute-setup.ts         DB and worktree setup
 * - execute-post-handler.ts  Async result handling (task/session status, code review)
 * - instruction-builder.ts   Full instruction string assembly
 */

import { Elysia, t } from 'elysia';
import { join } from 'path';
import { buildResearchPrompt } from '../research/research-prompt-builder';
import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { getProjectRoot } from '../../../../config';
import { AgentWorkerManager } from '../../../../services/agents/agent-worker-manager';
import { analyzeTaskComplexity } from '../../../../services/workflow/complexity-analyzer';
import { parseSpecArray } from '../../../../utils/common';
import { agentRateLimiter } from '../../../../middleware/rate-limiter';
import { acquireTaskExecutionLock, releaseTaskExecutionLock } from '../shared/execution-lock';
import { getTaskExecutionLockOwner } from '../../../../services/agents/task-execution-lock';
import {
  prepareManualExecution,
  settleManualExecution,
} from '../shared/manual-execution-settlement';
import { handleExecuteResult } from '../post-handlers/execute-post-handler';
import { handleManualExecutionError } from '../post-handlers/manual-execution-error';
import { buildFullInstruction, fetchAnalysisInfo } from '../shared/instruction-builder';
import { executeSetup } from '../shared/execute-setup';
import { resolveTaskForExecution } from '../../../../services/task/task-resolver';
import { narrowWorkflowMode } from '../../../../services/workflow/workflow-types.guards.generated';
import { resolveAgentForTask } from '../../../../services/workflow/role-resolver';
import { resolveEffectiveAutoApprovePlan } from '../../../../services/workflow/plan-auto-approve';
import { resolveEffectiveWorkflowDisabled } from '../../../../services/workflow/workflow-disabled';
import { buildHypothesisContext } from '../../../../services/workflow/workflow-hypothesis-context';
import {
  startWorktreeDependenciesInstall,
  taskNeedsDependencies,
} from '../../../../services/agents/orchestrator/git-operations/worktree/dependency-installer';
import { assertSafeGitRef } from '../../../../utils/common/branch-name-generator';
import type { AttachmentDescriptor } from '../shared/instruction-builder';
import { readPromptLanguage } from '../../../../services/system/prompt-language-store';

const log = createLogger('routes:agent-execution:execute');
const agentWorkerManager = AgentWorkerManager.getInstance();

export const executeRoute = new Elysia().post(
  '/tasks/:id/execute',
  async (context) => {
    const ip = context.headers?.['x-forwarded-for'] || 'local';
    if (
      !agentRateLimiter(
        context.set as { status?: number | string; headers: Record<string, string> },
        ip,
      )
    ) {
      return { success: false, error: 'Too many requests. Please try again later.' };
    }
    const params = context.params as { id: string };
    const body = context.body as {
      agentConfigId?: number;
      workingDirectory?: string;
      timeout?: number;
      instruction?: string;
      branchName?: string;
      /**
       * Base branch the new feature branch is cut FROM and the PR targets.
       * When omitted, falls back to the theme's defaultBranch (then 'develop').
       * The new branch is created from `origin/<baseBranch>` and the PR is
       * opened against the same branch (branch-from === PR-into).
       */
      baseBranch?: string;
      useTaskAnalysis?: boolean;
      optimizedPrompt?: string;
      sessionId?: number;
      attachments?: AttachmentDescriptor[];
      /**
       * Execution mode. `research` runs the agent as a strict
       * investigation-only role: no dependency install, no test/build/lint
       * execution, no plan.md gating, ANY git diff is reverted, and the
       * agent's final assistant message is captured to research.md
       * server-side. `development` is the default implementation mode.
       */
      mode?: 'research' | 'development';
    };
    const { id } = params;
    const taskIdNum = parseInt(id);
    const {
      agentConfigId,
      workingDirectory,
      timeout,
      instruction,
      branchName,
      baseBranch,
      useTaskAnalysis,
      optimizedPrompt,
      sessionId,
      attachments,
      mode,
    } = body;
    // Research mode is entered when the caller explicitly requests it OR when
    // the task is in the planning-stage workflow state (no plan.md yet).
    const isResearchMode = mode === 'research';

    const task = await resolveTaskForExecution(taskIdNum);
    if (!task) {
      context.set.status = 404;
      return { error: 'Task not found' };
    }

    // Task-level Task.workflowDisabled OR the global
    // UserSettings.workflowDisabledGlobally — see workflow-disabled.ts. Skips
    // complexity analysis (no mode to pick) and tells buildFullInstruction to
    // inject direct-implementation instructions instead of the phase-gated
    // research/plan workflow.
    const effectiveWorkflowDisabled = await resolveEffectiveWorkflowDisabled(taskIdNum);

    // Block manual execution while the theme's auto-run mode is active.
    // The scheduler owns exclusive control; allow only when no auto-run is running/paused.
    if (task.themeId) {
      const { isThemeAutoRunActive } =
        await import('../../../../services/workflow/auto-run/theme-auto-run-service');
      const autoRunActive = await isThemeAutoRunActive(task.themeId);
      if (autoRunActive) {
        context.set.status = 409;
        return {
          success: false,
          error: 'このテーマは自動実行モード中です。手動実行するには自動実行を停止してください。',
          code: 'AUTO_RUN_ACTIVE',
        };
      }
    }

    if (!acquireTaskExecutionLock(taskIdNum)) {
      log.warn(`[API] Duplicate execution rejected for task ${taskIdNum}: in-memory lock held`);
      context.set.status = 409;
      return { error: 'This task is already running. Please try again after completion.' };
    }
    const executionOwner = getTaskExecutionLockOwner(taskIdNum)!;
    const isCurrent = () => getTaskExecutionLockOwner(taskIdNum) === executionOwner;

    const earlyReturn = (response: Record<string, unknown>) => {
      releaseTaskExecutionLock(taskIdNum, executionOwner);
      return response;
    };

    return prepareManualExecution(taskIdNum, executionOwner, async () => {
      // Auto-analyze complexity if not yet scored (skipped when the workflow is
      // disabled — there's no phase-based mode to pick for a direct-implementation run).
      if (
        !effectiveWorkflowDisabled &&
        task.complexityScore === null &&
        !task.workflowModeOverride
      ) {
        try {
          const complexityInput = {
            title: task.title,
            description: task.description,
            estimatedHours: task.estimatedHours,
            labels: parseSpecArray(task.labels),
            priority: task.priority,
            themeId: task.themeId,
            goals: parseSpecArray(task.goals),
            constraints: parseSpecArray(task.constraints),
            acceptanceCriteria: parseSpecArray(task.acceptanceCriteria),
          };
          const analysisResult = analyzeTaskComplexity(complexityInput);
          // Map the score to a mode using the DB-configured complexity ranges
          // (UI-editable) rather than the hardcoded 35/70 split.
          const { getAllModeSettings, recommendModeFromSettings } =
            await import('../../../../services/workflow/workflow-mode-config');
          const recommendedMode = recommendModeFromSettings(
            analysisResult.complexityScore,
            await getAllModeSettings(),
          );
          await prisma.task.update({
            where: { id: taskIdNum },
            data: {
              complexityScore: analysisResult.complexityScore,
              workflowMode: recommendedMode,
            },
          });
          task.complexityScore = analysisResult.complexityScore;
          task.workflowMode = recommendedMode;
        } catch (error) {
          log.error(
            { err: error },
            `[API] Failed to analyze task complexity for task ${taskIdNum}`,
          );
        }
      }

      if (!task.theme?.isDevelopment && !workingDirectory) {
        context.set.status = 400;
        return earlyReturn({
          error:
            'Only tasks belonging to themes set in development projects can be executed. Please check theme settings.',
        });
      }

      // CRITICAL: Require explicit workingDirectory to prevent accidental modification of rapitas source
      const workDir = workingDirectory || task.theme?.workingDirectory;
      if (!workDir) {
        context.set.status = 400;
        return earlyReturn({
          error:
            'Task theme must have workingDirectory configured. Please set the working directory in theme settings to prevent accidental modification of rapitas source code.',
        });
      }

      // NOTE: Log warning when workingDirectory overlaps with rapitas project — allowed but flagged
      const projectRoot = getProjectRoot();
      if (workDir === projectRoot || workDir.startsWith(join(projectRoot, 'rapitas-'))) {
        log.warn(
          `[API] Task ${taskIdNum}: workingDirectory overlaps with rapitas project (${workDir}). Proceeding as user-intended.`,
        );
      }

      log.info(`[API] Executing task ${taskIdNum} in working directory: ${workDir}`);

      // Intake quality gate (manual-run path). The auto-run orchestrator runs this
      // BEFORE dispatching research (workflow-orchestrator draft→researcher branch);
      // the manual "実行" path dispatches the researcher agent DIRECTLY, so without
      // this a thin-spec draft task would skip the clarifying question entirely.
      // Only gate a FRESH draft run (not a continuation/`sessionId`, not an ad-hoc
      // `instruction` run). Fail-open: never block execution on a gate error.
      if (task.workflowStatus === 'draft' && !instruction && !sessionId) {
        try {
          const { ensureIntakeReady } = await import('../../../../services/intake');
          const intake = await ensureIntakeReady(taskIdNum);
          if (intake.status === 'awaiting_question') {
            log.info(
              `[API] Task ${taskIdNum}: intake gate raised a clarifying question — pausing before research (no agent launched).`,
            );
            return earlyReturn({
              success: true,
              status: 'awaiting_question',
              workflowStatus: 'awaiting_question',
              message:
                intake.message ??
                '仕様が不十分なため確認の質問を作成しました（回答されるまで先に進みません）',
            });
          }
        } catch (err) {
          log.warn(
            { err, taskId: taskIdNum },
            '[API] intake gate failed — proceeding to research (fail-open)',
          );
        }
      }

      // Resolve the base branch: explicit request value → theme default → develop.
      // It is used both as the branch-from base (worktree) AND the PR target, so
      // the two always match. Persisting it to agentExecutionConfig.targetBranch
      // is what makes the later auto-PR open against the chosen base.
      // Reject shell-metacharacter / traversal payloads in caller-supplied refs
      // BEFORE they reach any git command (defense-in-depth with the array-form
      // git calls). branchName/baseBranch flow into worktree creation.
      try {
        if (typeof branchName === 'string' && branchName.trim()) {
          assertSafeGitRef(branchName.trim(), 'branchName');
        }
        if (typeof baseBranch === 'string' && baseBranch.trim()) {
          assertSafeGitRef(baseBranch.trim(), 'baseBranch');
        }
      } catch (refErr) {
        context.set.status = 400;
        return earlyReturn({
          error: refErr instanceof Error ? refErr.message : 'Invalid branch name',
        });
      }

      const resolvedBaseBranch =
        (typeof baseBranch === 'string' && baseBranch.trim()) ||
        task.theme?.defaultBranch ||
        'develop';
      await prisma.agentExecutionConfig
        .updateMany({ where: { taskId: taskIdNum }, data: { targetBranch: resolvedBaseBranch } })
        .catch((err) => log.warn({ err, taskIdNum }, '[API] Failed to persist targetBranch'));

      let setupResult;
      try {
        setupResult = await executeSetup({
          taskIdNum,
          taskTitle: task.title,
          taskDescription: task.description,
          taskThemeRepositoryUrl: task.theme?.repositoryUrl,
          taskStartedAt: task.startedAt,
          existingConfig: task.developerModeConfig,
          sessionId,
          branchName,
          baseBranch: resolvedBaseBranch,
          workDir,
          currentWorkflowStatus: task.workflowStatus,
          workflowDisabled: effectiveWorkflowDisabled,
        });
      } catch (setupError) {
        const prismaCode = (setupError as Record<string, unknown>)?.code;
        if (prismaCode) {
          context.set.status = 500;
          return earlyReturn({
            error: 'Database query error occurred',
            code: prismaCode,
            details: setupError instanceof Error ? setupError.message : String(setupError),
          });
        }
        // Worktree creation failure
        return earlyReturn({ error: 'Failed to create worktree', branchName });
      }

      const { developerModeConfig, session, worktreePath } = setupResult;

      // Resolve which agent should run THIS task. The role-resolver consults:
      //   1. WorkflowRoleConfig (UI: AIエージェント管理ページ → ワークフローロール設定)
      //   2. Capability-based recommender (when role config is missing/disabled)
      // We also resolve the model: WorkflowRoleConfig.modelId → SmartRouter
      // auto-select when modelId is 'auto' or unset.
      let resolvedAgentConfigId = agentConfigId;
      let resolvedModelOverride: string | undefined;
      const roleAgent = await resolveAgentForTask(taskIdNum);

      // Tag the session with its workflow role (e.g. workflow-researcher). The
      // execute-route's run otherwise had a null session mode, so the FE could
      // not tell it was an auto-advancing phase: it showed "[完了] 実行が完了
      // しました" and stopped polling the moment this phase finished — even though
      // the orchestrator auto-advances to implement → verify (the agent keeps
      // running). With the mode set, the FE treats researcher/planner/
      // implementer as auto-advancing and keeps following the workflow until it
      // actually completes (verify → PR → done).
      if (roleAgent?.role) {
        await prisma.agentSession
          .update({ where: { id: session.id }, data: { mode: `workflow-${roleAgent.role}` } })
          .catch((err) =>
            log.warn({ err, taskIdNum, role: roleAgent.role }, '[API] Failed to set session mode'),
          );
      }
      if (roleAgent?.agentConfigId) {
        if (resolvedAgentConfigId !== roleAgent.agentConfigId) {
          log.info(
            `[API] Task ${taskIdNum}: WorkflowRoleConfig override — role=${roleAgent.role}, agentConfigId=${roleAgent.agentConfigId} (was ${resolvedAgentConfigId ?? 'default'})`,
          );
        }
        resolvedAgentConfigId = roleAgent.agentConfigId;
      }

      // Model selection: explicit roleAgent.modelId wins; otherwise SmartRouter
      // picks the best-fit model based on task complexity + budget + provider
      // preferences (cross-provider review bias mitigation included).
      if (roleAgent?.modelId) {
        resolvedModelOverride = roleAgent.modelId;
        log.info(
          { taskId: taskIdNum, role: roleAgent.role, model: resolvedModelOverride },
          '[API] Using per-role explicit model from WorkflowRoleConfig',
        );
      } else if (roleAgent?.shouldAutoSelectModel) {
        // Shared with the auto-run orchestrator (role-route-inputs) so a manual
        // run of the same phase gets the same model AND the same risk / retry /
        // evidence floors. This path used to call the router with provider
        // preferences only, which silently skipped every floor.
        const task = await prisma.task.findUnique({
          where: { id: taskIdNum },
          select: { title: true, description: true, labels: true, themeId: true },
        });
        if (task) {
          const { routeModelForRole } =
            await import('../../../../services/workflow/role-route-inputs');
          const routed = await routeModelForRole({
            taskId: taskIdNum,
            role: roleAgent.role,
            task,
          });
          resolvedModelOverride = routed.modelId;
          log.info(routed.details, '[API] Auto-selected model via Smart Router (auto mode)');
        }
      }

      // Switch the executor agent to one matching the chosen model's provider.
      // Mirrors `resolveExecutableAgentConfig` in workflow-orchestrator: when
      // SmartRouter (or a per-role explicit model) selects a model from a
      // different provider than the resolved agent's CLI, the original agent
      // (e.g. claude-code) cannot honor `--model gpt-...` and silently falls
      // back to its default. Picking a compatible agent (codex for openai,
      // gemini-cli for gemini, …) is what makes preferredProviderOverride
      // actually take effect end-to-end.
      if (resolvedModelOverride && resolvedAgentConfigId) {
        try {
          const [
            { inferProviderFromModelId },
            { agentTypeToProvider, findAgentConfigForProvider },
          ] = await Promise.all([
            import('../../../../services/workflow/role-provider-resolver'),
            import('../../../../services/ai/agent-fallback'),
          ]);
          const targetProvider = inferProviderFromModelId(resolvedModelOverride);
          const currentAgent = await prisma.aIAgentConfig
            .findUnique({
              where: { id: resolvedAgentConfigId },
              select: { id: true, agentType: true, name: true },
            })
            .catch(() => null);
          const currentProvider = agentTypeToProvider(currentAgent?.agentType);
          if (targetProvider && currentProvider && targetProvider !== currentProvider) {
            const compatible = await findAgentConfigForProvider(targetProvider, {
              excludeConfigId: resolvedAgentConfigId,
            });
            if (compatible) {
              log.info(
                {
                  taskId: taskIdNum,
                  role: roleAgent?.role,
                  model: resolvedModelOverride,
                  fromAgent: currentAgent?.name,
                  fromType: currentAgent?.agentType,
                  toAgent: compatible.name,
                  toType: compatible.agentType,
                },
                '[API] Switched executor agent to match selected model provider',
              );
              resolvedAgentConfigId = compatible.id;
            } else {
              // No compatible agent — passing the foreign-provider model to
              // the current agent will make the CLI reject it (e.g.
              // claude-code seeing `codex-auto-review`). Drop the override
              // so the agent uses its DB-configured default model instead.
              log.warn(
                {
                  taskId: taskIdNum,
                  role: roleAgent?.role,
                  model: resolvedModelOverride,
                  targetProvider,
                  currentAgentType: currentAgent?.agentType,
                },
                '[API] No compatible agent for selected model provider — DROPPING modelIdOverride and falling back to agent default',
              );
              resolvedModelOverride = undefined;
            }
          } else if (!targetProvider && resolvedModelOverride) {
            // We picked a model whose family we cannot infer (new release
            // naming, custom alias, …). Sending an unknown id to claude-code
            // produces "There's an issue with the selected model" and a 1.3s
            // dead-end. Verify the model name at least starts with a hint
            // matching the current agent's provider; otherwise drop the
            // override so the agent uses its default.
            const looksLikeOurFamily =
              (currentProvider === 'claude' &&
                /^(claude|opus|sonnet|haiku|anthropic)/i.test(resolvedModelOverride)) ||
              (currentProvider === 'openai' &&
                /^(gpt-|o\d|openai|chatgpt|codex)/i.test(resolvedModelOverride)) ||
              (currentProvider === 'gemini' && /^(gemini|google)/i.test(resolvedModelOverride)) ||
              (currentProvider === 'ollama' &&
                /(ollama|llama|qwen|mistral|deepseek|phi|gemma)/i.test(resolvedModelOverride));
            if (!looksLikeOurFamily) {
              log.warn(
                {
                  taskId: taskIdNum,
                  role: roleAgent?.role,
                  model: resolvedModelOverride,
                  currentAgentType: currentAgent?.agentType,
                },
                '[API] Selected model does not match agent provider family — DROPPING modelIdOverride',
              );
              resolvedModelOverride = undefined;
            }
          }
        } catch (switchErr) {
          log.warn(
            { err: switchErr, taskId: taskIdNum },
            '[API] Failed to align executor agent with model provider',
          );
        }
      }

      // NOTE: Workflow enforcement is suppressed when:
      //   - this execution is part of a workflow phase (orchestrator handles it)
      //   - the user passed an explicit `instruction` (free-form override)
      //   - an existing plan.md exists for this task (continuation past planning)
      //   - the resolved agent is codex (codex CLI fundamentally ignores
      //     "save plan and stop" instructions and always tries to implement;
      //     fighting it via prompts results in repeated revert loops). Codex
      //     runs without enforcement and the post-handler reviews the diff
      //     directly, mirroring how an engineer would use codex interactively.
      const existingPlan = await prisma.workflowFile
        .findFirst({
          where: { taskId: taskIdNum, fileType: 'plan' },
          select: { id: true },
        })
        .catch(() => null);
      // A prior research.md — so the prompt can tell the agent to reuse it on a
      // re-run instead of regenerating (see buildFullInstruction reuse section).
      const existingResearch = await prisma.workflowFile
        .findFirst({
          where: { taskId: taskIdNum, fileType: 'research' },
          select: { id: true },
        })
        .catch(() => null);
      const isContinuation = !!sessionId;
      const resolvedAgentConfig = resolvedAgentConfigId
        ? await prisma.aIAgentConfig
            .findUnique({
              where: { id: resolvedAgentConfigId },
              select: { agentType: true },
            })
            .catch(() => null)
        : null;
      const isCodexAgent = resolvedAgentConfig?.agentType === 'codex';

      // CRITICAL: When the resolved role is investigation-class
      // (researcher / planner) AND the agent is codex, downgrade
      // automatically to RESEARCH MODE. Without this, codex's
      // workflow-enforcement bypass would let it run implementation despite
      // being assigned the planner role — exactly the failure the user
      // reported. The downgrade applies even if the caller didn't pass
      // `mode: 'research'` explicitly.
      const investigationRoles = new Set(['researcher', 'planner']);
      const isInvestigationRole = !!roleAgent?.role && investigationRoles.has(roleAgent.role);

      // ALSO downgrade to research-only when the researcher's configured agent
      // differs from the planner's — otherwise the
      // workflow-enforcement injection tells the SAME researcher CLI to do
      // research + plan in one shot, silently bypassing the planner role's
      // configured agent. Splitting the phases lets each role run with its
      // own agent (and provider).
      let researcherPlannerSplit = false;
      if (roleAgent?.role === 'researcher' && resolvedAgentConfigId) {
        try {
          const downstream = await prisma.workflowRoleConfig.findMany({
            where: { role: { in: ['planner'] } },
            select: { role: true, agentConfigId: true, isEnabled: true },
          });
          researcherPlannerSplit = downstream.some(
            (r) => r.isEnabled && r.agentConfigId && r.agentConfigId !== resolvedAgentConfigId,
          );
        } catch {
          researcherPlannerSplit = false;
        }
      }

      const shouldForceResearch =
        !isResearchMode &&
        !instruction &&
        !isContinuation &&
        isInvestigationRole &&
        (isCodexAgent || researcherPlannerSplit);
      const effectiveResearchMode = isResearchMode || shouldForceResearch;
      if (shouldForceResearch) {
        const reason = isCodexAgent
          ? 'codex CLI does not honor "plan and stop"'
          : 'downstream phase (planner) is configured with a different agent — splitting researcher from planner so each role uses its own agent';
        log.warn(
          `[API] Task ${taskIdNum}: role=${roleAgent?.role} → research-only mode (${reason}).`,
        );
      }

      // In research mode, workflow injection is unnecessary and harmful — codex
      // gets a clean research-only prompt; we capture output via -o tempfile
      // and revert any code changes after the run.
      const enforceWorkflow =
        !effectiveResearchMode && !instruction && !isContinuation && !existingPlan && !isCodexAgent;
      if (effectiveResearchMode) {
        log.info(
          `[API] Task ${taskIdNum}: RESEARCH MODE active — skipping deps install / verification / plan.md gating. Any code change will be reverted.`,
        );
      } else if (isCodexAgent && !instruction && !isContinuation) {
        log.info(
          `[API] Task ${taskIdNum}: codex agent detected — running without workflow enforcement (codex CLI does not respect "plan and stop" instructions). Diff will be reviewed by post-handler.`,
        );
      }

      // We capture codex's final assistant message from STDOUT, NOT via the
      // CLI's --output-last-message flag. Reasoning: --output-last-message
      // requires codex to have file-write permission in the sandbox, which
      // contradicts the read-only investigation contract. codex always emits
      // its final message to stdout regardless of sandbox mode, and the
      // Rapitas backend (full permissions, outside sandbox) is the sole
      // writer for the persistent research.md.
      const researchTempOutputFile = null;
      const promptLanguage = readPromptLanguage();
      const taskSpec = {
        goals: parseSpecArray(task.goals),
        constraints: parseSpecArray(task.constraints),
        acceptanceCriteria: parseSpecArray(task.acceptanceCriteria),
      };
      // The hypothesis ledger (仮説台帳) — buildRoleContext already injects this
      // for the auto-run orchestrator's per-phase dispatch (workflow-orchestrator.ts),
      // but THIS manual "実行" button path builds its own separate prompt below and
      // never included it, so hypotheses were only ever filed while a theme's
      // auto-run was active. Skipped in research mode (buildResearchPrompt is a
      // completely separate template) and when the workflow is disabled (no
      // research.md is ever saved in that mode, so there's nothing to attach a
      // `## 仮説` section to).
      const hypothesisContext =
        enforceWorkflow && !effectiveWorkflowDisabled
          ? await buildHypothesisContext(taskIdNum, promptLanguage).catch(() => '')
          : '';

      const fullInstruction = effectiveResearchMode
        ? buildResearchPrompt(task.title, task.description ?? '', worktreePath)
        : buildFullInstruction({
            taskTitle: task.title,
            taskDescription: task.description,
            instruction,
            optimizedPrompt,
            attachments,
            workingDirectory: worktreePath,
            taskId: taskIdNum,
            enforceWorkflow,
            taskSpec,
            hasResearch: !!existingResearch,
            hasPlan: !!existingPlan,
            language: promptLanguage,
            // Lightweight tasks skip the plan phase: the workflow injection becomes
            // research → implement (no plan.md) instead of research → plan → stop.
            workflowMode: narrowWorkflowMode(task.workflowMode, 'standard'),
            workflowDisabled: effectiveWorkflowDisabled,
            hypothesisContext,
          });

      const analysisInfo =
        useTaskAnalysis && developerModeConfig
          ? await fetchAnalysisInfo(developerModeConfig.id)
          : undefined;

      const executionDir = worktreePath;

      // NOTE: Kick off dependency install in the BACKGROUND, but DO NOT await it
      // before launching the agent CLI. The agent typically spends 5-30s on
      // research/grep before attempting any verification command (vitest, build),
      // by which time the parallel pnpm install has usually finished. Worst case:
      // the agent's verification fails fast → empty diff → post-execution-review
      // marks the task as `blocked` and the user can re-run with logs.
      // This avoids the 30-90s "first log appears late" UX problem that came
      // from blocking the executeTask launch on install completion.
      // Research mode: skip dependency install entirely. The agent is read-only
      // and cannot run vitest/build/install commands anyway. This applies both
      // to explicit `mode: 'research'` calls AND auto-downgraded codex+planner.
      const needsDeps =
        !effectiveResearchMode && taskNeedsDependencies(task.title, task.description);
      if (needsDeps) {
        startWorktreeDependenciesInstall(executionDir).catch((error) => {
          log.warn(
            { err: error, taskId: taskIdNum },
            `[API] Background dependency install failed; verification commands may fail`,
          );
        });
        log.info(
          `[API] Task ${taskIdNum}: dependency install running in background (agent CLI launching now in parallel)`,
        );
      } else {
        log.info(
          `[API] Task ${taskIdNum}: skipping dependency install (task heuristic indicates no JS code change)`,
        );
      }

      // Resolve the EFFECTIVE auto-approve (task OR global OR subtask) so the
      // prompt's "proceed to implementation vs. stop and wait" branch matches what
      // maybeAutoApprovePlan will actually do. Without this, a globally-enabled
      // auto-approve left the prompt saying "stop", so the run ended at plan.md.
      const effectiveAutoApprovePlan = await resolveEffectiveAutoApprovePlan(taskIdNum);

      // NOTE: Execute in worktree directory for git isolation. We launch the
      // agent CLI immediately (no install gate) for fast UI feedback. The agent
      // worker spawns the codex/claude CLI process and the user starts seeing
      // output within ~2-3s instead of after the 30-90s install window.
      if (!isCurrent()) {
        context.set.status = 409;
        return earlyReturn({ success: false, error: 'Execution was cancelled during preparation' });
      }
      void settleManualExecution(
        agentWorkerManager.executeTask(
          {
            id: taskIdNum,
            title: task.title,
            description: fullInstruction,
            context: task.executionInstructions || undefined,
            workingDirectory: executionDir,
            autoApprovePlan: effectiveAutoApprovePlan,
            // Research mode: codex must run with --sandbox=read-only and
            // capture its final message via -o <tempfile>.
            investigationMode: effectiveResearchMode || undefined,
            outputLastMessageFile: researchTempOutputFile ?? undefined,
          },
          {
            taskId: taskIdNum,
            sessionId: session.id,
            agentConfigId: resolvedAgentConfigId,
            workingDirectory: executionDir,
            timeout,
            analysisInfo,
            // NOTE: Task detail execution has its own completion gate in
            // execute-post-handler/post-execution-review. The generic orchestrator
            // must not mark the task done just because the CLI process exited 0.
            autoCompleteTask: false,
            investigationMode: effectiveResearchMode || undefined,
            outputLastMessageFile: researchTempOutputFile ?? undefined,
            // Per-role model override (explicit pin or SmartRouter auto-pick).
            modelIdOverride: resolvedModelOverride,
          },
        ),
        {
          taskId: taskIdNum,
          owner: executionOwner,
          onResult: (result) =>
            handleExecuteResult({
              isExecutionCurrent: isCurrent,
              result,
              taskIdNum,
              sessionId: session.id,
              mode: effectiveResearchMode ? 'research' : 'development',
              researchTempOutputFile,
              configId: developerModeConfig.id,
              taskTitle: task.title,
              workDir,
              executionDir,
              branchName,
            }),
          onError: (cause) => handleManualExecutionError(cause, taskIdNum, session.id, isCurrent),
        },
      );

      return {
        success: true,
        message: 'Task execution started',
        sessionId: session.id,
        taskId: taskIdNum,
      };
    });
  },
  {
    params: t.Object({
      id: t.String(),
    }),
    // Explicit body schema: rejects unexpected/extra fields and non-JSON
    // content types (e.g. a form-urlencoded CSRF POST) at the framework layer,
    // before any handler logic runs. All fields optional — callers may execute
    // with just the path param.
    body: t.Optional(
      t.Object(
        {
          agentConfigId: t.Optional(t.Number()),
          workingDirectory: t.Optional(t.String()),
          timeout: t.Optional(t.Number()),
          instruction: t.Optional(t.String()),
          branchName: t.Optional(t.String()),
          baseBranch: t.Optional(t.String()),
          useTaskAnalysis: t.Optional(t.Boolean()),
          optimizedPrompt: t.Optional(t.String()),
          sessionId: t.Optional(t.Number()),
          attachments: t.Optional(t.Array(t.Any())),
          mode: t.Optional(t.Union([t.Literal('research'), t.Literal('development')])),
        },
        { additionalProperties: false },
      ),
    ),
  },
);
