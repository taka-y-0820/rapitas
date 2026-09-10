/** Platform admission boundary for auxiliary CLI containment. */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createOwnershipRegistry } from './aux-cli-ownership';
import { createWindowsAuxExecutionManager } from './windows-aux-execution';
import { createLinuxAuxExecutionManager } from './linux-aux-execution';

let windowsManager: ReturnType<typeof createWindowsAuxExecutionManager> | undefined;
let linuxManager: ReturnType<typeof createLinuxAuxExecutionManager> | undefined;
export async function prepareAuxCli(
  command: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
) {
  if (process.platform === 'linux') {
    linuxManager ??= createLinuxAuxExecutionManager(
      createOwnershipRegistry(
        join(
          process.env.RAPITAS_DATA_DIR?.trim() || join(homedir(), '.rapitas'),
          'aux-cli-ownership.json',
        ),
      ),
    );
    return linuxManager.reserve(command, args, directory, env);
  }
  if (process.platform !== 'win32')
    throw new Error(`Owned auxiliary CLI launch is unavailable on ${process.platform}`);
  windowsManager ??= createWindowsAuxExecutionManager(
    createOwnershipRegistry(
      join(
        process.env.RAPITAS_DATA_DIR?.trim() || join(homedir(), '.rapitas'),
        'aux-cli-ownership.json',
      ),
    ),
  );
  const shell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  return windowsManager.reserve(`"${shell}" /d /s /c "${command}"`, directory, env);
}
