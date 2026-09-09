import {
  mockStopTaskTreeAgents,
  mockResumeTransition,
} from './theme-auto-run-scheduler.test-support.collaborator-mocks';
/**
 * theme-auto-run-scheduler.advance-active.test
 *
 * Covers advanceTheme() when a currentTaskId is already tracked: the hang
 * backstop, in-flight queue items (incl. the plan-approval pause), the
 * completed/failed terminal-item resolution, the "awaiting a user answer"
 * hold, and the vanished-queue-item re-enqueue recovery path.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ThemeAutoRunScheduler,
  internal,
  resetSchedulerSingleton,
  resetAllMocks,
  TEST_MAX_TASK_WALL_MS,
  mockIsAwaitingUserAnswer,
  mockHasLiveExecution,
  mockResolveLastProgressAt,
  mockNotifyAwaitingUserAnswer,
  mockNotifyHangBackstop,
  mockTaskUpdate,
  mockRevertChanges,
  mockResolveTaskWorkingDirectory,
  mockTransitionCount,
  mockOnTaskFailed,
  mockOnTaskCompleted,
  mockOnAwaitingPlanApproval,
  mockNotifyAwaitingPlanApproval,
  mockNotifyTaskSkipped,
  mockNotifyTaskVanished,
  mockGetThemeActiveQueueItems,
  mockQueueItemFindFirst,
  mockResolveTaskWorkflowState,
  mockEnqueue,
  mockSetCurrentTask,
  mockBroadcast,
  mockReleaseStaleActiveItems,
  mockIsOverlapHeld,
  mockRecordTransition,
} from './theme-auto-run-scheduler.test-support';

let scheduler: ThemeAutoRunScheduler;

/** ISO timestamp old enough to trip the hang backstop (MAX_TASK_WALL_MS + margin). */
function staleLastRunAt(): string {
  return new Date(Date.now() - TEST_MAX_TASK_WALL_MS - 500).toISOString();
}

/** ISO timestamp fresh enough to stay under the hang backstop. */
function freshLastRunAt(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  resetAllMocks();
  mockResumeTransition.mockReset().mockResolvedValue(null);
  mockStopTaskTreeAgents.mockClear();
  resetSchedulerSingleton();
  scheduler = ThemeAutoRunScheduler.getInstance();
  // Default: no active queue item and no terminal item, so tests that only
  // care about the hang backstop don't fall through into the vanished-item
  // re-enqueue path.
  mockGetThemeActiveQueueItems.mockResolvedValue([]);
});

