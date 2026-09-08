/** Recheck durable task/theme state at each asynchronous publication boundary. */
import { prisma } from '../../config/database';

export async function canContinueAutoMerge(taskId: number): Promise<boolean> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true, themeId: true },
    });
    if (!task || !['in-progress', 'in_progress', 'done', 'completed'].includes(task.status))
      return false;
    if (task.themeId != null) {
      const run = await prisma.themeAutoRun.findUnique({
        where: { themeId: task.themeId },
        select: { enabled: true, status: true },
      });
      if (run && (!run.enabled || run.status !== 'running')) return false;
    }
    return true;
  } catch {
    return false;
  }
}
