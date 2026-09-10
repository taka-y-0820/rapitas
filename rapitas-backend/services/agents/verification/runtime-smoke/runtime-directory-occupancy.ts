import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeProcessIdentity } from './runtime-process-identity';

/**
 * Inspect Next's server-info files in the supported Rapitas layouts. Never
 * delete a lock or signal its PID: these files establish occupancy, not
 * ownership. An unlocked file may remain after process exit on POSIX.
 */
export async function inspectRuntimeDirectory(
  workdir: string,
  processes: RuntimeProcessIdentity[],
): Promise<{ free: boolean; reason?: string }> {
  for (const project of ['', 'rapitas-frontend']) {
    for (const output of ['.next', '.next-tauri']) {
      for (const variant of ['', 'dev']) {
        const path = join(workdir, project, output, variant, 'lock');
        let content: string;
        try {
          content = await readFile(path, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          return { free: false, reason: `Cannot inspect runtime lock: ${path}` };
        }
        try {
          const info = JSON.parse(content);
          if (!Number.isInteger(info?.pid) || info.pid <= 0) {
            return { free: false, reason: `Unknown runtime lock owner: ${path}` };
          }
          if (processes.some((process) => process.pid === info.pid)) {
            return {
              free: false,
              reason: `Runtime directory occupied by PID ${info.pid}: ${path}`,
            };
          }
        } catch {
          return { free: false, reason: `Unreadable runtime lock metadata: ${path}` };
        }
      }
    }
  }
  return { free: true };
}
