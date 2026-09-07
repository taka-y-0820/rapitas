/** Real SQLite transactions with independent Prisma connections and a temporary database. */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient, type Prisma } from '../../generated/prisma-sqlite';

const directory = mkdtempSync(join(tmpdir(), 'rapitas-stage-claim-'));
const file = join(directory, 'trial.sqlite');
const setup = new Database(file);
setup.exec(
  'CREATE TABLE PromptEvolution (id INTEGER PRIMARY KEY, status TEXT NOT NULL, basePromptKey TEXT, evidenceJson TEXT, afterPrompt TEXT)',
);
for (let id = 1; id <= 6; id++)
  setup
    .query('INSERT INTO PromptEvolution VALUES (?, ?, ?, ?, ?)')
    .run(
      id,
      'proposed',
      id <= 4 ? 'workflow_role_implementer' : 'workflow_role_planner',
      '{}',
      'candidate',
    );
setup.close();
const clients = Array.from(
  { length: 4 },
  () => new PrismaClient({ datasources: { db: { url: `file:${file}` } } }),
);
let next = 0;
mock.module('../../config/database', () => ({
  prisma: {
    $transaction: (
      action: (tx: Prisma.TransactionClient) => Promise<boolean>,
      options: { isolationLevel: 'Serializable' },
    ) => {
      const client = clients[next++ % clients.length];
      return client.$transaction(action, options);
    },
  },
}));
const { claimStagedRole } = await import('./prompt-evolution-stage-claim');
beforeEach(async () => {
  await clients[0].promptEvolution.updateMany({ data: { status: 'proposed', evidenceJson: '{}' } });
});
afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
  rmSync(directory, { recursive: true, force: true });
});

function candidate(id: number) {
  return {
    id,
    basePromptKey: id <= 4 ? 'workflow_role_implementer' : 'workflow_role_planner',
    evidenceJson: '{}',
    afterPrompt: 'candidate',
    createdAt: new Date(),
  };
}

test('four concurrent real connections claim only one trial; another role can still progress', async () => {
  await Promise.all(clients.map((client) => client.$connect()));
  const attempts = await Promise.allSettled(
    [1, 2, 3, 4].map((id) => claimStagedRole(candidate(id), '{"staged":true}')),
  );
  for (const result of attempts)
    if (result.status === 'rejected') {
      expect(['P2034', 'P1008']).toContain(result.reason.code);
    }
  expect(attempts.filter((result) => result.status === 'fulfilled' && result.value)).toHaveLength(
    1,
  );
  expect(
    await clients[0].promptEvolution.findMany({
      where: { status: 'staged' },
      select: { id: true },
    }),
  ).toHaveLength(1);
  expect(await claimStagedRole(candidate(5), '{"staged":true}')).toBe(true);
  expect(await claimStagedRole(candidate(5), '{}')).toBe(false);
  expect(await claimStagedRole(candidate(6), '{}')).toBe(false);
});

test('a stale evidence snapshot cannot stage a candidate', async () => {
  await clients[0].promptEvolution.updateMany({
    where: { id: 6 },
    data: { evidenceJson: '{"changed":true}' },
  });
  expect(
    await claimStagedRole({ ...candidate(6), basePromptKey: 'workflow_role_reviewer' }, '{}'),
  ).toBe(false);
  expect(
    (await clients[0].promptEvolution.findMany({ where: { id: 6 }, select: { status: true } }))[0]
      .status,
  ).toBe('proposed');
});

test('candidate text changed after its text gate cannot be claimed', async () => {
  expect(
    await claimStagedRole({ ...candidate(6), afterPrompt: 'outdated instruction' }, '{}'),
  ).toBe(false);
});

test('an outdated role cannot bypass the occupied role predicate', async () => {
  expect(await claimStagedRole(candidate(5), '{}')).toBe(true);
  expect(
    await claimStagedRole(
      {
        ...candidate(6),
        evidenceJson: '{}',
        basePromptKey: 'workflow_role_reviewer',
      },
      '{}',
    ),
  ).toBe(false);
});
