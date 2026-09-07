/**
 * ExecutionFileLogger / LogFileBuilder
 *
 * Converts in-memory log entries and an execution summary into the
 * human- and AI-readable text format written to disk.
 * Not responsible for file I/O or log entry collection.
 */

import type { StructuredLogEntry, ExecutionSummary } from './types';

/**
 * Build the full text content of one execution log file.
 *
 * The output has five sections:
 *   1. Header + summary
 *   2. Error summary (omitted when there are no errors)
 *   3. Warning summary (omitted when there are no warnings)
 *   4. Full chronological log
 *   5. Structured JSON block for automated parsing
 *
 * @param summary - Execution summary metadata / 実行サマリメタデータ
 * @param entries - All collected log entries / 収集済みログエントリの配列
 * @returns Complete file content as a single string / ファイル全体のテキスト
 */
export function buildLogFileContent(
  summary: ExecutionSummary,
  entries: StructuredLogEntry[],
): string {
  const sections: string[] = [];

  // ============================================================
  // Section 1: Header & Summary
  // ============================================================
  sections.push(`${'='.repeat(80)}`);
  sections.push(`AGENT EXECUTION LOG`);
  sections.push(`${'='.repeat(80)}`);
  sections.push(``);
  sections.push(`[SUMMARY]`);
  sections.push(`  Execution ID  : ${summary.executionId}`);
  sections.push(`  Session ID    : ${summary.sessionId}`);
  sections.push(`  Task ID       : ${summary.taskId}`);
  sections.push(`  Task Title    : ${summary.taskTitle}`);
  sections.push(`  Agent Type    : ${summary.agentType}`);
  sections.push(`  Agent Name    : ${summary.agentName}`);
  if (summary.modelId) {
    sections.push(`  Model ID      : ${summary.modelId}`);
  }
  sections.push(`  Status        : ${summary.status}`);
  sections.push(`  Started At    : ${summary.startedAt}`);
  sections.push(`  Completed At  : ${summary.completedAt || 'N/A'}`);
  sections.push(
    `  Duration      : ${summary.durationMs ? `${(summary.durationMs / 1000).toFixed(1)}s` : 'N/A'}`,
  );
  if (summary.tokensUsed) {
    sections.push(`  Tokens Used   : ${summary.tokensUsed}`);
  }
  sections.push(`  Log Entries   : ${summary.totalLogEntries}`);
  sections.push(`  Errors        : ${summary.errorCount}`);
  sections.push(`  Warnings      : ${summary.warningCount}`);
  sections.push(`  Output Size   : ${(summary.outputSizeBytes / 1024).toFixed(1)} KB`);
  sections.push(``);

  // ============================================================
  // Section 2: Error Summary (if errors exist)
  // ============================================================
  const errorEntries = entries.filter((e) => e.level === 'ERROR' || e.level === 'FATAL');

  if (errorEntries.length > 0) {
    sections.push(`${'='.repeat(80)}`);
    sections.push(`[ERROR SUMMARY] (${errorEntries.length} errors found)`);
    sections.push(`${'='.repeat(80)}`);
    sections.push(``);

    for (let i = 0; i < errorEntries.length; i++) {
      const entry = errorEntries[i];
      sections.push(`--- Error ${i + 1} / ${errorEntries.length} ---`);
      sections.push(`  Time     : ${entry.timestamp}`);
      sections.push(`  Event    : ${entry.eventType}`);
      sections.push(`  Message  : ${entry.message}`);
      if (entry.error) {
        sections.push(`  Error Name    : ${entry.error.name}`);
        sections.push(`  Error Message : ${entry.error.message}`);
        if (entry.error.code) {
          sections.push(`  Error Code    : ${entry.error.code}`);
        }
        if (entry.error.stack) {
          sections.push(`  Stack Trace   :`);
          const stackLines = entry.error.stack.split('\n');
          for (const line of stackLines) {
            sections.push(`    ${line.trim()}`);
          }
        }
      }
      if (entry.context && Object.keys(entry.context).length > 0) {
        sections.push(
          `  Context  : ${JSON.stringify(entry.context, null, 2).split('\n').join('\n    ')}`,
        );
      }
      sections.push(``);
    }
  }

  // ============================================================
  // Section 3: Warning Summary (if warnings exist)
  // ============================================================
  const warnEntries = entries.filter((e) => e.level === 'WARN');

  if (warnEntries.length > 0) {
    sections.push(`${'='.repeat(80)}`);
    sections.push(`[WARNING SUMMARY] (${warnEntries.length} warnings found)`);
    sections.push(`${'='.repeat(80)}`);
    sections.push(``);

    for (const entry of warnEntries) {
      sections.push(`  [${entry.timestamp}] ${entry.message}`);
      if (entry.context && Object.keys(entry.context).length > 0) {
        sections.push(`    Context: ${JSON.stringify(entry.context)}`);
      }
    }
    sections.push(``);
  }

  // ============================================================
  // Section 4: Full Log Entries (chronological)
  // ============================================================
  sections.push(`${'='.repeat(80)}`);
  sections.push(`[FULL EXECUTION LOG] (${entries.length} entries)`);
  sections.push(`${'='.repeat(80)}`);
  sections.push(``);

  for (const entry of entries) {
    const levelPad = entry.level.padEnd(5);
    const eventPad = entry.eventType.padEnd(20);

    if (entry.eventType === 'output' && entry.level === 'DEBUG') {
      const msg =
        entry.message.length > 500
          ? entry.message.substring(0, 500) + '... (truncated)'
          : entry.message;
      sections.push(`[${entry.timestamp}] [${levelPad}] [${eventPad}] ${msg}`);
      continue;
    }

    sections.push(`[${entry.timestamp}] [${levelPad}] [${eventPad}] ${entry.message}`);

    if (entry.context && Object.keys(entry.context).length > 0) {
      sections.push(
        `  Context: ${JSON.stringify(entry.context, null, 2).split('\n').join('\n  ')}`,
      );
    }

    if (entry.error) {
      sections.push(`  Error: ${entry.error.name}: ${entry.error.message}`);
      if (entry.error.stack) {
        sections.push(`  Stack:`);
        const stackLines = entry.error.stack.split('\n').slice(0, 10);
        for (const line of stackLines) {
          sections.push(`    ${line.trim()}`);
        }
      }
    }
  }

  sections.push(``);

  // ============================================================
  // Section 5: Structured Data (JSON)
  // ============================================================
  sections.push(`${'='.repeat(80)}`);
  sections.push(`[STRUCTURED DATA (JSON)]`);
  sections.push(`${'='.repeat(80)}`);
  sections.push(``);
  sections.push(
    JSON.stringify(
      {
        summary,
        attemptJournal: entries
          .filter((e) => e.message === 'execution_attempt_boundary' && e.eventType === 'recovery')
          .map((e) => e.context),
        attemptMeasurements: entries
          .filter((e) => e.message === 'execution_attempt_metrics' && e.eventType === 'recovery')
          .map((e) => e.context),
        errors: errorEntries.map((e) => ({
          timestamp: e.timestamp,
          message: e.message,
          error: e.error,
          context: e.context,
        })),
        timeline: entries.map((e) => ({
          timestamp: e.timestamp,
          level: e.level,
          eventType: e.eventType,
          message: e.message.substring(0, 300),
        })),
      },
      null,
      2,
    ),
  );
  sections.push(``);

  return sections.join('\n');
}
