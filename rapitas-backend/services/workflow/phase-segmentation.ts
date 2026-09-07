/**
 * phase-segmentation
 *
 * Pure functions that group a task's `AgentExecution` rows into the
 * research/plan/implement/verify timeline shown on the task-detail execution
 * log (task #785). `WorkflowTransition.executionId` is never populated by any
 * caller (see research.md 前提監査#3), so phase identity comes directly from
 * each execution's `AgentSession.mode` (`workflow-<role>`) — a call-time
 * value the orchestrator already sets, not a timestamp guess. Iteration
 * numbers (differencing "実装 (2回目)" from "実装 (1回目)") come from counting
 * `verify_repair` / `ci_repair` WorkflowTransition rows that precede each
 * execution — the only two causes that represent a repair-loop bounce back
 * to the implementer (see plan.md 設計判断の根拠 #6). Not responsible for DB
 * access — callers query WorkflowTransition/AgentExecution/AgentSession and
 * pass the already-fetched rows in here.
 */

export const PHASE_ORDER = ['research', 'plan', 'implement', 'verify'] as const;

/** One of the four timeline sections, populated from recorded executions. */
export type PhaseType = (typeof PHASE_ORDER)[number];

export type PhaseRunStatus = 'running' | 'completed' | 'failed';

const REPAIR_CAUSES = new Set(['verify_repair', 'ci_repair']);

/** Boundary-correlation tolerance between an execution's completion and the nearest WorkflowTransition (task #785 plan.md 設計判断#1). */
const BOUNDARY_TOLERANCE_MS = 3000;

const SESSION_MODE_TO_PHASE: Record<string, PhaseType> = {
  'workflow-researcher': 'research',
  'workflow-planner': 'plan',
  'workflow-implementer': 'implement',
  'workflow-verifier': 'verify',
  'workflow-auto_verifier': 'verify',
};

/**
 * Maps an `AgentSession.mode` value to the timeline phase it belongs to.
 *
 * @param sessionMode - `AgentSession.mode` (e.g. `"workflow-implementer"`), or null for non-workflow runs / 実行に紐づくセッションモード
 * @returns The phase this session's executions belong to, or null when the mode isn't a recognized workflow role / 該当フェーズ、判定不能な場合は null
 */
export function selectPhaseType(sessionMode: string | null | undefined): PhaseType | null {
  if (!sessionMode) return null;
  return SESSION_MODE_TO_PHASE[sessionMode] ?? null;
}

/** Shape of one `AgentExecution` row (already joined with its session for `phaseType`). */
export interface RawPhaseExecution {
  id: number;
  phaseType: PhaseType | null;
  /** `AgentExecution.status` — 'pending' | 'running' | 'completed' | 'failed' | ... */
  status: string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  /** Pre-aggregated `AgentExecutionLog` row count for this execution. */
  logLineCount: number;
}

/** Shape of one `WorkflowTransition` row (any cause — only repair causes affect iteration counting). */
export interface RawPhaseTransition {
  cause: string | null;
  createdAt: Date | string;
}

/** One run of a phase (iteration 1 is the first attempt; 2+ follow a verify_repair/ci_repair bounce). */
export interface PhaseIteration {
  iterationNumber: number;
  executionIds: number[];
  startedAt: string | null;
  completedAt: string | null;
  status: PhaseRunStatus;
  logLineCount: number;
  /** True when no WorkflowTransition landed within ±3s of this iteration's completion — the boundary is a best-effort guess, not confirmed (plan.md エッジケースの方針). */
  boundaryUncertain: boolean;
}

/** All iterations of one timeline phase, in chronological (iteration number) order. */
export interface PhaseSegment {
  phaseType: PhaseType;
  iterations: PhaseIteration[];
}

export type WorkflowTimelineMode = 'lightweight' | 'standard' | 'comprehensive';

