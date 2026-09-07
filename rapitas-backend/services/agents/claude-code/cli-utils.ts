/**
 * ClaudeCodeAgent CLI Utilities
 *
 * Platform-specific helpers for resolving and launching the Claude Code CLI binary.
 * Not responsible for process lifecycle management or output parsing.
 */

import { spawn } from 'child_process';
import { getClaudePathAsync } from '../../../utils/common/cli-path-resolver';

export {
  resolveCliPathAsync as resolveCliPath,
  getClaudePathAsync as getClaudePath,
} from '../../../utils/common/cli-path-resolver';

/**
 * Checks whether the Claude Code CLI binary is accessible on the current system.
 *
 * @returns true if the CLI responds to --version within 10 seconds / CLIが10秒以内に--versionに応答すればtrue
 */
export async function checkClaudeAvailable(): Promise<boolean> {
  const claudePath = await getClaudePathAsync();
  return new Promise((resolve) => {
    const proc = spawn(claudePath, ['--version'], { shell: true });

    // NOTE: 10-second timeout prevents indefinite hang when CLI is missing.
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 10000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Builds the final spawn command and args array for Claude Code CLI on the current platform.
 * On Windows, prepends `chcp 65001` for UTF-8 encoding and embeds all args in the command string.
 *
 * @param claudePath - Resolved CLI path / 解決されたCLIパス
 * @param args - CLI arguments to pass / CLIに渡す引数
 * @returns Tuple of [finalCommand, finalArgs] ready for spawn() / spawn()に渡す[最終コマンド, 最終引数]のタプル
 */
export function buildSpawnCommand(claudePath: string, args: string[]): [string, string[]] {
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    // NOTE: On Windows, set UTF-8 code page with chcp 65001 before running claude.cmd.
    // All args are embedded in the command string so the shell interprets them correctly.
    const argsString = args
      .map((arg) => {
        if (arg.includes(' ') || arg.includes('&') || arg.includes('|')) {
          return `"${arg}"`;
        }
        return arg;
      })
      .join(' ');
    const quotedPath = claudePath.includes(' ') ? `"${claudePath}"` : claudePath;
    return [`chcp 65001 >NUL 2>&1 && ${quotedPath} ${argsString}`, []];
  }

  return [claudePath, args];
}
