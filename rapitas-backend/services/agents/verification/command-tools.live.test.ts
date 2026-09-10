import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lintProject, formatProject } from './automated-verifier';

test('real eslint and prettier keep later-batch errors on a large file list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rapitas-large-tools-'));
  const modules = join(directory, 'node_modules');
  try {
    await symlink(
      await realpath(join(import.meta.dir, '../../../node_modules')),
      modules,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(
      join(directory, 'eslint.config.mjs'),
      'export default [{rules:{"no-unused-vars":"error"}}];\n',
    );
    await mkdir(join(directory, 'src'));
    const files = Array.from(
      { length: 180 },
      (_, index) => `src/${'long-file-name-'.repeat(6)}${index}.js`,
    );
    await Promise.all(
      files.map((file) => writeFile(join(directory, file), 'export const value = 1;\n')),
    );
    expect((await lintProject(directory, directory, files))?.ok).toBe(true);
    expect((await formatProject(directory, directory, files))?.ok).toBe(true);
    await writeFile(join(directory, files.at(-1)!), 'const unused=1');
    const lint = await lintProject(directory, directory, files);
    expect(lint?.ok).toBe(false);
    expect(lint?.errorCount).toBe(1);
    expect((await formatProject(directory, directory, files))?.ok).toBe(false);
  } finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + '\\') && !target.startsWith(resolve(tmpdir()) + '/'))
      throw new Error('Unexpected fixture path');
    // Remove the junction separately before deleting our temporary fixture.
    if (process.platform === 'win32') await rmdir(modules);
    else await unlink(modules);
    await rm(target, { recursive: true, force: true });
  }
}, 120000);
