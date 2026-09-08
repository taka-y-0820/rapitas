'use client';

/**
 * phase-timeline/PhaseTimeline
 *
 * Tabbed execution-log view (task #796, redesigned from #785's accordion on
 * operator feedback: expanding every section was tedious and tall). One tab
 * per phase, the running phase auto-selected, logs rendered as a forced-dark
 * terminal. Falls back to a flat log list when the backend has no phase data
 * for this task (manual non-workflow runs).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Terminal,
  Search,
  X,
  CheckCircle2,
  OctagonAlert,
  Square,
  CaseSensitive,
  WholeWord,
  Regex,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { SimpleLogEntryList } from '../simple-log-entry/simple-log-entry';
import { transformLogsToSimple } from '../../utils/log-message-transformer';
import { usePhaseTimeline } from '../../hooks/usePhaseTimeline';
import type { PhaseType } from '../../utils/phase-selector';
import { PhaseTabBar, type PhaseTabInfo } from './PhaseTabBar';
import { PhaseTabPane, type SearchOpts } from './PhaseTabPane';

const POLL_INTERVAL_MS = 5000;
const SEARCH_DEBOUNCE_MS = 200;

export interface PhaseTimelineProps {
  taskId: number;
  isRunning: boolean;
  /** Raw flat live log lines from useExecutionManager, fed to the running iteration's pane. */
  liveLogs: string[];
}

/**
 * @param taskId - Task whose execution log to render / タスクID
 * @param isRunning - Whether the task's agent is currently executing (drives polling + live tail) / 実行中かどうか
 * @param liveLogs - Raw live log lines forwarded to the running pane / ライブログ行
 */
