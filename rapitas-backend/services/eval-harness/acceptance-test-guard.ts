/**
 * AcceptanceTestGuard
 *
 * Detects an implementing agent editing the very tests it is being graded by.
 * Without this, "fail-to-pass" degenerates into "the agent deleted the failing
 * assertion", and the accuracy numbers become worthless.
 *
 * Standalone by design: `services/agents/verification/verification-gate.ts`
 * implements the OPPOSITE rule (spec-declared test files are explicitly
 * ALLOWED to change), and folding a prohibition into it would change the
 * production gate's meaning for every real task. This module is eval-only.
 */

/** Outcome reason recorded when the guard trips. */
export const ACCEPTANCE_TEST_MODIFIED_REASON = 'acceptance_test_modified';

/** Result of an acceptance-test integrity check. */
export interface AcceptanceGuardResult {
  /** True when no protected test file was touched. */
  ok: boolean;
  /** Protected files the run modified (empty when ok). */
  violatedFiles: string[];
  /** Machine-readable reason when not ok. */
  reason?: string;
}

/**
 * Normalizes a repository path for comparison.
 *
 * @param path - Raw path from git or a corpus row / gitまたはコーパス行の生パス
 * @returns Path with separators and prefix normalized / 区切り文字と接頭辞を正規化したパス
 */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Checks that none of the frozen acceptance tests were modified.
 *
 * @param protectedTestFiles - Test paths frozen at corpus-seed time / コーパス収集時に凍結したテストパス
 * @param changedFiles - Paths the run actually changed / 実行が実際に変更したパス
 * @returns Whether the run left the acceptance tests intact / 受入テストが無傷かどうか
 */
export function checkAcceptanceTestsUntouched(
  protectedTestFiles: string[],
  changedFiles: string[],
): AcceptanceGuardResult {
  const changed = new Set(changedFiles.map(normalizePath));
  const violatedFiles = protectedTestFiles
    .map(normalizePath)
    .filter((path) => path.length > 0 && changed.has(path));

  if (violatedFiles.length === 0) {
    return { ok: true, violatedFiles: [] };
  }
  return { ok: false, violatedFiles, reason: ACCEPTANCE_TEST_MODIFIED_REASON };
}

/**
 * Parses the JSON array stored in `EvalCorpusTask.protectedTestFiles`.
 *
 * @param raw - JSON-encoded string array / JSON文字列配列
 * @returns The parsed paths, or an empty array when unparseable / 解析結果（解析不能なら空配列）
 */
export function parseProtectedTestFiles(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    // NOTE: Never throws. A malformed corpus row must not abort a whole batch;
    // it degrades to "no protected tests", and the empty list is visible in the
    // run's metadata.
    return [];
  }
}
