#!/usr/bin/env node
/**
 * run-checked.cjs
 *
 * Runs a single shell command and guarantees the wrapper process's own exit
 * code equals the child's real exit code — no matter how much output the
 * command produces. Exists because agents piping verification commands
 * through `| tail` / `| head` lose the original exit code (Git Bash has
 * `pipefail` disabled by default, so `false | tail -1` exits 0). Full output
 * is written to a log file; the console only shows the last N lines.
 *
 * Rejects pipe/compound shell operators (`|`, `;`, `&&`, `||`) up front so a
 * command like `tsc --noEmit | tail -30` cannot silently swallow the real
 * exit code — it is refused (exit 2) instead of executed.
 *
 * Usage:
 *   node scripts/run-checked.cjs -- <command...>
 *   node scripts/run-checked.cjs --tail-lines 80 --heartbeat-ms 30000 --timeout-ms 180000 -- <command...>
 *
 * Exit codes:
 *   <child's own code>  the command ran to completion
 *   124                 timed out (child killed)
 *   127                 failed to spawn the command
 *   2                   rejected: command contains a pipe/compound operator
 */
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_TAIL_LINES = 80;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 0; // 0 = no timeout
const KILL_GRACE_MS = 5_000;
const MAX_TAIL_CHARS = 64 * 1024;
/** Operators that would let a later stage in the pipeline mask the real exit code. */
const REJECTED_OPERATORS = ['|', ';', '&', '\n', '\r'];

/** Parses argv into wrapper options and the raw command string after `--`. */
function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep === -1 || sep === argv.length - 1) {
    return { error: 'Usage: node scripts/run-checked.cjs [options] -- <command...>' };
  }
  const optArgs = argv.slice(0, sep);
  const command = argv.slice(sep + 1).join(' ');
  const opts = {
    tailLines: DEFAULT_TAIL_LINES,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < optArgs.length; i += 1) {
    const arg = optArgs[i];
    const key = {
      '--tail-lines': 'tailLines',
      '--heartbeat-ms': 'heartbeatMs',
      '--timeout-ms': 'timeoutMs',
    }[arg];
    if (!key) return { error: `Unknown option: ${arg}` };
    const value = Number(optArgs[++i]);
    if (
      !Number.isSafeInteger(value) ||
      value < (key === 'tailLines' ? 1 : 0) ||
      value > 2147483647
    ) {
      return { error: `Invalid value for ${arg}` };
    }
    opts[key] = value;
  }
  return { opts, command };
}

/** True when the command string contains a pipe/compound operator outside the wrapper's control. */
function containsRejectedOperator(command) {
  return REJECTED_OPERATORS.some((op) => command.includes(op));
}

function slugify(command) {
  return (
    command
      .slice(0, 40)
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'cmd'
  );
}

function tailLines(text, n) {
  const lines = text.split('\n');
  return lines.length <= n ? text : lines.slice(-n).join('\n');
}

/** Best-effort recursive kill so a `shell:true` child's grandchildren don't survive a timeout. */
function killTree(pid, signal = 'SIGKILL') {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* best-effort */
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { error, opts, command } = parseArgs(argv);
  if (error) {
    process.stderr.write(`[RUN-CHECKED] ${error}\n`);
    process.exitCode = 2;
    return;
  }
  if (containsRejectedOperator(command)) {
    process.stderr.write(
      `[RUN-CHECKED] rejected: command contains a pipe/compound operator (${REJECTED_OPERATORS.join(' ')}). ` +
        'Run the command directly, or put multi-step logic in a script file and pass its path instead.\n',
    );
    process.exitCode = 2;
    return;
  }

  const logDir = path.resolve(process.cwd(), '.verification-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${Date.now()}_${slugify(command)}.log`);
  const logFd = fs.openSync(logPath, 'a');
  const startedAt = Date.now();
  let childOutputBytes = 0;
  const write = (text) => {
    fs.writeSync(logFd, text);
  };
  write(
    `[RUN-CHECKED] command=${command}\n[RUN-CHECKED] cwd=${process.cwd()}\n[RUN-CHECKED] started\n`,
  );

  let child;
  try {
    child = spawn(command, {
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch {
    process.stderr.write('[RUN-CHECKED] failed to spawn command\n');
    fs.closeSync(logFd);
    process.exitCode = 127;
    return;
  }

  let consoleTail = '';
  const appendTail = (text) => {
    consoleTail = tailLines(consoleTail + text, opts.tailLines).slice(-MAX_TAIL_CHARS);
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream?.on('data', (buf) => {
      childOutputBytes += buf.length;
      write(buf);
      appendTail(decoder.write(buf));
    });
    stream?.on('end', () => appendTail(decoder.end()));
  }
  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
    process.stderr.write('[RUN-CHECKED] failed to spawn command\n');
  });

  const heartbeat =
    opts.heartbeatMs > 0
      ? setInterval(() => {
          const line = `[RUN-CHECKED] heartbeat elapsedMs=${Date.now() - startedAt} lastOutputBytes=${childOutputBytes}\n`;
          write(line);
          process.stdout.write(line);
        }, opts.heartbeatMs)
      : null;

  let timedOut = false;
  let graceTimer = null;
  const timeoutTimer =
    opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid, 'SIGTERM');
          if (process.platform !== 'win32') {
            // The shell can exit before descendants which ignore SIGTERM.
            // Keep the escalation alive even after the shell's close event.
            graceTimer = setTimeout(() => killTree(child.pid), KILL_GRACE_MS);
          }
        }, opts.timeoutMs)
      : null;

  child.on('close', (code) => {
    if (heartbeat) clearInterval(heartbeat);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer && !timedOut) clearTimeout(graceTimer);
    const finalCode = spawnFailed ? 127 : timedOut ? 124 : (code ?? 1);
    const truncated = childOutputBytes > Buffer.byteLength(consoleTail);
    if (truncated) {
      const notice = `[RUN-CHECKED] output truncated: full log at ${logPath}\n`;
      write(notice);
      process.stdout.write(notice);
    }
    process.stdout.write(consoleTail);
    const summary = `[RUN-CHECKED] exitCode=${finalCode}${timedOut ? ' (timeout)' : ''}\n`;
    write(summary);
    process.stdout.write(summary);
    fs.closeSync(logFd);
    process.exitCode = finalCode;
  });
}

main();
