import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRuntimeDirectory } from './runtime-directory-occupancy';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-occupancy-'));
  dirs.push(dir);
  const output = join(dir, 'rapitas-frontend', '.next-tauri', 'dev');
  await mkdir(output, { recursive: true });
  const lock = join(output, 'lock');
  if (content !== undefined) await writeFile(lock, content);
  return { dir, lock };
}
test('missing server-info files allow startup', async () => {
  const { dir } = await fixture();
  expect((await inspectRuntimeDirectory(dir, [])).free).toBe(true);
});
test('live external owner blocks startup without changing its lock', async () => {
  const content = JSON.stringify({ pid: 123 });
  const { dir, lock } = await fixture(content);
  expect(
    (
      await inspectRuntimeDirectory(dir, [
        { pid: 123, parentPid: 1, birth: '999', command: 'external' },
      ])
    ).free,
  ).toBe(false);
  expect(await readFile(lock, 'utf8')).toBe(content);
});
test('stale unlocked metadata for an absent process does not permanently hold workdir', async () => {
  const { dir, lock } = await fixture('{"pid":123}');
  expect((await inspectRuntimeDirectory(dir, [])).free).toBe(true);
  expect(await readFile(lock, 'utf8')).toBe('{"pid":123}');
});
test('invalid lock metadata remains an unknown occupant', async () => {
  for (const content of ['{', '{}', '{"pid":0}', '{"pid":"123"}']) {
    const { dir } = await fixture(content);
    expect((await inspectRuntimeDirectory(dir, [])).free).toBe(false);
  }
});
