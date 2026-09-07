/**
 * ExecutionFileLogger
 *
 * Agent execution file logger.  Generates one structured log file per
 * execution in a format optimised for both human reading and AI analysis.
 * Not responsible for log-file layout (see log-file-builder) or
 * file-system housekeeping (see log-file-manager).
 */

import { mkdir } from 'fs/promises';
import { writeAtomicTextFile } from '../../../utils/common/atomic-text-file';
import { existsSync } from 'fs';
import path from 'path';
import { createLogger } from '../../../config/logger';
import { buildLogFileContent } from './log-file-builder';
import { cleanupOldLogs } from './log-file-manager';
import type { LogEventType, StructuredLogEntry, ExecutionSummary, FileLoggerConfig } from './types';

export type { LogEventType, StructuredLogEntry, ExecutionSummary, FileLoggerConfig };

const log = createLogger('execution-file-logger');

/** Default configuration applied when no overrides are provided. */
export const DEFAULT_CONFIG: FileLoggerConfig = {
  logDir: path.join(process.cwd(), 'logs', 'agent-executions'),
  maxLogFiles: 100,
  maxLogSizeBytes: 50 * 1024 * 1024, // 50 MB
  enableConsolePassthrough: true,
};

/**
 * Agent execution file logger.
 * Generates one log file per execution in a format optimized for AI analysis.
 */
export class ExecutionFileLogger {
  private config: FileLoggerConfig;
  private entries: StructuredLogEntry[] = [];
  private executionId: number;
  private sessionId: number;
  private taskId: number;
  private taskTitle: string;
  private agentType: string;
  private agentName: string;
  private modelId?: string;
  private startedAt: Date;
  private errorCount = 0;
  private warningCount = 0;
  private outputSize = 0;
  private lastError?: string;
  private logFilePath: string;
  private initialized = false;
  private flushTail: Promise<string | null> = Promise.resolve(null);

  constructor(
    executionId: number,
    sessionId: number,
    taskId: number,
    taskTitle: string,
    agentType: string,
    agentName?: string,
    modelId?: string,
    config?: Partial<FileLoggerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.executionId = executionId;
    this.sessionId = sessionId;
    this.taskId = taskId;
    this.taskTitle = taskTitle;
    this.agentType = agentType;
    this.agentName = agentName || agentType;
    this.modelId = modelId;
    this.startedAt = new Date();

    // Log file path: logs/agent-executions/exec-{id}-{timestamp}.log
    const timestamp = this.startedAt.toISOString().replace(/[:.]/g, '-');
    this.logFilePath = path.join(this.config.logDir, `exec-${executionId}-${timestamp}.log`);
  }

  /**
   * Ensure the log directory exists before the first write.
   */
  private async ensureLogDir(): Promise<void> {
    if (this.initialized) return;
    try {
      if (!existsSync(this.config.logDir)) {
        await mkdir(this.config.logDir, { recursive: true });
      }
      this.initialized = true;
    } catch (e) {
      log.error({ err: e }, `[ExecutionFileLogger] Failed to create log directory`);
    }
  }

