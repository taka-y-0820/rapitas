/** Read the planning requirement without caching, seeding rows, or hiding DB failures. */
import type { Prisma } from '../../generated/prisma-postgres';

export interface ReviewedPlanPolicy {
  mode: 'lightweight' | 'standard' | 'comprehensive';
  includePlan: boolean;
}

export async function readReviewedPlanPolicy(
  db: Pick<Prisma.TransactionClient, 'workflowModeConfig'>,
  mode: string,
): Promise<ReviewedPlanPolicy> {
  if (mode !== 'lightweight' && mode !== 'standard' && mode !== 'comprehensive')
    throw new Error('Unknown workflow mode');
  const row = await db.workflowModeConfig.findUnique({
    where: { mode },
    select: { stepDefinitions: true },
  });
  const fallback = mode !== 'lightweight';
  // A missing row uses the documented built-in mode setting, unlike a failed read.
  if (!row) return { mode, includePlan: fallback };
  const parsed: unknown = JSON.parse(row.stepDefinitions || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid workflow phase settings');
  const value = parsed as Record<string, unknown>;
  const phases = value.phases ?? value;
  if (!phases || typeof phases !== 'object' || Array.isArray(phases))
    throw new Error('Invalid workflow phase settings');
  const includePlan = (phases as Record<string, unknown>).includePlan;
  if (includePlan !== undefined && typeof includePlan !== 'boolean')
    throw new Error('Invalid includePlan setting');
  return { mode, includePlan: includePlan ?? fallback };
}
