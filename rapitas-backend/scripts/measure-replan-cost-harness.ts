#!/usr/bin/env bun
/** Explicit AC5 measurement: isolated planning calls, never a production task replay. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Verified by the layer-1 real SQLite comparison: three legacy resets, one current reset.
const COUNTS = { legacyAlwaysReplan: 3, currentKindBased: 1 } as const;
const MODEL = 'sonnet';
const PROMPT =
  '以下が研究結果の全文です。追加の調査やファイル参照は不要です。' +
  '質問回答APIはtoStatusを返す。現行UIは親の古いplan_createdを取得済みdraftより優先してしまう。' +
  '回答後はtoStatusを優先し、再取得が追いついた後も古い親状態で後戻りさせず、タスク切替では前タスクの状態を破棄する。' +
  '実装方針と回帰テストをJSON {"implementation":"具体的な実装方針","verification":"具体的な検証方法"}だけで回答してください。';

export interface CliMeasurement {
  ok: boolean;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  modelNames: string[];
  durationMs: number;
  exitCode: number | null;
  error?: string;
}

/** Missing/invalid counters never become measured zero or successful evidence. */
export function parseCliMeasurement(
  stdout: string,
  durationMs: number,
  exitCode: number | null,
): CliMeasurement {
  const failed: CliMeasurement = {
    ok: false,
    totalCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    modelNames: [],
    durationMs,
    exitCode,
  };
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(stdout);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('invalid receipt');
  } catch {
    return { ...failed, error: 'CLI did not return a complete JSON receipt' };
  }
  const usage = row.usage as Record<string, unknown> | undefined;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const counter = (value: unknown): number | null =>
    finite(value) && Number.isInteger(value) ? value : null;
  const models = row.modelUsage;
  const result: CliMeasurement = {
    ...failed,
    totalCostUsd: finite(row.total_cost_usd) ? row.total_cost_usd : null,
    inputTokens: counter(usage?.input_tokens),
    outputTokens: counter(usage?.output_tokens),
    modelNames:
      models && typeof models === 'object' && !Array.isArray(models)
        ? Object.keys(models).sort()
        : [],
  };
  if (
    exitCode !== 0 ||
    row.is_error === true ||
    row.type !== 'result' ||
    row.subtype !== 'success'
  ) {
    return { ...result, error: 'CLI invocation did not succeed' };
  }
  if (
    result.totalCostUsd === null ||
    result.inputTokens === null ||
    result.outputTokens === null ||
    !result.modelNames.length
  ) {
    return {
      ...result,
      error: 'CLI receipt is missing valid cost, token, or actual-model measurements',
    };
  }
  // Process success alone is insufficient: a tool request or missing-context reply is not a plan.
  try {
    const response = typeof row.result === 'string' ? row.result.trim() : '';
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(response);
    const plan = JSON.parse(fenced ? fenced[1] : response);
    if (
      typeof plan?.implementation !== 'string' ||
      plan.implementation.trim().length < 40 ||
      typeof plan?.verification !== 'string' ||
      plan.verification.trim().length < 40
    )
      throw Error('incomplete plan');
  } catch {
    return { ...result, error: 'CLI output is not a complete structured planning response' };
  }
  return { ...result, ok: true };
}

/** Incomplete groups retain unknown totals instead of silently understating expense. */
export function sumMeasurements(results: CliMeasurement[], expected: number) {
  const complete = results.length === expected && results.every((r) => r.ok);
  return {
    expectedInvocations: expected,
    invocations: results.length,
    complete,
    totalCostUsd: complete ? results.reduce((sum, r) => sum + r.totalCostUsd!, 0) : null,
    totalInputTokens: complete ? results.reduce((sum, r) => sum + r.inputTokens!, 0) : null,
    totalOutputTokens: complete ? results.reduce((sum, r) => sum + r.outputTokens!, 0) : null,
    totalDurationMs: complete ? results.reduce((sum, r) => sum + r.durationMs, 0) : null,
    results,
  };
}

