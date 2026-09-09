/** Query only our named containment scope; failure never authorizes a retry. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execute = promisify(execFile);
const validToken = (token: string) => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(token);

/** A signal request only; recovery evidence must still confirm that the scope is empty. */
export async function requestWindowsAuxJobStop(token: string): Promise<void> {
  if (process.platform !== 'win32' || !validToken(token))
    throw new Error('Invalid Windows job stop request');
  const source = join(import.meta.dir, 'windows-aux-job.cs').replace(/'/g, "''");
  await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; Add-Type -Path '${source}'; [RapitasAuxJob]::RequestStop('${token}')`,
    ],
    { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 },
  );
}
export type WindowsJobObservation =
  | { kind: 'absent' }
  | { kind: 'present'; activeProcesses: number }
  | { kind: 'unknown'; reason: string };

export async function observeWindowsAuxJob(token: string): Promise<WindowsJobObservation> {
  if (process.platform !== 'win32' || !validToken(token))
    return { kind: 'unknown', reason: 'Invalid Windows job observation request' };
  try {
    const source = join(import.meta.dir, 'windows-aux-job.cs').replace(/'/g, "''");
    const { stdout } = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; Add-Type -Path '${source}'; [RapitasAuxJob]::ActiveProcesses('${token}')`,
      ],
      { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 },
    );
    const value = stdout.trim();
    if (value === '-1') return { kind: 'absent' };
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      return { kind: 'unknown', reason: 'Invalid job accounting response' };
    return { kind: 'present', activeProcesses: Number(value) };
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}
