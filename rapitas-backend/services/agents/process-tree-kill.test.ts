/**
 * process-tree-kill テスト
 *
 * 子孫PIDの収集が、親リンクが生きている間なら辿れること、
 * 中間の親が消えた後は辿れなくなること（＝事前捕捉が必要な理由）を固定する。
 */
import { describe, test, expect } from 'bun:test';
import { collectKillTargets, type ProcessSnapshotEntry } from './process-tree-kill';

const snap = (rows: Array<[number, number, string?]>): ProcessSnapshotEntry[] =>
  rows.map(([pid, ppid, cmd]) => ({ pid, ppid, cmd: cmd ?? '' }));

describe('collectKillTargets', () => {
  test('親リンクが生きていれば孫まで辿る', () => {
    // claude(100) → bash(200) → find(300)
    const s = snap([
      [100, 1, 'claude --print'],
      [200, 100, 'bash -c "find / -iname system.dic"'],
      [300, 200, 'find / -maxdepth 6 -iname system.dic'],
    ]);
    expect([...collectKillTargets(s, 100)].sort()).toEqual([200, 300]);
  });

  test('回帰: 中間の親が消えた後は孫に到達できない', () => {
    // bash(200) が先に終了して snapshot から消えると、find(300) の ppid は
    // 死んだPIDを指し、ルート100からのBFSでは永久に見つからない。実測
    // 2026-08-23、この状態の `find /` が15分間CPUを焼き続けた。だから
    // captureDescendants で「まだ辿れるうち」に捕まえておく必要がある。
    const s = snap([
      [100, 1, 'claude --print'],
      [300, 200, 'find / -maxdepth 6 -iname system.dic'],
    ]);
    expect([...collectKillTargets(s, 100)]).toEqual([]);
  });

  test('worktree パスのコマンドライン一致で孤児を拾える', () => {
    const wd = 'C:/Projects/rapitas/.worktrees/task-1-abc';
    const s = snap([
      [100, 1, 'claude'],
      [300, 999, `node dev.js --cwd ${wd}`],
    ]);
    expect([...collectKillTargets(s, 100, wd)]).toEqual([300]);
  });

  test('メインチェックアウトのパスでは一致させない（利用者のエディタを巻き込まない）', () => {
    const wd = 'C:/Projects/rapitas';
    const s = snap([
      [100, 1, 'claude'],
      [300, 999, `code ${wd}`],
    ]);
    expect([...collectKillTargets(s, 100, wd)]).toEqual([]);
  });

  test('ルート自身と自プロセスは対象から外す', () => {
    const s = snap([
      [100, 1, 'claude'],
      [100, 100, 'self-cycle'],
      [process.pid, 100, 'backend'],
    ]);
    const t = collectKillTargets(s, 100);
    expect(t.has(100)).toBe(false);
    expect(t.has(process.pid)).toBe(false);
  });

  test('PID再利用による循環でも停止する', () => {
    const s = snap([
      [100, 1, 'root'],
      [200, 100, 'a'],
      [100, 200, 'cycle back to root'],
    ]);
    expect(() => collectKillTargets(s, 100)).not.toThrow();
  });
});

test('worktree matching cannot select caller or launch ancestors for recursive kill', () => {
  const wd = 'C:/Projects/rapitas/.worktrees/task-897-test';
  const snapshot = snap([
    [40, 1, `outer shell ${wd}`],
    [50, 40, `invoking shell ${wd}`],
    [process.pid, 50, `verifier ${wd}`],
    [100, process.pid, 'launched app'],
    [101, 100, 'app child'],
  ]);
  expect([...collectKillTargets(snapshot, 100, wd)]).toEqual([101]);
});
test('launch ancestors remain protected when caller is outside the launch ancestry', () => {
  const wd = 'C:/Projects/rapitas/.worktrees/task-897-test';
  const snapshot = snap([
    [50, 1, `launcher ${wd}`],
    [100, 50, 'app'],
    [101, 100, 'child'],
  ]);
  expect([...collectKillTargets(snapshot, 100, wd)]).toEqual([101]);
});
