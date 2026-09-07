/** Real process contention/restart checks against an isolated budget directory. */
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assignCandidateBudget } from './prompt-comparison-alpha-ledger';

let directory: string;
let previous: string | undefined;
const modulePath = join(import.meta.dir, 'prompt-comparison-alpha-ledger.ts');

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rapitas-budget-process-'));
  previous = process.env.RAPITAS_DATA_DIR;
  process.env.RAPITAS_DATA_DIR = directory;
});
afterEach(() => {
  if (previous === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

function worker(script: string) {
  return Bun.spawn([process.execPath, '--eval', script], {
    env: { ...process.env, RAPITAS_DATA_DIR: directory },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

it('four independent workers reserve unique budgets and only one identical look', async () => {
  const children = Array.from({ length: 4 }, (_, index) =>
    worker(`
    const {assignCandidateBudget, resolveEvaluationBudget} = await import(${JSON.stringify(modulePath)});
    async function retry(fn) {
      for (let i=0; i<20; i++) {
        const r=fn(); if(r.issue !== 'io_error') return r;
        await Bun.sleep(10);
      }
      throw new Error('lock never acquired');
    }
    for(let id=${index * 10 + 1}; id<=${index * 10 + 10}; id++) {
      const r=await retry(()=>assignCandidateBudget(id));
      if(r.issue) throw new Error(r.issue);
    }
    await retry(()=>assignCandidateBudget(100));
    console.log(JSON.stringify(await retry(()=>resolveEvaluationBudget(100, 10))));
  `),
  );
  try {
    const results = await Promise.all(
      children.map(async (child) => {
        const [exit, output, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(errors).toBe('');
        expect(exit).toBe(0);
        return JSON.parse(output);
      }),
    );
    expect(results.filter((r) => r.isNewLook)).toHaveLength(1);
    const file = JSON.parse(
      readFileSync(join(directory, '.prompt-comparisons', '_alpha-ledger.json'), 'utf8'),
    );
    const indices = Object.values(file.entries).map((e) => (e as { k: number }).k);
    expect(indices).toHaveLength(41);
    expect(new Set(indices).size).toBe(41);
    expect(file.nextK).toBe(42);
    expect(file.entries['100'].lastLookJ).toBe(2);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}, 20000);

it('a killed lock owner cannot strand subsequent budget allocation', async () => {
  expect(assignCandidateBudget(1)).toMatchObject({ k: 1 });
  const path = join(directory, '.prompt-comparisons', '_alpha-ledger.json.lock.sqlite');
  const child = worker(`
    const {Database} = await import('bun:sqlite');
    const db = new Database(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE');
    console.log('locked');
    await new Promise(() => {});
  `);
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('locked');
    expect(assignCandidateBudget(2)).toEqual({ issue: 'io_error' });
    child.kill();
    await child.exited;
    reader.releaseLock();
    expect(assignCandidateBudget(2)).toMatchObject({ k: 2, issue: null });
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 10000);
