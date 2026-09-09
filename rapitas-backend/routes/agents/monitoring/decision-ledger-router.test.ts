/**
 * decision-ledger-router.test
 *
 * Covers the reporting surface over the unified ledger: the window, the
 * groupings, and that an unknown kind is dropped rather than silently widening
 * the read to everything.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
mock.module('../../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

const at = new Date('2026-08-25T15:00:00Z');
const decisions = [
  {
    id: 'trace:480',
    at,
    taskId: 666,
    kind: 'model_tier',
    subject: 'implementer phase',
    predicted: null,
    basis: '',
    outcome: null,
    verdict: 'correct',
    costUsd: 1,
    source: 'decision_trace',
  },
  {
    id: 'record:2750',
    at,
    taskId: 666,
    kind: 'workflow_mode',
    subject: 'standard mode',
    predicted: null,
    basis: '',
    outcome: null,
    verdict: 'indeterminate',
    costUsd: 0,
    source: 'learning_record',
  },
];

const readDecisions = mock(() => Promise.resolve(decisions));
mock.module('../../../services/decision-ledger', () => ({
  readDecisions,
  summarizeVerdicts: (d: unknown[]) => ({ total: d.length }),
  summarizeBy: (d: typeof decisions, keyOf: (x: (typeof decisions)[0]) => string) =>
    new Map(d.map((x) => [keyOf(x), { total: 1 }])),
}));

const { decisionLedgerRouter } = await import('./decision-ledger-router');
const BASE = 'http://localhost/agents/decision-ledger';

describe('GET /agents/decision-ledger', () => {
  beforeEach(() => readDecisions.mockReset().mockResolvedValue(decisions));

  test('reports overall plus the two groupings', async () => {
    const res = await decisionLedgerRouter.handle(new Request(BASE));
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

    expect(body.success).toBe(true);
    expect(body.data.overall).toEqual({ total: 2 });
    expect(Object.keys(body.data.byKind as object)).toEqual(['model_tier', 'workflow_mode']);
    expect(Object.keys(body.data.bySubject as object)).toEqual([
      'implementer phase',
      'standard mode',
    ]);
  });

  test('an unknown kind is dropped, never widened to everything', async () => {
    await decisionLedgerRouter.handle(new Request(`${BASE}?kinds=model_tier,nonsense`));

    const arg = readDecisions.mock.calls[0]?.[0] as { kinds?: string[] };
    expect(arg.kinds).toEqual(['model_tier']);
  });

  test('a kinds list with nothing valid reads unfiltered rather than empty', async () => {
    await decisionLedgerRouter.handle(new Request(`${BASE}?kinds=nonsense`));

    const arg = readDecisions.mock.calls[0]?.[0] as { kinds?: string[] };
    expect(arg.kinds).toBeUndefined();
  });

  test('rejects a nonsense window instead of defaulting silently', async () => {
    const res = await decisionLedgerRouter.handle(new Request(`${BASE}?days=abc`));
    expect(res.status).toBe(400);
  });

  test('narrows the window to the requested days', async () => {
    const before = Date.now();
    await decisionLedgerRouter.handle(new Request(`${BASE}?days=7`));
    const after = Date.now();

    const arg = readDecisions.mock.calls[0]?.[0] as { since: Date };
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    // The handler reads its clock between the observations, not before them.
    expect(arg.since.getTime()).toBeGreaterThanOrEqual(before - windowMs);
    expect(arg.since.getTime()).toBeLessThanOrEqual(after - windowMs);
  });
});
