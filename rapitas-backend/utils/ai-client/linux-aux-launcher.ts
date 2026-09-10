/** Dedicated Bun launcher outside the scope; closes descendants before returning CLI exit code. */
import { spawn } from 'node:child_process';
import { linuxAuxLauncher, requestLinuxAuxScopeStop, type LinuxAuxScope } from './linux-aux-cgroup';

const scope: LinuxAuxScope = JSON.parse(process.env.RAPITAS_AUX_LINUX_SCOPE || 'null');
const command: string[] = JSON.parse(process.env.RAPITAS_AUX_LINUX_COMMAND || 'null');
delete process.env.RAPITAS_AUX_LINUX_SCOPE;
delete process.env.RAPITAS_AUX_LINUX_COMMAND;
if (
  !scope ||
  !Array.isArray(command) ||
  !command.length ||
  !command.every((arg) => typeof arg === 'string')
)
  throw new Error('Invalid auxiliary Linux launch');
const launch = linuxAuxLauncher(scope, command[0], command.slice(1));
const child = spawn(launch.command, launch.args, { stdio: 'inherit', shell: false });
let ending = false;
const finish = async (code: number) => {
  if (ending) return;
  ending = true;
  clearTimeout(timer);
  try {
    await requestLinuxAuxScopeStop(scope);
    process.exit(code);
  } catch (error) {
    process.stderr.write(`Auxiliary Linux scope cleanup failed: ${String(error)}\n`);
    process.exit(1);
  }
};
const timer = setTimeout(
  () => void finish(124),
  Number(process.env.RAPITAS_AUX_AI_CLI_TIMEOUT_MS) || 120000,
);
child.once('exit', (code) => void finish(code ?? 1));
child.once('error', () => void finish(1));
process.once('SIGTERM', () => void finish(143));
