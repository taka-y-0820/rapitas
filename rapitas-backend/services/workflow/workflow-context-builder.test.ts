/**
 * Tests for workflow-context-builder.
 *
 * Verifies that buildRoleContext returns role-appropriate context, with special
 * focus on auto_verifier sharing the verifier's section-headed instruction.
 */

import { describe, expect, test, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sentinel task id whose plan.md is served by the mock below — lets the
// with-plan implementer path (file-size awareness injection, task 600) be
// exercised end-to-end without seeding the shared DB with fixture rows.
const PLAN_TASK_ID = 600600;
let planForSentinel: string | null = null;
let researchForSentinel: string | null = null;

/** Mirror of the real OpenSubtasksError (mock.module needs every export). */
class OpenSubtasksError extends Error {}

// readWorkflowFile is mocked so workflow-file reads are deterministic: null for
// every task (taskId 1 tests depend on "no plan.md") except the sentinel's
// plan. Full export mirror — bun's mock.module is process-global, so a partial
// mock would break any transitive importer with an export-not-found error.
mock.module('./workflow-file-utils', () => ({
  readWorkflowFile: mock((taskId: number, fileType: string) => {
    if (taskId !== PLAN_TASK_ID) return Promise.resolve(null);
    if (fileType === 'plan') return Promise.resolve(planForSentinel);
    if (fileType === 'research') return Promise.resolve(researchForSentinel);
    return Promise.resolve(null);
  }),
  writeWorkflowFile: mock((_t: number, _f: string, content: string) => Promise.resolve(content)),
  archiveWorkflowFile: mock(() => Promise.resolve(false)),
  resolveWorkflowDir: mock(() => Promise.resolve(null)),
  cleanupRootWorkflowFiles: mock(() => Promise.resolve()),
  looksLikeAgentLog: mock(() => false),
  sliceFromReportHeading: mock((text: string) => text),
  extractMarkdownFromOutput: mock((output: string) => output),
  OpenSubtasksError,
}));

// Cross-task lesson distillation (buildCriticLessonsSection) calls the aux-AI
// CLI (~30s per cold stream) whenever the live DB holds bounce rows — hermetic
// tests must never spawn it. With the flag off the builders return ''
// instantly, matching the empty-DB CI behaviour these tests were written for.
const ORIGINAL_CRITIC_LESSONS = process.env.RAPITAS_CRITIC_LESSONS;
process.env.RAPITAS_CRITIC_LESSONS = '0';
afterAll(() => {
  if (ORIGINAL_CRITIC_LESSONS === undefined) delete process.env.RAPITAS_CRITIC_LESSONS;
  else process.env.RAPITAS_CRITIC_LESSONS = ORIGINAL_CRITIC_LESSONS;
});

// Spy on the metrics hook: keeps builder tests DB-free (no TimelineEvent
// writes) and lets the wiring tests assert one recording per role. Full export
// mirror as required by process-global mock.module.
const recordContextMetricsSpy = mock((..._args: unknown[]) => Promise.resolve());
mock.module('./workflow-context-metrics', () => ({
  recordContextMetrics: recordContextMetricsSpy,
  computeSectionMetrics: mock(() => ({ sections: [], totalChars: 0, totalEstTokens: 0 })),
  estimateTokens: mock(() => 0),
}));

// NOTE: All four role builders (researcher/planner/implementer/verifier) call
// buildMemoryContext, which reaches a real Postgres via searchKnowledgeHybrid
// (lexical + vector channels). In this hermetic suite that DB is unreachable,
// and the embedding warm-up + connection-retry path burns the full 5000ms
// bun:test default timeout per test (task 865: 38 fail). Mock it to keep
// every builder test DB-free. Full export mirror required by mock.module.
mock.module('./workflow-memory-context', () => ({
  buildMemoryContext: mock(() => Promise.resolve('')),
  applyOutcomeWeighting: mock((entries: unknown[]) => entries),
  renderMemorySection: mock(() => ''),
  TEXT: { ja: {}, en: {} },
}));

// NOTE (task 865): beyond buildMemoryContext, the four builders transitively
// touch prisma directly through ~10 other helpers (hypothesis ledger,
// playbook, critic feedback, CBR case, rejected/revised-plan context,
// pitfalls, goal anchor, verifier diff/acceptance lookups) — each an
// independent import that would need its own full-export mock. Every one of
// those helpers already fails soft (catch → '' / null / []) on a DB error;
// the only problem is an unreachable localhost:5432 taking ~5s per call to
// reject, which alone exceeds bun's 5000ms default test timeout. A Proxy that
// resolves every prisma model.method call to a benign empty value keeps the
// whole chain DB-free without tracking every call site (and without
// suppressing a real behavioural assertion — none of these tests assert on
// hypothesis/playbook/CBR content).
function benignPrismaResult(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null; // findFirst / findUnique / create / update / delete / upsert / aggregate
}
const mockPrisma = new Proxy(
  {},
  {
    get: (_target, _model: string) =>
      new Proxy(
        {},
        {
          get: (_t2, method: string) => mock(() => Promise.resolve(benignPrismaResult(method))),
        },
      ),
  },
);
// Full export mirror of config/database.ts (prisma + ensureDatabaseConnection):
// some transitive dependency of the four builders re-exports both through the
// config barrel (config/index.ts), so omitting ensureDatabaseConnection here
// breaks that barrel's own re-export statement at module-load time.
mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: mock(() => Promise.resolve()),
}));