export function PhaseTimeline({ taskId, isRunning, liveLogs }: PhaseTimelineProps) {
  const t = useTranslations('phaseTimeline');
  // Reuse the original log-viewer header title (実行ログ) so the tabbed view
  // keeps the pre-#785 header composition.
  const tHeader = useTranslations('devMode.logViewerHeader');
  // Localizes machine log lines in the flat fallback views (same translator
  // the pane uses — keeps bubble language uniform).
  const tLog = useTranslations('devMode.logTransformer');
  const { phases, taskStatus, plannedMode, loading, refetch } = usePhaseTimeline(taskId);
  const [filterWarnOnly, setFilterWarnOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchOpts, setSearchOpts] = useState<SearchOpts>({
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
  });
  const [matchTotal, setMatchTotal] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const [selectedPhase, setSelectedPhase] = useState<PhaseType | null>(null);
  const [selectedIteration, setSelectedIteration] = useState<number | null>(null);
  // Once the user picks a tab by hand, stop auto-following the running phase
  // until they jump back ("実行中へ").
  const manualNavRef = useRef(false);

  const hasRunningPhase = phases.some((phase) =>
    phase.iterations.some((iteration) => iteration.status === 'running'),
  );

  useEffect(() => {
    if (!isRunning && !hasRunningPhase) {
      // Run just ended — one more fetch so the header badge shows the final
      // task status instead of the last mid-run poll's snapshot.
      void refetch();
      return;
    }
    const interval = setInterval(() => void refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isRunning, hasRunningPhase, refetch]);

  // Debounce so the (potentially large) highlight pass doesn't run per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // New query/toggles/tab — restart match navigation from the first hit.
  useEffect(() => {
    setActiveMatch(0);
  }, [debouncedQuery, searchOpts, selectedPhase, selectedIteration]);

  const runningPhase = useMemo<PhaseType | null>(() => {
    for (const phase of phases) {
      if (phase.iterations.some((it) => it.status === 'running')) return phase.phaseType;
    }
    return null;
  }, [phases]);

  // Real-time tail for the CURRENT execution: the raw SSE stream spans the
  // whole session, so slice from the last start banner (each execution —
  // including repair retries — emits its own).
  const liveTail = useMemo(() => {
    for (let i = liveLogs.length - 1; i >= 0; i--) {
      if (liveLogs[i].includes('Starting execution')) return liveLogs.slice(i);
    }
    return liveLogs;
  }, [liveLogs]);

  // Auto-follow: select the running phase (or the last phase with data) while
  // the user hasn't navigated manually.
  useEffect(() => {
    if (manualNavRef.current) return;
    const target = runningPhase ?? phases[phases.length - 1]?.phaseType ?? null;
    if (target && target !== selectedPhase) {
      setSelectedPhase(target);
      setSelectedIteration(null);
    }
  }, [runningPhase, phases, selectedPhase]);

  // NOTE: Task.status vocabulary is done/todo/in-progress/blocked/cancelled
  // (hyphenated) — normalize before matching.
  const normalizedStatus = (taskStatus ?? '').replace('-', '_');
  const isTerminalStatus = ['done', 'completed', 'cancelled'].includes(normalizedStatus);

  // Full expected tab strip from the planned mode (complexity staging):
  // phases that haven't run yet appear as pending tabs while the task is
  // still active, so the strip is visible from the moment complexity lands.
  const tabs = useMemo<PhaseTabInfo[]>(() => {
    const expected: PhaseType[] =
      plannedMode === 'lightweight'
        ? ['research', 'implement', 'verify']
        : ['research', 'plan', 'implement', 'verify'];
    const actual = new Map(phases.map((p) => [p.phaseType, p]));
    const list: PhaseTabInfo[] = [];
    for (const phaseType of expected) {
      const seg = actual.get(phaseType);
      if (seg) {
        list.push({
          phaseType,
          latestStatus: seg.iterations[seg.iterations.length - 1]?.status ?? 'completed',
          iterationCount: seg.iterations.length,
        });
      } else if (!isTerminalStatus) {
        list.push({ phaseType, latestStatus: 'pending', iterationCount: 0 });
      }
    }
    // Safety: keep any actual phase the expected list didn't predict.
    for (const p of phases) {
      if (!list.some((tab) => tab.phaseType === p.phaseType)) {
        list.push({
          phaseType: p.phaseType,
          latestStatus: p.iterations[p.iterations.length - 1]?.status ?? 'completed',
          iterationCount: p.iterations.length,
        });
      }
    }
    return list;
  }, [phases, plannedMode, isTerminalStatus]);

  const currentPhase = phases.find((p) => p.phaseType === selectedPhase) ?? null;
  const iterations = currentPhase?.iterations ?? [];
  // Default to the running iteration, else the latest.
  const activeIterationNumber =
    selectedIteration ??
    iterations.find((it) => it.status === 'running')?.iterationNumber ??
    iterations[iterations.length - 1]?.iterationNumber ??
    1;
  const activeIteration =
    iterations.find((it) => it.iterationNumber === activeIterationNumber) ?? null;

  const paneIsLive =
    isRunning && currentPhase?.phaseType === runningPhase && activeIteration?.status === 'running';

  const handleMatchCount = useCallback((n: number) => {
    setMatchTotal(n);
    setActiveMatch((a) => (n === 0 ? 0 : Math.min(a, n - 1)));
  }, []);

  const goNextMatch = useCallback(
    () => setActiveMatch((a) => (matchTotal === 0 ? 0 : (a + 1) % matchTotal)),
    [matchTotal],
  );
  const goPrevMatch = useCallback(
    () => setActiveMatch((a) => (matchTotal === 0 ? 0 : (a - 1 + matchTotal) % matchTotal)),
    [matchTotal],
  );

  const toggleOpt = (key: keyof SearchOpts) => setSearchOpts((o) => ({ ...o, [key]: !o[key] }));

  if (loading && phases.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
        <Spinner size="sm" />
        {t('loadingDetail')}
      </div>
    );
  }

  // No phase data AND nothing running — flat fallback (manual non-workflow
  // runs). While running, the tab strip renders from the planned mode instead
  // and the pane shows the live stream in real time.
  if (phases.length === 0 && !isRunning) {
    const entries = transformLogsToSimple(liveLogs, tLog);
    return <SimpleLogEntryList entries={entries} />;
  }

  // Header badge from TASK status: 進行中 until every flow is done — a phase
  // finishing must not flip the badge to 完了 (operator feedback).
  // NOTE: Task.status vocabulary is done/todo/in-progress/blocked/cancelled
  // (hyphenated) — normalize before matching.
  const effectiveStatus = taskStatus ? normalizedStatus : runningPhase ? 'in_progress' : 'done';
  const statusBadge =
    effectiveStatus === 'done' || effectiveStatus === 'completed' ? (
      <span className="flex items-center gap-1 rounded bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
        <CheckCircle2 className="h-3 w-3" />
        {t('statusLabel.completed')}
      </span>
    ) : effectiveStatus === 'blocked' ? (
      <span className="flex items-center gap-1 rounded bg-orange-500/20 px-2 py-0.5 text-xs text-orange-400">
        <OctagonAlert className="h-3 w-3" />
        {t('statusLabel.blocked')}
      </span>
    ) : effectiveStatus === 'cancelled' ? (
      <span className="flex items-center gap-1 rounded bg-zinc-500/20 px-2 py-0.5 text-xs text-zinc-400">
        <Square className="h-3 w-3" />
        {t('statusLabel.cancelled')}
      </span>
    ) : (
      <span className="flex items-center gap-1.5 rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-400">
        <span
          className={`h-1.5 w-1.5 rounded-full bg-blue-400 ${runningPhase ? 'animate-pulse' : ''}`}
        />
        {t('statusLabel.inProgress')}
      </span>
    );

  const searchToggles: Array<{
    key: keyof SearchOpts;
    Icon: typeof CaseSensitive;
    label: string;
  }> = [
    { key: 'caseSensitive', Icon: CaseSensitive, label: t('searchToggle.caseSensitive') },
    { key: 'wholeWord', Icon: WholeWord, label: t('searchToggle.wholeWord') },
    { key: 'useRegex', Icon: Regex, label: t('searchToggle.regex') },
  ];

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
      {/* Header: 実行ログ title + task status badge, VSCode-style search right */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-700/70 bg-zinc-800 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 shrink-0 text-green-400" />
          <span className="text-sm font-medium text-zinc-200">{tHeader('title')}</span>
          {statusBadge}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchQuery('');
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (e.shiftKey) goPrevMatch();
                  else goNextMatch();
                }
              }}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className="w-64 rounded border border-zinc-600 bg-zinc-900 py-1 pl-7 pr-[5.5rem] text-xs text-zinc-200 transition-all placeholder:text-zinc-500 focus:w-80 focus:border-indigo-400 focus:outline-none"
            />
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-500" />
            <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
              {searchToggles.map(({ key, Icon, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleOpt(key)}
                  aria-pressed={searchOpts[key]}
                  aria-label={label}
                  title={label}
                  className={`rounded p-0.5 ${
                    searchOpts[key]
                      ? 'bg-indigo-500/40 text-indigo-200'
                      : 'text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label={t('clearSearch')}
                  className="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          {debouncedQuery.trim() !== '' && (
            <span
              className={`whitespace-nowrap font-mono text-[11px] ${
                matchTotal > 0 ? 'text-zinc-400' : 'text-amber-400'
              }`}
            >
              {matchTotal > 0 ? `${activeMatch + 1}/${matchTotal}` : t('noResults')}
            </span>
          )}
          <button
            type="button"
            onClick={goPrevMatch}
            disabled={matchTotal === 0}
            aria-label={t('prevMatch')}
            title={t('prevMatch')}
            className="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-30"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={goNextMatch}
            disabled={matchTotal === 0}
            aria-label={t('nextMatch')}
            title={t('nextMatch')}
            className="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-30"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {manualNavRef.current && runningPhase && selectedPhase !== runningPhase && (
            <button
              type="button"
              onClick={() => {
                manualNavRef.current = false;
                setSelectedPhase(runningPhase);
                setSelectedIteration(null);
              }}
              className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500"
            >
              {t('jumpToRunning')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setFilterWarnOnly(false)}
            aria-pressed={!filterWarnOnly}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              !filterWarnOnly ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            {t('filter.all')}
          </button>
          <button
            type="button"
            onClick={() => setFilterWarnOnly(true)}
            aria-pressed={filterWarnOnly}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              filterWarnOnly ? 'bg-amber-500 text-white' : 'text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            {t('filter.warnOnly')}
          </button>
        </div>
      </div>

      <div className="bg-zinc-900">
        <PhaseTabBar
          tabs={tabs}
          selected={selectedPhase ?? tabs[0]?.phaseType ?? 'research'}
          onSelect={(phase) => {
            manualNavRef.current = phase !== runningPhase;
            setSelectedPhase(phase);
            setSelectedIteration(null);
          }}
        />
      </div>

      {iterations.length > 1 && (
        <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-3 py-1">
          {iterations.map((it) => (
            <button
              key={it.iterationNumber}
              type="button"
              onClick={() => setSelectedIteration(it.iterationNumber)}
              aria-pressed={it.iterationNumber === activeIterationNumber}
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                it.iterationNumber === activeIterationNumber
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
              }`}
            >
              {t('iterationChip', { n: it.iterationNumber })}
            </button>
          ))}
        </div>
      )}

      {activeIteration ? (
        <PhaseTabPane
          iteration={activeIteration}
          filterWarnOnly={filterWarnOnly}
          searchQuery={debouncedQuery}
          searchOpts={searchOpts}
          activeMatchIndex={activeMatch}
          onMatchCount={handleMatchCount}
          isLive={paneIsLive === true}
          liveLogLines={paneIsLive ? liveTail : null}
        />
      ) : (
        // Pending tab, or the pre-first-execution window: show the live
        // stream when nothing is segmented yet, else a placeholder.
        <div className="dark bg-zinc-950 font-mono">
          {phases.length === 0 && isRunning && liveTail.length > 0 ? (
            <div className="max-h-[340px] overflow-y-auto px-1 py-1">
              <SimpleLogEntryList entries={transformLogsToSimple(liveTail, tLog)} />
            </div>
          ) : (
            <div className="px-3 py-4 text-xs text-zinc-500">{t('noLogsYet')}</div>
          )}
        </div>
      )}
    </div>
  );
}
