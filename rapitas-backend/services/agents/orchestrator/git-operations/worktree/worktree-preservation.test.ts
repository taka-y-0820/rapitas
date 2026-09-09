import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isWorktreeContentPreserved } from './worktree-preservation';

let directory: string;
const prefix = join(tmpdir(), 'rapitas-preservation-');
const tag = 'recovery/task-913-123456';
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
const write = (name: string, content: string) => writeFileSync(join(directory, name), content);

beforeEach(() => {
  directory = mkdtempSync(prefix);
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Preservation test');
  write('existing.txt', 'original\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
});

afterEach(() => {
  const target = resolve(directory);
  if (!target.startsWith(resolve(prefix)) || !target.startsWith(resolve(tmpdir()) + sep)) {
    throw new Error('Unsafe test fixture cleanup path');
  }
  rmSync(target, { recursive: true, force: true });
});

function snapshot() {
  git('add', '-A');
  git('tag', tag, git('stash', 'create'));
}

test('clean content is preserved in HEAD', async () => {
  expect(await isWorktreeContentPreserved(directory)).toBe(true);
});

test('uncommitted edits and new files refuse ordinary removal', async () => {
  write('existing.txt', 'edited\n');
  expect(await isWorktreeContentPreserved(directory)).toBe(false);
  git('restore', 'existing.txt');
  write('new.txt', 'new\n');
  expect(await isWorktreeContentPreserved(directory)).toBe(false);
});

test('durable snapshot includes both modified and newly staged files', async () => {
  write('existing.txt', 'edited\n');
  write('new.txt', 'new\n');
  snapshot();
  expect(await isWorktreeContentPreserved(directory, tag)).toBe(true);
  expect(git('show', `${tag}:new.txt`)).toBe('new');
});

test('edits after snapshot cannot be discarded', async () => {
  write('existing.txt', 'edited\n');
  snapshot();
  write('existing.txt', 'later\n');
  await expect(isWorktreeContentPreserved(directory, tag)).rejects.toThrow();
});

test('new files after snapshot cannot be discarded', async () => {
  write('existing.txt', 'edited\n');
  snapshot();
  write('later.txt', 'not saved\n');
  expect(await isWorktreeContentPreserved(directory, tag)).toBe(false);
});

test('missing snapshot rejects instead of authorizing removal', async () => {
  write('existing.txt', 'edited\n');
  await expect(isWorktreeContentPreserved(directory, tag)).rejects.toThrow();
});