export interface SegmentPhasesResult {
  phases: PhaseSegment[];
  workflowMode: WorkflowTimelineMode;
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRunStatus(status: string): boolean {
  return status === 'pending' || status === 'running';
}

function isFailedStatus(status: string): boolean {
  return status === 'failed' || status === 'error' || status === 'cancelled';
}

/**
 * Groups a task's agent executions into research/plan/implement/verify
 * phase segments, splitting `implement`/`verify` into repair iterations.
 *
 * @param executions - Task's AgentExecution rows (any session, any order) with phaseType pre-derived via {@link selectPhaseType} / 実行行
 * @param transitions - Task's WorkflowTransition rows (any cause) / 遷移ログ
 * @param hasPlanFile - Whether a `plan` WorkflowFile row exists for the task (plan.md 設計判断#5) / plan.md の存在有無
 * @returns Ordered phase segments plus the derived workflow mode / フェーズ区分とワークフローモード
 */
export function segmentPhases(
  executions: RawPhaseExecution[],
  transitions: RawPhaseTransition[],
  hasPlanFile: boolean,
): SegmentPhasesResult {
  // A planner runs before plan.md exists; answering a question also archives
  // the old plan. Neither case may hide its live or historical execution logs.
  const hasPlanningExecution = executions.some((execution) => execution.phaseType === 'plan');
  const workflowMode: WorkflowTimelineMode =
    hasPlanFile || hasPlanningExecution ? 'standard' : 'lightweight';

  const repairTimes = transitions
    .filter((t) => t.cause && REPAIR_CAUSES.has(t.cause))
    .map((t) => toTime(t.createdAt))
    .sort((a, b) => a - b);

  const allTransitionTimes = transitions.map((t) => toTime(t.createdAt));

  const sorted = executions
    .filter((e) => e.phaseType !== null)
    .map((e) => ({ ...e, time: toTime(e.startedAt ?? e.createdAt) }))
    .sort((a, b) => a.time - b.time);

  const byPhase = new Map<PhaseType, typeof sorted>();
  for (const type of PHASE_ORDER) byPhase.set(type, []);
  for (const e of sorted) byPhase.get(e.phaseType as PhaseType)!.push(e);

  const phases: PhaseSegment[] = [];
  for (const phaseType of PHASE_ORDER) {
    const execs = byPhase.get(phaseType)!;
    if (execs.length === 0) continue;

    // research/plan never repeat via verify_repair/ci_repair — only implement
    // and verify get sent back around the loop (plan.md 設計判断#6).
    const repairEligible = phaseType === 'implement' || phaseType === 'verify';

    const iterationGroups = new Map<number, typeof execs>();
    for (const e of execs) {
      const iterationNumber = repairEligible
        ? repairTimes.filter((rt) => rt < e.time).length + 1
        : 1;
      const group = iterationGroups.get(iterationNumber) ?? [];
      group.push(e);
      iterationGroups.set(iterationNumber, group);
    }

    const iterations: PhaseIteration[] = [...iterationGroups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([iterationNumber, group]) => {
        const first = group[0];
        const last = group[group.length - 1];
        const completedAt = last.completedAt ? toIso(last.completedAt) : null;
        const status: PhaseRunStatus = group.some((g) => isRunStatus(g.status))
          ? 'running'
          : group.some((g) => isFailedStatus(g.status))
            ? 'failed'
            : 'completed';
        const boundaryUncertain =
          completedAt !== null &&
          !allTransitionTimes.some(
            (tt) =>
              Math.abs(tt - toTime(last.completedAt as Date | string)) <= BOUNDARY_TOLERANCE_MS,
          );
        return {
          iterationNumber,
          executionIds: group.map((g) => g.id),
          startedAt: toIso(first.startedAt ?? first.createdAt),
          completedAt,
          status,
          logLineCount: group.reduce((sum, g) => sum + g.logLineCount, 0),
          boundaryUncertain,
        };
      });

    phases.push({ phaseType, iterations });
  }

  return { phases, workflowMode };
}
