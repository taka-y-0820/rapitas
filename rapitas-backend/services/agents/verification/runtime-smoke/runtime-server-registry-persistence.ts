/**
 * runtime-smoke/runtime-server-registry-persistence
 *
 * Durable state for the workdir-scoped runtime server registry:
 * `.agent-pids/runtime-servers.json`. A single write chain (RuntimeRegistryStore)
 * serializes concurrent updates (temp+rename keeps each individual write
 * atomic; the chain keeps the SEQUENCE of writes ordered so a fast second
 * update can never be clobbered by a slower first one finishing later).
 */
import { RuntimeRegistryStore } from './runtime-registry-store';
import { isRuntimeProcessIdentity, type RuntimeProcessIdentity } from './runtime-process-identity';
import { PERSIST_PATH, type RegistryEntry } from './runtime-server-registry-types';

export interface PersistedEntry {
  key: string;
  workdir: string;
  state: 'starting' | 'active' | 'quarantined';
  configFingerprint: string;
  port?: number;
  baseUrl?: string;
  pid?: number;
  startedAt: string;
  identities?: RuntimeProcessIdentity[];
}

function validPersistedEntry(value: unknown): value is PersistedEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as PersistedEntry;
  return (
    typeof v.key === 'string' &&
    v.key.length > 0 &&
    typeof v.workdir === 'string' &&
    typeof v.configFingerprint === 'string' &&
    ['starting', 'active', 'quarantined'].includes(v.state) &&
    typeof v.startedAt === 'string' &&
    Number.isFinite(Date.parse(v.startedAt)) &&
    (v.pid === undefined || (Number.isInteger(v.pid) && v.pid > 0)) &&
    (v.port === undefined || (Number.isInteger(v.port) && v.port > 0 && v.port < 65536)) &&
    (v.baseUrl === undefined || typeof v.baseUrl === 'string') &&
    (v.identities === undefined ||
      (Array.isArray(v.identities) && v.identities.every(isRuntimeProcessIdentity)))
  );
}

export const ownershipStore = new RuntimeRegistryStore<PersistedEntry>(
  PERSIST_PATH,
  validPersistedEntry,
);

function upsertPersisted(entryData: PersistedEntry): Promise<void> {
  return ownershipStore.update((entries) => [
    ...entries.filter((entry) => entry.key !== entryData.key),
    entryData,
  ]);
}

function removePersisted(key: string): Promise<void> {
  return ownershipStore.update((entries) => entries.filter((entry) => entry.key !== key));
}

export function persistStartingIntent(key: string, workdir: string, fp: string): Promise<void> {
  return upsertPersisted({
    key,
    workdir,
    state: 'starting',
    configFingerprint: fp,
    startedAt: new Date().toISOString(),
  });
}

export function persistActive(entry: RegistryEntry, pid: number | undefined): Promise<void> {
  return upsertPersisted({
    key: entry.key,
    workdir: entry.workdir,
    state: entry.state === 'stopping' ? 'quarantined' : entry.state,
    configFingerprint: entry.configFingerprint,
    port: entry.port,
    baseUrl: entry.baseUrl,
    pid,
    identities: entry.identities,
    startedAt: new Date().toISOString(),
  });
}

export function persistQuarantine(entry: RegistryEntry): Promise<void> {
  return upsertPersisted({
    key: entry.key,
    workdir: entry.workdir,
    state: 'quarantined',
    configFingerprint: entry.configFingerprint,
    port: entry.port,
    baseUrl: entry.baseUrl,
    pid: entry.app?.pid,
    identities: entry.identities,
    startedAt: new Date().toISOString(),
  });
}

export function persistRemoval(key: string): Promise<void> {
  return removePersisted(key);
}
