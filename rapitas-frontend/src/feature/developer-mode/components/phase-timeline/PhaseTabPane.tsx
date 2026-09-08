'use client';

/**
 * phase-timeline/PhaseTabPane
 *
 * The log pane for ONE phase iteration inside the tabbed execution-log view
 * (task #796 redesign of #785). Always expanded — tab selection replaces the
 * old accordion — and styled as a terminal: forced-dark, monospace, dark
 * canvas regardless of the app theme. Search is VSCode-style: matches are
 * highlighted in place (never filtered out) and navigated via the header.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown } from 'lucide-react';
import { API_BASE_URL } from '@/utils/api';
import { transformLogsToSimple } from '../../utils/log-message-transformer';
import type { PhaseIteration } from '../../hooks/usePhaseTimeline';
import { usePhaseLogStreaming } from '../../hooks/usePhaseLogStreaming';
import {
  useResizableLogHeight,
  MIN_LOG_HEIGHT,
} from '../execution-log-viewer/useResizableLogHeight';

import { SimpleLogEntryList } from '../simple-log-entry/simple-log-entry';

// Speech bubbles live in SimpleLogEntryList (the pre-#785 renderer users
// asked for); the virtualized PhaseLogViewer dropped them. Cap the tail so a
// huge iteration doesn't mount thousands of DOM rows.
const MAX_RENDERED_ENTRIES = 1500;

/** Default pane height (px) before the user drags the grip. */
const DEFAULT_PANE_HEIGHT = 340;

/** Marker class for match <mark>s — the navigation effect queries these. */
const MARK_CLASS = 'pt-search-mark';
const ACTIVE_MARK_CLASSES = ['!bg-orange-400', '!text-zinc-900'];

