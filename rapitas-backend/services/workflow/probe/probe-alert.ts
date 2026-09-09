import { writeBlockedTask } from '../blocked-task-write';
/**
 * probe-alert
 *
 * Escalates a permanent probe failure to a human immediately: files a concern
 * (submitConcern) and blocks the task so the existing `blocked`-task guard in
 * workflow-orchestrator-preflight.ts stops it from being re-dispatched. Never
 * throws — an alerting failure must not affect the probe result itself.
 */
import { prisma } from '../../../config/database';
import { createLogger } from '../../../config/logger';
import { submitConcern } from '../../memory/concern-backlog-service';
import type { ProbeTargetId } from './probe.types';
import type { WorkflowRole } from '../workflow-types';

const log = createLogger('workflow:probe-alert');

/**
 * Files a concern and blocks the task for a permanently-failing probe target.
 * Intentionally deduplicates per (taskId, targetId) rather than globally per
 * targetId — see plan.md's "設計判断の根拠 / アラート統合" for the rationale
 * (an operator-visible tradeoff, not an oversight).
 *
 * @param taskId - Task whose phase transition the probe blocked. / 対象タスクID
 * @param targetId - Probe target that failed permanently. / 失敗したprobe対象
 * @param role - Workflow role the probe ran ahead of. / 実行予定だったロール
 * @param errorMessage - Last probe error, for the concern detail. / 直近のprobeエラー
 */
export async function alertPermanentProbeFailure(
  taskId: number,
  targetId: ProbeTargetId,
  role: WorkflowRole,
  errorMessage: string | null,
): Promise<void> {
  try {
    await submitConcern({
      title: `Preflight probe permanently failed: ${targetId}`,
      detail:
        `タスク #${taskId} のフェーズ遷移前probe（対象: ${targetId}、ロール: ${role}）が` +
        `永続的障害と判定されました。人手での調査が必要です。\n\nエラー: ${errorMessage ?? '(不明)'}`,
      type: 'other',
      severity: 'high',
      originTaskId: taskId,
      source: 'agent',
      dedupKey: `probe-permanent-fail:${taskId}:${targetId}`,
    });
    await writeBlockedTask(prisma, taskId);
  } catch (err) {
    log.warn(
      { err, taskId, targetId },
      '[probe-alert] Failed to file concern / block task (probe result unaffected)',
    );
  }
}
