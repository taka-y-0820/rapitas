import { prisma } from '../config/database';
import { readReviewedPlanPolicy } from '../services/workflow/reviewed-plan-policy';
import { parseStoredRequirementArray } from '../services/workflow/requirement-replan-commit';
import { replanSnapshotDigest } from '../services/workflow/requirement-replan-evidence';
import {
  claimRequirementReview,
  seedLegacyUnknownRequirementReview,
} from '../services/workflow/requirement-review-claim';

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing required argument ${prefix}<value>`);
  return value;
}

const taskId = Number(argument('task-id'));
const reason = argument('reason');
if (!Number.isInteger(taskId) || taskId <= 0) throw new Error('task-id must be a positive integer');

try {
  const source = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: {
        title: true,
        description: true,
        goals: true,
        constraints: true,
        acceptanceCriteria: true,
        workflowMode: true,
      },
    });
    if (!task) throw new Error(`Task ${taskId} does not exist`);
    const files = await tx.workflowFile.findMany({
      where: { taskId, fileType: { in: ['plan', 'verify'] } },
      select: { fileType: true, content: true },
    });
    const plan = files.find((file) => file.fileType === 'plan');
    const verify = files.find((file) => file.fileType === 'verify');
    const planPolicy = await readReviewedPlanPolicy(tx, task.workflowMode ?? 'comprehensive');
    if (!verify || (planPolicy.includePlan && !plan)) {
      throw new Error(`Task ${taskId} does not have the review artifacts required for a snapshot`);
    }
    return {
      title: task.title,
      description: task.description ?? '',
      goals: parseStoredRequirementArray(task.goals),
      constraints: parseStoredRequirementArray(task.constraints),
      acceptanceCriteria: parseStoredRequirementArray(task.acceptanceCriteria),
      planPolicy,
      plan: plan?.content ?? '',
      verify: verify.content,
    };
  });
  const snapshotDigest = replanSnapshotDigest(source);
  const outcome = await seedLegacyUnknownRequirementReview(prisma, taskId, snapshotDigest, reason);
  let automaticAdmission: string | undefined;
  if (process.argv.includes('--verify-automatic')) {
    const pendingRetry = await prisma.requirementReviewRetryRequest.count({
      where: { taskId, consumedAt: null },
    });
    if (pendingRetry !== 0) {
      throw new Error(`Task ${taskId} has ${pendingRetry} pending explicit retry request(s)`);
    }
    automaticAdmission = (await claimRequirementReview(prisma, taskId, snapshotDigest)).kind;
    if (automaticAdmission !== 'cached') {
      throw new Error(`Historical snapshot was not suppressed: ${automaticAdmission}`);
    }
  }
  console.log(JSON.stringify({ taskId, snapshotDigest, outcome, automaticAdmission }));
} finally {
  await prisma.$disconnect();
}
