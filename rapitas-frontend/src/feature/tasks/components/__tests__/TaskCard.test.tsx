import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TaskCard from '../TaskCard';
import type { Task, Status, Priority } from '@/types';

// Mock dependencies
vi.mock('@/components/ui/toast/ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

// NOTE: useTaskCard now calls useConfirmDialog; without this mock every render
// throws "must be used within ConfirmDialogProvider".
vi.mock('@/components/ui/dialog/ConfirmDialogProvider', () => ({
  useConfirmDialog: () => vi.fn().mockResolvedValue(false),
}));

// Mutable so individual tests can simulate a task mid auto-execution — see
// mockExecutingStatus below and the 選択モード/自動実行中 describe block.
let mockExecutingStatus: 'running' | 'waiting_for_input' | null = null;
vi.mock('@/stores/execution-state-store', () => ({
  useExecutionStateStore: (
    selector: (state: {
      getExecutingTaskStatus: (id: number) => 'running' | 'waiting_for_input' | null;
      getExecutingTaskStartedAt: (id: number) => null;
      getExecutingTaskActiveMs: (id: number) => number;
      executingTasks: Map<number, unknown>;
    }) => unknown,
  ) =>
    selector({
      getExecutingTaskStatus: () => mockExecutingStatus,
      getExecutingTaskStartedAt: () => null,
      // NOTE: useTaskCard now selects the cumulative active-time base (task #560);
      // omitting this getter makes every render throw TypeError.
      getExecutingTaskActiveMs: () => 0,
      executingTasks: new Map(),
    }),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('@/lib/api-client', () => ({
  prefetch: vi.fn(),
}));

vi.mock('@/utils/api', () => ({
  API_BASE_URL: 'http://localhost:3001',
}));

vi.mock('@/utils/labels', () => ({
  getLabelsArray: (labels: unknown) => {
    if (!labels) return [];
    if (typeof labels === 'string') {
      try {
        const parsed = JSON.parse(labels);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    if (Array.isArray(labels)) return labels;
    return [];
  },
  hasLabels: (labels: unknown) => {
    if (!labels) return false;
    if (Array.isArray(labels)) return labels.length > 0;
    if (typeof labels === 'string') {
      try {
        const parsed = JSON.parse(labels);
        return Array.isArray(parsed) && parsed.length > 0;
      } catch {
        return false;
      }
    }
    return false;
  },
}));

// Mock PriorityIcon component
vi.mock('@/feature/tasks/components/priority/PriorityIcon', () => ({
  default: ({ priority }: { priority: string | null | undefined; size?: string }) =>
    priority ? <span data-testid="priority-icon">{priority}</span> : null,
}));

// Mock TaskStatusChange component
vi.mock('@/feature/tasks/components/status/TaskStatusChange', () => ({
  default: ({
    status,
    currentStatus,
    onClick,
  }: {
    status: string;
    currentStatus: string;
    config: unknown;
    renderIcon: unknown;
    onClick: (s: string) => void;
    size?: string;
  }) => (
    <button
      data-testid={`status-btn-${status}`}
      data-current={currentStatus === status ? 'true' : 'false'}
      onClick={(e) => {
        e.stopPropagation();
        onClick(status);
      }}
    >
      {status}
    </button>
  ),
}));

// Mock SubtaskStatusButtons
vi.mock('@/feature/tasks/components/status/SubtaskStatusButtons', () => ({
  default: () => <div data-testid="subtask-status-buttons" />,
}));

// Mock StatusConfig
vi.mock('@/feature/tasks/config/StatusConfig', () => {
  const statusConfig = {
    todo: {
      color: 'text-zinc-700',
      bgColor: 'bg-zinc-100',
      borderColor: 'border-l-zinc-400',
      labelKey: 'statusTodo',
    },
    'in-progress': {
      color: 'text-indigo-700',
      bgColor: 'bg-indigo-50',
      borderColor: 'border-l-indigo-500',
      labelKey: 'statusInProgress',
    },
    done: {
      color: 'text-green-700',
      bgColor: 'bg-green-50',
      borderColor: 'border-l-green-500',
      labelKey: 'statusDone',
    },
  };
  const resolveStatusConfig = (status: string) =>
    statusConfig[status as keyof typeof statusConfig] || statusConfig.todo;
  return {
    statusConfig,
    resolveStatusConfig,
    getStatusDisplay: (t: (key: string) => string, status: string) => {
      const config = resolveStatusConfig(status);
      return { ...config, label: t(config.labelKey) };
    },
    isInProgressStatus: (status: string) => status === 'in-progress' || status === 'blocked',
    renderStatusIcon: (status: string) => <span data-testid={`status-icon-${status}`} />,
  };
});

// Mock TaskCompletionAnimation
vi.mock('../completion/TaskCompletionAnimation', () => ({
  CardLightSweep: ({ active }: { active: boolean }) =>
    active ? <div data-testid="card-light-sweep" /> : null,
  useProgressColors: () => ({
    primary: '#000',
    primaryLight: '#111',
    primaryDark: '#222',
  }),
}));

// Mock ModernCheckbox
vi.mock('@/components/ui/ModernCheckbox', () => ({
  ModernCheckbox: ({
    checked,
    onChange,
    onClick,
    disabled,
  }: {
    checked: boolean;
    onChange: () => void;
    onClick?: (e: React.MouseEvent) => void;
    disabled?: boolean;
  }) => (
    <button
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled}
      onClick={(e) => {
        if (disabled) return;
        if (onClick) onClick(e);
        onChange();
      }}
    />
  ),
}));

// NOTE: Uses the shared self-repairing factory so new icons (Repeat, RefreshCw, etc.)
// are auto-stubbed without updating this allowlist.
vi.mock('lucide-react', async (importOriginal) => {
  const { buildLucideMock } = await import('@/__tests__/helpers/lucide-react-mock');
  return buildLucideMock(importOriginal, {
    ExternalLink: 'external-link',
    Tag: 'tag',
    Copy: 'copy',
    Trash2: 'trash2',
    Edit: 'edit',
  });
});

vi.mock('@/components/category/icon-data', () => ({
  getIconComponent: () => () => <div data-testid="category-icon" />,
}));

// Sample task data
const mockTask: Task = {
  id: 1,
  title: 'Test Task',
  description: 'Test description',
  status: 'todo' as Status,
  priority: 'high' as Priority,
  themeId: 1,
  labels: ['urgent', 'frontend'],
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockProps = {
  task: mockTask,
  isSelected: false,
  isSelectionMode: false,
  onTaskClick: vi.fn(),
  onStatusChange: vi.fn(),
  onToggleSelect: vi.fn(),
  onTaskUpdated: vi.fn(),
  onOpenInPage: vi.fn(),
};

describe('TaskCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutingStatus = null;
  });

  describe('基本レンダリング', () => {
    it('タスクタイトルが表示される', () => {
      render(<TaskCard {...mockProps} />);
      expect(screen.getByText('Test Task')).toBeInTheDocument();
    });

    it('作成日が表示される', () => {
      render(<TaskCard {...mockProps} />);
      // Date formatted via the app-standard formatDate() (yyyy/mm/dd)
      expect(screen.getByText('2024/01/01')).toBeInTheDocument();
    });

    it('ラベルがある場合にラベル数が表示される', () => {
      render(<TaskCard {...mockProps} />);
      // hasLabels returns true for ['urgent', 'frontend'], shows count
      expect(screen.getByTestId('tag')).toBeInTheDocument();
    });
  });

  describe('ステータス表示', () => {
    it('todoステータスのアイコンが適切に表示される', () => {
      render(<TaskCard {...mockProps} />);
      expect(screen.getByTestId('status-icon-todo')).toBeInTheDocument();
    });

    it('ステータス変更ボタンが表示される', () => {
      render(<TaskCard {...mockProps} />);
      expect(screen.getByTestId('status-btn-todo')).toBeInTheDocument();
      expect(screen.getByTestId('status-btn-in-progress')).toBeInTheDocument();
      expect(screen.getByTestId('status-btn-done')).toBeInTheDocument();
    });

    it('異なるステータスでも適切に表示される', () => {
      const taskInProgress = {
        ...mockTask,
        status: 'in-progress' as Status,
      };
      render(<TaskCard {...mockProps} task={taskInProgress} />);
      expect(screen.getByTestId('status-icon-in-progress')).toBeInTheDocument();
    });

    it('blockedステータスではステータスアイコンに汎用ヒントのtitleが付く', () => {
      const blockedTask = { ...mockTask, status: 'blocked' as Status };
      render(<TaskCard {...mockProps} task={blockedTask} />);
      const icon = screen.getByTestId('status-icon-blocked');
      expect(icon.closest('div[title]')).toHaveAttribute(
        'title',
        'statusIndicator.blockedGenericHint',
      );
    });

    it('blocked以外のステータスではtitleが付かない', () => {
      render(<TaskCard {...mockProps} />);
      const icon = screen.getByTestId('status-icon-todo');
      expect(icon.closest('div')).not.toHaveAttribute('title');
    });

    it('blockedCauseが既知コードの場合、バッチ取得したcauseを反映したtitleになる', () => {
      const blockedTask = {
        ...mockTask,
        status: 'blocked' as Status,
        blockedCause: 'verify_pr_not_created',
      };
      render(<TaskCard {...mockProps} task={blockedTask} />);
      const icon = screen.getByTestId('status-icon-blocked');
      expect(icon.closest('div[title]')).toHaveAttribute(
        'title',
        'statusIndicator.blockedCauses.verifyPrNotCreated',
      );
    });

    it('blockedCauseが未知コードの場合、unknown-causeのtitleになる', () => {
      const blockedTask = {
        ...mockTask,
        status: 'blocked' as Status,
        blockedCause: 'some_unrecognized_code',
      };
      render(<TaskCard {...mockProps} task={blockedTask} />);
      const icon = screen.getByTestId('status-icon-blocked');
      expect(icon.closest('div[title]')).toHaveAttribute(
        'title',
        'statusIndicator.blockedCauseUnknown',
      );
    });

    it('blockedCauseが無い場合は汎用ヒントにフォールバックする', () => {
      const blockedTask = { ...mockTask, status: 'blocked' as Status, blockedCause: null };
      render(<TaskCard {...mockProps} task={blockedTask} />);
      const icon = screen.getByTestId('status-icon-blocked');
      expect(icon.closest('div[title]')).toHaveAttribute(
        'title',
        'statusIndicator.blockedGenericHint',
      );
    });
  });

  describe('プライオリティ表示', () => {
    it('プライオリティアイコンが表示される', () => {
      render(<TaskCard {...mockProps} />);
      const priorityIcon = screen.getByTestId('priority-icon');
      expect(priorityIcon).toBeInTheDocument();
      expect(priorityIcon).toHaveTextContent('high');
    });
  });

  describe('保護表示', () => {
    it('保護タスクではロックアイコンが表示される', () => {
      const protectedTask = { ...mockTask, isProtected: true };
      render(<TaskCard {...mockProps} task={protectedTask} />);
      expect(screen.getByTestId('Lock-icon')).toBeInTheDocument();
    });

    it('非保護タスクではロックアイコンが表示されない', () => {
      render(<TaskCard {...mockProps} />);
      expect(screen.queryByTestId('Lock-icon')).not.toBeInTheDocument();
    });
  });

  describe('選択モード', () => {
    it('選択モードでチェックボックスが表示される', () => {
      render(<TaskCard {...mockProps} isSelectionMode={true} />);
      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toBeInTheDocument();
    });

    it('選択状態が適切に反映される', () => {
      render(<TaskCard {...mockProps} isSelectionMode={true} isSelected={true} />);
      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toHaveAttribute('aria-checked', 'true');
    });

    it('チェックボックスクリックで選択状態が切り替わる', () => {
      render(<TaskCard {...mockProps} isSelectionMode={true} />);
      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);
      expect(mockProps.onToggleSelect).toHaveBeenCalledWith(1);
    });

    it('自動実行中のタスクはチェックボックスが無効化され選択できない', () => {
      mockExecutingStatus = 'running';
      render(<TaskCard {...mockProps} isSelectionMode={true} />);
      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(checkbox);
      expect(mockProps.onToggleSelect).not.toHaveBeenCalled();
    });

    it('自動実行中のタスクは行クリックでも選択状態が切り替わらない', () => {
      mockExecutingStatus = 'waiting_for_input';
      render(<TaskCard {...mockProps} isSelectionMode={true} />);
      // The row itself (not the checkbox) also toggles selection on click.
      fireEvent.click(screen.getByText('Test Task'));
      expect(mockProps.onToggleSelect).not.toHaveBeenCalled();
    });
  });

  describe('イベントハンドリング', () => {
    it('タスククリックで適切なコールバックが呼ばれる', () => {
      render(<TaskCard {...mockProps} />);
      const taskTitle = screen.getByText('Test Task');
      // Click the clickable area (parent div with cursor-pointer)
      fireEvent.click(taskTitle);
      expect(mockProps.onTaskClick).toHaveBeenCalledWith(1);
    });

    it('ステータスボタンクリックで適切なコールバックが呼ばれる', () => {
      render(<TaskCard {...mockProps} />);
      const inProgressBtn = screen.getByTestId('status-btn-in-progress');
      fireEvent.click(inProgressBtn);
      expect(mockProps.onStatusChange).toHaveBeenCalledWith(1, 'in-progress', expect.anything());
    });
  });

  describe('コンテキストメニュー', () => {
    it('右クリックでコンテキストメニューが表示される', async () => {
      render(<TaskCard {...mockProps} />);
      const taskTitle = screen.getByText('Test Task');
      const clickableArea = taskTitle.closest('.cursor-pointer')!;

      fireEvent.contextMenu(clickableArea);

      await waitFor(() => {
        // Context menu shows edit, copy (duplicate), and delete buttons
        expect(screen.getByTestId('edit')).toBeInTheDocument();
        expect(screen.getByTestId('copy')).toBeInTheDocument();
        expect(screen.getByTestId('trash2')).toBeInTheDocument();
      });
    });
  });

  describe('ページで開くボタン', () => {
    it('onOpenInPageが渡されている場合にボタンが表示される', () => {
      render(<TaskCard {...mockProps} />);
      expect(screen.getByTestId('external-link')).toBeInTheDocument();
    });

    it('onOpenInPageが未定義の場合にボタンが非表示', () => {
      render(<TaskCard {...mockProps} onOpenInPage={undefined} />);
      expect(screen.queryByTestId('external-link')).not.toBeInTheDocument();
    });
  });

  describe('アニメーション', () => {
    it('カードは正常に表示される', () => {
      render(<TaskCard {...mockProps} />);
      const cardContainer = screen.getByText('Test Task').closest('[data-task-card]');
      expect(cardContainer).toBeInTheDocument();
    });
  });

  describe('エッジケース', () => {
    it('ラベルがない場合でも適切に表示される', () => {
      const taskWithoutLabels = { ...mockTask, labels: undefined };
      render(<TaskCard {...mockProps} task={taskWithoutLabels} />);
      expect(screen.getByText('Test Task')).toBeInTheDocument();
    });

    it('説明が空の場合でも適切に表示される', () => {
      const taskWithoutDescription = { ...mockTask, description: '' };
      render(<TaskCard {...mockProps} task={taskWithoutDescription} />);
      expect(screen.getByText('Test Task')).toBeInTheDocument();
    });

    it('テーマがない場合でも適切に表示される', () => {
      const taskWithoutTheme = { ...mockTask, theme: null };
      render(<TaskCard {...mockProps} task={taskWithoutTheme} />);
      expect(screen.getByText('Test Task')).toBeInTheDocument();
    });
  });

  describe('アクセシビリティ', () => {
    it('タスクカード要素が適切にレンダリングされる', () => {
      render(<TaskCard {...mockProps} />);
      const taskElement = screen.getByText('Test Task').closest('[data-task-card]');
      expect(taskElement).toBeInTheDocument();
    });

    it('クリック可能な要素として機能する', () => {
      render(<TaskCard {...mockProps} />);
      const clickableArea = screen.getByText('Test Task').closest('.cursor-pointer');
      expect(clickableArea).toBeInTheDocument();
      expect(clickableArea).toHaveClass('cursor-pointer');
    });
  });
});

describe('質問待ち (awaiting_question) の表示', () => {
  beforeEach(() => {
    mockExecutingStatus = null;
  });

  it('question.md で停止中のタスクは実行行が無くてもアンバー表示になる', () => {
    const { container } = render(
      <TaskCard
        {...mockProps}
        task={{ ...mockTask, status: 'in-progress', workflowStatus: 'awaiting_question' }}
      />,
    );
    const card = container.querySelector('[data-task-card]') as HTMLElement;
    expect(card.className).toContain('ai-glow-amber');
    expect(card.className).toContain('border-l-amber-500');
    // The status pill announces the waiting state (aria-label) even without a
    // live execution row.
    expect(screen.getAllByLabelText('waitingForInput').length).toBeGreaterThan(0);
  });

  it('通常の in-progress タスクはアンバーにならない', () => {
    const { container } = render(
      <TaskCard
        {...mockProps}
        task={{ ...mockTask, status: 'in-progress', workflowStatus: 'in_progress' }}
      />,
    );
    const card = container.querySelector('[data-task-card]') as HTMLElement;
    expect(card.className).not.toContain('ai-glow-amber');
  });
});
