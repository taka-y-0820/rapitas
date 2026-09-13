'use client';
/**
 * header/header.tsx
 *
 * Main Header orchestrator component.
 * Composes the sticky top bar, slide-out side navigation panel,
 * and restart dialogs. All state logic lives in useHeader().
 */

import {
  Menu,
  X,
  Home,
  Tags,
  SwatchBook,
  LayoutList,
  LayoutDashboard,
  Folders,
  FolderGit2,
  ScrollText,
  Milestone,
  BarChart3,
  GanttChartSquare,
  FileText,
  FileCog,
  Calendar,
  CalendarRange,
  CalendarClock,
  Clock,
  GraduationCap,
  Bot,
  Settings,
  UserCog,
  Archive,
  GitPullRequest,
  CircleDot,
  GitMerge,
  Code,
  MessageSquare,
  Lightbulb,
  Bug,
  Inbox,
  NotebookTabs,
  NotepadText,
  Package,
  Beaker,
  Sprout,
  Sunrise,
  Library,
  Search,
  Workflow,
  WalletCards,
  ChartNoAxesCombined,
  ChartScatter,
  ScanSearch,
} from 'lucide-react';
import Link from 'next/link';
import AppIcon from '@/components/common/app-icon';
import { useTranslations } from 'next-intl';
import { useHeader } from './useHeader';
import { type NavItem } from './types';
import { GithubMarkIcon } from '@/components/icons/github-mark-icon';
import { SideNav } from './side-nav';
import { HeaderSearch } from './header-search';
import { HeaderToolbar } from './header-toolbar';
import { RestartDialogs } from './restart-dialogs';

/**
 * Sticky application header with a hamburger-triggered side navigation panel.
 */
