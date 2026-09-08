/**
 * process-tree-kill
 *
 * Windows process-tree enumeration for robust teardown of launched app
 * processes. `taskkill /T` walks live parent links only — when an
 * intermediate process dies first (e.g. tauri-cli exiting while its
 * BeforeDevCommand `pnpm dev` subtree keeps running), the orphaned subtree
 * is unreachable from the root and survives the kill. This module builds the
 * target set from a full process snapshot instead: BFS descendants of the
 * root PLUS any process whose command line references the launch worktree.
 * Not responsible for issuing the kill or the port-3001 guard — see
 * agent-process-tracker.ts.
 */
import { execSync } from 'child_process';
import { createLogger } from '../../config/logger';

const logger = createLogger('process-tree-kill');

/** One process from a system snapshot. */
export interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  cmd: string;
}

/**
 * Take a full process snapshot (pid / parent pid / command line) on Windows.
 *
 * @returns Snapshot entries, or [] when enumeration fails (fail-soft — the
 *          caller falls back to a plain `taskkill /T`) / 取得失敗時は空配列
 */
export function listWindowsProcessSnapshot(): ProcessSnapshotEntry[] {
  try {
    const raw = execSync(
      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"',
      // NOTE: 15s timeout + 16MB buffer — a full snapshot with command lines
      // is large, and a truncated/killed enumeration must degrade to [] rather
      // than leave a half-parsed target set.
      { stdio: 'pipe', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
    ).toString();
    const parsed: unknown = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const entries: ProcessSnapshotEntry[] = [];
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      const pid = typeof r.ProcessId === 'number' ? r.ProcessId : NaN;
      const ppid = typeof r.ParentProcessId === 'number' ? r.ParentProcessId : NaN;
      if (!Number.isFinite(pid)) continue;
      entries.push({
        pid,
        ppid: Number.isFinite(ppid) ? ppid : 0,
        cmd: typeof r.CommandLine === 'string' ? r.CommandLine : '',
      });
    }
    return entries;
  } catch (err) {
    logger.debug({ err }, '[process-tree-kill] snapshot enumeration failed');
    return [];
  }
}

/**
 * Walk a process's ancestor chain (parent, grandparent, ...) via the
 * snapshot's pid->ppid links.
 *
 * @param snapshot - Full process snapshot / プロセススナップショット
 * @param pid - Process whose lineage to walk / 起点PID
 * @returns Every ancestor pid, `pid` itself excluded / 祖先PID集合（自身は含まない）
 */
function collectAncestors(snapshot: ProcessSnapshotEntry[], pid: number): Set<number> {
  const parentOf = new Map<number, number>();
  for (const e of snapshot) parentOf.set(e.pid, e.ppid);
  const ancestors = new Set<number>();
  let cur = parentOf.get(pid);
  // guard against a pid->ppid cycle in a malformed/racy snapshot
  while (cur !== undefined && cur !== 0 && !ancestors.has(cur)) {
    ancestors.add(cur);
    cur = parentOf.get(cur);
  }
  return ancestors;
}

/**
 * Compute the kill-target set for a launched app's teardown.
 *
 * Includes every snapshot descendant of `rootPid` and — when `workdir` points
 * inside a `.worktrees` checkout — every process whose command line contains
 * that path (catches subtrees orphaned by a dead intermediate parent).
 * The `.worktrees` restriction is deliberate: a main-checkout path would also
 * match the user's own editors/dev servers for that project.
 *
 * The workdir substring match is command-line based, so it can also catch an
 * ANCESTOR of the calling process — e.g. the shell that invoked it, if the
 * worktree path happens to appear in that shell's own command line (observed
 * task 897: `bun <script-with-the-workdir-path-embedded>` matches itself).
 * `taskkill /T` on that ancestor recursively kills its whole descendant
 * subtree, which includes the caller — self-termination via a proxy target,
 * not a direct one, so excluding only `process.pid` does not prevent it. The
 * same proxy-kill risk applies to the launched app's OWN root: with
 * `shell:true`, `rootPid` is typically an intermediate shell, and if ITS
 * ancestor chain also happens to match the workdir substring (e.g. a parent
 * shell that `cd`'d into the worktree before spawning it), that ancestor
 * would be added as a target and `/T` would tear down the legitimate root
 * along with it via the same proxy mechanism. Both the calling process's
 * lineage and the launch root's lineage are therefore excluded from the
 * workdir-matched set — not just `process.pid`/`rootPid` themselves.
 *
 * @param snapshot - Full process snapshot / プロセススナップショット
 * @param rootPid - Spawned root process id / 起動ルートのPID
 * @param workdir - Launch working directory, if known / 起動時の作業ディレクトリ
 * @returns Target pids, root excluded (the caller decides whether the root
 *          itself is alive and killable) / ルートを除く対象PID集合
 */
export function collectKillTargets(
  snapshot: ProcessSnapshotEntry[],
  rootPid: number,
  workdir?: string,
): Set<number> {
  const targets = new Set<number>();

  const childrenByParent = new Map<number, number[]>();
  for (const e of snapshot) {
    const siblings = childrenByParent.get(e.ppid);
    if (siblings) siblings.push(e.pid);
    else childrenByParent.set(e.ppid, [e.pid]);
  }
  const queue = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const child of childrenByParent.get(cur) ?? []) {
      if (targets.has(child)) continue; // PID-reuse cycle guard
      targets.add(child);
      queue.push(child);
    }
  }

  if (workdir && workdir.includes('.worktrees')) {
    const protectedAncestors = collectAncestors(snapshot, process.pid);
    const protectedRootAncestors = collectAncestors(snapshot, rootPid);
    for (const e of snapshot) {
      if (
        e.pid !== rootPid &&
        e.cmd.includes(workdir) &&
        !protectedAncestors.has(e.pid) &&
        !protectedRootAncestors.has(e.pid)
      ) {
        targets.add(e.pid);
      }
    }
  }

  targets.delete(rootPid);
  targets.delete(process.pid); // never self-terminate the backend
  return targets;
}

/**
 * Capture a process's descendants RIGHT NOW, for a kill that happens later.
 *
 * `collectKillTargets` can only follow parent links that still exist. An agent
 * CLI often exits while a command it launched keeps running, and once the
 * intermediate shell exits too the survivor is unreachable from the root —
 * neither `taskkill /T` nor a later snapshot walk can find it. Observed
 * 2026-08-23: an agent left `find / -maxdepth 6 -iname system.dic` scanning the
 * whole drive for 15 minutes (781 CPU-seconds) after its parent had gone.
 *
 * Callers snapshot at teardown-decision time and pass the result to
 * killProcessTreeSafely, which kills whatever is still alive after the grace
 * period. Returns an empty set when the root is already gone (nothing to walk)
 * or on enumeration failure.
 *
 * @param rootPid - Process whose descendants should be remembered. / 対象プロセス
 * @param workdir - Optional launch cwd for command-line orphan matching. / 起動時cwd
 * @returns Descendant pids known at call time. / 呼び出し時点の子孫PID
 */
export function captureDescendants(rootPid: number, workdir?: string): Set<number> {
  if (process.platform !== 'win32') return new Set();
  const snapshot = listWindowsProcessSnapshot();
  if (snapshot.length === 0) return new Set();
  return collectKillTargets(snapshot, rootPid, workdir);
}