describe('advanceTheme — hang backstop', () => {
  it.each(['todo', 'in-progress', 'blocked'])(
    'preserves %s question waits but releases the theme slot',
    async (status) => {
      mockResolveTaskWorkflowState.mockResolvedValue({
        id: 100,
        status,
        workflowStatus: 'awaiting_question',
        workflowMode: null,
        parentId: null,
      });
      for (let tick = 0; tick < 3; tick++) {
        await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());
      }
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockStopTaskTreeAgents).not.toHaveBeenCalled();
      expect(mockTaskUpdate).not.toHaveBeenCalled();
      expect(mockNotifyAwaitingUserAnswer).toHaveBeenCalledWith(1, 100);
      expect(mockSetCurrentTask).toHaveBeenCalledWith(1, null);
      mockResolveTaskWorkflowState.mockResolvedValue({
        id: 100,
        status: 'in-progress',
        workflowStatus: 'draft',
        workflowMode: null,
        parentId: null,
      });
      await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    },
  );
  it('holds (does not stop) a wedged task that is awaiting a user answer', async () => {
    mockIsAwaitingUserAnswer.mockResolvedValue(true);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, staleLastRunAt());

    expect(mockNotifyAwaitingUserAnswer).toHaveBeenCalledWith(1, 100);
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
  });

  it('force-stops and blocks a genuinely wedged task, then advances past it', async () => {
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'in-progress',
      workflowStatus: 'plan_approved',
      workflowMode: null,
      parentId: null,
    });

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, staleLastRunAt());

    expect(mockNotifyHangBackstop).toHaveBeenCalledWith(1, 100, expect.any(Number));
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 100, updatedAt: new Date(0) },
      data: { status: 'blocked', updatedAt: expect.any(Date) },
    });
    expect(mockOnTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining('100'));
    // Recurses with currentTaskId=null and globalActive decremented by 1.
    expect(mockBroadcast).toHaveBeenCalled();
    // Task 793: the row must name the backstop as the cause AND record a real
    // transition INTO blocked — fromStatus is the task's prior state
    // (workflowStatus 'plan_approved'), toStatus is 'blocked'. A self-loop
    // (from===to) would have hidden that the task actually became blocked.
    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition).toHaveBeenCalledWith({
      taskId: 100,
      fromStatus: 'plan_approved',
      toStatus: 'blocked',
      actor: 'system',
      cause: 'auto_run_hang_backstop',
      metadata: {
        wallMinutes: expect.any(Number),
        workflowStatus: 'plan_approved',
        taskStatusFrom: 'in-progress',
      },
    });
  });

  it('does not force-stop a task held by the overlap guard — the wait is queued behind an open auto-PR, not wedged (task 793)', async () => {
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    mockIsOverlapHeld.mockReturnValue(true);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, staleLastRunAt());

    expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
    expect(mockHasLiveExecution).not.toHaveBeenCalled();
  });

  it('defers the backstop while a live (fresh-heartbeat) execution is running — slow ≠ wedged (task 563)', async () => {
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    mockHasLiveExecution.mockResolvedValue(true);
    // In-flight queue item so the fall-through path waits instead of re-enqueuing.
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, staleLastRunAt());

    expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
  });

  it('still force-stops past the 3x hard ceiling even with a live heartbeat (runaway-token guard)', async () => {
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    mockHasLiveExecution.mockResolvedValue(true);
    const past3x = new Date(Date.now() - TEST_MAX_TASK_WALL_MS * 3 - 500).toISOString();

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, past3x);

    expect(mockNotifyHangBackstop).toHaveBeenCalled();
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 100, updatedAt: new Date(0) },
      data: { status: 'blocked', updatedAt: expect.any(Date) },
    });
  });

  it('フェーズ継ぎ目で直前に進捗があれば停止しない — 実行行が一瞬いない隙間 (task 585)', async () => {
    // implementer がコミットを終えて completed になり、verifier の実行行が
    // まだ作られていない30秒の隙間。hasLiveExecution は false になるが、
    // 8秒前に phase_completed 遷移がある = 進行中。
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    mockHasLiveExecution.mockResolvedValue(false);
    // 壁時計(テストでは短縮値)より新しい進捗 = 直前に前進している。
    mockResolveLastProgressAt.mockResolvedValue(
      Date.now() - Math.floor(TEST_MAX_TASK_WALL_MS / 10),
    );
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, staleLastRunAt());

    expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
  });

  it('進捗が途絶えていれば従来どおり停止する(本当のハング)', async () => {
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    mockHasLiveExecution.mockResolvedValue(false);
    // 最後の進捗が壁時計より前 = 動いていない。
    mockResolveLastProgressAt.mockResolvedValue(Date.now() - TEST_MAX_TASK_WALL_MS - 5_000);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, staleLastRunAt());

    expect(mockNotifyHangBackstop).toHaveBeenCalled();
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 100, updatedAt: new Date(0) },
      data: { status: 'blocked', updatedAt: expect.any(Date) },
    });
  });

  it('進捗が続いていても3倍の絶対上限を超えたら停止する(暴走ガード)', async () => {
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    mockHasLiveExecution.mockResolvedValue(false);
    mockResolveLastProgressAt.mockResolvedValue(Date.now() - 100);
    const past3x = new Date(Date.now() - TEST_MAX_TASK_WALL_MS * 3 - 500).toISOString();

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, past3x);

    expect(mockNotifyHangBackstop).toHaveBeenCalled();
  });

  it('壁時計超過でも進捗ありなら「解決」まで進む — 停止しないことと前進が両立する (theme wedge 回帰)', async () => {
    // 実測事故: task 594 が壁時計を超えた状態で完了したところ、
    // 「progressed 429s ago — deferring」を出したまま毎tick早期returnし、
    // 完了タスクを currentTaskId に抱えたまま9件の実行可能タスクを放置した。
    // 猶予は「強制停止しない」だけを意味し、通常の解決処理は必ず走ること。
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    mockHasLiveExecution.mockResolvedValue(false);
    mockResolveLastProgressAt.mockResolvedValue(
      Date.now() - Math.floor(TEST_MAX_TASK_WALL_MS / 10),
    );
    mockGetThemeActiveQueueItems.mockResolvedValue([]); // 実行中の項目は無い
    mockQueueItemFindFirst.mockResolvedValue({ id: 1, status: 'completed', errorMessage: null });

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, staleLastRunAt());

    // 強制停止はしない
    expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
    // かつ、完了として解決され次へ進む
    expect(mockOnTaskCompleted).toHaveBeenCalledWith(1);
  });

  it('does not trigger the backstop for a task still within its wall budget', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());

    expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
  });

  it('does not trigger the backstop when lastRunAt is null', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, null);

    expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
  });
});

