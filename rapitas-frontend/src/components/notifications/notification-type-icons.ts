/**
 * Notification type icons and i18n resolution
 *
 * Maps `Notification.type` (a free-form string from the backend — see
 * `NotificationType` in notification-service.ts) to a lucide glyph/color pair
 * and resolves the displayed title/message from `metadata.i18n` when present,
 * falling back to the stored (legacy) title/message otherwise.
 */
import {
  AlarmClock,
  BadgeCheck,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  CircleOff,
  Eye,
  Files,
  FileText,
  GitFork,
  GitMerge,
  GitPullRequestArrow,
  Hammer,
  Hourglass,
  Layers3,
  Library,
  ListPlus,
  OctagonAlert,
  PlayCircle,
  PowerOff,
  SkipForward,
  Sunrise,
  Thermometer,
  TimerOff,
  TriangleAlert,
  Unlock,
  type LucideIcon,
} from 'lucide-react';

/** Color classes applied to the icon's circular background, keyed by notification type. */
const typeColors: Record<string, string> = {
  approval_request: 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400',
  task_created: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
  task_completed: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  agent_error: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  daily_summary: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
  pr_review_requested: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  pr_approved: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  pr_changes_requested: 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
  agent_execution_started: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400',
  agent_execution_complete: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  github_sync_complete: 'bg-gray-100 dark:bg-gray-900/30 text-gray-600 dark:text-gray-400',
  knowledge_extracted: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
  knowledge_reminder: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  memo_reminder: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
  daily_report: 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
  auto_run_awaiting_approval:
    'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  auto_run_awaiting_answer: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  auto_run_hang_backstop: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  auto_run_task_skipped: 'bg-gray-100 dark:bg-gray-900/30 text-gray-600 dark:text-gray-400',
  auto_run_task_vanished: 'bg-gray-100 dark:bg-gray-900/30 text-gray-600 dark:text-gray-400',
  auto_run_all_blocked: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  auto_run_stall_released: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400',
  auto_run_queue_starved: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  auto_run_zero_progress: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  auto_run_resource_hold:
    'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
  auto_run_all_done: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  auto_run_idle_stopped: 'bg-zinc-100 dark:bg-zinc-800/60 text-zinc-600 dark:text-zinc-300',
  blocked_escalation: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  blocked_escalation_needs_answer: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  auto_merge_success: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  auto_merge_failed: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  auto_merge_timeout: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  auto_merge_exhausted: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  auto_merge_ci_failed: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  auto_merge_ci_repair: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400',
  auto_merge_ci_repair_no_diff:
    'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  auto_merge_conflict_filed:
    'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
  auto_merge_conflict_unresolved: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  base_sync_conflict_unresolved: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  base_sync_reverify_failed: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  duplicate_open_prs: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  pr_ci_completed: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  auto_pr_created: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
  auto_pr_merged: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  auto_pr_merge_failed: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  auto_pr_identity_mismatch:
    'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
  auto_pr_draft_unknown: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  auto_merge_awaiting_approval:
    'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  system: 'bg-gray-100 dark:bg-gray-900/30 text-gray-600 dark:text-gray-400',
};

/** Fallback color for types with no explicit mapping — neutral, matches the Bell fallback icon. */
const FALLBACK_COLOR = 'bg-gray-100 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400';

/**
 * Lucide glyph per notification type — see ICON_POLICY.md §3 for the meaning
 * each glyph owns project-wide.
 */
const typeIconComponents: Record<string, LucideIcon> = {
  approval_request: BadgeCheck,
  task_created: ListPlus,
  task_completed: Check,
  agent_error: TriangleAlert,
  daily_summary: FileText,
  pr_review_requested: Eye,
  knowledge_extracted: Library,
  knowledge_reminder: BookOpen,
  memo_reminder: AlarmClock,
  agent_execution_started: PlayCircle,
  daily_report: Sunrise,
  auto_run_awaiting_approval: Hourglass,
  auto_run_awaiting_answer: Hourglass,
  auto_run_hang_backstop: TimerOff,
  auto_run_task_skipped: SkipForward,
  auto_run_task_vanished: Bell,
  auto_run_all_blocked: OctagonAlert,
  auto_run_stall_released: Unlock,
  auto_run_queue_starved: Layers3,
  auto_run_zero_progress: CircleOff,
  auto_run_resource_hold: Thermometer,
  auto_run_all_done: CheckCircle2,
  auto_run_idle_stopped: PowerOff,
  blocked_escalation: OctagonAlert,
  blocked_escalation_needs_answer: OctagonAlert,
  auto_merge_success: GitMerge,
  auto_merge_failed: CircleAlert,
  auto_merge_timeout: CircleAlert,
  auto_merge_exhausted: CircleAlert,
  auto_merge_ci_failed: CircleAlert,
  auto_merge_ci_repair: Hammer,
  auto_merge_ci_repair_no_diff: Hammer,
  auto_merge_conflict_filed: GitFork,
  auto_merge_conflict_unresolved: GitFork,
  base_sync_conflict_unresolved: GitFork,
  base_sync_reverify_failed: GitFork,
  duplicate_open_prs: Files,
  pr_ci_completed: CheckCircle2,
  auto_pr_created: GitPullRequestArrow,
  auto_pr_merged: GitMerge,
  auto_pr_merge_failed: CircleAlert,
  auto_pr_identity_mismatch: CircleAlert,
  auto_pr_draft_unknown: CircleHelp,
  auto_merge_awaiting_approval: Hourglass,
};

