import type { ClaudeCodeAgent } from './agent-core';

/**
 * Build the Claude Code CLI argument list from agent config. Pure function.
 *
 * @param agent - Host agent providing `.config` and `.logPrefix` only — safe to
 *   call with any object shape that has those two fields (see unit tests). / `.config`と`.logPrefix`のみ使用
 * @returns CLI args plus any log lines the caller should emit / CLI引数と呼び出し元が出力すべきログ行
 */
export function buildClaudeArgs(agent: ClaudeCodeAgent): { args: string[]; logExtras: string[] } {
  const cfg = agent.config;
  const args: string[] = ['--print', '--verbose', '--output-format', 'stream-json'];
  const logExtras: string[] = [];

  if (cfg.resumeSessionId) {
    args.push('--resume', cfg.resumeSessionId);
    logExtras.push(
      `${agent.logPrefix} Resuming specific session with --resume ${cfg.resumeSessionId}`,
    );
  } else if (cfg.continueConversation) {
    args.push('--continue');
    logExtras.push(`${agent.logPrefix} Continuing most recent conversation with --continue`);
  }

  if (cfg.dangerouslySkipPermissions) {
    // NOTE(security): This agent runs fully headless (spawned with stdio
    // pipes, no TTY — see runClaudeExecution below) for up to the phase
    // timeout (tens of minutes) with nobody available to answer a permission
    // prompt. `--permission-mode acceptEdits` was evaluated as a narrower
    // alternative but does NOT auto-approve arbitrary Bash (only a handful of
    // filesystem commands like mkdir/rm/mv) — every test/build/git/lint
    // command this workflow needs to run would still prompt and, with no TTY
    // to answer it, the run aborts instead of hanging. `--permission-mode
    // dontAsk` avoids the abort but requires enumerating exact allowed Bash
    // command patterns up front, which is incompatible with a general-purpose
    // coding agent that decides its own test/build tooling per task. Bypass
    // therefore stays, compensated by: (1) worktree isolation — the agent
    // only ever touches its own disposable worktree, never the primary
    // checkout; (2) a sanitized spawn env (buildSpawnEnv below) that strips
    // ENCRYPTION_KEY/DATABASE_URL/*_TOKEN/etc. before the process starts, so
    // there is nothing sensitive in-process for a prompt-steered command to
    // read; (3) the `--disallowedTools` denylist below, which removes
    // network-egress and meta/recursion tools this workflow never needs.
    args.push('--dangerously-skip-permissions');
    // Also set permission-mode to ensure all file edits (including .claude/) are allowed
    args.push('--permission-mode', 'bypassPermissions');
  }
  if (cfg.model) args.push('--model', cfg.model);
  // Keep unattended runs responsive instead of inheriting the CLI's changing
  // effort default. Operators can opt into deeper reasoning for harder work.
  const configuredEffort = process.env.RAPITAS_CLAUDE_EFFORT?.trim().toLowerCase();
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(configuredEffort ?? '')
    ? configuredEffort!
    : 'medium';
  args.push('--effort', effort);
  logExtras.push(`${agent.logPrefix} Effort: ${effort}`);
  if (cfg.maxTokens) args.push('--max-tokens', String(cfg.maxTokens));

  // NOTE(security): No --mcp-config is ever passed to this spawn, so without
  // --strict-mcp-config the CLI would still ambiently load MCP servers from
  // the machine's global (~/.claude.json) or project (.mcp.json) config —
  // reachable tools this workflow's prompts never sanction and that an
  // implementer/verifier agent has no legitimate need for. --strict-mcp-config
  // restricts loading to --mcp-config sources only, and since none is passed
  // here that means zero MCP servers are loaded for spawned agents.
  args.push('--strict-mcp-config');

  // NOTE: Disable worktree tools to prevent the spawned CLI from creating nested worktrees
  // that conflict with rapitas-managed worktrees and could corrupt .git/ directory structure.
  // NOTE(security): WebFetch/WebSearch (network egress), ToolSearch/Skill (can
  // indirectly reach tools/skills outside this denylist, including network
  // ones), and Task (recursive sub-agent spawning — costs tokens/time and
  // isn't part of the sanctioned workflow, which registers subtasks via the
  // HTTP API instead) are blocked unconditionally: no implementer/verifier/
  // research prompt in this codebase instructs the agent to use them, so
  // they are pure attack surface with no functional cost to removing them.
  const disallowed = [
    'EnterWorktree',
    'ExitWorktree',
    'WebFetch',
    'WebSearch',
    'ToolSearch',
    'Skill',
    'Task',
    // NOTE(security): destructive git operations are denied even in mutating
    // mode. The agent works in a disposable worktree, but its branch may back
    // an OPEN PR (force-push auto-closes/orphans it — observed with PR #253),
    // `git stash` on a shared branch has clobbered real work before, and
    // reset --hard / clean erase the agent's own uncommitted progress that the
    // repair loop may still need. Prefix rules — a determined prompt injection
    // can rephrase, so the worktree isolation guard remains the real boundary;
    // this denylist removes the ACCIDENTAL destruction class.
    'Bash(git push --force:*)',
    'Bash(git push -f:*)',
    'Bash(git reset --hard:*)',
    'Bash(git clean:*)',
    'Bash(git stash:*)',
    'Bash(git switch:*)',
    'PowerShell(git push --force:*)',
    'PowerShell(git push -f:*)',
    'PowerShell(git reset --hard:*)',
    'PowerShell(git clean:*)',
    'PowerShell(git stash:*)',
    'PowerShell(git switch:*)',
  ];
  if (cfg.investigationMode) {
    // Investigation mode (research / planner): additionally block
    // ALL mutating tools so the agent can't bypass the parent-only workflow
    // contract by writing files directly, running shell commands (curl /
    // git / pnpm), or invoking the workflow API itself. Read-only tools
    // (Read / Glob / Grep) remain available so the agent can still
    // investigate the codebase.
    const investigationExtras = [
      'Bash',
      'PowerShell',
      'Edit',
      'Write',
      // NOTE: 'MultiEdit' removed — current Claude Code CLI has no such tool and
      // logged "Permission deny rule MultiEdit matches no known tool" every run.
      // File mutation is already blocked via Edit/Write/NotebookEdit.
      'NotebookEdit',
    ];
    disallowed.push(...investigationExtras);
    logExtras.push(
      `${agent.logPrefix} Investigation mode: blocking write/shell tools (${investigationExtras.join(',')})`,
    );
  }
  args.push('--disallowedTools', disallowed.join(','));

  return { args, logExtras };
}
