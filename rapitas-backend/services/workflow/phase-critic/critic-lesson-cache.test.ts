import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readCriticLessonCache, writeCriticLessonCache } from './critic-lesson-cache';

let dir: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.RAPITAS_DATA_DIR;
  dir = await mkdtemp(join(tmpdir(), 'rapitas-critic-cache-'));
  process.env.RAPITAS_DATA_DIR = dir;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = previous;
  if (!resolve(dir).startsWith(resolve(tmpdir()) + sep))
    throw new Error('Unexpected test directory');
  await rm(dir, { recursive: true, force: true });
});

test('disk reload preserves fresh lessons without process memory', async () => {
  const entry = {
    fingerprint: 'source-a',
    at: Date.now(),
    bullets: ['Check explicit requirements'],
  };
  await writeCriticLessonCache('plan', entry);
  expect(await readCriticLessonCache('plan', 'source-a', 60000)).toEqual(entry);
  expect(await readCriticLessonCache('research', 'source-a', 60000)).toBeUndefined();
  expect(await readCriticLessonCache('plan', 'source-b', 60000)).toBeUndefined();
});

test('expired and future entries cannot be reused', async () => {
  for (const at of [Date.now() - 61000, Date.now() + 61000]) {
    await writeCriticLessonCache('plan', { fingerprint: 'a', at, bullets: [] });
    expect(await readCriticLessonCache('plan', 'a', 60000)).toBeUndefined();
  }
});

test('malformed contents are a cache miss, including invalid lesson payloads', async () => {
  await writeCriticLessonCache('plan', { fingerprint: 'a', at: Date.now(), bullets: [] });
  for (const data of [
    'broken-json',
    JSON.stringify({ version: 1, fingerprint: 'a', at: Date.now(), bullets: [42] }),
  ]) {
    await writeFile(join(dir, 'cache', 'critic-lessons-plan.json'), data);
    expect(await readCriticLessonCache('plan', 'a', 60000)).toBeUndefined();
  }
});

test('write failure remains best effort and never reports a false cache hit', async () => {
  await writeFile(join(dir, 'cache'), 'not a directory');
  await writeCriticLessonCache('plan', { fingerprint: 'a', at: Date.now(), bullets: [] });
  expect(await readCriticLessonCache('plan', 'a', 60000)).toBeUndefined();
});
