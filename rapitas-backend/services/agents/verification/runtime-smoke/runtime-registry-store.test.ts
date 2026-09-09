import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeRegistryStore } from './runtime-registry-store';

const dirs: string[] = [];
const valid = (v: unknown): v is { key: string } =>
  typeof v === 'object' && v !== null && typeof (v as { key?: unknown }).key === 'string';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-registry-'));
  dirs.push(dir);
  const path = join(dir, 'ownership.json');
  return { path, store: new RuntimeRegistryStore(path, valid) };
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test('concurrent updates retain both ownership records', async () => {
  const { store } = await fixture();
  await Promise.all([
    store.update((rows) => [...rows, { key: 'first' }]),
    store.update((rows) => [...rows, { key: 'second' }]),
  ]);
  expect(await store.read()).toEqual([{ key: 'first' }, { key: 'second' }]);
});

test('corruption rejects updates without overwriting evidence; repair can recover', async () => {
  const { path, store } = await fixture();
  await writeFile(path, '{broken');
  await expect(store.update(() => [{ key: 'unsafe-start' }])).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{broken');
  await writeFile(path, '{"version":1,"entries":[]}');
  await store.update(() => [{ key: 'repaired' }]);
  expect(await store.read()).toEqual([{ key: 'repaired' }]);
});

test('unknown versions, malformed records and duplicate keys fail closed', async () => {
  const { path, store } = await fixture();
  for (const value of [
    { version: 2, entries: [] },
    { version: 1, entries: [null] },
    { version: 1, entries: [{ key: 'same' }, { key: 'same' }] },
  ]) {
    await writeFile(path, JSON.stringify(value));
    await expect(store.read()).rejects.toThrow('Invalid runtime ownership snapshot');
  }
});

test('filesystem failure rejects the write rather than granting success', async () => {
  const { path } = await fixture();
  await writeFile(path, 'a file cannot be a parent directory');
  const store = new RuntimeRegistryStore(join(path, 'ownership.json'), valid);
  await expect(store.update(() => [{ key: 'unsafe-start' }])).rejects.toThrow();
});
