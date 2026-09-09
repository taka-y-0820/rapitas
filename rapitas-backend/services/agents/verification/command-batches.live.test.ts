import { expect, test } from 'bun:test';
import { exec } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFileCommands } from './command-batches';

test('real shell preserves a long file list and a later batch failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rapitas-command-batches-'));
  try {
    const script = join(directory, 'capture.cjs');
    await writeFile(
      script,
      'console.log(JSON.stringify(process.argv.slice(2))); if(process.argv.includes("fail.ts"))process.exitCode=7;',
    );
    const files = Array.from(
      { length: 200 },
      (_, i) => `src/long directory/${'x'.repeat(80)}-${i}.ts`,
    );
    files.push('fail.ts');
    const commands = buildFileCommands(
      `"${process.execPath}" "${script}"`,
      files.map((file) => `"${file}"`),
    );
    const observed: string[] = [];
    const codes: number[] = [];
    for (const command of commands) {
      const result = await new Promise<{ code: number; stdout: string }>((complete) => {
        exec(command, { timeout: 10000, windowsHide: true }, (error, stdout) => {
          complete({ code: error ? Number(error.code) : 0, stdout });
        });
      });
      codes.push(result.code);
      observed.push(...JSON.parse(result.stdout));
    }
    expect(observed).toEqual(files);
    expect(codes.slice(0, -1).every((code) => code === 0)).toBe(true);
    expect(codes.at(-1)).toBe(7);
    expect(commands.every((command) => command.length <= 6000)).toBe(true);
  } finally {
    const target = resolve(directory);
    if (
      !target.startsWith(resolve(tmpdir()) + '\\') &&
      !target.startsWith(resolve(tmpdir()) + '/')
    ) {
      throw new Error('Unexpected temporary directory');
    }
    await rm(target, { recursive: true, force: true });
  }
}, 30000);
