/** Report slow preparation stages without aborting or changing their outcome. */
import { createLogger } from '../../config/logger';

const log = createLogger('workflow-stage-timing');

export async function observeWorkflowStage<T>(
  taskId: number,
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let reported = false;
  const timer = setTimeout(() => {
    reported = true;
    log.warn(
      { taskId, stage, elapsedMs: Date.now() - startedAt },
      'Workflow preparation stage still pending',
    );
  }, 10000);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    if (reported)
      log.warn(
        { taskId, stage, elapsedMs: Date.now() - startedAt },
        'Workflow preparation stage settled',
      );
  }
}
