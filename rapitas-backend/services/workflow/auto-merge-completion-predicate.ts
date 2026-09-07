import type { Prisma } from '../../generated/prisma-postgres';
/** Applied by the terminal UPDATE itself, not only a preceding read. */
export function autoMergeCompletionPredicate(taskId: number): Prisma.TaskWhereInput {
  return {
    id: taskId,
    OR: [
      { status: 'in-progress', workflowStatus: 'verify_done' },
      { status: { in: ['done', 'completed'] }, workflowStatus: 'completed' },
    ],
    NOT: {
      developerModeConfig: {
        is: {
          agentSessions: {
            some: {
              agentExecutions: { some: { status: 'canceling' } },
            },
          },
        },
      },
    },
  };
}
