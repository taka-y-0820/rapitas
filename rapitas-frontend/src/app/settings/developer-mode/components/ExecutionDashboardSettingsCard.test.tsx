/**
 * ExecutionDashboardSettingsCard.test
 *
 * Covers the execution dashboard's stall threshold field (task 870): edits
 * commit to onUpdateSettings with the exact key the backend persists,
 * out-of-range values clamp to 1..120, and unchanged values are not re-sent.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { ExecutionDashboardSettingsCard } from './ExecutionDashboardSettingsCard';
import type { UserSettings } from '@/types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const BASE_SETTINGS: UserSettings = {
  id: 1,
  aiTaskAnalysisDefault: false,
  autoResumeInterruptedTasks: false,
  autoExecuteAfterCreate: false,
  autoGenerateTitle: false,
  autoGenerateTitleDelay: 3,
  autoCreateAfterTitleGeneration: false,
  autoFetchTaskSuggestions: true,
  autoApprovePlan: false,
  autoApproveSubtaskPlan: true,
  autoComplexityAnalysis: false,
  activeMode: 'both',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  executionStallThresholdMinutes: 5,
};

function renderCard(overrides: Partial<UserSettings> = {}, onUpdateSettings = vi.fn()) {
  render(
    <ExecutionDashboardSettingsCard
      settings={{ ...BASE_SETTINGS, ...overrides }}
      isSaving={false}
      onUpdateSettings={onUpdateSettings}
    />,
  );
  return onUpdateSettings;
}

describe('ExecutionDashboardSettingsCard', () => {
  it('renders the threshold field with its server value', () => {
    renderCard();
    expect(screen.getByText('thresholdLabel')).toBeTruthy();
    expect((screen.getByLabelText('thresholdLabel') as HTMLInputElement).value).toBe('5');
  });

  it('falls back to 5 when the server has not migrated the column yet', () => {
    renderCard({ executionStallThresholdMinutes: undefined });
    expect((screen.getByLabelText('thresholdLabel') as HTMLInputElement).value).toBe('5');
  });

  it('commits a changed threshold on blur as the PATCH payload key', () => {
    const onUpdateSettings = renderCard();
    const input = screen.getByLabelText('thresholdLabel');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onUpdateSettings).toHaveBeenCalledWith({ executionStallThresholdMinutes: 10 });
  });

  it('clamps out-of-range values to 1..120', () => {
    const onUpdateSettings = renderCard();
    const input = screen.getByLabelText('thresholdLabel');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(onUpdateSettings).toHaveBeenCalledWith({ executionStallThresholdMinutes: 1 });

    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input);
    expect(onUpdateSettings).toHaveBeenLastCalledWith({ executionStallThresholdMinutes: 120 });
  });

  it('resets to the server value and does not re-send when cleared then blurred', () => {
    const onUpdateSettings = renderCard();
    const input = screen.getByLabelText('thresholdLabel');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onUpdateSettings).not.toHaveBeenCalled();
  });

  it('does not re-send an unchanged threshold', () => {
    const onUpdateSettings = renderCard();
    const input = screen.getByLabelText('thresholdLabel');
    fireEvent.blur(input);
    expect(onUpdateSettings).not.toHaveBeenCalled();
  });
});
