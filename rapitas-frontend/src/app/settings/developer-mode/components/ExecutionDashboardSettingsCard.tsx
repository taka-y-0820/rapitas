'use client';
// ExecutionDashboardSettingsCard

import { Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { UserSettings } from '@/types';

interface ExecutionDashboardSettingsCardProps {
  settings: UserSettings | null;
  isSaving: boolean;
  onUpdateSettings: (updates: Partial<UserSettings>) => void;
}

/**
 * Settings for the execution visualization dashboard (task 870): the
 * no-progress threshold (minutes) after which a task is flagged stalled.
 * Split out of AutoRunSettingsCard.tsx (already at the 301-500 line
 * split-at-next-edit band — see COMPONENT_SPLITTING_POLICY.md).
 *
 * @param settings - Current user settings. / 現在のユーザー設定
 * @param isSaving - Whether a save is in progress. / 保存中かどうか
 * @param onUpdateSettings - Callback to persist a partial update. / 部分更新を保存するコールバック
 */
export function ExecutionDashboardSettingsCard({
  settings,
  isSaving,
  onUpdateSettings,
}: ExecutionDashboardSettingsCardProps) {
  const t = useTranslations('settings.executionDashboardSettingsCard');
  const tSettings = useTranslations('settings');

  // Same local-state + blur-commit pattern as AutoRunSettingsCard's fields
  // (typing must not be interrupted by a per-keystroke PATCH mid-save).
  const serverThreshold = settings?.executionStallThresholdMinutes ?? 5;
  const [localThreshold, setLocalThreshold] = useState<number | ''>(serverThreshold);

  useEffect(() => {
    setLocalThreshold(serverThreshold);
  }, [serverThreshold]);

  const commit = () => {
    const clamped = localThreshold === '' ? 5 : Math.max(1, Math.min(120, localThreshold));
    setLocalThreshold(clamped);
    if (clamped !== serverThreshold) {
      onUpdateSettings({ executionStallThresholdMinutes: clamped });
    }
  };

  return (
    <div className="mt-8 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-indigo-dark-900">
      <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <Workflow className="h-5 w-5 text-violet-500" />
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">{t('title')}</h2>
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t('description')}</p>
      </div>
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium text-zinc-900 dark:text-zinc-50">{t('thresholdLabel')}</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {t('thresholdDescription')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={120}
              aria-label={t('thresholdLabel')}
              value={localThreshold}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setLocalThreshold('');
                  return;
                }
                const num = Number(raw);
                if (Number.isNaN(num)) return;
                setLocalThreshold(num);
              }}
              onBlur={commit}
              className="w-16 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-center text-sm text-zinc-900 focus:border-indigo-400 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50"
            />
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              {t('thresholdUnit')}
              {isSaving ? tSettings('autoRunSettingsCard.savingSuffix') : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