/** VSCode-style independent search toggles. */
export interface SearchOpts {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

interface ExecutionLogEntryRow {
  logChunk: string;
}

async function fetchExecutionLogLines(executionId: number): Promise<string[]> {
  const res = await fetch(`${API_BASE_URL}/agents/executions/${executionId}/logs?limit=2000`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { success: boolean; logs?: ExecutionLogEntryRow[] };
  if (!data.success || !data.logs) throw new Error('malformed response');
  return data.logs.flatMap((l) => l.logChunk.split('\n'));
}

/**
 * Compile the search query into a matcher regex, or null when the query is
 * empty / an invalid user regex (both mean "no active search").
 *
 * @param query - Raw query text from the header search box / 検索クエリ
 * @param opts - VSCode-style match toggles / 検索トグル
 * @returns Matcher regex or null / マッチャ正規表現（無効時 null）
 */
export function buildSearchMatcher(query: string, opts: SearchOpts): RegExp | null {
  const q = opts.useRegex ? query : query.trim();
  if (!q) return null;
  try {
    let src = opts.useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (opts.wholeWord) {
      // Whole-token match: not embedded inside a longer word/number run.
      // Unicode classes keep it meaningful for Japanese identifiers too.
      src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    }
    return new RegExp(src, `gu${opts.caseSensitive ? '' : 'i'}`);
  } catch {
    return null; // NOTE: invalid user regex is treated as "no search", not an error state.
  }
}

export interface PhaseTabPaneProps {
  iteration: PhaseIteration;
  filterWarnOnly: boolean;
  /** Debounced query from the header search box ('' = no search). */
  searchQuery: string;
  /** VSCode-style search toggles. */
  searchOpts: SearchOpts;
  /** 0-based index of the active match occurrence (header navigation). */
  activeMatchIndex: number;
  /** Reports the total number of match occurrences currently rendered. */
  onMatchCount?: (n: number) => void;
  /** True while this iteration is the currently-running one (drives tail follow). */
  isLive: boolean;
  /** Real-time SSE lines for the CURRENT execution (sliced from its start
   * banner by the parent) — null when this iteration is not live. */
  liveLogLines: string[] | null;
}

/**
 * @param iteration - The iteration whose logs to show / 表示する反復
 * @param filterWarnOnly - "⚠のみ" filter state / 警告のみフィルタ
 * @param searchQuery - Debounced search query / 検索クエリ
 * @param searchOpts - Search toggles / 検索トグル
 * @param activeMatchIndex - Active match to scroll to / アクティブな一致
 * @param onMatchCount - Occurrence-count reporter for the header / ヒット数通知
 * @param isLive - Whether this iteration is running / 実行中かどうか
 * @param liveLogLines - Real-time lines while running / ライブログ行
 */
export function PhaseTabPane({
  iteration,
  filterWarnOnly,
  searchQuery,
  searchOpts,
  activeMatchIndex,
  onMatchCount,
  isLive,
  liveLogLines,
}: PhaseTabPaneProps) {
  const t = useTranslations('phaseTimeline');
  // Machine log lines (Starting execution / Result / tool markers …) localize
  // through this translator — without it they render raw English and the
  // bubbles mix languages (operator feedback).
  const tLog = useTranslations('devMode.logTransformer');
  // Kept as per-execution groups: one iteration can bundle several executions
  // (continuation runs / uncertain boundaries), and the pane inserts a divider
  // between them so multi-run logs stay readable (operator feedback).
  const [fetchedLogs, setFetchedLogs] = useState<string[][] | null>(null);
  const [fetchError, setFetchError] = useState(false);
  // Whether the pane is scrolled to (near) the bottom — hides the 末尾へ button.
  const [atBottom, setAtBottom] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const updateAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 24);
  }, []);

  // Iteration switched (tab / repair selector) — drop the previous logs.
  const iterKey = iteration.executionIds.join(',');
  useEffect(() => {
    setFetchedLogs(null);
    setFetchError(false);
  }, [iterKey]);

  // Refresh persisted logs as the timeline advances, even when no SSE arrives.
  // Keep the previous snapshot visible while fetching; ignore stale responses
  // after switching execution or receiving a newer timeline snapshot.
  useEffect(() => {
    let cancelled = false;
    Promise.all(iteration.executionIds.map(fetchExecutionLogLines))
      .then((groups) => {
        if (!cancelled) {
          setFetchedLogs(groups);
          setFetchError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFetchError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- iterKey represents executionIds
  }, [iterKey, iteration.logLineCount, iteration.status, isLive]);

  // The model belongs IN the log (operator feedback), not in a separate meta
  // row. Newer executions store a "[Claude Code] Model: …" banner line; for
  // older ones synthesize an equivalent line from the timeline's modelName.
  const rawLogs = useMemo(() => {
    // Multi-execution iterations get a divider line between runs so the
    // concatenated logs stay readable per run.
    const total = fetchedLogs?.length ?? 0;
    // Divider only BETWEEN runs — a leading "実行 1/N" line is just noise.
    const storedFlat = (fetchedLogs ?? []).flatMap((group, i) =>
      total > 1 && i > 0 ? [t('runDivider', { n: i + 1, total }), ...group] : group,
    );
    // Live pane renders the SSE stream directly (real time). When the stream
    // contains this execution's start banner it is complete from the top;
    // otherwise (opened mid-run) prepend the stored catch-up base.
    let source: string[];
    if (isLive && liveLogLines) {
      const hasStartBanner = liveLogLines.some((l) => l.includes('Starting execution'));
      source = hasStartBanner ? liveLogLines : [...storedFlat, ...liveLogLines];
    } else {
      source = storedFlat;
    }
    // Normalize the runner-emitted "[Claude Code] Model: …" banner to the same
    // plain "Model: …" form as the synthesized line — one style everywhere.
    const logs = source.map((l) => l.replace(/^\[[^\]]+\] Model: /, 'Model: '));
    if (!iteration.modelName || logs.length === 0) return logs;
    const hasModelLine = logs.some((l) => l.includes('] Model: ') || l.startsWith('Model: '));
    if (hasModelLine) return logs;
    // Right after the "Starting execution" banner — same slot the newer
    // runner-emitted Model line occupies.
    const startIdx = logs.findIndex((l) => l.includes('Starting execution'));
    const at = startIdx >= 0 ? startIdx + 1 : 0;
    return [...logs.slice(0, at), `Model: ${iteration.modelName}`, ...logs.slice(at)];
  }, [fetchedLogs, isLive, liveLogLines, iteration.modelName, t]);
  const entries = useMemo(() => transformLogsToSimple(rawLogs, tLog), [rawLogs, tLog]);

  const matcher = useMemo(
    () => buildSearchMatcher(searchQuery, searchOpts),
    [searchQuery, searchOpts],
  );

  // Search never filters (VSCode semantics) — only the ⚠ quick-filter does.
  const filteredEntries = useMemo(
    () =>
      filterWarnOnly
        ? entries.filter((e) => e.category === 'error' || e.category === 'warning')
        : entries,
    [entries, filterWarnOnly],
  );

  // Wraps matches in <mark> — MARK_CLASS lets the navigation effect find them.
  const highlightText = useCallback(
    (text: string): React.ReactNode => {
      if (!matcher) return text;
      const g = new RegExp(matcher.source, matcher.flags);
      const parts: React.ReactNode[] = [];
      let last = 0;
      for (const m of text.matchAll(g)) {
        if (m.index === undefined || m[0] === '') break; // zero-length guard
        if (m.index > last) parts.push(text.slice(last, m.index));
        parts.push(
          <mark
            key={m.index}
            className={`${MARK_CLASS} rounded bg-yellow-600/50 px-0.5 text-yellow-200`}
          >
            {m[0]}
          </mark>,
        );
        last = m.index + m[0].length;
      }
      if (last === 0) return text;
      parts.push(text.slice(last));
      return parts;
    },
    [matcher],
  );

  // After render: count occurrences, style the active one, scroll it into view.
  useEffect(() => {
    const root = containerRef.current;
    const marks = root ? Array.from(root.getElementsByClassName(MARK_CLASS)) : [];
    onMatchCount?.(matcher ? marks.length : 0);
    marks.forEach((el, i) => {
      if (i === activeMatchIndex) el.classList.add(...ACTIVE_MARK_CLASSES);
      else el.classList.remove(...ACTIVE_MARK_CLASSES);
    });
    const active = marks[activeMatchIndex];
    if (active && matcher) active.scrollIntoView({ block: 'nearest' });
  }, [matcher, activeMatchIndex, filteredEntries, fetchedLogs, onMatchCount]);

  const { autoScroll, handleScroll, handleScrollStart, handleScrollEnd, scrollToBottom } =
    usePhaseLogStreaming(isLive ? rawLogs.length : 0, containerRef);
  // Drag-to-resize (restored from the pre-#785 viewer, same hook): the grip
  // below the pane adjusts and persists the log height.
  const resize = useResizableLogHeight(DEFAULT_PANE_HEIGHT);

  // Content or pane height changed — the bottom position may have moved.
  useEffect(() => {
    updateAtBottom();
  }, [filteredEntries, fetchedLogs, resize.height, updateAtBottom]);

  return (
    // Forced-dark terminal canvas: `.dark` (class-strategy variant) makes the
    // shared row styles resolve to their dark palette on every app theme.
    <div className="dark relative bg-zinc-950 font-mono">
      {fetchError ? (
        <div className="px-3 py-4 text-xs text-red-400">{t('loadFailed')}</div>
      ) : !isLive && fetchedLogs === null ? (
        <div className="px-3 py-4 text-xs text-zinc-500">{t('loadingDetail')}</div>
      ) : filteredEntries.length === 0 ? (
        <div className="px-3 py-4 text-xs text-zinc-500">{t('noLogsYet')}</div>
      ) : (
        <div
          ref={containerRef}
          onScroll={() => {
            if (isLive) handleScroll();
            updateAtBottom();
          }}
          style={{ height: resize.height }}
          className="overflow-y-auto px-1 py-1"
        >
          <SimpleLogEntryList
            entries={filteredEntries.slice(-MAX_RENDERED_ENTRIES)}
            searchQuery={matcher ? searchQuery : undefined}
            highlightText={highlightText}
          />
        </div>
      )}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('resizeLog')}
        aria-valuenow={resize.height}
        aria-valuemin={MIN_LOG_HEIGHT}
        tabIndex={0}
        onPointerDown={resize.onPointerDown}
        onPointerMove={resize.onPointerMove}
        onPointerUp={resize.onPointerUp}
        onKeyDown={resize.onKeyDown}
        className="group flex h-2.5 w-full cursor-ns-resize touch-none items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <div className="h-0.5 w-12 rounded-full bg-zinc-600 opacity-40 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </div>
      {filteredEntries.length > 0 && !(isLive && autoScroll) && !atBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          onMouseDown={handleScrollStart}
          onMouseUp={handleScrollEnd}
          className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-indigo-600 px-2.5 py-1 text-[11px] text-white shadow-lg hover:bg-indigo-500"
        >
          <ArrowDown className="h-3 w-3" />
          {t('scrollToBottom')}
        </button>
      )}
    </div>
  );
}