export default function Header() {
  const h = useHeader();
  const t = useTranslations('nav');
  const tTask = useTranslations('task');

  if (h.hideHeader || (h.isTaskDetailPage && !h.showHeader)) {
    return null;
  }

  const navItems: NavItem[] = [
    {
      href: '/',
      label: t('taskList'),
      icon: Home,
      shortcut: h.getShortcutLabel('home'),
      children: [
        { href: '/gantt', label: tTask('ganttView.title'), icon: GanttChartSquare },
        {
          href: '#',
          label: t('category'),
          icon: LayoutList,
          children: [
            {
              href: '/categories',
              label: t('categoryList'),
              icon: Folders,
            },
            { href: '/themes', label: t('themeList'), icon: SwatchBook },
            { href: '/labels', label: t('labelList'), icon: Tags },
          ],
        },
      ],
    },
    {
      href: '#',
      label: t('backlog'),
      icon: Inbox,
      children: [
        { href: '/ideas', label: t('ideas'), icon: Lightbulb },
        { href: '/concerns', label: t('concerns'), icon: Bug },
        { href: '/hypotheses', label: t('hypotheses'), icon: Beaker },
        { href: '/backlog/settings', label: t('settings'), icon: CalendarClock },
      ],
    },
    {
      href: '/dashboard',
      label: t('dashboard'),
      icon: LayoutDashboard,
      shortcut: h.getShortcutLabel('dashboard'),
    },
    {
      href: '/notes',
      label: t('notes'),
      icon: NotebookTabs,
    },
    {
      href: '/memos',
      label: t('memos'),
      icon: NotepadText,
    },
    {
      href: '#',
      label: t('learning'),
      icon: GraduationCap,
      children: [
        {
          href: '/learning-roadmap',
          label: t('learningRoadmap'),
          icon: Milestone,
        },
        { href: '/vocabulary', label: t('vocabulary'), icon: WalletCards },
      ],
    },
    {
      href: '#',
      label: t('habitsAchievements'),
      icon: CalendarRange,
      children: [
        {
          href: '/calendar',
          label: t('calendar'),
          icon: Calendar,
          shortcut: h.getShortcutLabel('calendar'),
        },
        {
          href: '/habits/daily-schedule',
          label: t('dailySchedule'),
          icon: Clock,
        },
        { href: '/reports', label: t('weeklyReport'), icon: FileText },
      ],
    },
    {
      href: '#',
      label: t('development'),
      icon: Code,
      children: [
        {
          href: '#',
          label: 'GitHub',
          icon: GithubMarkIcon,
          children: [
            { href: '/github', label: t('devDashboard'), icon: FolderGit2 },
            {
              href: '/github/pull-requests',
              label: 'Pull Requests',
              icon: GitPullRequest,
            },
            { href: '/github/issues', label: 'Issues', icon: CircleDot },
            { href: '/github/actions', label: 'CI/CD', icon: GitMerge },
          ],
        },
        { href: '/logs', label: t('logAnalysis'), icon: ScrollText },
        {
          href: '#',
          label: t('agent'),
          icon: Bot,
          children: [
            // NOTE: UserCog, not Settings — the gear glyph is owned by 設定
            // (ICON_POLICY: one glyph, one meaning app-wide).
            { href: '/agents', label: t('agentManagement'), icon: UserCog },
            {
              href: '/agents/execution-dashboard',
              label: t('executionDashboard'),
              icon: Workflow,
            },
            { href: '/agents/metrics', label: t('metrics'), icon: BarChart3 },
            // NOTE: Sunrise = 自律活動デイリーレポート (ICON_POLICY §3) — the
            // same glyph is reused on the /agents/daily-report page (same
            // concept). /agents/growth is owned by the growth ledger below.
            {
              href: '/agents/daily-report',
              label: t('growthReport'),
              icon: Sunrise,
            },
            {
              href: '/agents/memory',
              label: t('memoryVisualization'),
              icon: Sprout,
            },
            {
              href: '/agents/growth',
              label: t('growthLedger'),
              icon: ChartNoAxesCombined,
            },
            // NOTE: ChartScatter = 効率フロンティア (ICON_POLICY glyphs-a-f) — the
            // same glyph is reused on the /agents/pareto page (same concept).
            {
              href: '/agents/pareto',
              label: t('paretoFrontier'),
              icon: ChartScatter,
            },
            // NOTE: ScanSearch = 検出漏れ兆候の学習・レビュー (ICON_POLICY §3).
            {
              href: '/agents/miss-signatures',
              label: t('missSignatures'),
              icon: ScanSearch,
            },
            {
              href: '#',
              label: t('knowledgeBase'),
              icon: Library,
              children: [
                {
                  href: '/knowledge',
                  label: t('knowledgeBrowser'),
                  icon: Search,
                },
                {
                  href: '/knowledge/contradictions',
                  label: t('contradictions'),
                  icon: NotebookTabs,
                },
                {
                  href: '/knowledge/admin',
                  label: t('memoryAdmin'),
                  // NOTE: Archive, not Settings — the page administers the KB's
                  // validation/forgetting (archival) lifecycle, and the gear
                  // glyph is owned by 設定.
                  icon: Archive,
                },
              ],
            },
          ],
        },
        {
          href: '/system-prompts',
          label: t('promptManagement'),
          icon: MessageSquare,
        },
        {
          href: '/claude-md-generator',
          label: t('claudeGeneration'),
          icon: FileCog,
        },
        { href: '/settings/cli-tools', label: t('cliTools'), icon: Package },
      ],
    },
    {
      // Single entry into the unified settings hub; sub-sections (general /
      // API keys / task automation / shortcuts / CLI tools) are the hub's tabs.
      href: '/settings/general',
      label: t('settings'),
      icon: Settings,
    },
  ];

  const filteredNavItems = navItems;

  return (
    <>
      {/* z-110: above the task slide panel (z-50) and side nav (z-100) so header
          menus are never hidden behind them, but below modal dialogs (z-200). */}
      <header className="sticky top-0 z-110 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-indigo-dark-900">
        <div className="flex items-center justify-between h-16 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => h.setIsMenuOpen(!h.isMenuOpen)}
              className="p-2 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              aria-label={t('openMenu')}
            >
              {h.isMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>

            <Link href="/" className="flex items-center gap-2 group">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center w-8 h-8 bg-indigo-500 rounded-lg">
                  <AppIcon size={20} className="text-white" />
                </div>
                <span className="text-lg font-bold text-indigo-600 dark:text-indigo-400">
                  Rapi+
                </span>
              </div>
            </Link>
          </div>

          <HeaderSearch
            searchQuery={h.searchQuery}
            setSearchQuery={h.setSearchQuery}
            handleSearchKeyDown={h.handleSearchKeyDown}
            debounceTimerRef={h.debounceTimerRef}
          />

          <HeaderToolbar
            hasMounted={h.hasMounted}
            isAuthLoading={h.isAuthLoading}
            isAuthenticated={h.isAuthenticated}
            user={h.user}
            isUserMenuOpen={h.isUserMenuOpen}
            setIsUserMenuOpen={h.setIsUserMenuOpen}
            userMenuRef={h.userMenuRef}
            handleLogout={h.handleLogout}
            isMoreMenuOpen={h.isMoreMenuOpen}
            setIsMoreMenuOpen={h.setIsMoreMenuOpen}
            moreMenuRef={h.moreMenuRef}
            isDarkMode={h.isDarkMode}
            darkModeMounted={h.darkModeMounted}
            toggleTheme={h.toggleTheme}
            isTauriEnv={h.isTauriEnv}
            isRestarting={h.isRestarting}
            handleRestartClick={h.handleRestartClick}
          />
        </div>
      </header>

      <SideNav
        menuRef={h.menuRef}
        isMenuOpen={h.isMenuOpen}
        isMenuPinned={h.isMenuPinned}
        setIsMenuPinned={h.setIsMenuPinned}
        setIsMenuOpen={h.setIsMenuOpen}
        filteredNavItems={filteredNavItems}
        expandedItems={h.expandedItems}
        toggleExpand={h.toggleExpand}
        getShortcutLabel={h.getShortcutLabel}
      />

      <RestartDialogs
        restartConfirmDialog={h.restartConfirmDialog}
        setRestartConfirmDialog={h.setRestartConfirmDialog}
        executeRestart={h.executeRestart}
        isRestarting={h.isRestarting}
      />

      <style jsx global>{`
        .line-animate-vertical {
          transform-origin: top;
          transform: scaleY(0);
          animation: draw-vertical var(--line-duration, 0.22s) ease-out forwards;
          animation-delay: var(--line-delay, 0s);
          will-change: transform;
        }

        .line-animate-horizontal {
          transform-origin: left;
          transform: scaleX(0);
          animation: draw-horizontal var(--line-duration, 0.22s) ease-out forwards;
          animation-delay: calc(var(--line-delay, 0s) + var(--line-stagger, 0.12s));
          will-change: transform;
        }

        @keyframes draw-vertical {
          from {
            transform: scaleY(0);
          }
          to {
            transform: scaleY(1);
          }
        }

        @keyframes draw-horizontal {
          from {
            transform: scaleX(0);
          }
          to {
            transform: scaleX(1);
          }
        }
      `}</style>
    </>
  );
}
