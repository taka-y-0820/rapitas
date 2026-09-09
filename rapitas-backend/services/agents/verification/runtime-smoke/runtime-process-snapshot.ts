/** Nonblocking OS snapshot. Failure rejects; callers must keep ownership held. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir } from 'fs/promises';
import type { RuntimeProcessIdentity } from './runtime-process-identity';

const exec = promisify(execFile);
export interface RuntimeProcessSnapshot {
  processes: RuntimeProcessIdentity[];
  protectedPids: Set<number>;
  listeners?: Array<{ port: number; pid: number }>;
}

export function ownsRuntimePort(
  snapshot: RuntimeProcessSnapshot,
  identities: RuntimeProcessIdentity[],
  port: number,
): boolean {
  if (!snapshot.listeners) return false;
  const owners = snapshot.listeners.filter((listener) => listener.port === port);
  const pids = new Set(identities.map((identity) => identity.pid));
  return owners.length > 0 && owners.every((owner) => pids.has(owner.pid));
}

const windowsScript = `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; birth=([string]$_.CreationDate.ToUniversalTime().Ticks); command=[string]$_.CommandLine}
})
$listeners = @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{port=[int]$_.LocalPort; pid=[int]$_.OwningProcess} })
$protected = @($listeners | Where-Object port -eq 3001 | ForEach-Object {$_.pid})
@{processes=$rows; protectedPids=$protected; listeners=$listeners} | ConvertTo-Json -Depth 4 -Compress
`;

export function parseWindowsRuntimeSnapshot(raw: string): RuntimeProcessSnapshot {
  const value = JSON.parse(raw);
  if (!Array.isArray(value.processes) || !Array.isArray(value.protectedPids)) {
    throw new Error('Incomplete OS process snapshot');
  }
  for (const row of value.processes) {
    if (
      !Number.isInteger(row?.pid) ||
      !Number.isInteger(row?.parentPid) ||
      typeof row.birth !== 'string' ||
      !/^\d+$/.test(row.birth) ||
      typeof row.command !== 'string'
    ) {
      throw new Error('Invalid OS process identity');
    }
  }
  if (!value.protectedPids.every((pid: unknown) => Number.isInteger(pid))) {
    throw new Error('Invalid protected process list');
  }
  if (
    !Array.isArray(value.listeners) ||
    !value.listeners.every(
      (v: { port: number; pid: number }) =>
        Number.isInteger(v?.port) &&
        v.port > 0 &&
        v.port < 65536 &&
        Number.isInteger(v.pid) &&
        v.pid > 0,
    )
  ) {
    throw new Error('Missing or invalid listener ownership');
  }
  return {
    processes: value.processes,
    protectedPids: new Set<number>([process.pid, ...value.protectedPids]),
    listeners: value.listeners,
  };
}

/** Linux starttime is field 22, expressed in ticks since system boot. */
export function parseLinuxRuntimeStat(stat: string, command: string): RuntimeProcessIdentity {
  const end = stat.lastIndexOf(')');
  const pid = Number(stat.slice(0, stat.indexOf(' ')));
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (
    end < 0 ||
    !Number.isInteger(pid) ||
    !/^\d+$/.test(fields[19] ?? '') ||
    !Number.isInteger(Number(fields[1]))
  )
    throw new Error('Invalid Linux process identity');
  return { pid, parentPid: Number(fields[1]), birth: fields[19], command };
}

/** Parse `ss -H -ltnp`; anonymous listener owners are explicitly unknown (PID 0). */
export function parseLinuxRuntimeListeners(raw: string): Array<{ port: number; pid: number }> {
  const listeners: Array<{ port: number; pid: number }> = [];
  for (const line of raw.split('\n').filter((row) => row.trim())) {
    const columns = line.trim().split(/\s+/);
    const match = columns[3]?.match(/:(\d+)$/);
    if (columns[0] !== 'LISTEN' || !match) throw new Error('Invalid ss listener output');
    const port = Number(match[1]);
    if (port <= 0 || port > 65535) throw new Error('Invalid listener port');
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((item) => Number(item[1]));
    for (const pid of pids.length ? pids : [0]) listeners.push({ port, pid });
  }
  return listeners;
}

export async function readRuntimeProcessSnapshot(): Promise<RuntimeProcessSnapshot> {
  if (process.platform === 'win32') {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', windowsScript],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return parseWindowsRuntimeSnapshot(stdout);
  }
  if (process.platform !== 'linux') {
    // Do not silently substitute PID-only identity on an unsupported OS.
    throw new Error(`Runtime process identity unavailable on ${process.platform}`);
  }
  const processes: RuntimeProcessIdentity[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const [stat, cmd] = await Promise.all([
        readFile(`/proc/${name}/stat`, 'utf8'),
        readFile(`/proc/${name}/cmdline`, 'utf8'),
      ]);
      processes.push(parseLinuxRuntimeStat(stat, cmd.replace(/\0/g, ' ').trim()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  // ss is read-only. Its failure cannot authorize any stop operation.
  const { stdout } = await exec('ss', ['-H', '-ltnp'], { timeout: 5000 });
  const listeners = parseLinuxRuntimeListeners(stdout);
  const protectedPids = new Set<number>([process.pid]);
  for (const listener of listeners.filter((item) => item.port === 3001)) {
    if (listener.pid === 0) throw new Error('Cannot identify backend listener owner');
    protectedPids.add(listener.pid);
  }
  return { processes, protectedPids, listeners };
}
