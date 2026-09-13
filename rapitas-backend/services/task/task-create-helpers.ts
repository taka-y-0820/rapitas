/**
 * TaskCreateHelpers
 *
 * Internal helpers for creating subtasks and parent tasks.
 * Called exclusively by task-mutations.ts — not part of the public API.
 */
import { PrismaClient, Prisma } from '../../generated/prisma-postgres';
import { createLogger } from '../../config/logger';
import { isApiRecoveryMode } from '../system/api-recovery-mode';
import { getInsensitiveMode } from '../../config/db-provider';
import { UserBehaviorService } from '../../src/services/user-behavior-service';
import {
  analyzeTaskComplexityWithLearning,
  type TaskComplexityInput,
} from '../workflow/complexity-analyzer';
import { TASK_FULL_INCLUDE } from './task-mutations';
import type { CreateTaskInput } from './task-mutations';

type PrismaInstance = InstanceType<typeof PrismaClient>;

const logger = createLogger('task-create-helpers');

function titleEqualsFilter(title: string) {
  return { equals: title, ...getInsensitiveMode() };
}

/**
 * Creates a subtask under an existing parent, preventing duplicates via Serializable transaction.
 *
 * @param prisma - Prisma client instance / Prismaクライアント
 * @param parentId - Parent task ID / 親タスクID
 * @param title - Subtask title / サブタスクタイトル
 * @param labelIds - Optional label IDs to attach / 付与するラベルID
 * @param data - Remaining create fields / 残りの作成フィールド
 * @returns Created or existing duplicate subtask / 作成済みまたは重複サブタスク
 * @throws {Error} When parent task does not exist / 親タスクが存在しない場合
 */
export async function createSubtask(
  prisma: PrismaInstance,
  parentId: number,
  title: string,
  labelIds: number[] | undefined,
  data: Omit<CreateTaskInput, 'title' | 'parentId' | 'labelIds'>,
) {
  const parentTask = await prisma.task.findUnique({
    where: { id: parentId },
    select: { id: true },
  });

  if (!parentTask) {
    throw new Error(`親タスク(ID: ${parentId})が見つかりません`);
  }

  return prisma.$transaction(
    async (tx) => {
      const existingSubtask = await tx.task.findFirst({
        // HACK(agent): Prisma's StringFilter type doesn't support runtime conditional mode property
        where: { parentId, title: titleEqualsFilter(title) } as Prisma.TaskWhereInput,
      });

      if (existingSubtask) {
        logger.info(
          `[task-create-helpers] Duplicate subtask prevented: "${title}" for parent ${parentId}`,
        );
        return tx.task.findUnique({
          where: { id: existingSubtask.id },
          include: TASK_FULL_INCLUDE,
        });
      }

      const task = await tx.task.create({
        data: {
          title,
          ...(data.description && { description: data.description }),
          status: data.status ?? 'todo',
          priority: data.priority ?? 'medium',
          ...(data.labels && { labels: data.labels }),
          ...(data.estimatedHours && { estimatedHours: data.estimatedHours }),
          ...(data.actualHours && { actualHours: data.actualHours }),
          ...(data.dueDate && { dueDate: new Date(data.dueDate) }),
          ...(data.subject && { subject: data.subject }),
          parentId,
          ...(data.projectId && { projectId: data.projectId }),
          ...(data.milestoneId && { milestoneId: data.milestoneId }),
          ...(data.themeId !== undefined && { themeId: data.themeId }),
          ...(data.examGoalId !== undefined && { examGoalId: data.examGoalId }),
          ...(data.isDeveloperMode !== undefined && { isDeveloperMode: data.isDeveloperMode }),
          ...(data.isAiTaskAnalysis !== undefined && { isAiTaskAnalysis: data.isAiTaskAnalysis }),
          // NOTE: Structured spec stored as JSON-array strings, mirroring `labels`.
          ...(data.goals && data.goals.length > 0 && { goals: JSON.stringify(data.goals) }),
          ...(data.constraints &&
            data.constraints.length > 0 && { constraints: JSON.stringify(data.constraints) }),
          ...(data.acceptanceCriteria &&
            data.acceptanceCriteria.length > 0 && {
              acceptanceCriteria: JSON.stringify(data.acceptanceCriteria),
            }),
        },
      });

      if (labelIds && labelIds.length > 0) {
        await tx.taskLabel.createMany({
          data: labelIds.map((labelId: number) => ({ taskId: task.id, labelId })),
        });
      }

      return tx.task.findUnique({
        where: { id: task.id },
        include: TASK_FULL_INCLUDE,
      });
    },
    { isolationLevel: 'Serializable' },
  );
}

/**
 * Creates a top-level (parent) task and auto-assigns workflow mode from complexity analysis.
 *
 * @param prisma - Prisma client instance / Prismaクライアント
 * @param title - Task title / タスクタイトル
 * @param labelIds - Optional label IDs to attach / 付与するラベルID
 * @param data - Remaining create fields / 残りの作成フィールド
 * @returns Created task with full includes / フルインクルード付きの作成タスク
 */
