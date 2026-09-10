/** OS observations for auxiliary CLI ownership. Never authorizes a kill by PID alone. */
import { execFile } from 'node:child_process';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { LinuxAuxScope } from './linux-aux-cgroup';
import { withOwnershipFileLock } from './ownership-file-lock';

const execute = promisify(execFile);

export type ProcessIdentity = {
  pid: number;
  /** Native precision and boot identity; never rounded to epoch seconds. */
  birth: string;
  pgid: number | null;
};
export type ProcessObservation =
  | { kind: 'present'; identity: ProcessIdentity }
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: string };

/** Injectable I/O keeps OS failures distinct from a successful absence observation. */
export type ObservationDependencies = {
  platform: NodeJS.Platform;
  read: (path: string) => Promise<string>;
  windows: (pid: number) => Promise<string>;
};

/** Parse /proc stat without splitting the command name (which can contain spaces and ')'). */
export function parseLinuxIdentity(pid: number, stat: string, boot: string): ProcessIdentity {
  const end = stat.lastIndexOf(')');
  if (!stat.startsWith(`${pid} (`) || end < 0 || !boot.trim())
    throw new Error('Invalid proc identity');
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  // The first field here is stat field 3 (state); pgrp=5 and starttime=22.
  const pgid = Number(fields[2]);
  const ticks = fields[19];
  if (!Number.isSafeInteger(pgid) || pgid < 1 || !/^\d+$/.test(ticks ?? '')) {
    throw new Error('Incomplete proc identity');
  }
  return { pid, birth: `linux:${boot.trim()}:${ticks}`, pgid };
}

