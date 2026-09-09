/** Ownership decisions require process birth identity, never a PID alone. */
export interface RuntimeProcessIdentity {
  pid: number;
  parentPid: number;
  /** OS process creation identity, not the time the record was saved. */
  birth: string;
  command: string;
}

export function isRuntimeProcessIdentity(value: unknown): value is RuntimeProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as RuntimeProcessIdentity;
  return (
    Number.isInteger(item.pid) &&
    item.pid > 0 &&
    Number.isInteger(item.parentPid) &&
    item.parentPid >= 0 &&
    typeof item.birth === 'string' &&
    /^\d+$/.test(item.birth) &&
    typeof item.command === 'string' &&
    item.command.length > 0
  );
}

export function sameRuntimeProcess(
  recorded: RuntimeProcessIdentity,
  current: RuntimeProcessIdentity,
): boolean {
  return (
    recorded.pid === current.pid &&
    recorded.birth.length > 0 &&
    recorded.birth === current.birth &&
    recorded.command.length > 0 &&
    recorded.command === current.command
  );
}

/**
 * Extend a previously proven tree using current parent links. A reused PID
 * cannot be a seed, and previously captured orphans retain their own identity.
 * Callers must obtain the initial root identity immediately after their spawn.
 */
export function extendOwnedRuntimeTree(
  recorded: RuntimeProcessIdentity[],
  snapshot: RuntimeProcessIdentity[],
): RuntimeProcessIdentity[] {
  const byPid = new Map(snapshot.map((item) => [item.pid, item]));
  const owned = new Map(recorded.map((item) => [item.pid, item]));
  const live = new Set<number>();
  for (const item of recorded) {
    const current = byPid.get(item.pid);
    if (current && sameRuntimeProcess(item, current)) live.add(item.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot) {
      if (owned.has(item.pid) || !live.has(item.parentPid) || !item.birth || !item.command)
        continue;
      const parent = owned.get(item.parentPid)!;
      // Parent ids survive parent exit and can later refer to a reused PID.
      // OS birth values use integer ticks in one common unit per snapshot.
      if (
        !/^\d+$/.test(item.birth) ||
        !/^\d+$/.test(parent.birth) ||
        BigInt(item.birth) < BigInt(parent.birth)
      )
        continue;
      owned.set(item.pid, item);
      live.add(item.pid);
      changed = true;
    }
  }
  return [...owned.values()];
}

/**
 * A missing snapshot is unknown, never evidence that every process exited.
 * Unknown/reused/protected targets block the entire stop operation.
 */
export function inspectOwnedRuntimeTree(
  recorded: RuntimeProcessIdentity[],
  snapshot: RuntimeProcessIdentity[] | null,
  protectedPids: ReadonlySet<number>,
): { safe: boolean; alive: RuntimeProcessIdentity[]; reason?: string } {
  if (!snapshot || recorded.length === 0)
    return { safe: false, alive: [], reason: 'identity-unavailable' };
  const byPid = new Map(snapshot.map((item) => [item.pid, item]));
  const alive: RuntimeProcessIdentity[] = [];
  for (const item of recorded) {
    const current = byPid.get(item.pid);
    if (!current) continue;
    if (!sameRuntimeProcess(item, current))
      return { safe: false, alive: [], reason: 'identity-mismatch' };
    if (protectedPids.has(item.pid)) return { safe: false, alive: [], reason: 'protected-process' };
    alive.push(current);
  }
  return { safe: true, alive };
}
