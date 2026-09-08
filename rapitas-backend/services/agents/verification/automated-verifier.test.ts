/**
 * automated-verifier.test
 *
 * Unit tests for the verifier's pure output parsers (eslint JSON error count,
 * tsc error file extraction) and the markdown renderer. Command execution and
 * git/file I/O are integration concerns covered elsewhere.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  parseEslintErrorCount,
  parseTscErrorFiles,
  renderVerificationMarkdown,
  looksLikeBugFixTask,
  tamperCheck,
  coverageCheck,
  generatedSyncCheck,
  computeOverallOk,
  computeVerdict,
  mergeChecks,
  type VerificationCheck,
  type VerificationResult,
} from './automated-verifier';

describe('computeOverallOk', () => {
  const check = (name: VerificationCheck['name'], ok: boolean): VerificationCheck => ({
    name,
    ran: true,
    ok,
    errorCount: ok ? 0 : 1,
    details: `${name}: ${ok ? 'ok' : 'NG'}`,
  });

  // Pins the advisory exclusion (task 617 premortem 1): dropping 'acceptance'
  // from the exclusion list turns it into a hard gate and makes this RED.
  it('stays ok when only the advisory acceptance check fails', () => {
    const checks = [
      check('lint', true),
      check('typecheck', true),
      check('test', true),
      check('acceptance', false),
    ];
    expect(computeOverallOk(checks)).toBe(true);
  });

  it('stays ok when only the advisory scope check fails', () => {
    expect(computeOverallOk([check('lint', true), check('scope', false)])).toBe(true);
  });

  it('fails when a correctness check fails, regardless of advisory results', () => {
    expect(computeOverallOk([check('lint', false), check('acceptance', true)])).toBe(false);
    expect(computeOverallOk([check('test', false), check('scope', false)])).toBe(false);
  });
});

describe('computeVerdict', () => {
  const check = (
    name: VerificationCheck['name'],
    ok: boolean,
    extra: Partial<VerificationCheck> = {},
  ): VerificationCheck => ({
    name,
    ran: true,
    ok,
    errorCount: ok ? 0 : 1,
    details: `${name}: ${ok ? 'ok' : 'NG'}`,
    ...extra,
  });

  it("returns 'pass' when every check is green with no indeterminate failures", () => {
    const checks = [check('lint', true), check('typecheck', true), check('test', true)];
    expect(computeVerdict(checks)).toBe('pass');
  });

  it("returns 'unknown' when the test check is indeterminate (baseline comparison failed)", () => {
    const checks = [check('lint', true), check('test', true, { indeterminate: true })];
    expect(computeVerdict(checks)).toBe('unknown');
  });

  it("returns 'unknown' when the advisory scope check reports NG", () => {
    const checks = [check('lint', true), check('scope', false)];
    expect(computeVerdict(checks)).toBe('unknown');
  });

  it("returns 'unknown' when the advisory acceptance check reports NG", () => {
    const checks = [check('lint', true), check('acceptance', false)];
    expect(computeVerdict(checks)).toBe('unknown');
  });

  it('ignores a scope/acceptance check that did not run (ran:false)', () => {
    const checks = [check('lint', true), check('scope', false, { ran: false })];
    expect(computeVerdict(checks)).toBe('pass');
  });
});

describe('generatedSyncCheck', () => {
  it('returns null when no prisma schema file changed', () => {
    expect(generatedSyncCheck(['rapitas-backend/services/foo.ts'])).toBeNull();
    // schema.desktop is a generated OUTPUT, not a source schema — no trigger.
    expect(generatedSyncCheck(['rapitas-backend/prisma/schema.desktop/agents.prisma'])).toBeNull();
  });

  it('fails when a schema changes without both regenerated artifacts', () => {
    const onlySchema = generatedSyncCheck(['rapitas-backend/prisma/schema/agents.prisma']);
    expect(onlySchema?.ok).toBe(false);
    expect(onlySchema?.details).toContain('db:prepare:sqlite');

    const missingInitSql = generatedSyncCheck([
      'rapitas-backend/prisma/schema/agents.prisma',
      'rapitas-backend/prisma/schema.desktop/agents.prisma',
    ]);
    expect(missingInitSql?.ok).toBe(false);
  });

  it('passes when the schema change ships with both regenerated artifacts', () => {
    const check = generatedSyncCheck([
      'rapitas-backend/prisma/schema/agents.prisma',
      'rapitas-backend/prisma/schema.desktop/agents.prisma',
      'rapitas-backend/src/generated/sqlite-init-sql.ts',
    ]);
    expect(check?.ok).toBe(true);
  });

  it('normalizes Windows path separators before matching', () => {
    const check = generatedSyncCheck([
      'rapitas-backend\\prisma\\schema\\agents.prisma',
      'rapitas-backend\\prisma\\schema.desktop\\agents.prisma',
      'rapitas-backend\\src\\generated\\sqlite-init-sql.ts',
    ]);
    expect(check?.ok).toBe(true);
  });
});

describe('parseEslintErrorCount', () => {
  it('sums errorCount across files, ignoring warnings', () => {
    const json = JSON.stringify([
      { filePath: 'a.ts', errorCount: 2, warningCount: 5 },
      { filePath: 'b.ts', errorCount: 1, warningCount: 0 },
      { filePath: 'c.ts', errorCount: 0, warningCount: 3 },
    ]);
    expect(parseEslintErrorCount(json)).toEqual({ ok: true, errorCount: 3 });
  });

  it('reports ok with 0 errors for a clean run', () => {
    expect(parseEslintErrorCount('[]')).toEqual({ ok: true, errorCount: 0 });
  });

  it('flags non-JSON output as a failed run (eslint crashed)', () => {
    expect(parseEslintErrorCount('Oops: cannot find config').ok).toBe(false);
  });
});

describe('parseTscErrorFiles', () => {
  it('extracts file paths from tsc error lines and normalizes slashes', () => {
    const out = [
      'src/foo.ts(12,5): error TS2322: Type X is not assignable to Y.',
      'src\\bar.tsx(3,1): error TS2304: Cannot find name Z.',
      'src/foo.ts(40,2): error TS2345: Argument error.',
      'note: some non-error line',
      "src/baz.ts(1,1): warning TS6133: 'x' is declared but never used.", // not an error
    ].join('\n');
    expect(parseTscErrorFiles(out)).toEqual(['src/foo.ts', 'src/bar.tsx', 'src/foo.ts']);
  });

  it('returns empty for clean output', () => {
    expect(parseTscErrorFiles('')).toEqual([]);
  });
});

describe('renderVerificationMarkdown', () => {
  it.each([
    {
      name: 'renders pass/fail and embeds details only for failing checks',
      result: {
        ok: false,
        changedFiles: ['src/a.ts', 'src/b.ts'],
        checks: [
          { name: 'lint', ran: true, ok: false, errorCount: 2, details: 'eslint: 2 errors' },
          { name: 'typecheck', ran: true, ok: true, errorCount: 0, details: 'tsc ok' },
        ],
        summary: '自動検証: lint=NG(2) / typecheck=ok',
      } as VerificationResult,
      expectedContains: [
        '❌ 失敗',
        'lint: ❌ 2件',
        'eslint: 2 errors',
        'typecheck: ✅ OK',
        '対象変更ファイル: 2件',
      ],
    },
    {
      name: 'renders a failing test check (Phase ① dynamic gate)',
      result: {
        ok: false,
        changedFiles: ['src/a.ts'],
        checks: [
          { name: 'lint', ran: true, ok: true, errorCount: 0, details: 'eslint: 0 errors' },
          { name: 'typecheck', ran: true, ok: true, errorCount: 0, details: 'tsc ok' },
          {
            name: 'test',
            ran: true,
            ok: false,
            errorCount: 1,
            details: 'npm run test failed:\n1 failing',
          },
        ],
        summary: '自動検証: lint=ok / typecheck=ok / test=NG(1)',
      } as VerificationResult,
      expectedContains: ['test: ❌ 1件', 'npm run test failed'],
    },
    {
      name: 'renders an unverifiable result as fail-closed and shows its details',
      result: {
        ok: false,
        unverifiable: true,
        changedFiles: ['src/a.ts'],
        checks: [
          { name: 'lint', ran: false, ok: true, errorCount: 0, details: 'lint: not applicable' },
          {
            name: 'typecheck',
            ran: false,
            ok: false,
            errorCount: 0,
            details: 'tsconfig.json is present but the tsc binary could not be resolved.',
            unverifiable: true,
          },
        ],
        summary: '自動検証: lint=skip / typecheck=UNVERIFIED',
      } as VerificationResult,
      // details surfaced even though the check did not "run"
      expectedContains: [
        '⚠️ 未検証（ツールを実行できず fail-closed）',
        'typecheck: ⚠️ 未検証（ツール実行不可）',
        'could not be resolved',
      ],
    },
    {
      name: 'renders pre-existing failures as a separate section when present',
      result: {
        ok: true,
        changedFiles: ['src/a.ts'],
        checks: [
          {
            name: 'test',
            ran: true,
            ok: true,
            errorCount: 0,
            details: '1 test command(s): passed (2 pre-existing failure(s) excluded)',
            preExistingFailures: [
              'tests/services/idea-box-service.test.ts',
              'tests/services/other.test.ts',
            ],
          },
        ],
        summary: '自動検証: test=ok',
      } as VerificationResult,
      expectedContains: [
        '✅ 合格',
        '既存失敗（本変更とは無関係）',
        'idea-box-service.test.ts',
        '懸念バックログに起票済み',
      ],
    },
  ])('$name', ({ result, expectedContains }) => {
    const md = renderVerificationMarkdown(result);
    for (const s of expectedContains) expect(md).toContain(s);
  });

  it('does not render pre-existing section when none detected', () => {
    const result: VerificationResult = {
      ok: false,
      changedFiles: ['src/a.ts'],
      checks: [
        {
          name: 'test',
          ran: true,
          ok: false,
          errorCount: 1,
          details: 'bun test failed:\n1 failing',
        },
      ],
      summary: '自動検証: test=NG(1)',
    };
    const md = renderVerificationMarkdown(result);
    expect(md).not.toContain('既存失敗');
  });

  it('renders mixed: new failure blocks gate, pre-existing listed separately', () => {
    const result: VerificationResult = {
      ok: false,
      changedFiles: ['src/a.ts'],
      checks: [
        {
          name: 'test',
          ran: true,
          ok: false,
          errorCount: 1,
          details: 'bun test tests/services/new.test.ts failed:\n1 failing',
          preExistingFailures: ['tests/services/idea-box-service.test.ts'],
        },
      ],
      summary: '自動検証: test=NG(1)',
    };
    const md = renderVerificationMarkdown(result);
    expect(md).toContain('❌ 失敗');
    expect(md).toContain('既存失敗（本変更とは無関係）');
    expect(md).toContain('idea-box-service.test.ts');
  });
});

describe('looksLikeBugFixTask', () => {
  it('returns false for null/undefined/empty text', () => {
    expect(looksLikeBugFixTask(null)).toBe(false);
    expect(looksLikeBugFixTask(undefined)).toBe(false);
    expect(looksLikeBugFixTask('')).toBe(false);
  });

  it('returns false for text with no bug-related keywords', () => {
    expect(looksLikeBugFixTask('新しいダッシュボード widget を追加する')).toBe(false);
  });

  it.each([
    'ログイン画面でバグが発生',
    '保存時に不具合がある',
    '起動時にクラッシュする',
    '例外が発生する',
    '入力するとエラーになる',
    'アプリが落ちる',
    'アイコンが表示されない',
    'ボタンが動かない',
    'fix a bug in the parser',
    'app crash on startup',
    'this is a regression',
    'the sort order is broken',
  ])('returns true for %j', (text) => {
    expect(looksLikeBugFixTask(text)).toBe(true);
  });

  it('is case-insensitive for English keywords', () => {
    expect(looksLikeBugFixTask('BUG in the retry logic')).toBe(true);
  });
});

describe('tamperCheck', () => {
  it('returns null when no protected path is changed', () => {
    expect(tamperCheck(['src/foo.ts', 'src/bar.test.ts'], null)).toBeNull();
  });

  it('returns ok when the protected file is listed in the plan', () => {
    const result = tamperCheck(
      ['services/workflow/completion-gate.ts'],
      ['services/workflow/completion-gate.ts'],
    );
    expect(result).toEqual({
      name: 'tamper',
      ran: true,
      ok: true,
      errorCount: 0,
      details: 'tamper: 1 protected file(s) changed — all listed in the approved plan',
    });
  });

  it('fails when a protected file is changed but not listed in the plan', () => {
    const result = tamperCheck(['services/workflow/completion-gate.ts'], ['src/foo.ts']);
    expect(result?.ok).toBe(false);
    expect(result?.errorCount).toBe(1);
    expect(result?.details).toContain('services/workflow/completion-gate.ts');
    expect(result?.details).toContain('計画外の変更');
  });

  it('treats a null planFiles (plan-less mode) as an empty plan — always unplanned', () => {
    const result = tamperCheck(['.github/workflows/test-lint.yml'], null);
    expect(result?.ok).toBe(false);
    expect(result?.errorCount).toBe(1);
  });

  it('matches protected paths regardless of path separator and case', () => {
    const result = tamperCheck(['SERVICES\\AGENTS\\VERIFICATION\\foo.ts'], []);
    expect(result?.ok).toBe(false);
  });

  it('matches a plan entry via suffix containment (relative vs. absolute-ish paths)', () => {
    const result = tamperCheck(['.husky/pre-commit'], ['rapitas-backend/.husky/pre-commit']);
    expect(result?.ok).toBe(true);
  });

  it('only counts unplanned protected files toward errorCount when some are planned', () => {
    const result = tamperCheck(
      ['.husky/pre-commit', 'scripts/pre-commit-check.ts'],
      ['.husky/pre-commit'],
    );
    expect(result?.ok).toBe(false);
    expect(result?.errorCount).toBe(1);
    expect(result?.details).toContain('scripts/pre-commit-check.ts');
    expect(result?.details).not.toContain('.husky/pre-commit');
  });
});

describe('coverageCheck', () => {
  const ORIGINAL_ENV = process.env.RAPITAS_REQUIRE_TESTS;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.RAPITAS_REQUIRE_TESTS;
    else process.env.RAPITAS_REQUIRE_TESTS = ORIGINAL_ENV;
  });

  it('returns null when not forced and the env opt-in is unset', () => {
    delete process.env.RAPITAS_REQUIRE_TESTS;
    expect(coverageCheck(['src/foo.ts'])).toBeNull();
  });

  it.each(['1', 'true', 'on', 'TRUE', 'On'])('is enabled via RAPITAS_REQUIRE_TESTS=%s', (val) => {
    process.env.RAPITAS_REQUIRE_TESTS = val;
    const result = coverageCheck(['src/foo.ts']);
    expect(result?.ok).toBe(false);
  });

  it('is disabled for other env values', () => {
    process.env.RAPITAS_REQUIRE_TESTS = '0';
    expect(coverageCheck(['src/foo.ts'])).toBeNull();
  });

  it('returns null when forced but no source files changed (only exempt/test files)', () => {
    delete process.env.RAPITAS_REQUIRE_TESTS;
    expect(
      coverageCheck(['src/foo.d.ts', 'src/bar.config.ts', 'src/baz.stories.tsx'], true),
    ).toBeNull();
  });

  it('fails when forced and a source file changed without a paired test', () => {
    delete process.env.RAPITAS_REQUIRE_TESTS;
    const result = coverageCheck(['src/foo.ts'], true);
    expect(result).toEqual({
      name: 'coverage',
      ran: true,
      ok: false,
      errorCount: 1,
      details: 'ソース変更にテストが伴っていません（テストの追加/更新が必要）:\nsrc/foo.ts',
    });
  });

  it('passes when forced and a test file was changed alongside the source', () => {
    delete process.env.RAPITAS_REQUIRE_TESTS;
    const result = coverageCheck(['src/foo.ts', 'src/foo.test.ts'], true);
    expect(result).toEqual({
      name: 'coverage',
      ran: true,
      ok: true,
      errorCount: 0,
      details: 'coverage: 1 test file(s) changed alongside source',
    });
  });
});

// Task 659: a triage that came back null (baseline comparison indeterminate)
// yields an ok:true part carrying `indeterminate`; merging must keep the gate
// open, carry the unattributed files, and STILL fail on a genuine failure.
describe('mergeChecks — indeterminate triage (task 659)', () => {
  const indeterminatePart: VerificationCheck = {
    name: 'test',
    ran: true,
    ok: true,
    errorCount: 0,
    details: '1 test command(s) failed, but the baseline comparison was indeterminate',
    indeterminate: true,
    indeterminateFailures: ['a.test.ts'],
  };
  const passingPart: VerificationCheck = {
    name: 'test',
    ran: true,
    ok: true,
    errorCount: 0,
    details: '2 test command(s): passed',
  };
  const failingPart: VerificationCheck = {
    name: 'test',
    ran: true,
    ok: false,
    errorCount: 1,
    details: 'bun test --isolate b.test.ts failed',
  };

  it('keeps the merged test check ok and carries the unattributed files', () => {
    const merged = mergeChecks('test', [indeterminatePart, passingPart]);
    expect(merged.ok).toBe(true);
    expect(merged.errorCount).toBe(0);
    expect(merged.indeterminate).toBe(true);
    expect(merged.indeterminateFailures).toEqual(['a.test.ts']);
    expect(merged.unverifiable).toBeUndefined();
  });

  it('still fails when another project part has a genuine new failure', () => {
    const merged = mergeChecks('test', [indeterminatePart, failingPart]);
    expect(merged.ok).toBe(false);
    expect(merged.errorCount).toBe(1);
    expect(merged.indeterminateFailures).toEqual(['a.test.ts']);
    expect(merged.details).toContain('b.test.ts failed');
  });

  it('omits the indeterminate fields when no part is indeterminate', () => {
    const merged = mergeChecks('test', [passingPart, failingPart]);
    expect(merged.indeterminate).toBeUndefined();
    expect(merged.indeterminateFailures).toBeUndefined();
  });

  it('does not let an indeterminate test check hide a real lint failure in computeOverallOk', () => {
    const lintFail: VerificationCheck = {
      name: 'lint',
      ran: true,
      ok: false,
      errorCount: 2,
      details: 'eslint: 2 errors',
    };
    expect(computeOverallOk([mergeChecks('test', [indeterminatePart]), lintFail])).toBe(false);
    expect(computeOverallOk([mergeChecks('test', [indeterminatePart])])).toBe(true);
  });
});
