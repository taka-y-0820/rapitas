/** Linux cgroup-v2 ownership. No PID-based signaling or successful-empty fallback on error. */
import { access, mkdir, open, readFile, realpath, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, basename } from 'node:path';

export type LinuxAuxScope = { path: string; boot: string; device: string; inode: string };
export type LinuxScopeObservation =
  | { kind: 'present'; populated: boolean }
  | { kind: 'absent'; reason: 'different-boot' }
  | { kind: 'unknown'; reason: string };

const tokenPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
function validate(scope: LinuxAuxScope) {
  if (
    process.platform !== 'linux' ||
    !scope.path.startsWith('/sys/fs/cgroup/') ||
    !basename(scope.path).startsWith('rapitas-aux-') ||
    !tokenPattern.test(basename(scope.path).slice('rapitas-aux-'.length)) ||
    !scope.boot ||
    !/^\d+$/.test(scope.device) ||
    !/^\d+$/.test(scope.inode)
  )
    throw new Error('Invalid auxiliary cgroup identity');
}
const bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();

/** Pin the directory inode for every control operation, rejecting path replacement. */
async function ownedDirectory<T>(
  scope: LinuxAuxScope,
  action: (path: string) => Promise<T>,
): Promise<T> {
  validate(scope);
  if ((await bootId()) !== scope.boot) throw new Error('Auxiliary cgroup belongs to another boot');
  if ((await realpath(scope.path)) !== scope.path) throw new Error('Auxiliary cgroup path changed');
  const directory = await open(
    scope.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await directory.stat({ bigint: true });
    if (stat.dev.toString() !== scope.device || stat.ino.toString() !== scope.inode)
      throw new Error('Auxiliary cgroup identity changed');
    return await action(`/proc/self/fd/${directory.fd}`);
  } finally {
    await directory.close();
  }
}

/** Creates an empty private scope only; caller must durably record it before spawning. */
export async function createLinuxAuxScope(
  delegatedRoot: string,
  token: string,
): Promise<LinuxAuxScope> {
  if (process.platform !== 'linux' || !tokenPattern.test(token))
    throw new Error('Invalid cgroup launch');
  const parent = await realpath(delegatedRoot);
  if (!parent.startsWith('/sys/fs/cgroup/'))
    throw new Error('Expected delegated cgroup-v2 directory');
  await readFile(join(parent, 'cgroup.type'), 'utf8');
  const boot = await bootId();
  const path = join(parent, `rapitas-aux-${token}`);
  await mkdir(path); // Never reuse an existing execution scope.
  try {
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await directory.stat({ bigint: true });
      await access(join(path, 'cgroup.kill'), constants.W_OK);
      await access(join(path, 'cgroup.procs'), constants.W_OK);
      return { path, boot, device: stat.dev.toString(), inode: stat.ino.toString() };
    } finally {
      await directory.close();
    }
  } catch (error) {
    // rmdir is nonrecursive and the kernel rejects populated cgroups.
    await rmdir(path).catch(() => {});
    throw error;
  }
}

export async function observeLinuxAuxScope(scope: LinuxAuxScope): Promise<LinuxScopeObservation> {
  try {
    validate(scope);
    if ((await bootId()) !== scope.boot) return { kind: 'absent', reason: 'different-boot' };
    return await ownedDirectory(scope, async (path) => {
      const events = await readFile(join(path, 'cgroup.events'), 'utf8');
      const match = events.match(/^populated ([01])$/m);
      if (!match) throw new Error('Invalid cgroup population observation');
      return { kind: 'present' as const, populated: match[1] === '1' };
    });
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function requestLinuxAuxScopeStop(scope: LinuxAuxScope): Promise<void> {
  await ownedDirectory(scope, async (path) => {
    const control = await open(join(path, 'cgroup.kill'), 'w');
    try {
      await control.writeFile('1');
    } finally {
      await control.close();
    }
  });
}

/** Launcher moves itself before exec. Positional argv preserves spaces and shell metacharacters. */
export function linuxAuxLauncher(scope: LinuxAuxScope, command: string, args: string[]) {
  validate(scope);
  return {
    command: '/bin/sh',
    args: [
      '-c',
      'printf "%s" "$$" > "$1/cgroup.procs" || exit 97; shift; exec "$@"',
      'rapitas-aux-launcher',
      scope.path,
      command,
      ...args,
    ],
    shell: false as const,
  };
}
