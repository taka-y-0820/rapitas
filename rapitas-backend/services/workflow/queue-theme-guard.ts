/** Queue repairs may omit themeId; consult the owning task before dispatch. */
import { prisma } from '../../config';
export async function isQueueThemeRunning(
  taskId: number,
  db: Pick<typeof prisma, 'task' | 'themeAutoRun'> = prisma,
): Promise<boolean> {
  try {
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: { themeId: true, status: true },
    });
    if (!task || ['blocked', 'failed', 'cancelled', 'canceled', 'canceling'].includes(task.status))
      return false;
    if (task.themeId == null) return true;
    const run = await db.themeAutoRun.findUnique({
      where: { themeId: task.themeId },
      select: { enabled: true, status: true },
    });
    return !run || (run.enabled && run.status === 'running');
  } catch {
    return false;
  }
}
