import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { typecheckProject } from './automated-verifier';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'rapitas-typecheck-'));
  roots.push(root);
  const project = join(root, 'packages', 'backend');
  mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(project, 'node_modules', 'bun-types'), { recursive: true });
  writeFileSync(join(project, 'node_modules', 'bun-types', 'index.d.ts'), '');
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ['*.ts'] }),
  );
  writeFileSync(join(project, 'changed.ts'), source);
  const compiler = require.resolve('typescript/bin/tsc');
  const windows = process.platform === 'win32';
  const bin = join(project, 'node_modules', '.bin', windows ? 'tsc.cmd' : 'tsc');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    bin,
    windows
      ? `@"${process.execPath}" "${compiler}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(compiler)} "$@"\n`,
  );
  if (!windows) chmodSync(bin, 0o755);
  return { root, project };
}

test('scoped monorepo typecheck actually detects a changed-file type error', async () => {
  const { root, project } = fixture('export const value: number = "wrong";');
  const result = await typecheckProject(project, root, ['packages/backend/changed.ts']);
  expect(result).toMatchObject({ ran: true, ok: false, errorCount: 1 });
  expect(result?.details).toContain('changed.ts');
}, 30000);

test('scoped monorepo typecheck accepts a correctly typed changed file', async () => {
  const { root, project } = fixture('export const value: number = 42;');
  const result = await typecheckProject(project, root, ['packages/backend/changed.ts']);
  expect(result).toMatchObject({ ran: true, ok: true, errorCount: 0 });
}, 30000);

test('compiler configuration errors cannot count as a successful check', async () => {
  const { root, project } = fixture('export const value: number = 42;');
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { invalidCompilerFlag: true }, include: ['*.ts'] }),
  );
  const result = await typecheckProject(project, root, ['packages/backend/changed.ts']);
  expect(result).toMatchObject({ ran: false, ok: false, unverifiable: true });
  expect(result?.details).toContain('TS5023');
}, 30000);