const defaults: ObservationDependencies = {
  platform: process.platform,
  read: (path) => readFile(path, 'utf8'),
  windows: async (pid) => {
    // pid is validated as a positive integer before interpolation.
    const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { 'null' } else { @{pid=[int]$p.ProcessId; birth=$p.CreationDate.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress }`;
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 64 * 1024,
      },
    );
    return stdout;
  },
};

/** Observe an identity; unsupported or failed observation is never evidence of absence. */
export async function observeProcess(
  pid: number,
  deps: ObservationDependencies = defaults,
): Promise<ProcessObservation> {
  if (!Number.isSafeInteger(pid) || pid < 1) return { kind: 'unknown', reason: 'Invalid PID' };
  try {
    if (deps.platform === 'linux') {
      // A boot-id failure must not be mistaken for a missing process stat.
      const boot = await deps.read('/proc/sys/kernel/random/boot_id');
      let stat: string;
      try {
        stat = await deps.read(`/proc/${pid}/stat`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
        throw error;
      }
      return { kind: 'present', identity: parseLinuxIdentity(pid, stat, boot) };
    }
    if (deps.platform === 'win32') {
      const raw: unknown = JSON.parse(await deps.windows(pid));
      if (raw === null) return { kind: 'absent' };
      const row = raw as { pid?: unknown; birth?: unknown };
      if (row.pid !== pid || typeof row.birth !== 'string' || !/^\d+$/.test(row.birth)) {
        return { kind: 'unknown', reason: 'Invalid Windows process identity' };
      }
      return { kind: 'present', identity: { pid, birth: `windows:${row.birth}`, pgid: null } };
    }
    return { kind: 'unknown', reason: `Native identity observation unavailable: ${deps.platform}` };
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

export type OwnershipRecord = {
  executionToken: string;
  /** Present only for launches created through the dedicated containment launcher. */
  ownershipScope?: 'windows-job' | 'linux-cgroup';
  linuxScope?: LinuxAuxScope;
  status: 'intent' | 'active' | 'stopping' | 'unresolved';
  root: ProcessIdentity | null;
  descendants: ProcessIdentity[];
  /** False includes crash windows and any incomplete OS enumeration. */
  fullyEnumerated: boolean;
};

export type OwnershipEvidence = {
  /** A successful complete ownership-scope scan, not merely a missing root. */
  scopeEmpty: boolean;
  fullyEnumerated: boolean;
  observations: Array<{ expected: ProcessIdentity; actual: ProcessObservation }>;
};

/** Only complete evidence for this execution can discharge its durable hold. */
export function canReconcileOwnership(
  record: OwnershipRecord,
  evidence: OwnershipEvidence,
): boolean {
  if (!record.root || !evidence.scopeEmpty || !evidence.fullyEnumerated) return false;
  return [record.root, ...record.descendants].every((expected) => {
    const actual = evidence.observations.find(
      (entry) => entry.expected.pid === expected.pid && entry.expected.birth === expected.birth,
    )?.actual;
    return (
      actual?.kind === 'absent' ||
      (actual?.kind === 'present' &&
        actual.identity.pid === expected.pid &&
        actual.identity.birth !== expected.birth)
    );
  });
}

function validIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const row = value as ProcessIdentity;
  return (
    Number.isSafeInteger(row.pid) &&
    row.pid > 0 &&
    typeof row.birth === 'string' &&
    row.birth.length > 0 &&
    (row.pgid === null || (Number.isSafeInteger(row.pgid) && row.pgid > 0))
  );
}

function validLinuxScope(value: unknown, token: string): value is LinuxAuxScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as LinuxAuxScope;
  return (
    typeof scope.path === 'string' &&
    scope.path.startsWith('/sys/fs/cgroup/') &&
    !scope.path.split('/').some((part) => part === '..' || part === '.') &&
    scope.path.endsWith(`/rapitas-aux-${token}`) &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(token) &&
    typeof scope.boot === 'string' &&
    scope.boot.length > 0 &&
    typeof scope.device === 'string' &&
    /^\d+$/.test(scope.device) &&
    typeof scope.inode === 'string' &&
    /^\d+$/.test(scope.inode)
  );
}

function parseRegistry(content: string): OwnershipRecord[] {
  const parsed = JSON.parse(content) as { version?: unknown; records?: unknown };
  if (parsed?.version !== 1 || !Array.isArray(parsed.records))
    throw new Error('Invalid ownership registry');
  const tokens = new Set<string>();
  for (const value of parsed.records) {
    const row = value as OwnershipRecord;
    if (
      !row ||
      typeof row.executionToken !== 'string' ||
      !row.executionToken ||
      (row.ownershipScope !== undefined &&
        !['windows-job', 'linux-cgroup'].includes(row.ownershipScope)) ||
      (row.ownershipScope === 'linux-cgroup'
        ? !validLinuxScope(row.linuxScope, row.executionToken)
        : row.linuxScope !== undefined) ||
      tokens.has(row.executionToken) ||
      !['intent', 'active', 'stopping', 'unresolved'].includes(row.status) ||
      !(row.root === null || validIdentity(row.root)) ||
      !Array.isArray(row.descendants) ||
      !row.descendants.every(validIdentity) ||
      typeof row.fullyEnumerated !== 'boolean' ||
      (row.status === 'active' && row.root === null)
    )
      throw new Error('Invalid ownership record');
    tokens.add(row.executionToken);
  }
  return parsed.records;
}

const registryQueues = new Map<string, Promise<unknown>>();
/** Serialize all instances using the same registry within this backend process. */
async function serializeRegistry<T>(path: string, action: () => Promise<T>): Promise<T> {
  const prior = registryQueues.get(path) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => withOwnershipFileLock(path, action));
  registryQueues.set(path, next);
  try {
    return await next;
  } finally {
    if (registryQueues.get(path) === next) registryQueues.delete(path);
  }
}

/** Durable records; a corrupt existing file remains in place and rejects every update. */
export function createOwnershipRegistry(filename: string) {
  const path = resolve(filename);
  let initialized = false;
  let failure: Error | null = null;
  const read = async () => {
    try {
      const records = parseRegistry(await readFile(path, 'utf8'));
      initialized = true;
      return records;
    } catch (error) {
      if (!initialized && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await readFile(`${path}.initialized`, 'utf8');
        } catch (markerError) {
          if ((markerError as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw markerError;
        }
        throw new Error('Previously initialized ownership registry is missing');
      }
      throw error;
    }
  };
  const write = async (records: OwnershipRecord[]) => {
    const content = JSON.stringify({ version: 1, records });
    parseRegistry(content);
    await mkdir(dirname(path), { recursive: true });
    // Persist the existence witness before the first launch record. If a crash
    // interrupts this write sequence, missing data must block rather than reset.
    const witness = await open(`${path}.initialized`, 'a');
    try {
      if ((await witness.stat()).size === 0) await witness.writeFile('1');
      await witness.sync();
    } finally {
      await witness.close();
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx');
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      initialized = true;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };
  const run = <T>(action: () => Promise<T>) =>
    serializeRegistry(path, async () => {
      if (failure) throw failure;
      try {
        return await action();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        throw failure;
      }
    });
  return {
    snapshot: () => run(read),
    recordLaunchIntent: (
      executionToken: string,
      ownershipScope?: 'windows-job' | 'linux-cgroup',
      linuxScope?: LinuxAuxScope,
    ) =>
      run(async () => {
        const records = await read();
        if (records.some((row) => row.executionToken === executionToken))
          throw new Error('Duplicate execution token');
        records.push({
          executionToken,
          ...(ownershipScope ? { ownershipScope } : {}),
          ...(linuxScope ? { linuxScope } : {}),
          status: 'intent',
          root: null,
          descendants: [],
          fullyEnumerated: false,
        });
        await write(records);
      }),
    confirmOwnership: (executionToken: string, root: ProcessIdentity) =>
      run(async () => {
        const records = await read();
        const row = records.find((record) => record.executionToken === executionToken);
        if (!row || row.status !== 'intent' || !validIdentity(root))
          throw new Error('Invalid ownership confirmation');
        row.root = root;
        row.status = 'active';
        await write(records);
      }),
    recordDescendants: (
      executionToken: string,
      identities: ProcessIdentity[],
      fullyEnumerated: boolean,
    ) =>
      run(async () => {
        const records = await read();
        const row = records.find((record) => record.executionToken === executionToken);
        if (!row || !identities.every(validIdentity))
          throw new Error('Invalid descendant observation');
        // Never forget a formerly captured child after reparenting or PID reuse.
        for (const identity of identities) {
          if (
            !row.descendants.some(
              (prior) => prior.pid === identity.pid && prior.birth === identity.birth,
            )
          ) {
            row.descendants.push(identity);
          }
        }
        row.fullyEnumerated = fullyEnumerated;
        await write(records);
      }),
    markStopping: (executionToken: string) =>
      run(async () => {
        const records = await read();
        const row = records.find((record) => record.executionToken === executionToken);
        if (!row) throw new Error('Unknown execution token');
        row.status = 'stopping';
        await write(records);
      }),
    reconcile: (
      executionToken: string,
      inspect: (record: OwnershipRecord) => Promise<OwnershipEvidence>,
    ) =>
      run(async () => {
        const records = await read();
        const row = records.find((record) => record.executionToken === executionToken);
        if (!row) return false;
        let resolved = false;
        try {
          // Evidence providers cannot mutate the stored ownership proof.
          resolved = canReconcileOwnership(row, await inspect(structuredClone(row)));
        } catch {
          // Observation failure preserves this execution; it is not an I/O reset.
          resolved = false;
        }
        if (resolved) records.splice(records.indexOf(row), 1);
        else row.status = 'unresolved';
        await write(records);
        return resolved;
      }),
  };
}
