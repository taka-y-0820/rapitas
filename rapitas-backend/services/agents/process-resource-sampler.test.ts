/**
 * process-resource-sampler ユニットテスト
 *
 * CSV/`/proc` パース関数の境界値と、start/stopResourceSampling のライフサイクルを検証する。
 * 正常系(モックした生存PIDから値取得)は child_process.exec をモックして検証する。
 *
 * NOTE: sampleOnce() (process-resource-sampler.ts) branches on
 * process.platform === 'win32' to pick readWindowsStats (exec, mocked below)
 * vs readPosixStats (real /proc/<pid> read). The start/stopResourceSampling
 * describe block below pins process.platform to 'win32' for its duration so
 * the exec mock is actually exercised on Linux CI too — without it, CI ran
 * readPosixStats against fake PIDs (55555 etc.) whose /proc entries don't
 * exist, so every "正常系" assertion failed there (task #869). The pure
 * parser describes (parseTasklistCsvLine / parseProcStat*) are platform-
 * independent and are left unpinned.
 */
import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test';
import * as realChildProcess from 'child_process';
import type { ExecOptions } from 'child_process';

// ── Module-level mock（import 前に宣言） ──────────────────────────────────────
// 他のexportは実体をそのまま透過し、exec だけ差し替え可能にする。
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
let execOverride: ((command: string, options: ExecOptions, callback: ExecCallback) => void) | null =
  null;

mock.module('child_process', () => ({
  ...realChildProcess,
  exec: (command: string, options: ExecOptions, callback: ExecCallback) => {
    if (execOverride) {
      execOverride(command, options, callback);
      return;
    }
    return realChildProcess.exec(command, options, callback);
  },
}));

const {
  parseTasklistCsvLine,
  parseProcStatCpuTimeMs,
  parseProcStatusRssKb,
  startResourceSampling,
  stopResourceSampling,
} = await import('./process-resource-sampler');

describe('parseTasklistCsvLine()', () => {
  test('正常系: CPU Time と Mem Usage(カンマ区切り)を正しくパースする', () => {
    const line = '"claude.exe","12345","Console","1","12,345 K","Running","user","0:01:05","N/A"';
    const result = parseTasklistCsvLine(line);
    expect(result).not.toBeNull();
    expect(result?.peakRssKb).toBe(12345);
    expect(result?.cpuTimeMs).toBe((1 * 60 + 5) * 1000);
  });

  test('CSV行として不正な入力は null を返す(例外を投げない)', () => {
    expect(
      parseTasklistCsvLine('INFO: No tasks are running which match the specified criteria.'),
    ).toBeNull();
    expect(parseTasklistCsvLine('')).toBeNull();
    expect(parseTasklistCsvLine('"only","two"')).toBeNull();
  });
});

describe('parseProcStatCpuTimeMs()', () => {
  test('正常系: utime+stime を USER_HZ=100 前提で ms に変換する', () => {
    // fields: pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime ...
    const line = '123 (node) S 1 1 1 0 -1 0 0 0 0 0 250 150 0 0';
    expect(parseProcStatCpuTimeMs(line)).toBe((250 + 150) * 10);
  });

  test('プロセス名に空白や括弧を含む場合でも最後の ) を起点に正しく解析する', () => {
    const line = '123 (my weird ) process) S 1 1 1 0 -1 0 0 0 0 0 40 10 0 0';
    expect(parseProcStatCpuTimeMs(line)).toBe((40 + 10) * 10);
  });

  test('フィールド不足など不正な形式は null を返す', () => {
    expect(parseProcStatCpuTimeMs('malformed line without parens')).toBeNull();
    expect(parseProcStatCpuTimeMs('123 (node) S 1')).toBeNull();
  });
});

describe('parseProcStatusRssKb()', () => {
  test('正常系: VmRSS 行を KB として抽出する', () => {
    const content = 'Name:\tnode\nVmRSS:\t   102400 kB\nVmSize:\t  200000 kB\n';
    expect(parseProcStatusRssKb(content)).toBe(102400);
  });

  test('VmRSS 行が無い場合は null を返す', () => {
    expect(parseProcStatusRssKb('Name:\tnode\n')).toBeNull();
  });
});

describe('start/stopResourceSampling() — 正常系(モックした生存PID)', () => {
  const originalPlatform = process.platform;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  test('exec が有効な tasklist CSV を返す場合、stop で実測値を取得できる', async () => {
    const pid = 55555;
    execOverride = (_command, _options, callback) => {
      callback(
        null,
        '"claude.exe","55555","Console","1","51,200 K","Running","user","0:02:00","N/A"\r\n',
        '',
      );
    };
    try {
      startResourceSampling(pid);
      // exec のコールバックはモック内で同期的に呼ばれるが、readWindowsStats の
      // Promise 継続(sampleOnce 内の await 以降)はマイクロタスク経由になるため、
      // setTimeout(0) で確実にフラッシュしてから検証する。
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = stopResourceSampling(pid);
      expect(result.cpuTimeMs).toBe(120000);
      expect(result.peakRssKb).toBe(51200);
    } finally {
      execOverride = null;
    }
  });
});

describe('start/stopResourceSampling() — プロセス消滅後・未対応プラットフォーム', () => {
  const originalPlatform = process.platform;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  test('一度もサンプリングできなかった PID は stop で null/null を返す', async () => {
    const fakePid = 999999;
    execOverride = (_command, _options, callback) => {
      callback(new Error('process not found'), '', '');
    };
    try {
      startResourceSampling(fakePid);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = stopResourceSampling(fakePid);
      expect(result).toEqual({ cpuTimeMs: null, peakRssKb: null });
    } finally {
      execOverride = null;
    }
  });

  test('未登録の PID を stop しても例外を投げず null/null を返す', () => {
    expect(stopResourceSampling(888888)).toEqual({ cpuTimeMs: null, peakRssKb: null });
  });

  test('start を同じ PID で2回呼んでも二重登録しない(冪等)', () => {
    const fakePid = 777777;
    execOverride = (_command, _options, callback) => {
      callback(new Error('process not found'), '', '');
    };
    try {
      startResourceSampling(fakePid);
      startResourceSampling(fakePid);
      stopResourceSampling(fakePid);
      // 2回目の stop はレジストリから既に削除済みのため null/null
      expect(stopResourceSampling(fakePid)).toEqual({ cpuTimeMs: null, peakRssKb: null });
    } finally {
      execOverride = null;
    }
  });
});
