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

/** One helper and listener query for the whole tree, with an OS handle per identity. */
export async function terminateRuntimeIdentities(
  identities: RuntimeProcessIdentity[],
): Promise<void> {
  for (const identity of identities) {
    if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.birth)) {
      throw new Error('Invalid stop identity');
    }
  }
  if (identities.length === 0) return;
  if (process.platform !== 'win32') throw new Error('Handle-based runtime termination unavailable');
  const targets = identities
    .map((identity) => `@{pid=${identity.pid}; birth='${identity.birth}'}`)
    .join(',');
  // Hold all verified handles before signalling the root. A disappearing child
  // must not prevent stopping its siblings; a fresh snapshot decides success.
  const script = `
$ErrorActionPreference='Stop'
$handles = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$failures = New-Object System.Collections.Generic.List[string]
try {
  $listeners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3001)
  foreach ($target in @(${targets})) {
    $targetProcess = $null
    try {
      $targetProcess = [System.Diagnostics.Process]::GetProcessById($target.pid)
      $null = $targetProcess.Handle
      $birthTicks = $targetProcess.StartTime.ToUniversalTime().Ticks
      $birthTicks -= $birthTicks % 10 # CIM timestamps have microsecond precision
      if ([string]$birthTicks -ne $target.birth) { throw 'Process identity changed' }
      if ($listeners.OwningProcess -contains $target.pid) { throw 'Backend process is protected' }
      $handles.Add($targetProcess)
      $targetProcess = $null
    } catch { $failures.Add([string]$_) }
    finally { if ($null -ne $targetProcess) { $targetProcess.Dispose() } }
  }
  foreach ($targetProcess in $handles) {
    try { $targetProcess.Kill() } catch { $failures.Add([string]$_) }
  }
  if ($failures.Count -gt 0) { throw ($failures -join '; ') }
} finally { foreach ($targetProcess in $handles) { $targetProcess.Dispose() } }
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
  terminateMany?(identities: RuntimeProcessIdentity[]): Promise<void>;
  wait(): Promise<void>;
  now(): number;
}
const defaults: RuntimeStopDependencies = {
  snapshot: readRuntimeProcessSnapshot,
  terminate: (identity) => terminateRuntimeIdentities([identity]),
  terminateMany: terminateRuntimeIdentities,
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
    while (true) {
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
      if (deps.now() >= deadline)
        return { stopped: false, identities, reason: 'exit-not-confirmed' };
      // Remember newly captured descendants before the parent links disappear.
      // Recording failure must not prevent an explicitly requested stop of
      // positively identified processes. The caller retains its exclusion
      // until durable removal succeeds, even after all processes are gone.
      try {
        await persistOwnership(identities);
      } catch (error) {
        persistenceError = String(error);
      }
      // Production sends the entire captured tree through one helper so shell
      // startup and listener queries cannot exhaust the budget between children.
      if (deps.terminateMany) {
        try {
          await deps.terminateMany(inspection.alive);
        } catch (error) {
          signalError = String(error);
        }
      } else {
        for (const identity of inspection.alive) {
          if (deps.now() >= deadline) break;
          try {
            await deps.terminate(identity);
          } catch (error) {
            signalError = String(error);
          }
        }
      }
      await deps.wait();
    }
  } catch (error) {
    return { stopped: false, identities, reason: String(error) };
  }
}
