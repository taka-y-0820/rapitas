/** Identity-aware stop; sending a signal is never proof of termination. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  extendOwnedRuntimeTree,
  inspectOwnedRuntimeTree,
  type RuntimeProcessIdentity,
} from './runtime-process-identity';
import {
  readRuntimeProcessSnapshot,
  type RuntimeProcessSnapshot,
} from './runtime-process-snapshot';

const exec = promisify(execFile);

async function terminateIdentity(identity: RuntimeProcessIdentity): Promise<void> {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.birth)) {
    throw new Error('Invalid stop identity');
  }
  if (process.platform !== 'win32') throw new Error('Handle-based runtime termination unavailable');
  // Open a process handle before checking its creation time. Kill uses this
  // handle, rather than resolving a PID again after the identity check.
  const script = `
$ErrorActionPreference='Stop'
$targetProcess = [System.Diagnostics.Process]::GetProcessById(${identity.pid})
try {
  $null = $targetProcess.Handle
  $birthTicks = $targetProcess.StartTime.ToUniversalTime().Ticks
  $birthTicks -= $birthTicks % 10 # CIM timestamps have microsecond precision
  if ([string]$birthTicks -ne '${identity.birth}') { throw 'Process identity changed' }
  $listeners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3001)
  if ($listeners.OwningProcess -contains ${identity.pid}) { throw 'Backend process is protected' }
  $targetProcess.Kill()
} finally { $targetProcess.Dispose() }
`;
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

export interface RuntimeStopDependencies {
  snapshot(): Promise<RuntimeProcessSnapshot>;
  terminate(identity: RuntimeProcessIdentity): Promise<void>;
  wait(): Promise<void>;
  now(): number;
}
const defaults: RuntimeStopDependencies = {
  snapshot: readRuntimeProcessSnapshot,
  terminate: terminateIdentity,
  wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
  now: Date.now,
};

export async function stopRuntimeProcesses(
  recorded: RuntimeProcessIdentity[],
  persistOwnership: (identities: RuntimeProcessIdentity[]) => Promise<void>,
  timeoutMs = 20_000,
  deps: RuntimeStopDependencies = defaults,
): Promise<{ stopped: boolean; identities: RuntimeProcessIdentity[]; reason?: string }> {
  let identities = recorded;
  let signalError: string | undefined;
  let persistenceError: string | undefined;
  const deadline = deps.now() + timeoutMs;
  try {
    do {
      const snapshot = await deps.snapshot();
      identities = extendOwnedRuntimeTree(identities, snapshot.processes);
      const inspection = inspectOwnedRuntimeTree(
        identities,
        snapshot.processes,
        snapshot.protectedPids,
      );
      if (!inspection.safe) return { stopped: false, identities, reason: inspection.reason };
      if (inspection.alive.length === 0)
        return { stopped: true, identities, reason: persistenceError };
      if (signalError) return { stopped: false, identities, reason: signalError };
      // Remember newly captured descendants before the parent links disappear.
      // Recording failure must not prevent an explicitly requested stop of
      // positively identified processes. The caller retains its exclusion
      // until durable removal succeeds, even after all processes are gone.
      try {
        await persistOwnership(identities);
      } catch (error) {
        persistenceError = String(error);
      }
      // Root first prevents further child creation. Every individual kill
      // independently rechecks OS identity and backend protection.
      for (const identity of inspection.alive) {
        if (deps.now() >= deadline) break;
        try {
          await deps.terminate(identity);
        } catch (error) {
          signalError = String(error);
          // A child may disappear after the parent exits. Continue stopping
          // other independently verified children, then let a fresh snapshot
          // distinguish successful exit from a real signalling failure.
        }
      }
      await deps.wait();
    } while (deps.now() < deadline);
    return { stopped: false, identities, reason: 'exit-not-confirmed' };
  } catch (error) {
    return { stopped: false, identities, reason: String(error) };
  }
}