const { buildRoleContext, researchModeDirective, applyPlanModeDirective } =
  await import('./workflow-context-builder');

const TASK = { title: 'Test task', description: 'A test description' };

describe('buildRoleContext', () => {
  test('every workflow role receives explicit DB acceptance criteria without dropping late items', async () => {
    const criteria = [
      'Preserve the existing plan for evidence-only answers',
      'Measure retry count, elapsed time and cost',
      'Handle simultaneous answers, stops and stale questions',
    ];
    const task = {
      ...TASK,
      description: 'A brief that omits the measurable requirements',
      acceptanceCriteria: JSON.stringify(criteria),
    };
    for (const role of [
      'researcher',
      'planner',
      'implementer',
      'verifier',
      'auto_verifier',
    ] as const) {
      for (const language of ['ja', 'en'] as const) {
        const context = await buildRoleContext(1, role, task, language);
        for (const criterion of criteria) expect(context).toContain(criterion);
      }
    }
  });
  describe('auto_verifier role', () => {
    test.each([
      { name: '検証結果サマリ heading in instruction', expected: '検証結果サマリ' },
      { name: 'テスト結果 heading in instruction', expected: 'テスト結果' },
      { name: 'チェックリスト heading in instruction', expected: 'チェックリスト' },
      { name: 'task title in context', expected: TASK.title },
    ])('includes $name', async ({ expected }) => {
      const ctx = await buildRoleContext(1, 'auto_verifier', TASK);
      expect(ctx).toContain(expected);
    });
  });

  describe('verifier role', () => {
    test('includes the same 3 required section headings', async () => {
      const ctx = await buildRoleContext(1, 'verifier', TASK);
      expect(ctx).toContain('検証結果サマリ');
      expect(ctx).toContain('テスト結果');
      expect(ctx).toContain('チェックリスト');
    });
  });

  describe('auto_verifier and verifier produce equivalent instructions', () => {
    test('auto_verifier instruction text equals verifier instruction text', async () => {
      const autoCtx = await buildRoleContext(1, 'auto_verifier', TASK);
      const verifierCtx = await buildRoleContext(1, 'verifier', TASK);
      // Both roles fall through to the same code block, so their outputs must be identical.
      expect(autoCtx).toBe(verifierCtx);
    });
  });

  describe('premortem (R7)', () => {
    test('planner context mandates a プレモーテム section', async () => {
      const ctx = await buildRoleContext(1, 'planner', TASK);
      expect(ctx).toContain('## プレモーテム');
      expect(ctx).toContain('失敗原因を3つ');
    });

    test('verifier context mandates the premortem cross-check', async () => {
      const ctx = await buildRoleContext(1, 'verifier', TASK);
      expect(ctx).toContain('プレモーテム照合');
    });

    test('english planner variant carries the premortem too', async () => {
      const ctx = await buildRoleContext(1, 'planner', TASK, 'en');
      expect(ctx).toContain('Premortem (REQUIRED)');
    });
  });
});

