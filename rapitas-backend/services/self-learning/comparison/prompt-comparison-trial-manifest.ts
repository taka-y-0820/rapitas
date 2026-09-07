/** Prospective task assignments. Results cannot create or reorder trial slots. */
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { withAlphaLedgerLock, writeAlphaLedger } from './prompt-comparison-alpha-storage';
import { assignArm } from './prompt-comparison-randomization';
import type { ComparisonArm, ComparisonCell, ComparisonRecord } from './prompt-comparison-types';

export interface TrialSlot {
  id: string;
  taskId: number;
  arm: ComparisonArm;
  createdAt: string;
  sessionIds: number[];
}
export interface TrialManifest {
  schemaVersion: 1;
  promptEvolutionId: number;
  role: string;
  candidateVersion: string;
  controlVersion: string | null;
  seed: string;
  slots: TrialSlot[];
}

function fileFor(id: number): string {
  return join(
    process.env.RAPITAS_DATA_DIR?.trim() || join(homedir(), '.rapitas'),
    '.prompt-comparisons',
    `${id}.trial.json`,
  );
}

function validManifest(value: unknown, id: number): value is TrialManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as TrialManifest;
  if (
    m.schemaVersion !== 1 ||
    m.promptEvolutionId !== id ||
    typeof m.role !== 'string' ||
    !m.role ||
    typeof m.candidateVersion !== 'string' ||
    !m.candidateVersion ||
    !(m.controlVersion === null || typeof m.controlVersion === 'string') ||
    typeof m.seed !== 'string' ||
    !m.seed ||
    !Array.isArray(m.slots)
  )
    return false;
  const tasks = new Set<number>();
  const ids = new Set<string>();
  return m.slots.every((slot, index) => {
    if (
      !slot ||
      typeof slot.id !== 'string' ||
      !slot.id ||
      ids.has(slot.id) ||
      !Number.isSafeInteger(slot.taskId) ||
      slot.taskId < 1 ||
      tasks.has(slot.taskId) ||
      typeof slot.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(slot.createdAt)) ||
      !Array.isArray(slot.sessionIds) ||
      slot.sessionIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(slot.sessionIds).size !== slot.sessionIds.length ||
      slot.arm !== assignArm(m.seed, index)
    )
      return false;
    tasks.add(slot.taskId);
    ids.add(slot.id);
    return true;
  });
}

export function readTrialManifest(id: number): TrialManifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(fileFor(id), 'utf8'));
    return validManifest(value, id) ? value : null;
  } catch {
    return null;
  }
}

/** Idempotent by task; retries cannot redraw arms or become independent samples. */
export function reserveTrialSlot(
  seed: Omit<TrialManifest, 'schemaVersion' | 'slots'>,
  taskId: number,
  canInitialize: () => boolean,
): { slot: TrialSlot; index: number; manifest: TrialManifest; issue: null } | { issue: string } {
  if (
    !Number.isSafeInteger(taskId) ||
    taskId < 1 ||
    !Number.isSafeInteger(seed.promptEvolutionId) ||
    seed.promptEvolutionId < 1
  ) {
    return { issue: 'invalid_identity' };
  }
  return withAlphaLedgerLock(fileFor(seed.promptEvolutionId), () => {
    let manifest = readTrialManifest(seed.promptEvolutionId);
    if (!manifest) {
      if (existsSync(fileFor(seed.promptEvolutionId))) return { issue: 'corrupted' };
      if (!canInitialize()) return { issue: 'prospective_registration_required' };
      manifest = { ...seed, schemaVersion: 1, slots: [] };
      if (!validManifest(manifest, seed.promptEvolutionId)) return { issue: 'invalid_identity' };
    }
    if (
      manifest.role !== seed.role ||
      manifest.candidateVersion !== seed.candidateVersion ||
      manifest.controlVersion !== seed.controlVersion
    )
      return { issue: 'trial_version_changed' };
    const existing = manifest.slots.findIndex((slot) => slot.taskId === taskId);
    if (existing >= 0)
      return { slot: manifest.slots[existing], index: existing, manifest, issue: null };
    const index = manifest.slots.length;
    const slot = {
      id: randomUUID(),
      taskId,
      arm: assignArm(manifest.seed, index),
      createdAt: new Date().toISOString(),
      sessionIds: [],
    };
    manifest.slots.push(slot);
    if (!writeAlphaLedger(fileFor(seed.promptEvolutionId), manifest))
      return { issue: 'write_failed' };
    return { slot, index, manifest, issue: null };
  });
}

/** Persist the session before execution so interrupted result recording can be replayed. */
export function bindTrialSession(id: number, slotId: string, sessionId: number): boolean {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) return false;
  return (
    withAlphaLedgerLock(fileFor(id), () => {
      const manifest = readTrialManifest(id);
      const slot = manifest?.slots.find((s) => s.id === slotId);
      if (!manifest || !slot) return false;
      if (slot.sessionIds.includes(sessionId)) return true;
      slot.sessionIds.push(sessionId);
      return writeAlphaLedger(fileFor(id), manifest);
    }) === true
  );
}

/** Only complete, consecutive blocks from the original assignment order are eligible. */
export function trialPrefix(
  manifest: TrialManifest,
  record: ComparisonRecord,
): { cells: ComparisonCell[]; completeSlots: number; issue: null } | { issue: string } {
  const slots = new Map(manifest.slots.map((slot) => [slot.id, slot]));
  const outcomes = new Map<string, ComparisonCell['runs'][number]>();
  for (const cell of record.arms) {
    if (cell.knowledge !== 'with') continue;
    for (const run of cell.runs) {
      const slot = run.assignmentId ? slots.get(run.assignmentId) : undefined;
      if (!slot || slot.arm !== cell.arm || slot.taskId !== run.taskId || outcomes.has(slot.id)) {
        return { issue: 'assignment_mismatch' };
      }
      if (run.controlVersion !== manifest.controlVersion)
        return { issue: 'control_version_mismatch' };
      outcomes.set(slot.id, run);
    }
  }
  let completeSlots = 0;
  for (const slot of manifest.slots) {
    if (!outcomes.has(slot.id)) break;
    completeSlots++;
  }
  // Five complete randomized pairs form the first checkpoint.
  completeSlots = Math.floor(completeSlots / 10) * 10;
  const cells: ComparisonCell[] = ['current', 'candidate'].map((arm) => ({
    arm: arm as ComparisonArm,
    knowledge: 'with',
    runs: [],
  }));
  for (const slot of manifest.slots.slice(0, completeSlots)) {
    const run = outcomes.get(slot.id)!;
    // Intention-to-treat: infrastructure failures remain failures in the fixed
    // cohort. The original failure cause remains unchanged in the stored record.
    cells[slot.arm === 'current' ? 0 : 1].runs.push({
      ...run,
      failureCause:
        run.failureCause === 'infra_failure' ? 'implementation_error' : run.failureCause,
    });
  }
  return { cells, completeSlots, issue: null };
}
