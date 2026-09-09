/** Coalesced output snapshots, shared by fallback agents for one execution. */
import type { OutputHandlerContext } from './execution-helpers-types';
import type { LogChunkManager } from './log-chunk-manager';
import { createLogger } from '../../../config/logger';

const logger = createLogger('output-persistence');
const writers = new WeakMap<LogChunkManager, ReturnType<typeof createWriter>>();

function createWriter(ctx: OutputHandlerContext, manager: LogChunkManager) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  let revision = 0;
  let attempted = 0;
  let errorMessage: string | undefined;
  let closed = false;
  const active = () => ['running', 'waiting_for_input'].includes(ctx.state.status);

  const flush = async (): Promise<void> => {
    if (writing) {
      await writing;
      return flush();
    }
    if (attempted === revision || !active()) return;
    attempted = revision;
    const data = { output: ctx.state.output, ...(errorMessage ? { errorMessage } : {}) };
    errorMessage = undefined;
    writing = (async () => {
      try {
        // A delayed snapshot must never overwrite a terminal result or cancellation.
        await ctx.prisma.agentExecution.updateMany({
          where: { id: ctx.executionId, status: { in: ['running', 'waiting_for_input'] } },
          data,
        });
      } catch (error) {
        logger.error({ err: error }, 'Failed to update execution output');
      }
    })();
    await writing;
    writing = undefined;
  };

  manager.registerCleanup(async () => {
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    await flush();
  });

  return async (error?: string) => {
    if (closed || !active()) return;
    revision++;
    if (error) {
      errorMessage = error;
      clearTimeout(timer);
      timer = undefined;
      await flush();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, 200);
    }
  };
}

export function getOutputWriter(ctx: OutputHandlerContext, manager: LogChunkManager) {
  let writer = writers.get(manager);
  if (!writer) {
    writer = createWriter(ctx, manager);
    writers.set(manager, writer);
  }
  return writer;
}