describe('advanceTheme — active queue item present', () => {
  it('waits (no side effects) while the item is queued/running', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());

    expect(mockQueueItemFindFirst).not.toHaveBeenCalled();
    expect(mockOnTaskCompleted).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
  });

  it('pauses the theme for plan approval when the active item is waiting_approval', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([
      { id: 1, taskId: 100, status: 'waiting_approval' },
    ]);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());

    expect(mockOnAwaitingPlanApproval).toHaveBeenCalledWith(1);
    expect(mockNotifyAwaitingPlanApproval).toHaveBeenCalledWith(1, 100);
    expect(mockBroadcast).toHaveBeenCalled();
  });

  it('only counts items belonging to the CURRENT task, ignoring other tasks in the theme queue', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 999, status: 'running' }]);
    mockQueueItemFindFirst.mockResolvedValue(null);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'in-progress',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());

    // No active item for task 100 itself → falls through to the terminal-item lookup.
    expect(mockQueueItemFindFirst).toHaveBeenCalled();
  });
});

describe('advanceTheme — stall guard fall-through (task 618)', () => {
  it('残留項目が解除されたら同一ティックで終端解決まで進む — 完了タスクを保持し続けない (事例2)', async () => {
    // done タスク 100 が 'running' 残留項目を握ったままの形。ガードが解除
    // (released=1) したら、待機 return せず isCompleted 解決に到達すること。
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);
    mockReleaseStaleActiveItems.mockResolvedValue(1);
    // 解除直後: 残留項目は 'cancelled' の終端項目になっているが、
    // task.status='done' が先勝ちして「完了」として解決される（順序の固定）。
    mockQueueItemFindFirst.mockResolvedValue({ id: 1, status: 'cancelled', errorMessage: null });
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'done',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, freshLastRunAt());

    expect(mockReleaseStaleActiveItems).toHaveBeenCalledTimes(1);
    const args = mockReleaseStaleActiveItems.mock.calls[0] as unknown as [
      unknown,
      number,
      number,
      Array<{ id: number; taskId: number; status: string }>,
    ];
    expect(args[1]).toBe(1);
    expect(args[2]).toBe(100);
    expect(args[3]).toEqual([{ id: 1, taskId: 100, status: 'running' }]);
    expect(mockOnTaskCompleted).toHaveBeenCalledWith(1);
  });

  it('解除ゼロ（通常の非終端タスク）なら従来どおり無副作用で待機する', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);
    mockReleaseStaleActiveItems.mockResolvedValue(0);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());

    expect(mockQueueItemFindFirst).not.toHaveBeenCalled();
    expect(mockOnTaskCompleted).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
  });

  it('解除ゼロでも waiting_approval の一時停止パスは従来どおり動く', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([
      { id: 1, taskId: 100, status: 'waiting_approval' },
    ]);
    mockReleaseStaleActiveItems.mockResolvedValue(0);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());

    expect(mockOnAwaitingPlanApproval).toHaveBeenCalledWith(1);
    expect(mockNotifyAwaitingPlanApproval).toHaveBeenCalledWith(1, 100);
  });
});

