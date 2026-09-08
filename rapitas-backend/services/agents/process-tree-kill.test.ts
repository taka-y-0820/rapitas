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

  test('回帰(task897): workdir 一致が自プロセスの祖先（呼び出し元シェル）を巻き込まない', () => {
    // 実測: `bun <script>` の起動コマンドライン自体に worktree パスが含まれる
    // と、そのコマンドを実行したシェル(ここでは pid 50)も workdir 文字列一致で
    // targets に入り、taskkill /T がそのシェルの子孫として自プロセスまで巻き
    // 込んで停止させた（2026-09-08 実機で再現・修正確認済み）。
    const wd = 'C:/Projects/rapitas/.worktrees/task-897-2bff4c91';
    const s = snap([
      [50, 1, `bash -c "bun script.mjs ${wd}"`], // 呼び出し元シェル（祖先）
      [process.pid, 50, `bun script.mjs ${wd}`], // 呼び出し元プロセス自身
      [100, 1, 'claude'], // 起動ルート（launchApp の対象）
      [300, 999, `node dev.js --cwd ${wd}`], // 本来拾うべき孤児
    ]);
    const t = collectKillTargets(s, 100, wd);
    expect(t.has(50)).toBe(false); // 祖先は保護される
    expect(t.has(process.pid)).toBe(false); // 自プロセスは保護される
    expect(t.has(300)).toBe(true); // 無関係な孤児は引き続き回収される
  });

  test('回帰(task897 監督差戻し): 起動ルート(rootPid)自身の祖先系統もworkdir一致から除外する', () => {
    // 呼出元プロセス(process.pid)の祖先には workdir 一致が無いが、起動ルート
    // (rootPid=100)の祖先(60)には一致がある構成。呼出元系統の除外だけでは
    // 60 は保護されず、taskkill /T が 60 を経由して起動ルート/子孫を巻き込む
    // （監督パッチ2141ef4a相当: 呼出元・起動ルート双方の系統を除外する）。
    const wd = 'C:/Projects/rapitas/.worktrees/task-897-2bff4c91';
    const s = snap([
      [1, 0, 'init'],
      [process.pid, 1, 'bun backend'], // 呼出元系統に workdir 一致なし
      [60, 1, `powershell -Command "cd ${wd}; npm run dev"`], // 起動ルートの祖先（workdir一致）
      [100, 60, 'cmd /c npm run dev:no-check'], // 起動ルート
      [101, 100, 'node next dev'], // 起動ルートのBFS子孫
      [300, 999, `node dev.js --cwd ${wd}`], // 無関係な孤児（依然拾うべき＝後退なし）
    ]);
    const t = collectKillTargets(s, 100, wd);
    expect(t.has(60)).toBe(false); // 起動ルートの祖先は保護される
    expect(t.has(101)).toBe(true); // BFS子孫は引き続き対象（保護の巻き込まれなし）
    expect(t.has(300)).toBe(true); // 無関係な孤児は引き続き回収される（orphan sweep 非後退）
  });
});

// A stale/cyclic snapshot can place an ancestor in the BFS set, independently
// of the workdir match. Final-set exclusion must still protect that ancestor.
test('excludes launch ancestors from the final BFS set', () => {
  const result = collectKillTargets(
    [
      { pid: 100, ppid: 50, cmd: 'app' },
      { pid: 50, ppid: 100, cmd: 'ancestor' },
      { pid: 101, ppid: 100, cmd: 'child' },
    ],
    100,
  );
  expect([...result]).toEqual([101]);
});
