import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { observeCommand, withCommandEvidence, type CommandEvidence } from './command-evidence';
import { spawnQuiet } from './quiet-verification';

test('the production quiet process runner records its real exit', async () => {
  const records: CommandEvidence[] = [];
  await withCommandEvidence(records, () => {
    const child = spawnQuiet(`"${process.execPath}" -e "process.exit(19)"`, {
      cwd: process.cwd(),
      shell: true,
    });
    return new Promise<void>((resolve) => child.once('close', () => resolve()));
  });
  expect(records[0]).toMatchObject({ exitCode: 19, status: 'exited', cwd: process.cwd() });
});

function execute(code: number): Promise<void> {
  const child = spawn(process.execPath, ['-e', `process.exit(${code})`], { cwd: process.cwd() });
  observeCommand(`exit-${code}`, { cwd: process.cwd() }, child);
  return new Promise((resolve) => child.once('close', () => resolve()));
}

test('concurrent scopes retain exact nonzero process codes without mixing jobs', async () => {
  const first: CommandEvidence[] = [];
  const second: CommandEvidence[] = [];
  await Promise.all([
    withCommandEvidence(first, () => execute(7)),
    withCommandEvidence(second, () => execute(23)),
  ]);
  expect(first).toEqual([
    { command: 'exit-7', cwd: process.cwd(), status: 'exited', exitCode: 7, signal: null },
  ]);
  expect(second).toEqual([
    { command: 'exit-23', cwd: process.cwd(), status: 'exited', exitCode: 23, signal: null },
  ]);
});

test('spawn failure has no invented process exit code', async () => {
  const records: CommandEvidence[] = [];
  await withCommandEvidence(records, () => {
    const child = spawn('missing-rapitas-test-executable-12345');
    observeCommand('missing executable', {}, child);
    return new Promise<void>((resolve) => child.once('close', () => resolve()));
  });
  expect(records[0].status).toBe('spawn_failed');
  expect(records[0].exitCode).toBeNull();
  expect(records[0].error).toBeTruthy();
});
