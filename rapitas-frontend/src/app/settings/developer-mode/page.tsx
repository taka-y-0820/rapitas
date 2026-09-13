'use client';
// DeveloperModeSettingsPage

import { Bot, AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDeveloperModeSettings } from './hooks/useDeveloperModeSettings';
import { TaskCreationSettingsCard } from './components/TaskCreationSettingsCard';
import { AutoRunSettingsCard } from './components/AutoRunSettingsCard';
import { ExecutionDashboardSettingsCard } from './components/ExecutionDashboardSettingsCard';
import { AutoResumeSettingsCard } from './components/AutoResumeSettingsCard';
import { WorkflowConfigCard } from './components/WorkflowConfigCard';
import { AutoMergeSettingsCard } from './components/AutoMergeSettingsCard';
import { TaskCleanupSection } from '../_components/TaskCleanupSection';
import { CiTimingDashboard } from './components/CiTimingDashboard';

export default function DeveloperModeSettingsPage() {
  const t = useTranslations('settings');
  const {
    settings,
    isLoading,
    isSaving,
    isSavingAutoResume,
    error,
    localDelay,
    updateSettings,
    toggleAutoResume,
    handleDelayChange,
    handleDelayBlur,
  } = useDeveloperModeSettings();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center gap-3 mb-8">
        <div className="p-2.5 bg-indigo-100 dark:bg-indigo-900/30 rounded-xl">
          <Bot className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            {t('devModeTitle')}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('devModeSubtitle')}</p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertCircle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        </div>
      )}

      <div className="space-y-6">
        <TaskCreationSettingsCard
          settings={settings}
          isSaving={isSaving}
          localDelay={localDelay}
          onUpdateSettings={updateSettings}
          onDelayChange={handleDelayChange}
          onDelayBlur={handleDelayBlur}
        />

        <AutoRunSettingsCard
          settings={settings}
          isSaving={isSaving}
          onUpdateSettings={updateSettings}
        />

        <ExecutionDashboardSettingsCard
          settings={settings}
          isSaving={isSaving}
          onUpdateSettings={updateSettings}
        />

        <AutoResumeSettingsCard
          settings={settings}
          isSaving={isSavingAutoResume}
          onToggle={toggleAutoResume}
        />

        <WorkflowConfigCard
          settings={settings}
          isSaving={isSaving}
          onUpdateSettings={updateSettings}
        />

        <AutoMergeSettingsCard
          settings={settings}
          isSaving={isSaving}
          onUpdateSettings={updateSettings}
        />

        <TaskCleanupSection />

        <CiTimingDashboard />
      </div>
    </div>
  );
}
