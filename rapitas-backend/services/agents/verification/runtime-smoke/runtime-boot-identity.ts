/** OS boot evidence; never infer a reboot from elapsed wall-clock time. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let observation: Promise<string | undefined> | undefined;

/** A backend process cannot survive an OS reboot, so a successful observation is stable. */
export function readRuntimeBootId(): Promise<string | undefined> {
  return (observation ??= observeBoot().catch(() => undefined));
}

async function observeBoot(): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const id = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return isRuntimeBootId(`linux:${id}`) ? `linux:${id}` : undefined;
  }
  if (process.platform !== 'win32') return undefined;
  // Kernel-General event 12 records OS startup, not an application/service restart.
  // https://learn.microsoft.com/en-us/troubleshoot/windows-server/performance/troubleshoot-unexpected-reboots-system-event-logs
  const { stdout } = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; $event=Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-General'; Id=12} -MaxEvents 1; [Console]::Write($event.RecordId.ToString()+':'+$event.TimeCreated.ToUniversalTime().Ticks.ToString())",
    ],
    { windowsHide: true, timeout: 8000, maxBuffer: 4096 },
  );
  const id = stdout.trim();
  return isRuntimeBootId(`windows-event12:${id}`) ? `windows-event12:${id}` : undefined;
}

export function isRuntimeBootId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ||
      /^windows-event12:[1-9]\d*:[1-9]\d*$/.test(value))
  );
}

/** Missing evidence, or switching evidence mechanisms, is never reboot proof. */
export function isPriorRuntimeBoot(previous?: string, current?: string): boolean {
  return Boolean(
    isRuntimeBootId(previous) &&
    isRuntimeBootId(current) &&
    previous !== current &&
    previous.split(':')[0] === current.split(':')[0],
  );
}