  /**
   * Add a log entry.
   *
   * @param level - Severity level / 重大度レベル
   * @param eventType - Semantic event type / イベント種別
   * @param message - Human-readable message / メッセージ
   * @param context - Optional structured context / 追加コンテキスト（省略可）
   * @param error - Optional originating error / 元のエラー（省略可）
   */
  log(
    level: StructuredLogEntry['level'],
    eventType: LogEventType,
    message: string,
    context?: Record<string, unknown>,
    error?: Error,
  ): void {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      eventType,
      executionId: this.executionId,
      sessionId: this.sessionId,
      taskId: this.taskId,
      message,
      context,
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: 'code' in error ? (error as NodeJS.ErrnoException).code : undefined,
      };
      this.lastError = error.message;
    }

    if (level === 'ERROR' || level === 'FATAL') {
      this.errorCount++;
      if (!error) {
        this.lastError = message;
      }
    }
    if (level === 'WARN') {
      this.warningCount++;
    }

    this.entries.push(entry);

    if (this.config.enableConsolePassthrough) {
      const prefix = `[ExecLog:${this.executionId}]`;
      // NOTE: context/error were previously dropped on the pino passthrough, so ERROR/WARN
      // log lines (e.g. execution_end failures) carried no failure reason for triage (#694).
      const pinoContext: Record<string, unknown> | undefined = error
        ? { ...context, err: error }
        : context;
      switch (level) {
        case 'ERROR':
        case 'FATAL':
          if (pinoContext) {
            log.error(pinoContext, `${prefix} ${message}`);
          } else {
            log.error(`${prefix} ${message}`);
          }
          break;
        case 'WARN':
          if (pinoContext) {
            log.warn(pinoContext, `${prefix} ${message}`);
          } else {
            log.warn(`${prefix} ${message}`);
          }
          break;
        default:
          log.info(`${prefix} ${message}`);
      }
    }
  }

  /**
   * Record output data from the agent process.
   *
   * @param output - Raw output text / エージェント出力テキスト
   * @param isError - True if the text came from stderr / stderrからの出力の場合はtrue
   */
  logOutput(output: string, isError: boolean): void {
    this.outputSize += Buffer.byteLength(output, 'utf-8');

    if (isError && output.trim()) {
      const level = classifyStderrLevel(output);
      this.log(level, level === 'ERROR' ? 'error' : 'output', `[stderr] ${output.trim()}`);
    }
    // NOTE: Normal output uses DEBUG level to avoid flooding — only non-empty output is recorded
    if (!isError && output.trim().length > 0) {
      this.log('DEBUG', 'output', output.trim());
    }
  }

  /**
   * Record execution start.
   *
   * @param command - The shell command being run / 実行されるシェルコマンド
   * @param config - Additional configuration context / 追加の設定コンテキスト
   */
  logExecutionStart(command: string, config: Record<string, unknown>): void {
    this.log(
      'INFO',
      'execution_start',
      `Execution started: ${command} [Agent: ${this.agentName} (${this.agentType})]`,
      {
        command,
        agentType: this.agentType,
        agentName: this.agentName,
        modelId: this.modelId,
        taskId: this.taskId,
        taskTitle: this.taskTitle,
        ...config,
      },
    );
  }

  /**
   * Record execution end.
   *
   * @param status - Final execution status string / 最終ステータス文字列
   * @param result - Optional execution result details / 実行結果の詳細（省略可）
   */
  logExecutionEnd(
    status: string,
    result?: {
      success?: boolean;
      tokensUsed?: number;
      executionTimeMs?: number;
      errorMessage?: string;
    },
  ): void {
    const durationMs = Date.now() - this.startedAt.getTime();
    const level = status === 'completed' ? 'INFO' : status === 'failed' ? 'ERROR' : 'WARN';
    // NOTE: log-format-parser's parsePino() reads err.message (not a plain errorMessage
    // field) to build the log-health-check dedup signature. Without this, every failed
    // execution collapsed onto the same generic "Execution ended with status: failed"
    // signature regardless of cause, so log-health-check kept re-filing one undiagnosable
    // concern instead of one per actual failure reason (#694).
    const err = result?.errorMessage ? new Error(result.errorMessage) : undefined;

    this.log(
      level,
      'execution_end',
      `Execution ended with status: ${status}`,
      {
        status,
        durationMs,
        success: result?.success,
        tokensUsed: result?.tokensUsed,
        executionTimeMs: result?.executionTimeMs,
        errorMessage: result?.errorMessage,
      },
      err,
    );
  }

  /**
   * Record a status transition.
   *
   * @param from - Previous status / 変更前ステータス
   * @param to - New status / 変更後ステータス
   * @param reason - Optional reason for the change / 変更理由（省略可）
   */
  logStatusChange(from: string, to: string, reason?: string): void {
    this.log('INFO', 'status_change', `Status changed: ${from} -> ${to}`, {
      fromStatus: from,
      toStatus: to,
      reason,
    });
  }

  /**
   * Record detection of a clarification question from the agent.
   *
   * @param question - Question text / 質問テキスト
   * @param questionType - Classified question type / 質問種別
   * @param claudeSessionId - Optional Claude session ID / ClaudeセッションID（省略可）
   */
  logQuestionDetected(question: string, questionType: string, claudeSessionId?: string): void {
    this.log('INFO', 'question_detected', `Question detected: ${question.substring(0, 200)}`, {
      question,
      questionType,
      claudeSessionId,
    });
  }

  /**
   * Record the answer to a detected question.
   *
   * @param response - Answer text / 回答テキスト
   * @param source - Who provided the answer / 回答の提供者
   */
  logQuestionAnswered(response: string, source: 'user' | 'auto_timeout'): void {
    this.log(
      'INFO',
      'question_answered',
      `Question answered (${source}): ${response.substring(0, 200)}`,
      {
        response,
        source,
      },
    );
  }

  /**
   * Record a Git commit made during execution.
   *
   * @param commitInfo - Commit metadata / コミットメタデータ
   */
  logGitCommit(commitInfo: Record<string, unknown>): void {
    this.log(
      'INFO',
      'git_commit',
      `Git commit: ${commitInfo.message || '(no message)'}`,
      commitInfo,
    );
  }

  /**
   * Record a warning.
   *
   * @param message - Warning description / 警告説明
   * @param context - Optional structured context / 追加コンテキスト（省略可）
   */
  logWarn(message: string, context?: Record<string, unknown>): void {
    // NOTE: Previously used eventType 'error' which caused WARN-level fallback retries to be
    // classified as ERROR events by monitoring, triggering spurious bug tickets.
    this.log('WARN', 'warning', message, context);
  }

  /**
   * Record an error.
   *
   * @param message - Error description / エラー説明
   * @param error - Optional originating Error object / 元のErrorオブジェクト（省略可）
   * @param context - Optional structured context / 追加コンテキスト（省略可）
   */
  logError(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log('ERROR', 'error', message, context, error);
  }

  /**
   * Flush all buffered log entries to disk.
   *
   * @returns Absolute path to the written log file, or null on failure / 書き込まれたログファイルの絶対パス（失敗時はnull）
   */
  async flush(): Promise<string | null> {
    const next = this.flushTail.then(() => this.flushNow());
    this.flushTail = next.catch(() => null);
    return next;
  }

  private async flushNow(): Promise<string | null> {
    if (this.entries.length === 0) return null;

    try {
      await this.ensureLogDir();

      const durationMs = Date.now() - this.startedAt.getTime();

      const summary: ExecutionSummary = {
        executionId: this.executionId,
        sessionId: this.sessionId,
        taskId: this.taskId,
        taskTitle: this.taskTitle,
        agentType: this.agentType,
        agentName: this.agentName,
        modelId: this.modelId,
        status: this.getLatestStatus(),
        startedAt: this.startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        totalLogEntries: this.entries.length,
        errorCount: this.errorCount,
        warningCount: this.warningCount,
        lastError: this.lastError,
        outputSizeBytes: this.outputSize,
      };

      const logContent = buildLogFileContent(summary, this.entries);

      await writeAtomicTextFile(this.logFilePath, logContent);

      await cleanupOldLogs(this.config.logDir, this.config.maxLogFiles);

      return this.logFilePath;
    } catch (e) {
      log.error({ err: e }, `[ExecutionFileLogger] Failed to write log file`);
      return null;
    }
  }

  /**
   * Walk entries in reverse to find the most recent known status.
   *
   * @returns Latest status string, or 'unknown' / 最新ステータス文字列（不明の場合は'unknown'）
   */
  private getLatestStatus(): string {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.eventType === 'execution_end' && entry.context?.status) {
        return String(entry.context.status);
      }
      if (entry.eventType === 'status_change' && entry.context?.toStatus) {
        return String(entry.context.toStatus);
      }
    }
    return 'unknown';
  }

  /**
   * Get the absolute path of the log file for this execution.
   *
   * @returns Log file path / ログファイルパス
   */
  getLogFilePath(): string {
    return this.logFilePath;
  }
}

function classifyStderrLevel(output: string): StructuredLogEntry['level'] {
  const text = output.trim();
  if (!text) return 'DEBUG';

  // Codex CLI currently emits most of its normal transcript to stderr in
  // JSON/streaming mode. Treat obvious transcript/tool/status lines as output
  // so successful runs do not produce misleading error summaries.
  const informationalPatterns = [
    /^Reading additional input from stdin/i,
    /^OpenAI Codex\b/i,
    /^workdir:/i,
    /^model:/i,
    /^provider:/i,
    /^approval:/i,
    /^sandbox:/i,
    /^reasoning/i,
    /^session id:/i,
    /^user$/i,
    /^codex$/i,
    /^exec$/i,
    /^succeeded in \d+ms/i,
    /^diff --git /i,
    /^tokens used/i,
  ];
  if (informationalPatterns.some((pattern) => pattern.test(text))) return 'DEBUG';

  if (
    /\b(ERROR|Error|Exception|failed|panic|traceback|usage limit|quota|rate limit|RESOURCE_EXHAUSTED)\b/i.test(
      text,
    )
  ) {
    return 'ERROR';
  }

  return 'DEBUG';
}