/** Icon + background color for a notification's circular badge. */
export interface NotificationIconResolution {
  Icon: LucideIcon;
  colorClass: string;
}

/**
 * Resolve the icon and color for a notification type. Types rendered by the
 * inline-SVG branches in `NotificationContent` (the original 9) are not in
 * `typeIconComponents` — callers there should skip this resolver. Unknown
 * types fall back to a neutral Bell so no notification is ever iconless.
 *
 * @param type - `Notification.type` value. / 通知タイプ
 * @returns The glyph component and its background color class. / グリフと背景色クラス
 */
export function resolveNotificationIcon(
  type: string | undefined | null,
): NotificationIconResolution {
  const Icon = (type && typeIconComponents[type]) || Bell;
  const colorClass = (type && typeColors[type]) || FALLBACK_COLOR;
  return { Icon, colorClass };
}

/** i18n pointer stored in `Notification.metadata.i18n` — see notification-i18n.ts (backend). */
export interface NotificationI18nRef {
  key: string;
  /** ICU MessageFormat only accepts these value types — matches next-intl's Translator signature. */
  params?: Record<string, string | number | Date>;
}

/**
 * Extract `metadata.i18n` from a notification's metadata field, tolerating
 * both the raw DB JSON string and an already-parsed object (mirrors
 * `extractMemoId` in useBrowserNotifications.ts).
 *
 * @param metadata - Notification metadata as stored/received. / 通知メタデータ
 * @returns The i18n pointer, or null when absent/unparseable. / i18n参照(無ければnull)
 */
export function extractNotificationI18n(
  metadata: string | Record<string, unknown> | null | undefined,
): NotificationI18nRef | null {
  try {
    const obj = typeof metadata === 'string' ? (JSON.parse(metadata) as unknown) : metadata;
    const i18n = (obj as { i18n?: unknown } | null | undefined)?.i18n;
    if (!i18n || typeof i18n !== 'object') return null;
    const key = (i18n as { key?: unknown }).key;
    if (typeof key !== 'string' || key.length === 0) return null;
    const params = (i18n as { params?: unknown }).params;
    return {
      key,
      params:
        params && typeof params === 'object'
          ? (params as Record<string, string | number | Date>)
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Resolved display text for a notification. */
export interface ResolvedNotificationText {
  title: string;
  message: string;
}

/**
 * Resolve a notification's displayed title/message: translated via
 * `metadata.i18n` when present (re-renders on locale change), otherwise the
 * stored (legacy) title/message untouched.
 *
 * @param t - next-intl translator for the `notification` namespace. / 翻訳関数
 * @param notification - Notification fields needed to resolve text. / 対象通知
 * @returns The title/message to render. / 表示用タイトルとメッセージ
 */
export function resolveNotificationText(
  t: (key: string, params?: Record<string, string | number | Date>) => string,
  notification: {
    title: string;
    message: string;
    metadata?: string | Record<string, unknown> | null;
  },
): ResolvedNotificationText {
  const i18n = extractNotificationI18n(notification.metadata);
  if (!i18n || !i18n.key.endsWith('.title')) {
    return { title: notification.title, message: notification.message };
  }
  // The backend stores the FULL path (notification.types.x.title) while `t`
  // is already scoped to the `notification` namespace — passing it unchanged
  // resolved notification.notification.types... and rendered the raw key.
  const titleKey = i18n.key.replace(/^notification\./, '');
  const messageKey = titleKey.replace(/\.title$/, '.message');
  try {
    const title = t(titleKey, i18n.params);
    const message = t(messageKey, i18n.params);
    // next-intl returns the key path (no throw) on a missing message — fall
    // back to the stored strings instead of showing the raw key to the user.
    if (title.includes('.title') || message.includes('.message')) {
      return { title: notification.title, message: notification.message };
    }
    return { title, message };
  } catch {
    return { title: notification.title, message: notification.message };
  }
}