/** Launch only the executable with all built-in/MCP tools and skills disabled. */
function measure(cli: string, cwd: string, receipt: string): CliMeasurement {
  const env = { ...process.env };
  // This explicit, tool-free measurement may also be launched from an agent's shell.
  delete env.CLAUDECODE;
  const started = Date.now();
  const proc = spawnSync(
    cli,
    [
      '--print',
      '--output-format',
      'json',
      '--model',
      MODEL,
      '--system-prompt',
      'You write implementation plans from the supplied self-contained research. Return only the requested JSON object. No tools or external context are available.',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      PROMPT,
    ],
    { cwd, env, encoding: 'utf-8', timeout: 120_000 },
  );
  const stdout = String(proc.stdout ?? '');
  writeFileSync(receipt, stdout, 'utf8');
  const result = parseCliMeasurement(stdout, Date.now() - started, proc.status);
  if (proc.error) return { ...result, ok: false, error: 'CLI launch failed or timed out' };
  return result;
}

/** Explicit opt-in only; any unavailable, failed, missing, or unsaved evidence exits nonzero. */
async function main(): Promise<void> {
  if (process.env.RAPITAS_RUN_REPLAN_COST_HARNESS !== '1') {
    console.log('Cost measurement not requested; no CLI invocation performed.');
    return;
  }
  const output = resolve(
    process.env.RAPITAS_REPLAN_COST_OUTPUT_DIR ??
      join(import.meta.dir, '..', '..', '.supervisor', 'measurements'),
  );
  mkdirSync(output, { recursive: true });
  const reportPath = join(output, 'task902-cli-replan-cost-audit.json');
  const startedAt = new Date().toISOString();
  const groups: Record<keyof typeof COUNTS, CliMeasurement[]> = {
    legacyAlwaysReplan: [],
    currentKindBased: [],
  };
  const save = (status: string, error?: string) =>
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          status,
          startedAt,
          measuredAt: new Date().toISOString(),
          requestedModel: MODEL,
          fixedPrompt: PROMPT,
          note: '隔離した同一入力の追加計画生成費用。順次実行のキャッシュ・出力差を含み、本番897全工程の因果効果ではない。実モデル別費用・キャッシュ利用量は各生JSONを参照。構造検証に加え出力内容をレビューすること。',
          error,
          legacyAlwaysReplan: sumMeasurements(groups.legacyAlwaysReplan, COUNTS.legacyAlwaysReplan),
          currentKindBased: sumMeasurements(groups.currentKindBased, COUNTS.currentKindBased),
        },
        null,
        2,
      ),
      'utf8',
    );
  save('running'); // Invalidate any previous success before a new attempt.
  const cli = Bun.which('claude');
  if (!cli) {
    save('failed', 'Claude executable was not found');
    process.exitCode = 1;
    return;
  }
  const isolatedDir = mkdtempSync(join(tmpdir(), 'rapitas-replan-cost-harness-'));
  try {
    for (const group of Object.keys(COUNTS) as (keyof typeof COUNTS)[]) {
      for (let i = 0; i < COUNTS[group]; i++) {
        console.log(`Measuring ${group} ${i + 1}/${COUNTS[group]}`);
        const result = measure(
          cli,
          isolatedDir,
          join(output, `task902-cli-${group}-${i + 1}.json`),
        );
        groups[group].push(result);
        save('running');
        if (!result.ok) throw Error(result.error);
      }
    }
    const models = [...groups.legacyAlwaysReplan, ...groups.currentKindBased].map((r) =>
      r.modelNames.join(','),
    );
    if (new Set(models).size !== 1) throw Error('Actual model changed between comparison groups');
    save('completed');
    console.log(`Measurement complete: ${reportPath}`);
  } catch (error) {
    save('failed', error instanceof Error ? error.message : 'Measurement failed');
    process.exitCode = 1;
  } finally {
    const target = resolve(isolatedDir);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('rapitas-replan-cost-harness-')
    ) {
      throw Error('Unsafe measurement cleanup path');
    }
    rmSync(target, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
