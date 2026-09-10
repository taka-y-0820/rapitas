import { describe, it, expect } from 'bun:test';
import {
  segmentPhases,
  selectPhaseType,
  type RawPhaseExecution,
  type RawPhaseTransition,
} from './phase-segmentation';

function exec(overrides: Partial<RawPhaseExecution>): RawPhaseExecution {
  return {
    id: 1,
    phaseType: 'research',
    status: 'completed',
    startedAt: '2026-08-30T00:00:00.000Z',
    completedAt: '2026-08-30T00:01:00.000Z',
    createdAt: '2026-08-30T00:00:00.000Z',
    logLineCount: 10,
    ...overrides,
  };
}

function transition(overrides: Partial<RawPhaseTransition>): RawPhaseTransition {
  return {
    cause: 'phase_completed:researcher',
    createdAt: '2026-08-30T00:01:00.000Z',
    ...overrides,
  };
}

describe('selectPhaseType', () => {
  it('maps known workflow session modes to their phase', () => {
    expect(selectPhaseType('workflow-researcher')).toBe('research');
    expect(selectPhaseType('workflow-planner')).toBe('plan');
    expect(selectPhaseType('workflow-implementer')).toBe('implement');
    expect(selectPhaseType('workflow-verifier')).toBe('verify');
    expect(selectPhaseType('workflow-auto_verifier')).toBe('verify');
  });

  it('returns null for unrecognized or missing modes', () => {
    expect(selectPhaseType(null)).toBeNull();
    expect(selectPhaseType(undefined)).toBeNull();
    expect(selectPhaseType('development')).toBeNull();
  });
});