describe('advanceTheme — terminal resolution: completed', () => {
  it.each([
    {
      desc: 'a terminal queue item',
      terminalItem: { id: 1, status: 'completed', errorMessage: null },
      taskState: null,
    },
    {
      desc: 'task.status="done" even with no terminal queue item',
      terminalItem: null,
      taskState: {
        id: 100,
        status: 'done',
        workflowStatus: 'in_progress',
        workflowMode: null,
        parentId: null,
      },
    },
    {
      desc: 'task.workflowStatus="completed" (WorkflowRunner only sets task.status for subtasks)',
      terminalItem: null,
      taskState: {
        id: 100,
        status: 'in-progress',
        workflowStatus: 'completed',
        workflowMode: null,
        parentId: null,
      },
    },
  ])('completes via $desc', async ({ terminalItem, taskState }) => {
    mockQueueItemFindFirst.mockResolvedValue(terminalItem);
    mockResolveTaskWorkflowState.mockResolvedValue(taskState);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, freshLastRunAt());

    expect(mockOnTaskCompleted).toHaveBeenCalledWith(1);
  });
});

describe('advanceTheme — terminal resolution: failed/blocked', () => {
  it('holds (does not skip) a blocked task that is awaiting a user answer', async () => {
    mockQueueItemFindFirst.mockResolvedValue(null);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'blocked',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });
    mockIsAwaitingUserAnswer.mockResolvedValue(true);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, freshLastRunAt());

    expect(mockNotifyAwaitingUserAnswer).toHaveBeenCalledWith(1, 100);
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
  });

  it('skips a failed terminal queue item, marks the task blocked, and advances', async () => {
    mockQueueItemFindFirst.mockResolvedValue({ id: 1, status: 'failed', errorMessage: 'boom' });
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'in-progress',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, freshLastRunAt());

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 100, updatedAt: new Date(0) },
      data: { status: 'blocked', updatedAt: expect.any(Date) },
    });
    expect(mockOnTaskFailed).toHaveBeenCalledWith(1, 'boom');
    expect(mockNotifyTaskSkipped).toHaveBeenCalledWith(1, 100, 'boom');
  });

  it('回帰: 質問に回答して復帰したタスクを blocked に巻き戻さない', async () => {
    // 実測 2026-08-24 task 646: キュー項目が awaiting_question で cancelled →
    // 10秒後にユーザーが回答して workflowStatus=draft / status=todo になったのに、
    // スケジューラが古いスナップショットから blocked を書き戻していた。
    mockQueueItemFindFirst.mockResolvedValue({
      id: 1,
      status: 'failed',
      errorMessage: 'ステータス "awaiting_question" では次のフェーズを実行できません',
      completedAt: new Date('2026-08-24T00:53:24Z'),
    } as never);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'blocked',
      workflowStatus: 'draft',
      workflowMode: null,
      parentId: null,
    });
    mockIsAwaitingUserAnswer.mockResolvedValue(false);
    // A user transition landed after the queue item went terminal.
    mockTransitionCount.mockResolvedValue(1);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, freshLastRunAt());

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
    expect(mockNotifyTaskSkipped).not.toHaveBeenCalled();
  });

  it('cancelled なキュー項目だけでは失敗扱いにしない', async () => {
    // cancelled = 配車の中止(auto-run停止 / 実行不能スキップ / 幽霊項目の一掃)。
    // タスク自体の失敗ではないので blocked を書いてはいけない。
    mockQueueItemFindFirst.mockResolvedValue({
      id: 1,
      status: 'cancelled',
      errorMessage: null,
      completedAt: new Date('2026-08-24T00:53:24Z'),
    } as never);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'todo',
      workflowStatus: 'draft',
      workflowMode: null,
      parentId: null,
    });

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, freshLastRunAt());

    expect(mockTaskUpdate).not.toHaveBeenCalledWith({
      where: { id: 100, updatedAt: new Date(0) },
      data: { status: 'blocked', updatedAt: expect.any(Date) },
    });
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
  });

  it('does not re-mark status when the task is already blocked', async () => {
    mockQueueItemFindFirst.mockResolvedValue({ id: 1, status: 'cancelled', errorMessage: null });
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'blocked',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });
    mockIsAwaitingUserAnswer.mockResolvedValue(false);

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, freshLastRunAt());

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).toHaveBeenCalled();
  });

  it('falls back to a generic message when the terminal item has no errorMessage', async () => {
    mockQueueItemFindFirst.mockResolvedValue(null);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'failed',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });

    await internal(scheduler).advanceTheme(1, 100, 'priority', 1, freshLastRunAt());

    expect(mockOnTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining('100'));
  });
});

