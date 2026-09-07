/**
 * process-runner-args.cmd-roundtrip.test
 *
 * Real-process, real-`cmd.exe` verification of `buildSpawnCommand` (task
 * #891 / CodeQL "Incomplete string escaping or encoding"). The unit tests
 * in process-runner.spawn.test.ts only assert on the literal escaped
 * string; they cannot prove cmd.exe actually decodes it back to the
 * original argv. This file spawns a mock `.cmd` shim shaped like the real
 * `codex.cmd` (an `%*`-expanding batch wrapper around a Node script) and
 * confirms the child process receives exactly the argv it was given.
 *
 * Windows-only: requires a live `cmd.exe`. Skipped everywhere else,
 * including this repo's CI (`test-lint.yml` runs backend `bun test` only on
 * `ubuntu-latest`; `windows-latest` CI jobs cover Rust/Tauri only) — so this
 * suite is verified by local execution on Windows, not by CI.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnCommand } from './process-runner-args';

const isWindows = process.platform === 'win32';
const describeWindowsOnly = isWindows ? describe : describe.skip;

describeWindowsOnly('buildSpawnCommand — real cmd.exe round-trip (Windows only)', () => {
  let tmpDir: string;
  let shimPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-cmd-roundtrip-'));
    const echoScriptPath = join(tmpDir, 'echo-argv.js');
    writeFileSync(echoScriptPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');

    // Mirrors the re-parse-triggering structure of the real codex.cmd shim
    // (see research.md's `Get-Content` inspection of the installed
    // codex.cmd): `%*` is expanded into a new command line that cmd.exe
    // parses a second time, which is exactly the scenario
    // `escapeWindowsShellArg`'s `doubleEscapeMetaChars` targets.
    shimPath = join(tmpDir, 'mock-codex.cmd');
    writeFileSync(shimPath, `@ECHO off\r\nnode "${echoScriptPath}" %*\r\n`);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runRoundtrip(argv: string[]): Promise<string[]> {
    const [command, finalArgs] = buildSpawnCommand(shimPath, argv, true);
    return new Promise((resolve, reject) => {
      const child = spawn(command, finalArgs, { shell: true, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`mock-codex.cmd exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`failed to parse child stdout as JSON: ${stdout} (${String(err)})`));
        }
      });
      child.on('error', reject);
    });
  }

  test.each([
    ['plain flags and values', ['exec', '--cd', 'C:/work', '--json']],
    ['trailing-backslash path', ['--cd', 'C:\\work\\nested\\']],
    ['embedded quote and backslash', ['say "hi\\', 'plain']],
    ['percent (env-var-like) token', ['-m', '%OPENAI_API_KEY%']],
    ['caret escape char itself', ['^literal^caret^']],
    ['ampersand and pipe', ['a&b', 'c|d']],
    ['angle brackets and redirection-like tokens', ['a<b>c']],
    ['parentheses grouping tokens', ['(group)', 'a;b,c']],
    ['empty string argument', ['exec', '', '--flag']],
  ])('round-trips %s through a real cmd.exe + %%*-expanding shim', async (_label, argv) => {
    const received = await runRoundtrip(argv);
    expect(received).toEqual(argv);
  });

  test("a literal newline in an argument is truncated by cmd.exe — pre-existing platform limitation, not this fix's scope", async () => {
    // A raw LF inside a `shell: true` command string is not something any
    // argv-escaping scheme can fix: cmd.exe treats it as a command-line
    // terminator before quoting/caret rules are even applied, so the text
    // after the newline is dropped. This reproduces with both the old and
    // the new escaping implementation — filed as a separate concern
    // (task #891 verify.md) rather than treated as a CodeQL-escaping defect.
    const received = await runRoundtrip(['implement the\nfeature with spaces']);
    expect(received).toEqual(['implement the']);
  });

  test('the codex path itself is quoted safely even when it lives under a space-containing directory', async () => {
    const spacedDir = mkdtempSync(join(tmpdir(), 'codex cmd roundtrip '));
    try {
      const echoScriptPath = join(spacedDir, 'echo-argv.js');
      writeFileSync(
        echoScriptPath,
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      );
      const spacedShimPath = join(spacedDir, 'mock-codex.cmd');
      writeFileSync(spacedShimPath, `@ECHO off\r\nnode "${echoScriptPath}" %*\r\n`);

      const [command, finalArgs] = buildSpawnCommand(spacedShimPath, ['exec', '--json'], true);
      const received = await new Promise<string[]>((resolve, reject) => {
        const child = spawn(command, finalArgs, { shell: true, windowsHide: true });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`exited with code ${code}: ${stderr}`));
            return;
          }
          resolve(JSON.parse(stdout));
        });
        child.on('error', reject);
      });
      expect(received).toEqual(['exec', '--json']);
    } finally {
      rmSync(spacedDir, { recursive: true, force: true });
    }
  });
});
