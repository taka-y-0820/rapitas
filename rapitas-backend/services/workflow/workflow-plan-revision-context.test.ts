/**
 * workflow-plan-revision-context.test
 *
 * Covers the planner-facing side of "ask the agent to edit the plan": the
 * rendered instruction section, and the staleness rule that stops an already
 * applied instruction being injected into a later, unrelated planner run.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const transitionFindFirst = mock(() =>
  Promise.resolve<{ createdAt: Date; metadata: string | null } | null>(null),
);
const fileFindFirst = mock(() => Promise.resolve<{ updatedAt: Date } | null>(null));

mock.module('../../config/database', () => ({
  prisma: {
    workflowTransition: { findFirst: transitionFindFirst },
    workflowFile: { findFirst: fileFindFirst },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

const { renderPlanRevision, getPendingPlanRevision, buildPlanRevisionContext } =
  await import('./workflow-plan-revision-context');

const AT = (iso: string) => new Date(iso);

describe('renderPlanRevision', () => {
  test('carries the instruction AND the current plan so the planner revises rather than re-derives', () => {
    const out = renderPlanRevision(
      '非対象からUIカードを外して',
      '# 実装計画\n## 非対象\n- UIカード',
      'ja',
    );
    expect(out).toContain('非対象からUIカードを外して');
    expect(out).toContain('# 実装計画');
    expect(out).toContain('ゼロから作り直さず');
  });

  test('returns nothing for a blank instruction', () => {
    expect(renderPlanRevision('   ', '# 実装計画', 'ja')).toBe('');
  });

  test('retains requirements and completion gates beyond the former plan cap', () => {
    const huge =
      '# Plan\n' +
      'x'.repeat(30000) +
      '\n## Required gates\nReal child-process verification and CI merge remain mandatory.';
    const out = renderPlanRevision('直して', huge, 'ja');
    expect(out).toContain(huge);
    expect(out).not.toContain('長さ上限により省略');
  });
});

describe('getPendingPlanRevision', () => {
  beforeEach(() => {
    transitionFindFirst.mockReset().mockResolvedValue(null);
    fileFindFirst.mockReset().mockResolvedValue(null);
  });

  test('returns the instruction when the request is newer than plan.md', async () => {
    transitionFindFirst.mockResolvedValue({
      createdAt: AT('2026-08-25T03:00:00Z'),
      metadata: JSON.stringify({ instruction: 'UIカードを採用に変更' }),
    });
    fileFindFirst.mockResolvedValue({ updatedAt: AT('2026-08-25T02:00:00Z') });

    expect(await getPendingPlanRevision(1)).toBe('UIカードを採用に変更');
  });

  test('returns null once a plan saved AFTER the request has applied it', async () => {
    transitionFindFirst.mockResolvedValue({
      createdAt: AT('2026-08-25T03:00:00Z'),
      metadata: JSON.stringify({ instruction: 'UIカードを採用に変更' }),
    });
    fileFindFirst.mockResolvedValue({ updatedAt: AT('2026-08-25T03:30:00Z') });

    expect(await getPendingPlanRevision(1)).toBeNull();
  });

  test('returns null when no revision was ever requested', async () => {
    expect(await getPendingPlanRevision(1)).toBeNull();
  });

  test('survives malformed metadata instead of throwing into the planner', async () => {
    transitionFindFirst.mockResolvedValue({
      createdAt: AT('2026-08-25T03:00:00Z'),
      metadata: 'not json',
    });
    expect(await getPendingPlanRevision(1)).toBeNull();
  });
});

describe('buildPlanRevisionContext', () => {
  beforeEach(() => {
    transitionFindFirst.mockReset().mockResolvedValue(null);
    fileFindFirst.mockReset().mockResolvedValue(null);
  });

  test('injects nothing when there is no plan to revise', async () => {
    transitionFindFirst.mockResolvedValue({
      createdAt: AT('2026-08-25T03:00:00Z'),
      metadata: JSON.stringify({ instruction: '直して' }),
    });
    expect(await buildPlanRevisionContext(1, null, 'ja')).toBe('');
  });

  test('renders the section when a revision is pending', async () => {
    transitionFindFirst.mockResolvedValue({
      createdAt: AT('2026-08-25T03:00:00Z'),
      metadata: JSON.stringify({ instruction: '非対象を直して' }),
    });
    fileFindFirst.mockResolvedValue({ updatedAt: AT('2026-08-25T02:00:00Z') });

    const out = await buildPlanRevisionContext(1, '# 実装計画', 'ja');
    expect(out).toContain('非対象を直して');
    expect(out).toContain('# 実装計画');
  });
});
