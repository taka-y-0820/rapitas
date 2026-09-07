/** Recover verified tasks stranded after GitHub merged but task persistence failed. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrismaClient } from '../../generated/prisma-postgres';
import { resolveAutomationPolicy } from './automation-policy';
import { resolveIntegrationId } from '../github/pr-link';
import { autoMergeCompletionPredicate } from './auto-merge-completion-predicate';
import { createLogger } from '../../config/logger';

const run = promisify(execFile);
const log = createLogger('workflow:auto-merge-recovery');
type MergeEvidence = { state: string; number: number; url: string; mergedAt: string | null };
export async function readMergedPr(repository: string, number: number): Promise<MergeEvidence> {
  const executable = process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';
  const { stdout } = await run(
    executable,
    ['pr', 'view', String(number), '--repo', repository, '--json', 'state,number,url,mergedAt'],
    { timeout: 15000, windowsHide: true },
  );
  return JSON.parse(stdout) as MergeEvidence;
}

/** No Git mutations: only complete the unchanged task after authoritative merge evidence. */
export async function recoverMergedTasks(
  db: PrismaClient,
  read: typeof readMergedPr = readMergedPr,
): Promise<number> {
  const tasks = await db.task.findMany({
    where: { status: 'in-progress', workflowStatus: 'verify_done', githubPrId: { not: null } },
    select: {
      id: true,
      githubPrId: true,
      updatedAt: true,
      workingDirectory: true,
      theme: { select: { repositoryUrl: true, workingDirectory: true } },
    },
  });
  let recovered = 0;
  for (const task of tasks) {
    try {
      if (!task.githubPrId || !(await resolveAutomationPolicy(db, task.id)).autoMergePR) continue;
      const integrationId = await resolveIntegrationId(
        db,
        task.theme?.repositoryUrl ?? null,
        task.workingDirectory ?? task.theme?.workingDirectory ?? null,
      );
      if (integrationId == null) continue;
      const pr = await db.gitHubPullRequest.findFirst({
        where: { integrationId, prNumber: task.githubPrId, state: 'merged' },
        select: {
          url: true,
          linkedTaskId: true,
          integration: { select: { ownerName: true, repositoryName: true } },
        },
      });
      if (!pr || (pr.linkedTaskId != null && pr.linkedTaskId !== task.id)) continue;
      const executions = await db.agentExecution.findMany({
        where: { session: { config: { taskId: task.id } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, status: true, completedAt: true, createdAt: true },
      });
      const latest = executions[0];
      if (
        !latest ||
        latest.status !== 'completed' ||
        !latest.completedAt ||
        executions.some((e) => !['completed', 'failed', 'cancelled', 'canceled'].includes(e.status))
      )
        continue;
      const evidence = await read(
        `${pr.integration.ownerName}/${pr.integration.repositoryName}`,
        task.githubPrId,
      );
      const mergedAt = evidence.mergedAt ? new Date(evidence.mergedAt) : null;
      if (
        evidence.state !== 'MERGED' ||
        evidence.number !== task.githubPrId ||
        evidence.url !== pr.url ||
        !mergedAt ||
        !Number.isFinite(mergedAt.getTime()) ||
        latest.completedAt > mergedAt ||
        latest.createdAt > mergedAt
      )
        continue;
      // Freeze task revision and execution membership in the terminal UPDATE. A new run,
      // reopened execution or stop intent during GitHub I/O must defeat recovery.
      const result = await db.task.updateMany({
        where: {
          AND: [
            autoMergeCompletionPredicate(task.id),
            {
              status: 'in-progress',
              workflowStatus: 'verify_done',
              githubPrId: task.githubPrId,
              updatedAt: task.updatedAt,
              developerModeConfig: {
                is: {
                  agentSessions: {
                    every: {
                      agentExecutions: {
                        every: {
                          id: { in: executions.map((e) => e.id) },
                          status: { in: ['completed', 'failed', 'cancelled', 'canceled'] },
                        },
                      },
                    },
                    some: {
                      agentExecutions: {
                        some: {
                          id: latest.id,
                          status: 'completed',
                          completedAt: latest.completedAt,
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
      });
      recovered += result.count;
      if (result.count)
        log.info(
          { taskId: task.id, prNumber: task.githubPrId },
          'Recovered merged task completion',
        );
    } catch (err) {
      log.warn({ err, taskId: task.id }, 'Merged task recovery deferred');
    }
  }
  return recovered;
}
