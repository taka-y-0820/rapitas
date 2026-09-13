/**
 * execution-dashboard barrel
 *
 * Re-exports the execution visualization dashboard's public API (task 870).
 * Not responsible for any logic itself — see useExecutionDashboardData and
 * components/.
 */
export { useExecutionDashboardData } from './useExecutionDashboardData';
export type {
  ExecutionDashboardTask,
  ExecutionDashboardTaskState,
  ExecutionDashboardData,
  UseExecutionDashboardDataResult,
} from './useExecutionDashboardData';
export {
  ExecutionFlowChart,
  countTasksByStage,
  buildFlowChartSource,
} from './components/ExecutionFlowChart';
export type { ExecutionFlowChartCounts } from './components/ExecutionFlowChart';
export { ExecutionActivityTimeline } from './components/ExecutionActivityTimeline';
export { TaskExecutionDrilldownModal } from './components/TaskExecutionDrilldownModal';