describe('segmentPhases', () => {
  it('segments a normal 4-phase progression in order with one iteration each', () => {
    const executions: RawPhaseExecution[] = [
      exec({
        id: 1,
        phaseType: 'research',
        startedAt: '2026-08-30T00:00:00.000Z',
        completedAt: '2026-08-30T00:05:00.000Z',
      }),
      exec({
        id: 2,
        phaseType: 'plan',
        startedAt: '2026-08-30T00:05:03.000Z',
        completedAt: '2026-08-30T00:10:00.000Z',
      }),
      exec({
        id: 3,
        phaseType: 'implement',
        startedAt: '2026-08-30T00:10:03.000Z',
        completedAt: '2026-08-30T00:20:00.000Z',
      }),
      exec({
        id: 4,
        phaseType: 'verify',
        startedAt: '2026-08-30T00:20:03.000Z',
        completedAt: '2026-08-30T00:25:00.000Z',
      }),
    ];
    const transitions: RawPhaseTransition[] = [
      transition({ cause: 'phase_completed:researcher', createdAt: '2026-08-30T00:05:00.000Z' }),
      transition({ cause: 'phase_completed:planner', createdAt: '2026-08-30T00:10:00.000Z' }),
      transition({ cause: 'phase_completed:implementer', createdAt: '2026-08-30T00:20:00.000Z' }),
      transition({ cause: 'phase_completed:verifier', createdAt: '2026-08-30T00:25:00.000Z' }),
    ];

    const result = segmentPhases(executions, transitions, true);

    expect(result.workflowMode).toBe('standard');
    expect(result.phases.map((p) => p.phaseType)).toEqual([
      'research',
      'plan',
      'implement',
      'verify',
    ]);
    for (const phase of result.phases) {
      expect(phase.iterations).toHaveLength(1);
      expect(phase.iterations[0].iterationNumber).toBe(1);
      expect(phase.iterations[0].status).toBe('completed');
      expect(phase.iterations[0].boundaryUncertain).toBe(false);
    }
  });

  it('omits the plan phase entirely in lightweight mode', () => {
    const executions: RawPhaseExecution[] = [
      exec({ id: 1, phaseType: 'research' }),
      exec({ id: 2, phaseType: 'implement' }),
      exec({ id: 3, phaseType: 'verify' }),
    ];

    const result = segmentPhases(executions, [], false);

    expect(result.workflowMode).toBe('lightweight');
    expect(result.phases.map((p) => p.phaseType)).toEqual(['research', 'implement', 'verify']);
  });

  it('retains recorded planning logs after the plan file is archived', () => {
    const executions: RawPhaseExecution[] = [
      exec({ id: 1, phaseType: 'research' }),
      exec({ id: 2, phaseType: 'plan' }),
      exec({ id: 3, phaseType: 'implement' }),
    ];

    const result = segmentPhases(executions, [], false);

    expect(result.workflowMode).toBe('standard');
    expect(result.phases.find((p) => p.phaseType === 'plan')?.iterations[0].executionIds).toEqual([
      2,
    ]);
  });

  it('shows the running planner before it first saves plan.md', () => {
    const result = segmentPhases(
      [
        exec({
          id: 3820,
          phaseType: 'plan',
          status: 'running',
          completedAt: null,
          logLineCount: 12,
        }),
      ],
      [],
      false,
    );
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].phaseType).toBe('plan');
    expect(result.phases[0].iterations[0]).toMatchObject({
      executionIds: [3820],
      status: 'running',
      logLineCount: 12,
    });
  });

  it('increments the implement iteration once per verify_repair bounce', () => {
    const executions: RawPhaseExecution[] = [
      exec({
        id: 1,
        phaseType: 'implement',
        startedAt: '2026-08-30T00:00:00.000Z',
        completedAt: '2026-08-30T00:10:00.000Z',
      }),
      exec({
        id: 2,
        phaseType: 'verify',
        startedAt: '2026-08-30T00:10:03.000Z',
        completedAt: '2026-08-30T00:15:00.000Z',
      }),
      exec({
        id: 3,
        phaseType: 'implement',
        startedAt: '2026-08-30T00:15:05.000Z',
        completedAt: '2026-08-30T00:25:00.000Z',
      }),
      exec({
        id: 4,
        phaseType: 'verify',
        startedAt: '2026-08-30T00:25:03.000Z',
        completedAt: '2026-08-30T00:30:00.000Z',
      }),
    ];
    const transitions: RawPhaseTransition[] = [
      transition({ cause: 'verify_repair', createdAt: '2026-08-30T00:15:01.000Z' }),
      transition({ cause: 'phase_completed:verifier', createdAt: '2026-08-30T00:30:00.000Z' }),
    ];

    const result = segmentPhases(executions, transitions, true);

    const implement = result.phases.find((p) => p.phaseType === 'implement')!;
    const verify = result.phases.find((p) => p.phaseType === 'verify')!;
    expect(implement.iterations.map((i) => i.iterationNumber)).toEqual([1, 2]);
    expect(implement.iterations[1].executionIds).toEqual([3]);
    expect(verify.iterations.map((i) => i.iterationNumber)).toEqual([1, 2]);
  });

  it('increments across consecutive ci_repair bounces (3+ iterations)', () => {
    const executions: RawPhaseExecution[] = [
      exec({ id: 1, phaseType: 'implement', startedAt: '2026-08-30T00:00:00.000Z' }),
      exec({ id: 2, phaseType: 'implement', startedAt: '2026-08-30T01:00:00.000Z' }),
      exec({ id: 3, phaseType: 'implement', startedAt: '2026-08-30T02:00:00.000Z' }),
      exec({ id: 4, phaseType: 'implement', startedAt: '2026-08-30T03:00:00.000Z' }),
    ];
    const transitions: RawPhaseTransition[] = [
      transition({ cause: 'ci_repair', createdAt: '2026-08-30T00:30:00.000Z' }),
      transition({ cause: 'ci_repair', createdAt: '2026-08-30T01:30:00.000Z' }),
      transition({ cause: 'verify_repair', createdAt: '2026-08-30T02:30:00.000Z' }),
    ];

    const result = segmentPhases(executions, transitions, true);
    const implement = result.phases.find((p) => p.phaseType === 'implement')!;
    expect(implement.iterations.map((i) => i.iterationNumber)).toEqual([1, 2, 3, 4]);
  });

  it('marks a completed iteration boundary-uncertain when no transition lands within ±3s', () => {
    const executions: RawPhaseExecution[] = [
      exec({
        id: 1,
        phaseType: 'research',
        startedAt: '2026-08-30T00:00:00.000Z',
        completedAt: '2026-08-30T00:05:00.000Z',
      }),
    ];
    const farTransitions: RawPhaseTransition[] = [
      transition({ cause: 'phase_completed:researcher', createdAt: '2026-08-30T00:05:04.000Z' }),
    ];

    const uncertain = segmentPhases(executions, farTransitions, true);
    expect(uncertain.phases[0].iterations[0].boundaryUncertain).toBe(true);

    const nearTransitions: RawPhaseTransition[] = [
      transition({ cause: 'phase_completed:researcher', createdAt: '2026-08-30T00:05:02.500Z' }),
    ];
    const certain = segmentPhases(executions, nearTransitions, true);
    expect(certain.phases[0].iterations[0].boundaryUncertain).toBe(false);
  });

  it('marks a still-running iteration as running without requiring a boundary transition', () => {
    const executions: RawPhaseExecution[] = [
      exec({ id: 1, phaseType: 'implement', status: 'running', completedAt: null }),
    ];
    const result = segmentPhases(executions, [], true);
    expect(result.phases[0].iterations[0].status).toBe('running');
    expect(result.phases[0].iterations[0].boundaryUncertain).toBe(false);
  });

  it('marks an iteration failed when its execution status is failed', () => {
    const executions: RawPhaseExecution[] = [
      exec({ id: 1, phaseType: 'verify', status: 'failed' }),
    ];
    const result = segmentPhases(executions, [], true);
    expect(result.phases[0].iterations[0].status).toBe('failed');
  });

  it.each(['failed', 'cancelled', 'error', 'running'])(
    'reflects a successful retry after %s while retaining all execution logs',
    (previousStatus) => {
      const result = segmentPhases(
        [
          exec({ id: 1, phaseType: 'implement', status: previousStatus }),
          exec({
            id: 2,
            phaseType: 'implement',
            startedAt: '2026-08-30T00:02:00.000Z',
            completedAt: '2026-08-30T00:03:00.000Z',
          }),
        ],
        [],
        true,
      );
      expect(result.phases[0].iterations[0]).toMatchObject({
        status: 'completed',
        executionIds: [1, 2],
        logLineCount: 20,
        completedAt: '2026-08-30T00:03:00.000Z',
      });
    },
  );

  it.each([
    ['failed', 'failed'],
    ['running', 'running'],
    ['pending', 'running'],
  ])('reflects the latest %s attempt after an earlier success', (status, expected) => {
    const result = segmentPhases(
      [
        exec({ id: 1, phaseType: 'verify' }),
        exec({
          id: 2,
          phaseType: 'verify',
          status,
          startedAt: '2026-08-30T00:02:00.000Z',
          completedAt: null,
        }),
      ],
      [],
      true,
    );
    expect(result.phases[0].iterations[0].status).toBe(expected);
  });

  it('uses execution IDs to order retries with identical timestamps', () => {
    const result = segmentPhases([exec({ id: 2 }), exec({ id: 1, status: 'failed' })], [], true);
    expect(result.phases[0].iterations[0]).toMatchObject({
      status: 'completed',
      executionIds: [1, 2],
    });
  });

  it('preserves a failed repair iteration when a later iteration succeeds', () => {
    const result = segmentPhases(
      [
        exec({ id: 1, phaseType: 'verify', status: 'failed' }),
        exec({ id: 2, phaseType: 'verify', startedAt: '2026-08-30T00:03:00.000Z' }),
      ],
      [transition({ cause: 'verify_repair', createdAt: '2026-08-30T00:02:00.000Z' })],
      true,
    );
    expect(result.phases[0].iterations.map((iteration) => iteration.status)).toEqual([
      'failed',
      'completed',
    ]);
  });

  it('omits phases with no executions yet', () => {
    const executions: RawPhaseExecution[] = [exec({ id: 1, phaseType: 'research' })];
    const result = segmentPhases(executions, [], true);
    expect(result.phases.map((p) => p.phaseType)).toEqual(['research']);
  });
});
