import { expect, mock, test } from 'bun:test';
import type { Prisma } from '../../generated/prisma-postgres';
import { readReviewedPlanPolicy } from './reviewed-plan-policy';
const database = (raw: string | null) =>
  ({
    workflowModeConfig: {
      findUnique: mock(async () => (raw === null ? null : { stepDefinitions: raw })),
    },
  }) as unknown as Pick<Prisma.TransactionClient, 'workflowModeConfig'>;

test('configured planning requirement overrides the mode name', async () => {
  expect(
    await readReviewedPlanPolicy(database('{"phases":{"includePlan":true}}'), 'lightweight'),
  ).toEqual({ mode: 'lightweight', includePlan: true });
  expect(await readReviewedPlanPolicy(database('{"includePlan":false}'), 'standard')).toEqual({
    mode: 'standard',
    includePlan: false,
  });
});
test('missing rows and missing toggles use built-in defaults without writes', async () => {
  expect((await readReviewedPlanPolicy(database(null), 'lightweight')).includePlan).toBe(false);
  expect((await readReviewedPlanPolicy(database('{}'), 'standard')).includePlan).toBe(true);
});
test('invalid settings never imply permission to omit planning', async () => {
  for (const raw of ['broken', 'null', '[]', '{"phases":[]}', '{"includePlan":"false"}']) {
    await expect(readReviewedPlanPolicy(database(raw), 'lightweight')).rejects.toThrow();
  }
  await expect(readReviewedPlanPolicy(database(null), 'unknown')).rejects.toThrow(
    'Unknown workflow mode',
  );
});
test('database failure propagates instead of allowing the lightweight default', async () => {
  const db = database(null);
  db.workflowModeConfig.findUnique = mock(async () => {
    throw new Error('DB unavailable');
  }) as unknown as typeof db.workflowModeConfig.findUnique;
  await expect(readReviewedPlanPolicy(db, 'lightweight')).rejects.toThrow('DB unavailable');
});
