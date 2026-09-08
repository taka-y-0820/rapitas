/**
 * CodexCliAgent — Process Runner: CLI argument / environment construction
 *
 * Builds the Codex CLI argv, spawn environment, and platform-specific spawn
 * command string. Split out of process-runner.ts (task #879) to keep that
 * file under the COMPONENT_SPLITTING_POLICY.md hard line limit.
 * Not responsible for spawning, event parsing, or result construction.
 */

import type { CodexCliAgentConfig } from './types';
import { createLogger } from '../../../config/logger';
import { buildSanitizedSpawnEnv } from '../../../utils/agent';

const logger = createLogger('codex-cli-agent/process-runner-args');

/**
 * Build the final spawn command and args for the given platform.
 */
export function buildSpawnCommand(
  codexPath: string,
  args: string[],
  isWindows: boolean,
): [string, string[]] {
  if (!isWindows) return [codexPath, args];

  const argsString = args
    .map((arg) => {
      if (arg.includes(' ') || arg.includes('&') || arg.includes('|') || arg.includes('\n')) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    })
    .join(' ');

  const quotedPath = codexPath.includes(' ') ? `"${codexPath}"` : codexPath;
  return [`chcp 65001 >NUL 2>&1 && ${quotedPath} ${argsString}`, []];
}

/**
 * Build the environment variables for the Codex CLI process.
 *
 * NOTE: The spawned CLI is prompt-steerable (the task prompt can ask it to
 * print/exfiltrate its own env), so start from a sanitized base — never the
 * raw inherited process.env — to keep ENCRYPTION_KEY/DATABASE_URL/tokens out
 * of its reach. OPENAI_* is kept because the Codex CLI authenticates with it.
 */
export function buildProcessEnv(
  config: CodexCliAgentConfig,
  isWindows: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = buildSanitizedSpawnEnv(
    {
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      CI: '1',
      TERM: 'dumb',
    },
    ['OPENAI_'],
  );

  if (config.apiKey) env.OPENAI_API_KEY = config.apiKey;

  if (isWindows) {
    env.LANG = 'en_US.UTF-8';
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.CHCP = '65001';
  }

  return env;
}

/** Investigation mode headline mappings */
const INVESTIGATION_HEADLINES: Record<string, string> = {
  research:
    '次の標準入力に含まれる調査タスクを実行し、最終回答を必ず "# 調査レポート" から始めてください。前置きは不要です。',
  plan: '次の標準入力に含まれる実装計画タスクを実行し、最終回答を必ず "# 実装計画" から始めてください。前置きは不要です。"## 設計判断の根拠" と "## 実装チェックリスト" のセクションを必ず含めてください。',
  review:
    '次の標準入力に含まれるレビュータスクを実行し、最終回答を必ず "# レビュー指摘" から始めてください。前置きは不要です。',
  verify:
    '次の標準入力に含まれる検証タスクを実行し、最終回答を必ず "# 検証結果" から始めてください。前置きは不要です。',
};

/** Result of building CLI args */
export interface ArgsResult {
  args: string[];
  promptForStdin: string | null;
}

/**
 * Build Codex CLI arguments based on configuration and mode.
 */
export function buildCodexArgs(
  config: CodexCliAgentConfig,
  workDir: string,
  prompt: string,
  logPrefix: string,
): ArgsResult {
  const args: string[] = [];
  // Approval is a top-level CLI option, so place it before the subcommand.
  const approvalPolicy = config.investigationMode ? 'never' : config.approvalPolicy;
  if (approvalPolicy && (!config.yolo || config.investigationMode)) {
    args.push('--ask-for-approval', approvalPolicy);
  }
  args.push('exec');

  // NOTE(security): Unlike Claude Code (`--strict-mcp-config`, see
  // claude-execution-runner.ts), Codex CLI has no single flag that restricts
  // MCP loading to an explicit allowlist and ignores ambient config. Its only
  // documented controls are per-server: `codex mcp disable <name>` (mutates
  // ~/.codex/config.toml persistently — not a per-spawn flag) or
  // `-c mcp_servers.<name>.enabled=false` overrides, both of which require
  // enumerating server names this codebase has no way to know ahead of time
  // (they live in the operator's machine-level ~/.codex/config.toml, not
  // ours). Pointing CODEX_HOME at an isolated directory per spawn was
  // considered but rejected: it would also relocate the session/auth store
  // Codex needs to function, is a larger behavioral change than this hardening
  // pass's scope, and could not be verified here (the Codex CLI is not
  // installed in this environment). Left as a follow-up — track "generic
  // MCP-isolation flag" against future Codex CLI releases.
  // JSON mode for implementation (not investigation)
  if (!config.investigationMode) {
    args.push('--json');
  }
  args.push('--cd', workDir);

  // Sandbox and permission settings
  if (config.investigationMode) {
    args.push('--sandbox', 'read-only');
    args.push('--skip-git-repo-check');
    logger.info(
      `${logPrefix} Investigation mode: --sandbox=read-only, --skip-git-repo-check, NO --json`,
    );
  } else if (config.yolo) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (config.sandboxMode) {
    args.push('--sandbox', config.sandboxMode);
  } else if (approvalPolicy) {
    args.push('--sandbox', 'workspace-write');
  } else {
    args.push('--full-auto');
  }

  // Output capture is independent of the sandbox selection (including research).
  if (config.outputLastMessageFile) {
    args.push('--output-last-message', config.outputLastMessageFile);
  }

  // Model setting (skip in investigation mode)
  if (config.model && !config.investigationMode) {
    const model = normalizeCodexModel(
      config.model,
      !!config.apiKey || !!process.env.OPENAI_API_KEY,
    );
    args.push('-m', model);
  }

  // Prompt handling
  let promptForStdin: string | null = null;
  const resumeId = config.resumeSessionId;

  if (resumeId) {
    args.push('resume', resumeId);
    logger.info(`${logPrefix} Resuming session: ${resumeId}`);
  } else if (config.investigationMode) {
    const outputType = config.investigationOutputType ?? 'research';
    const headline = INVESTIGATION_HEADLINES[outputType] ?? INVESTIGATION_HEADLINES.research;
    args.push(headline);
    promptForStdin = prompt;
  } else {
    args.push(prompt);
  }

  return { args, promptForStdin };
}

export function normalizeCodexModel(model: string, hasApiKey: boolean): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;

  // Legacy GPT-4-era API models are not reliable with Codex CLI ChatGPT
  // account mode. Prefer the current Codex-capable default family so the CLI
  // does not silently ignore the request and then report a different model.
  if (!hasApiKey && /^(gpt-4|gpt-3\.5)/i.test(trimmed)) {
    return 'gpt-5.5';
  }
  return trimmed;
}
