/**
 * guards テスト — verify_done 中の in-flight 再送分岐 (task 828)
 *
 * タスク#825で観測された「verify.md保存後、後続自動化(runVerifyPostSaveAutomation)が
 * 同一HTTPリクエスト内で数分かかる間にエージェントが再送し、guardStatusTransition が
 * 一律 ValidationError(invariantViolation) で拒否していた」問題への対応を検証する。
 * fileType==='verify' かつ status==='verify_done' かつ hasVerifyCompletionInFlight が
 * true の場合のみ、invariantViolation を記録せず202応答へ振り分けることを確認する。
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';

mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const mockPrisma = {
  task: { update: mock(() => Promise.resolve({})) },
};
mock.module('../../../../config', () => ({ prisma: mockPrisma }));

mock.module('../../../../services/workflow/workflow-file-utils', () => ({
  readWorkflowFile: mock(() => Promise.resolve(null)),
  resolveWorkflowDir: mock(() => Promise.resolve(null)),
}));

mock.module('../../../../services/workflow/phase-output-validator', () => ({
  isReusableArtifact: () => false,
}));

const mockRecordTransition = mock(() => Promise.resolve()) as any;
mock.module('../../../../services/workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

// Identity pass-through — every test supplies an already-valid WorkflowStatus.
mock.module('../../../../services/workflow/workflow-invariants', () => ({
  normalizeWorkflowStatus: (s: string) => s,
}));

const mockFindRecentCriticBounce = mock(() => Promise.resolve(null)) as any;
mock.module('../../../../services/workflow/phase-critic', () => ({
  findRecentCriticBounce: mockFindRecentCriticBounce,
}));

const mockHasVerifyCompletionInFlight = mock(() => false) as any;
mock.module('../../../../services/workflow/verify-completion-inflight', () => ({
  hasVerifyCompletionInFlight: mockHasVerifyCompletionInFlight,
}));

const { guardStatusTransition } = await import('./guards');

function buildResolved(workflowStatus: string) {
  return { task: { id: 828, workflowStatus }, categoryId: null, themeId: null } as any;
}

describe('guardStatusTransition — verify_done 中の in-flight 再送分岐', () => {
  beforeEach(() => {
    mockRecordTransition.mockClear();
    mockFindRecentCriticBounce.mockReset().mockResolvedValue(null);
    mockHasVerifyCompletionInFlight.mockReset().mockReturnValue(false);
  });

  test('verify_done かつ in-flight中の verify再送は202応答を返し invariantViolation を記録しないこと', async () => {
    mockHasVerifyCompletionInFlight.mockReturnValue(true);

    const result = await guardStatusTransition(828, 'verify', buildResolved('verify_done'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(202);
      expect(result.body.alreadyInFlight).toBe(true);
      expect(result.body.success).toBe(true);
      expect(result.status).toBe('verify_done');
    }
    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'verify_inflight_retry_ignored',
        fromStatus: 'verify_done',
        toStatus: 'verify_done',
      }),
    );
    const recordedArgs = mockRecordTransition.mock.calls[0][0];
    expect(recordedArgs.invariantViolation).toBeUndefined();
  });

  test('verify_done だが in-flightでない場合は従来通り ValidationError を投げ invariantViolation を記録すること', async () => {
    mockHasVerifyCompletionInFlight.mockReturnValue(false);

    await expect(
      guardStatusTransition(828, 'verify', buildResolved('verify_done')),
    ).rejects.toThrow();

    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'transition_rejected',
        invariantViolation: true,
      }),
    );
  });

  test('fileType!=="verify" の場合は in-flightでも従来通り ValidationError を投げること', async () => {
    mockHasVerifyCompletionInFlight.mockReturnValue(true);

    await expect(
      guardStatusTransition(828, 'research', buildResolved('verify_done')),
    ).rejects.toThrow();

    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'transition_rejected',
        invariantViolation: true,
      }),
    );
  });

  test('許可された通常の遷移は ok:true でステータスを返すこと（回帰確認）', async () => {
    const result = await guardStatusTransition(828, 'verify', buildResolved('plan_approved'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('plan_approved');
    }
    expect(mockRecordTransition).not.toHaveBeenCalled();
  });

  // task 902 (revised plan, AC2): verify_done previously rejected EVERY file
  // type including question.md, so completion_confirmation could never be
  // raised via the real PUT /files/question API — computeAndApplyStatusTransition
  // was never reached. This is the gate-level fix, tested at the actual guard
  // (not bypassing it via computeAndApplyStatusTransition directly).
  test('verify_done での question.md 保存は ok:true を返すこと（AC2: completion_confirmation の到達性）', async () => {
    const result = await guardStatusTransition(828, 'question', buildResolved('verify_done'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('verify_done');
    }
    expect(mockRecordTransition).not.toHaveBeenCalled();
  });

  test('verify_done での verify.md 保存は引き続き拒否されること（task 632のretry契約を維持）', async () => {
    mockHasVerifyCompletionInFlight.mockReturnValue(false);

    await expect(
      guardStatusTransition(828, 'verify', buildResolved('verify_done')),
    ).rejects.toThrow();
  });
});