describe('subtask-split flag alignment (RAPITAS_ENABLE_SUBTASK_SPLIT)', () => {
  const ORIGINAL_ENV = process.env.RAPITAS_ENABLE_SUBTASK_SPLIT;

  beforeEach(() => {
    delete process.env.RAPITAS_ENABLE_SUBTASK_SPLIT;
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.RAPITAS_ENABLE_SUBTASK_SPLIT;
    } else {
      process.env.RAPITAS_ENABLE_SUBTASK_SPLIT = ORIGINAL_ENV;
    }
  });

  test('planner (ja) carries the split prohibition when the flag is unset (default off)', async () => {
    const ctx = await buildRoleContext(1, 'planner', TASK);
    expect(ctx).toContain('## サブタスク分割の禁止');
    expect(ctx).toContain('POST /tasks による子タスク起票');
    // Existing planner sections stay intact alongside the new directive.
    expect(ctx).toContain('## プレモーテム');
    expect(ctx).toContain('## 自己完結ルール');
  });

  test('planner (en) carries the English prohibition, without Japanese leakage', async () => {
    const ctx = await buildRoleContext(1, 'planner', TASK, 'en');
    expect(ctx).toContain('Subtask splitting is FORBIDDEN');
    expect(ctx).not.toContain('サブタスク分割の禁止');
  });

  test('planner carries NO prohibition when the flag is enabled', async () => {
    process.env.RAPITAS_ENABLE_SUBTASK_SPLIT = '1';
    const jaCtx = await buildRoleContext(1, 'planner', TASK);
    expect(jaCtx).not.toContain('## サブタスク分割の禁止');
    const enCtx = await buildRoleContext(1, 'planner', TASK, 'en');
    expect(enCtx).not.toContain('Subtask splitting is FORBIDDEN');
  });

  test('other roles are untouched by the directive', async () => {
    for (const role of ['researcher', 'implementer', 'verifier'] as const) {
      const ctx = await buildRoleContext(1, role, TASK);
      expect(ctx).not.toContain('## サブタスク分割の禁止');
    }
  });
});

describe('report style rule (emoji-free professional markdown)', () => {
  test.each(['researcher', 'planner', 'implementer', 'verifier', 'auto_verifier'])(
    '%s context carries the ja style rule',
    async (role) => {
      const ctx = await buildRoleContext(1, role as Parameters<typeof buildRoleContext>[1], TASK);
      expect(ctx).toContain('## 文体ルール');
      expect(ctx).toContain('絵文字は使用禁止');
      expect(ctx).toContain('横スクロールなしで全列が見える');
      // Changed-files reporting is qualitative: table of file/kind/summary,
      // never +N/-N line deltas.
      expect(ctx).toContain('行数・差分数値（+N/-N）は記載しない');
      // Machine-first priority clause + figure-first presentation layer.
      expect(ctx).toContain('正確性と機械可読性が最優先');
      expect(ctx).toContain('図表ファースト');
      expect(ctx).toContain('図と表が矛盾する場合は表が正');
      expect(ctx).toContain('```mermaid');
    },
  );

  test('en variant carries the en style rule', async () => {
    const ctx = await buildRoleContext(1, 'verifier', TASK, 'en');
    expect(ctx).toContain('## Style rules');
    expect(ctx).toContain('Emoji are forbidden');
    expect(ctx).toContain('prioritize AI comprehension');
    expect(ctx).toContain('Figure-first');
  });

  test('verifier verdict-marker vocabulary is unchanged by the style rule', async () => {
    const ctx = await buildRoleContext(1, 'verifier', TASK);
    // The machine-parsed phrases must still be present verbatim.
    expect(ctx).toContain('✅ 検証成功 / ❌ 検証失敗 / ⚠️ 一部失敗');
    expect(ctx).toContain('`**❌ 検証失敗**`');
  });
});

describe('report hygiene rules (round 7 audit fixes)', () => {
  test('verifier carries the machine-gate output discipline', async () => {
    const ctx = await buildRoleContext(1, 'verifier', TASK);
    expect(ctx).toContain('### 出力規律（機械ゲート互換 — 厳守）');
    expect(ctx).toContain('タスク種別（軽量・マージ・競合解消・サブタスク）を問わず');
    expect(ctx).toContain('言い換えは禁止');
    expect(ctx).toContain('偽陽性検証');
    expect(ctx).toContain('数値集計行を本文に書かない');
    expect(ctx).toContain('`| +追加 | -削除 |`');
  });

  test('en verifier carries the output discipline too', async () => {
    const ctx = await buildRoleContext(1, 'verifier', TASK, 'en');
    expect(ctx).toContain('### Output discipline (machine-gate compatibility — strict)');
    expect(ctx).toContain('deliberate-RED');
  });

  test('lightweight verifier keeps the machine-parsed チェックリスト消化状況 heading', async () => {
    // taskId 1 has no plan.md → the no-plan replacement applies. The heading must
    // keep the チェックリスト substring the section validator scans for.
    const ctx = await buildRoleContext(1, 'verifier', TASK);
    expect(ctx).toContain('## チェックリスト消化状況 (計画なしタスク:');
    expect(ctx).not.toContain('## 要件の充足状況');
  });

  test('planner carries the self-containment rule and the fact-form premortem note', async () => {
    const ctx = await buildRoleContext(1, 'planner', TASK);
    expect(ctx).toContain('## 自己完結ルール');
    expect(ctx).toContain('「research.md の選択肢A」');
    expect(ctx).toContain('修正除去でRED→復元でGREENを確認');
  });

  test('researcher forbids template placeholder residue and uses 類似機能', async () => {
    const ctx = await buildRoleContext(1, 'researcher', TASK);
    expect(ctx).toContain('プレースホルダ説明を見出しや本文に残さない');
    expect(ctx).toContain('類似機能の有無');
    expect(ctx).not.toContain('類似実装の有無');
  });

  test('style rule carries negative examples, verdict vocabulary lock, and deixis ban', async () => {
    const ctx = await buildRoleContext(1, 'implementer', TASK);
    expect(ctx).toContain('負例（書いてはならない形）');
    expect(ctx).toContain('「合格」「条件付き合格」「不合格」等への言い換えは禁止');
    expect(ctx).toContain('指示語（「上記」「前述」「これ」）で他セクションを参照しない');
  });
});

