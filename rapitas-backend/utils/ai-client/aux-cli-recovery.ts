/** Reconcile durable holds from OS evidence before admitting a new auxiliary request. */
import {
  observeProcess,
  type OwnershipRecord,
  type OwnershipEvidence,
  type ProcessObservation,
  type createOwnershipRegistry,
} from './aux-cli-ownership';
import { observeWindowsAuxJob, type WindowsJobObservation } from './windows-aux-job';
import {
  observeLinuxAuxScope,
  type LinuxAuxScope,
  type LinuxScopeObservation,
} from './linux-aux-cgroup';

type RecoveryObservations = {
  process(pid: number): Promise<ProcessObservation>;
  job(token: string): Promise<WindowsJobObservation>;
  linuxScope?(scope: LinuxAuxScope): Promise<LinuxScopeObservation>;
};
const defaults: RecoveryObservations = { process: observeProcess, job: observeWindowsAuxJob };

export async function inspectAuxCliRecovery(
  record: OwnershipRecord,
  deps: RecoveryObservations = defaults,
): Promise<OwnershipEvidence> {
  const identities = [...(record.root ? [record.root] : []), ...record.descendants];
  const observations = await Promise.all(
    identities.map(async (expected) => ({
      expected,
      actual: await deps.process(expected.pid),
    })),
  );
  // Never infer job containment for old PID-only records or an unconfirmed intent.
  if (record.ownershipScope === 'linux-cgroup' && record.root && record.linuxScope) {
    const scope = await (deps.linuxScope ?? observeLinuxAuxScope)(record.linuxScope);
    return {
      observations,
      fullyEnumerated: scope.kind !== 'unknown',
      scopeEmpty: scope.kind === 'absent' || (scope.kind === 'present' && !scope.populated),
    };
  }
  if (record.ownershipScope !== 'windows-job' || !record.root)
    return { observations, fullyEnumerated: false, scopeEmpty: false };
  const scope = await deps.job(record.executionToken);
  return {
    observations,
    fullyEnumerated: scope.kind !== 'unknown',
    scopeEmpty:
      scope.kind === 'absent' || (scope.kind === 'present' && scope.activeProcesses === 0),
  };
}

/** Single-flight recovery; active calls are excluded only by this process's live ownership. */
export function createAuxCliRecovery(
  registry: ReturnType<typeof createOwnershipRegistry>,
  inspect: (record: OwnershipRecord) => Promise<OwnershipEvidence> = inspectAuxCliRecovery,
  liveTokens: ReadonlySet<string> = new Set(),
) {
  let recovering: Promise<void> | null = null;
  return {
    assertReady(): Promise<void> {
      if (recovering) return recovering;
      const run = async () => {
        const pending = (await registry.snapshot()).filter(
          (row) => !liveTokens.has(row.executionToken),
        );
        const unresolved: string[] = [];
        for (const record of pending) {
          if (!(await registry.reconcile(record.executionToken, inspect)))
            unresolved.push(record.executionToken);
        }
        if (unresolved.length)
          throw new Error(`Auxiliary CLI recovery pending: ${unresolved.join(', ')}`);
      };
      recovering = run().finally(() => {
        recovering = null;
      });
      return recovering;
    },
  };
}