describe('advanceTheme — confirmed-vanished task (task 651)', () => {
  it('records task.skipped(cause=task_vanished), notifies, and advances — never writes task.blocked', async () => {
    mockQueueItemFindFirst.mockResolvedValue({
      id: 1,
      status: 'cancelled',
      errorMessage:
        'タスク行が見つからないため、残留キュー項目を自動キャンセルしました（タスク 648）',
    });
    mockResolveTaskWorkflowState.mockResolvedValue(null);

    await internal(scheduler).advanceTheme(1, 648, 'priority', 1, freshLastRunAt());

    expect(mockNotifyTaskVanished).toHaveBeenCalledWith(1, 648);
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockOnTaskFailed).not.toHaveBeenCalled();
    expect(mockNotifyTaskSkipped).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does not take the vanished-task branch when the task still resolves (not vanished)', async () => {
    mockQueueItemFindFirst.mockResolvedValue({
      id: 1,
      status: 'cancelled',
      errorMessage:
        'タスク行が見つからないため、残留キュー項目を自動キャンセルしました（タスク 648）',
    });
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 648,
      status: 'todo',
      workflowStatus: 'draft',
      workflowMode: null,
      parentId: null,
    });

    await internal(scheduler).advanceTheme(1, 648, 'priority', 1, freshLastRunAt());

    expect(mockNotifyTaskVanished).not.toHaveBeenCalled();
  });

  it('does not take the vanished-task branch for an ordinary cancelled item (no vanished marker)', async () => {
    mockQueueItemFindFirst.mockResolvedValue({
      id: 1,
      status: 'cancelled',
      errorMessage: 'タスクは既に終端状態のため、残留キュー項目を自動キャンセルしました',
    });
    mockResolveTaskWorkflowState.mockResolvedValue(null);

    await internal(scheduler).advanceTheme(1, 648, 'priority', 1, freshLastRunAt());

    expect(mockNotifyTaskVanished).not.toHaveBeenCalled();
  });
});

