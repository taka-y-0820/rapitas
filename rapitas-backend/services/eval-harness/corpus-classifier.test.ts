/**
 * corpus-classifier.test
 *
 * The corpus is only as trustworthy as this heuristic: a task filed in the
 * wrong category silently skews the per-category accuracy figures, and the
 * error is invisible downstream. Each of the five categories is tested for
 * both a hit and a near-miss, and the fixed priority order is pinned so a
 * later rule cannot start shadowing an earlier one.
 *
 * Pure functions — no mocking needed.
 */
import { describe, it, expect } from 'bun:test';
import {
  assignSplit,
  classifyTask,
  countTouchedServices,
  EVAL_CATEGORIES,
  type ClassifierInput,
} from './corpus-classifier';

const base: ClassifierInput = {
  taskId: 1,
  title: 'Some task',
  workflowStatus: 'completed',
  fixCommitSubject: null,
  changedTopLevelDirs: ['rapitas-backend'],
  changedFileCount: 3,
  hasBlockedRecovery: false,
};

describe('classifyTask — bug_fix', () => {
  it('matches a [Bug] title prefix', () => {
    const result = classifyTask({ ...base, title: '[Bug] タスクが完了しない' });
    expect(result?.category).toBe('bug_fix');
    expect(result?.method).toBe('title_prefix_bug');
  });

  it('matches a fix( commit subject when the title is neutral', () => {
    const result = classifyTask({ ...base, fixCommitSubject: 'fix(workflow): stop the loop' });
    expect(result?.category).toBe('bug_fix');
    expect(result?.confidence).toBeLessThan(0.9);
  });

  it('does not match a title merely containing the word bug', () => {
    const result = classifyTask({ ...base, title: 'Debugging helper cleanup' });
    expect(result?.category).not.toBe('bug_fix');
  });
});

describe('classifyTask — feature', () => {
  it('matches an [Idea] title prefix', () => {
    expect(classifyTask({ ...base, title: '[Idea] 評価セットを整備する' })?.category).toBe(
      'feature',
    );
  });

  it('matches a feat( commit subject', () => {
    expect(classifyTask({ ...base, fixCommitSubject: 'feat(eval): add harness' })?.category).toBe(
      'feature',
    );
  });

  it('does not match a refactor( commit subject', () => {
    expect(classifyTask({ ...base, fixCommitSubject: 'refactor(x): tidy' })).toBeNull();
  });
});

describe('classifyTask — investigation_only', () => {
  it('matches a completed task with an empty diff', () => {
    const result = classifyTask({ ...base, changedFileCount: 0, changedTopLevelDirs: [] });
    expect(result?.category).toBe('investigation_only');
  });

  it('does not match when the task changed files', () => {
    expect(classifyTask({ ...base, changedFileCount: 2 })).toBeNull();
  });

  it('does not match when the task never completed', () => {
    const result = classifyTask({
      ...base,
      workflowStatus: 'blocked',
      changedFileCount: 0,
      changedTopLevelDirs: [],
    });
    expect(result).toBeNull();
  });
});

describe('classifyTask — multi_service', () => {
  it('matches when two services were touched', () => {
    const result = classifyTask({
      ...base,
      changedTopLevelDirs: ['rapitas-backend', 'rapitas-frontend'],
    });
    expect(result?.category).toBe('multi_service');
  });

  it('does not match one service plus unrelated top-level dirs', () => {
    const result = classifyTask({
      ...base,
      title: '[Bug] x',
      changedTopLevelDirs: ['rapitas-backend', 'docs', '.github'],
    });
    expect(result?.category).toBe('bug_fix');
  });
});

describe('classifyTask — failure_recovery', () => {
  it('matches a blocked → in_progress transition', () => {
    const result = classifyTask({ ...base, hasBlockedRecovery: true });
    expect(result?.category).toBe('failure_recovery');
    expect(result?.method).toBe('blocked_transition');
  });

  it('matches a 陳腐化テスト title keyword', () => {
    expect(classifyTask({ ...base, title: '[Test] 陳腐化テスト修正 D' })?.category).toBe(
      'failure_recovery',
    );
  });

  it('does not match an ordinary completed task', () => {
    expect(classifyTask({ ...base, title: '[Bug] x' })?.category).toBe('bug_fix');
  });
});

describe('classifyTask — priority order', () => {
  it('prefers failure_recovery over every other matching rule', () => {
    const result = classifyTask({
      ...base,
      title: '[Bug] broken',
      hasBlockedRecovery: true,
      changedTopLevelDirs: ['rapitas-backend', 'rapitas-desktop'],
    });
    expect(result?.category).toBe('failure_recovery');
  });

  it('prefers multi_service over bug_fix', () => {
    const result = classifyTask({
      ...base,
      title: '[Bug] broken',
      changedTopLevelDirs: ['rapitas-backend', 'rapitas-desktop'],
    });
    expect(result?.category).toBe('multi_service');
  });

  it('returns null rather than guessing when nothing fires', () => {
    const result = classifyTask({
      ...base,
      title: 'chore stuff',
      workflowStatus: 'in_progress',
      fixCommitSubject: 'chore: bump',
    });
    expect(result).toBeNull();
  });
});

describe('countTouchedServices', () => {
  it('counts distinct services and ignores non-service dirs', () => {
    expect(
      countTouchedServices(['rapitas-backend', 'rapitas-backend', 'docs', 'rapitas-frontend']),
    ).toBe(2);
  });

  it('returns 0 for no service dirs', () => {
    expect(countTouchedServices(['docs', '.github'])).toBe(0);
  });
});

describe('assignSplit', () => {
  it('assigns every third index to eval, deterministically', () => {
    expect([0, 1, 2, 3, 4, 5].map(assignSplit)).toEqual([
      'eval',
      'train',
      'train',
      'eval',
      'train',
      'train',
    ]);
  });

  it('produces a roughly 2:1 train:eval ratio over 30 items', () => {
    const splits = Array.from({ length: 30 }, (_, index) => assignSplit(index));
    expect(splits.filter((s) => s === 'eval').length).toBe(10);
    expect(splits.filter((s) => s === 'train').length).toBe(20);
  });
});

describe('EVAL_CATEGORIES', () => {
  it('lists all five categories in priority order', () => {
    expect([...EVAL_CATEGORIES]).toEqual([
      'failure_recovery',
      'multi_service',
      'bug_fix',
      'feature',
      'investigation_only',
    ]);
  });
});