export async function createParentTask(
  prisma: PrismaInstance,
  title: string,
  labelIds: number[] | undefined,
  data: Omit<CreateTaskInput, 'title' | 'parentId' | 'labelIds'>,
) {
  const task = await prisma.task.create({
    data: {
      title,
      ...(data.description && { description: data.description }),
      status: data.status ?? 'todo',
      priority: data.priority ?? 'medium',
      ...(data.labels && { labels: data.labels }),
      ...(data.estimatedHours && { estimatedHours: data.estimatedHours }),
      ...(data.actualHours && { actualHours: data.actualHours }),
      ...(data.dueDate && { dueDate: new Date(data.dueDate) }),
      ...(data.subject && { subject: data.subject }),
      ...(data.projectId && { projectId: data.projectId }),
      ...(data.milestoneId && { milestoneId: data.milestoneId }),
      ...(data.themeId !== undefined && { themeId: data.themeId }),
      ...(data.examGoalId !== undefined && { examGoalId: data.examGoalId }),
      ...(data.isDeveloperMode !== undefined && { isDeveloperMode: data.isDeveloperMode }),
      ...(data.isAiTaskAnalysis !== undefined && { isAiTaskAnalysis: data.isAiTaskAnalysis }),
      // NOTE: Structured spec stored as JSON-array strings, mirroring `labels`.
      ...(data.goals && data.goals.length > 0 && { goals: JSON.stringify(data.goals) }),
      ...(data.constraints &&
        data.constraints.length > 0 && { constraints: JSON.stringify(data.constraints) }),
      ...(data.acceptanceCriteria &&
        data.acceptanceCriteria.length > 0 && {
          acceptanceCriteria: JSON.stringify(data.acceptanceCriteria),
        }),
    },
  });

  if (labelIds && labelIds.length > 0) {
    await prisma.taskLabel.createMany({
      data: labelIds.map((labelId: number) => ({ taskId: task.id, labelId })),
    });
  }

  const createdTask = await prisma.task.findUnique({
    where: { id: task.id },
    include: TASK_FULL_INCLUDE,
  });

  if (createdTask && !isApiRecoveryMode()) {
    await UserBehaviorService.recordTaskCreated(createdTask.id, createdTask);

    // NOTE: Auto-assign workflow mode based on complexity analysis + learning history
    try {
      const complexityInput: TaskComplexityInput = {
        title,
        description: data.description || undefined,
        estimatedHours: data.estimatedHours || undefined,
        priority: (data.priority as 'low' | 'medium' | 'high' | 'urgent') || 'medium',
        // Real label names + theme + structured spec so every factor (and the
        // learning lookup) gets meaningful input instead of neutral defaults.
        labels: createdTask.taskLabels?.map((tl) => tl.label.name) ?? [],
        themeId: data.themeId,
        goals: data.goals,
        constraints: data.constraints,
        acceptanceCriteria: data.acceptanceCriteria,
      };
      const analysis = await analyzeTaskComplexityWithLearning(complexityInput);

      // Map the score to a mode via the DB-configured complexity ranges
      // (UI-editable) instead of the hardcoded 35/70 split.
      const { getAllModeSettings, recommendModeFromSettings } =
        await import('../workflow/workflow-mode-config');
      const settingsMode = recommendModeFromSettings(
        analysis.complexityScore,
        await getAllModeSettings(),
      );

      // Learned mode rules (nightly-generated from real outcomes) refine the
      // settings-based default. Creation-time only — a user changing the mode
      // later in the UI is the override and is never touched by rules.
      const { applyModeRules } = await import('../workflow/learning/workflow-learning-optimizer');
      const ruleDecision = await applyModeRules(
        { themeId: data.themeId ?? null },
        analysis.complexityScore,
        settingsMode,
      );
      const recommendedMode = ruleDecision.mode;
      if (ruleDecision.ruleIds.length > 0) {
        // Surface the rule application in the task's activity log so the user
        // can see WHY the mode differs from the complexity-range default.
        await prisma.activityLog
          .create({
            data: {
              taskId: createdTask.id,
              action: 'workflow_mode_rule_applied',
              metadata: JSON.stringify({
                baseMode: settingsMode,
                appliedMode: ruleDecision.mode,
                ruleIds: ruleDecision.ruleIds,
                reasons: ruleDecision.reasons,
              }),
            },
          })
          .catch(() => {});
      }

      // NOTE: The metadata heuristic score is used ONLY to pick the initial
      // workflow mode — it is deliberately NOT persisted to complexityScore.
      // That column now holds exclusively the code-grounded value the research
      // agent assesses after inspecting the repo (applyResearchAssessedComplexity);
      // the UI shows 複雑度"-" until then. Persisting the title/description
      // heuristic here made a weak a-priori guess look like a measured value
      // and fed model routing before research ever ran.
      await prisma.task.update({
        where: { id: createdTask.id },
        data: { workflowMode: recommendedMode },
      });
      logger.info(
        `[task-create-helpers] Auto-assigned workflow mode: ${recommendedMode} (heuristic score: ${analysis.complexityScore}, not persisted) for task ${createdTask.id}`,
      );
    } catch (err) {
      // NOTE: Complexity analysis failure should not block task creation
      logger.debug(
        { err },
        `[task-create-helpers] Complexity analysis failed for task ${createdTask.id}`,
      );
    }
  }

  return createdTask;
}