describe('researchModeDirective', () => {
  test('lightweight declares no plan phase and demands implementation-ready research', () => {
    const d = researchModeDirective('lightweight', 'ja');
    expect(d).toContain('軽量');
    expect(d).toContain('計画(plan)フェーズはありません');
  });

  test('standard / comprehensive declare a following plan phase', () => {
    expect(researchModeDirective('standard', 'ja')).toContain('計画(plan)フェーズ');
    expect(researchModeDirective('comprehensive', 'ja')).toContain('計画(plan)フェーズ');
  });

  test('english variants', () => {
    expect(researchModeDirective('lightweight', 'en')).toContain('no planning phase');
    expect(researchModeDirective('standard', 'en')).toContain('planning phase will run');
  });
});

describe('applyPlanModeDirective', () => {
  test('implementer without a plan gets the plan-less directive prepended', () => {
    const out = applyPlanModeDirective('implementer', 'BASE PROMPT', false);
    expect(out.startsWith('## 実行モード: 調査→実装→検証（plan.md なし）')).toBe(true);
    expect(out).toContain('plan.md を新規作成・保存しないでください');
    expect(out.endsWith('BASE PROMPT')).toBe(true);
  });

  test('implementer with a plan gets the with-plan directive prepended', () => {
    const out = applyPlanModeDirective('implementer', 'BASE PROMPT', true);
    expect(out.startsWith('## 実行モード: 計画あり（plan.md）')).toBe(true);
    expect(out).toContain('承認済みの plan.md');
    expect(out).not.toContain('plan.md を新規作成・保存しないでください');
  });

  test('verifier without a plan gets the plan-less verifier directive prepended', () => {
    const out = applyPlanModeDirective('verifier', 'BASE PROMPT', false);
    expect(out).toContain('検証の基準は **タスク要件と research.md** です');
  });

  test('verifier with a plan gets the with-plan verifier directive prepended', () => {
    const out = applyPlanModeDirective('verifier', 'BASE PROMPT', true);
    expect(out).toContain('plan.md のチェックリストと実装結果を照合して検証');
  });

  test('every other role (researcher/planner/auto_verifier) is left unchanged', () => {
    for (const role of ['researcher', 'planner', 'auto_verifier']) {
      expect(applyPlanModeDirective(role, 'BASE PROMPT', true)).toBe('BASE PROMPT');
      expect(applyPlanModeDirective(role, 'BASE PROMPT', false)).toBe('BASE PROMPT');
    }
  });
});

