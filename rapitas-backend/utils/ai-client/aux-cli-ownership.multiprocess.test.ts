import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnershipRegistry } from './aux-cli-ownership';

test('separate backend processes cannot overwrite each other ownership intents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rapitas-ownership-processes-'));
  const registryPath = join(directory, 'ownership.json');
  const registry = createOwnershipRegistry(registryPath);
  await registry.recordLaunchIntent('seed');
  const fixture = join(directory, 'writer.ts');
  await writeFile(
    fixture,
    `
import { createOwnershipRegistry } from ${JSON.stringify(join(import.meta.dir, 'aux-cli-ownership.ts'))};
const registry=createOwnershipRegistry(process.argv[2]);
for(let i=0;i<8;i++) await registry.recordLaunchIntent(process.argv[3]+'-'+i);
`,
  );
  try {
    const results = await Promise.allSettled(
      Array.from(
        { length: 4 },
        (_, index) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [fixture, registryPath, String(index)], {
              stdio: ['ignore', 'ignore', 'pipe'],
              windowsHide: true,
            });
            let errors = '';
            child.stderr.on('data', (data) => {
              errors += data;
            });
            child.once('error', reject);
            child.once('close', (code) =>
              code === 0 ? resolve() : reject(new Error(errors || `writer exit ${code}`)),
            );
          }),
      ),
    );
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const records = await registry.snapshot();
    expect(records).toHaveLength(33);
    expect(new Set(records.map((row) => row.executionToken)).size).toBe(33);
  } finally {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  }
}, 15000);