describe('advanceTheme — vanished queue item (neither active nor terminal)', () => {
  it('re-enqueues the same task to resume a mid-workflow task', async () => {
    mockQueueItemFindFirst.mockResolvedValue(null);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'in-progress',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });

    await internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt());

    expect(mockEnqueue).toHaveBeenCalledWith({ taskId: 100, themeId: 1, priority: 50 });
    expect(mockSetCurrentTask).toHaveBeenCalledWith(1, 100);
  });

  it('silently tolerates a race where the item was already re-created by another tick', async () => {
    mockQueueItemFindFirst.mockResolvedValue(null);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'in-progress',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });
    mockEnqueue.mockImplementation(() => Promise.reject(new Error('Task is already in the queue')));

    await expect(
      internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt()),
    ).resolves.toBeUndefined();
    expect(mockSetCurrentTask).not.toHaveBeenCalled();
  });

  it('logs but does not throw on a genuine re-enqueue failure', async () => {
    mockQueueItemFindFirst.mockResolvedValue(null);
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 100,
      status: 'in-progress',
      workflowStatus: 'in_progress',
      workflowMode: null,
      parentId: null,
    });
    mockEnqueue.mockImplementation(() => Promise.reject(new Error('db unreachable')));

    await expect(
      internal(scheduler).advanceTheme(1, 100, 'priority', 0, freshLastRunAt()),
    ).resolves.toBeUndefined();
  });
});

it('uses the durable answer time even when the scheduler holds an old tenure snapshot', async () => {
  mockResumeTransition.mockResolvedValue({ createdAt: new Date() });
  mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);
  await internal(scheduler).advanceTheme(
    1,
    100,
    'priority',
    1,
    new Date(Date.now() - TEST_MAX_TASK_WALL_MS * 4).toISOString(),
  );
  expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
  expect(mockTaskUpdate).not.toHaveBeenCalled();
  expect(mockResumeTransition).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        taskId: 100,
        fromStatus: 'awaiting_question',
        cause: { in: ['intake_question_answered', 'question_resolved'] },
      }),
    }),
  );
});

it('a resumed run still reaches the hard ceiling after its own budget expires', async () => {
  mockResumeTransition.mockResolvedValue({
    createdAt: new Date(Date.now() - TEST_MAX_TASK_WALL_MS * 3 - 500),
  });
  mockHasLiveExecution.mockResolvedValue(true);
  await internal(scheduler).advanceTheme(
    1,
    100,
    'priority',
    1,
    new Date(Date.now() - TEST_MAX_TASK_WALL_MS * 4).toISOString(),
  );
  expect(mockNotifyHangBackstop).toHaveBeenCalled();
});

it('a hang timeout stops execution but preserves uncommitted work for diagnosis and retry', async () => {
  mockResolveTaskWorkingDirectory.mockResolvedValue({
    themeId: 1,
    workingDirectory: '/repo/work',
    theme: null,
  });
  await internal(scheduler).advanceTheme(1, 100, 'priority', 1, staleLastRunAt());
  expect(mockStopTaskTreeAgents).toHaveBeenCalledWith(100);
  expect(mockRevertChanges).not.toHaveBeenCalled();
  expect(mockTaskUpdate).toHaveBeenCalledWith({
    where: { id: 100, updatedAt: new Date(0) },
    data: { status: 'blocked', updatedAt: expect.any(Date) },
  });
});

it('actual scheduler waits for a same-task lifecycle owner before reading the hang budget', async () => {
  const { withTaskLifecycleLock } = await import('../task-lifecycle-lock');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = withTaskLifecycleLock(100, async () => {
    await gate;
  });
  const tick = internal(scheduler).advanceTheme(
    1,
    100,
    'priority',
    1,
    new Date(Date.now() - TEST_MAX_TASK_WALL_MS * 4).toISOString(),
  );
  try {
    await withTaskLifecycleLock(101, async () => {});
    expect(mockResumeTransition).not.toHaveBeenCalled();
    expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
    // Model the committed answer visible when ownership is released.
    mockResumeTransition.mockResolvedValue({ createdAt: new Date() });
    mockGetThemeActiveQueueItems.mockResolvedValue([{ id: 1, taskId: 100, status: 'running' }]);
  } finally {
    release();
    await Promise.all([answer, tick]);
  }
  expect(mockResumeTransition).toHaveBeenCalled();
  expect(mockNotifyHangBackstop).not.toHaveBeenCalled();
});