describe('file-size awareness (task 600)', () => {
  test('no plan.md (taskId 1) → no file-size awareness section', async () => {
    const ctx = await buildRoleContext(1, 'implementer', TASK);
    expect(ctx).not.toContain('変更対象ファイルの行数状況');
  });

  describe('plan.md referencing an over-limit file (positive path)', () => {
    let fixtureRoot: string;
    let prevEnv: string | undefined;

    beforeAll(() => {
      // Fixture repo with one 700-line file; RAPITAS_FILE_SIZE_REPO_ROOT points
      // the section builder at it because buildRoleContext cannot pass repoRoot.
      fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'ctx-fsize-'));
      const abs = path.join(fixtureRoot, 'services', 'workflow', 'huge-service.ts');
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, 'const x = 1;\n'.repeat(700));
      prevEnv = process.env.RAPITAS_FILE_SIZE_REPO_ROOT;
      process.env.RAPITAS_FILE_SIZE_REPO_ROOT = fixtureRoot;
      planForSentinel = [
        '# 実装計画',
        '',
        '## 変更予定ファイル',
        '',
        '| ファイル | 種別 |',
        '|---|---|',
        '| `services/workflow/huge-service.ts` | 変更 |',
      ].join('\n');
    });

    afterAll(() => {
      if (prevEnv === undefined) delete process.env.RAPITAS_FILE_SIZE_REPO_ROOT;
      else process.env.RAPITAS_FILE_SIZE_REPO_ROOT = prevEnv;
      planForSentinel = null;
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    test('implementer context contains the section with path, measured lines and severity', async () => {
      const ctx = await buildRoleContext(PLAN_TASK_ID, 'implementer', TASK);
      expect(ctx).toContain('変更対象ファイルの行数状況');
      expect(ctx).toContain('services/workflow/huge-service.ts');
      expect(ctx).toContain('現在 700 行で hard 上限(500行)を既に超過');
      // The with-plan path really ran: the plan body itself is in the context.
      expect(ctx).toContain('# 実装計画');
    });

    test('warning section precedes the plan body (visible before coding starts)', async () => {
      const ctx = await buildRoleContext(PLAN_TASK_ID, 'implementer', TASK);
      const sectionAt = ctx.indexOf('変更対象ファイルの行数状況');
      const planAt = ctx.indexOf('# 実装計画');
      expect(sectionAt).toBeGreaterThan(-1);
      expect(planAt).toBeGreaterThan(-1);
      expect(sectionAt).toBeLessThan(planAt);
    });

    test('non-implementer roles do not receive the section', async () => {
      const ctx = await buildRoleContext(PLAN_TASK_ID, 'planner', TASK);
      expect(ctx).not.toContain('変更対象ファイルの行数状況');
    });
  });
});

describe('context metrics + budget wiring (task 632)', () => {
  const ORIGINAL_BUDGET = process.env.RAPITAS_CONTEXT_BUDGET;
  const LONG_RESEARCH = 'R'.repeat(13000);

  beforeEach(() => {
    delete process.env.RAPITAS_CONTEXT_BUDGET;
    recordContextMetricsSpy.mockClear();
    planForSentinel = null;
    researchForSentinel = null;
  });

  afterAll(() => {
    if (ORIGINAL_BUDGET === undefined) delete process.env.RAPITAS_CONTEXT_BUDGET;
    else process.env.RAPITAS_CONTEXT_BUDGET = ORIGINAL_BUDGET;
    planForSentinel = null;
    researchForSentinel = null;
  });

  test.each(['researcher', 'planner', 'implementer', 'verifier', 'auto_verifier'])(
    '%s records section metrics exactly once per build',
    async (role) => {
      await buildRoleContext(1, role as Parameters<typeof buildRoleContext>[1], TASK);
      expect(recordContextMetricsSpy).toHaveBeenCalledTimes(1);
    },
  );

  test('default (log) mode injects a long research body unmodified (no truncation)', async () => {
    planForSentinel = '# 実装計画\n\n(plan body)';
    researchForSentinel = LONG_RESEARCH;
    const ctx = await buildRoleContext(PLAN_TASK_ID, 'implementer', TASK);
    expect(ctx).toContain(LONG_RESEARCH);
    expect(ctx).not.toContain('…[truncated:');
  });

  test('enforce mode clamps the with-plan research injection at 12000 chars', async () => {
    process.env.RAPITAS_CONTEXT_BUDGET = 'enforce';
    planForSentinel = '# 実装計画\n\n(plan body)';
    researchForSentinel = LONG_RESEARCH;
    const ctx = await buildRoleContext(PLAN_TASK_ID, 'implementer', TASK);
    expect(ctx).toContain(`${'R'.repeat(12000)}\n\n…[truncated: 1000 chars]`);
    expect(ctx).not.toContain('R'.repeat(12001));
    // The plan body (gate material downstream) is injected untouched.
    expect(ctx).toContain('# 実装計画');
  });

  test('enforce mode leaves research untouched when there is NO plan (lightweight)', async () => {
    process.env.RAPITAS_CONTEXT_BUDGET = 'enforce';
    researchForSentinel = LONG_RESEARCH;
    const ctx = await buildRoleContext(PLAN_TASK_ID, 'implementer', TASK);
    expect(ctx).toContain(LONG_RESEARCH);
    expect(ctx).not.toContain('…[truncated:');
  });
});
