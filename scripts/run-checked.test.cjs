#!/usr/bin/env node
/**
 * run-checked.test.cjs
 *
 * Node-test-runner suite for run-checked.cjs (bun/vitest-free by design so
 * this standalone tool can be verified without either test framework).
 * Run with: node --test scripts/run-checked.test.cjs
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'run-checked.cjs');

test(
  'shell spawn failure retains exit 127 without writing to a closed log',
  { skip: process.platform !== 'win32' },
  () => {
    const { status, stderr, stdout } = run(['--', 'echo ok'], {
      env: {
        ...process.env,
        ComSpec: 'C:/missing-run-checked-shell.exe',
        COMSPEC: 'C:/missing-run-checked-shell.exe',
      },
      timeout: 10000,
    });
    assert.equal(status, 127);
    assert.match(stderr, /failed to spawn command/);
    assert.doesNotMatch(stderr, /EBADF/);
    assert.match(stdout, /exitCode=127/);
  },
);

/** Runs run-checked.cjs inside a fresh temp cwd so .verification-logs never pollutes the repo. */
function run(args, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checked-test-'));
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    ...options,
  });
  return { ...result, cwd };
}

test('exit 0: wrapper exit code matches the successful child', () => {
  const { status, stdout } = run([
    '--',
    `${JSON.stringify(process.execPath)} -e "console.log(42)"`,
  ]);
  assert.equal(status, 0);
  assert.match(stdout, /42/);
  assert.match(stdout, /\[RUN-CHECKED\] exitCode=0/);
});

test('exit 1: wrapper exit code matches the failing child (no pipe involved)', () => {
  const { status, stdout } = run([
    '--',
    `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
  ]);
  assert.equal(status, 1);
  assert.match(stdout, /\[RUN-CHECKED\] exitCode=1/);
});

test('no output: wrapper still resolves with the child exit code', () => {
  const { status } = run(['--', `${JSON.stringify(process.execPath)} -e "process.exit(0)"`]);
  assert.equal(status, 0);
});

test('regression: a failing command followed by a pipe never reports exit 0', () => {
  // This is the exact bug (task 916): `false | tail -1` exits 0 under Git Bash.
  // run-checked.cjs must never let that pattern through as success.
  const { status, stderr } = run(['--', 'exit 1 | tail -1']);
  assert.notEqual(status, 0);
  assert.equal(status, 2);
  assert.match(stderr, /rejected/);
});

test('rejects semicolon-chained commands (exit 2, command never runs)', () => {
  const { status } = run(['--', 'exit 1 ; echo masked']);
  assert.equal(status, 2);
});

test('rejects && / || compound commands (exit 2, command never runs)', () => {
  assert.equal(run(['--', 'exit 1 && echo masked']).status, 2);
  assert.equal(run(['--', 'exit 1 || echo masked']).status, 2);
});

test('single ampersand and newline cannot hide a failed first command', () => {
  const failing = `"${process.execPath}" -e "process.exit(7)"`;
  for (const separator of [' & ', '\n', '\r\n']) {
    const result = run(['--', `${failing}${separator}echo masked`]);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /masked/);
  }
});

test('large output: console shows only the tail, full output is preserved in the log file', () => {
  const script = `${JSON.stringify(process.execPath)} -e "Array.from({length:500}).forEach((_,i)=>console.log('line'+i))"`;
  const { status, stdout, cwd } = run(['--tail-lines', '5', '--', script]);
  assert.equal(status, 0);
  assert.match(stdout, /output truncated/);
  assert.match(stdout, /line499/);
  assert.doesNotMatch(stdout, /line0\n/);
  const logDir = path.join(cwd, '.verification-logs');
  const [logFile] = fs.readdirSync(logDir);
  const logContent = fs.readFileSync(path.join(logDir, logFile), 'utf8');
  assert.match(logContent, /line0\n/);
  assert.match(logContent, /line499/);
});

test('heartbeat: long-running command emits progress lines before completion', () => {
  const script = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{}, 900)"`;
  const { status, stdout } = run(['--heartbeat-ms', '300', '--', script]);
  assert.equal(status, 0);
  const heartbeats = stdout.match(/\[RUN-CHECKED\] heartbeat/g) || [];
  assert.ok(heartbeats.length >= 1, 'expected at least one heartbeat line');
});

test('timeout: exit code is 124 and the child is killed before it can finish', () => {
  const script = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{}, 5000)"`;
  const { status, stdout } = run(['--timeout-ms', '400', '--', script]);
  assert.equal(status, 124);
  assert.match(stdout, /timeout/);
});

test('malformed invocation (missing --) is rejected with exit 2', () => {
  const { status, stderr } = run(['echo', 'hi']);
  assert.equal(status, 2);
  assert.match(stderr, /Usage/);
});

test('invalid numeric and unknown options fail before command execution', () => {
  for (const args of [
    ['--timeout-ms', 'NaN'],
    ['--heartbeat-ms', '-1'],
    ['--tail-lines', '0'],
    ['--timeout-ms', '2147483648'],
    ['--unknown', '1'],
  ]) {
    assert.equal(run([...args, '--', 'echo should-not-run']).status, 2);
  }
});

test('split UTF-8 bytes survive in full log and console', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checked-utf8-'));
  const fixture = path.join(fixtureDir, 'split.cjs');
  fs.writeFileSync(
    fixture,
    "const b = Buffer.from('日本語'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 150);",
  );
  const { status, stdout, cwd } = run(['--', `"${process.execPath}" "${fixture}"`]);
  assert.equal(status, 0);
  assert.ok(stdout.includes('日本語'));
  const logDir = path.join(cwd, '.verification-logs');
  const log = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]));
  assert.ok(log.includes(Buffer.from('日本語')));
  assert.ok(!log.includes(Buffer.from('\ufffd')));
});

test('newline-free output is bounded on console but retained in full log', () => {
  const { status, stdout, cwd } = run([
    '--',
    `"${process.execPath}" -e "process.stdout.write('x'.repeat(2000000))"`,
  ]);
  assert.equal(status, 0);
  assert.ok(stdout.length < 67000);
  const logDir = path.join(cwd, '.verification-logs');
  const log = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8');
  assert.ok(log.includes('x'.repeat(2000000)));
});

test('timeout terminates a grandchild, including one ignoring SIGTERM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checked-tree-'));
  const pidFile = path.join(dir, 'child.pid');
  const grandchild = path.join(dir, 'grandchild.cjs');
  const parent = path.join(dir, 'parent.cjs');
  fs.writeFileSync(
    grandchild,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
  );
  fs.writeFileSync(
    parent,
    `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], {stdio: 'inherit'}); setInterval(() => {}, 1000);`,
  );
  const result = run(['--timeout-ms', '2000', '--', `"${process.execPath}" "${parent}"`], {
    timeout: 15000,
  });
  assert.equal(result.status, 124);
  assert.ok(fs.existsSync(pidFile), 'grandchild must have started before timeout');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
