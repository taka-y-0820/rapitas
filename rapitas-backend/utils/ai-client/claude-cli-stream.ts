/** Streaming settlement waits for owned cleanup and ignores late process events. */
import type { ChildProcess } from 'child_process';
import { createLogger } from '../../config/logger';
import { auxCliCleanup } from './aux-cli-cleanup';
import type { prepareAuxCli } from './aux-cli-launch';
const log = createLogger('ai-client:claude-cli');

export function createClaudeCliStream(
  child: ChildProcess,
  prompt: string,
  launch: Awaited<ReturnType<typeof prepareAuxCli>>,
  confirmed: Promise<void>,
  untrack: () => void,
  releaseSlot: () => void,
  timeoutMs: number,
): ReadableStream {
  const encoder = new TextEncoder();
  const emit = (controller: ReadableStreamDefaultController, payload: object) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

  let cancelExecution: () => Promise<void> = async () => {};
  return new ReadableStream({
    start(controller) {
      let lineBuffer = '';
      let emittedAny = false;
      let fallbackResult = '';
      let settled = false;
      let consumerCanceled = false;
      let ending: Promise<void> | undefined;
      const cleanup = async (stop: boolean) => {
        if (launch) {
          if (stop) await launch.stop();
          else await launch.finish();
          untrack();
        } else if (stop) auxCliCleanup.stop(child);
        else untrack();
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ending = (async () => {
          try {
            await cleanup(false);
            if (consumerCanceled) return;
            if (!emittedAny && fallbackResult) emit(controller, { content: fallbackResult });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch (error) {
            if (!consumerCanceled) {
              emit(controller, { error: `Claude CLI cleanup unresolved: ${String(error)}` });
              controller.close();
            }
          } finally {
            releaseSlot();
          }
        })();
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ending = (async () => {
          try {
            await cleanup(true);
          } catch (error) {
            log.error({ error, pid: child.pid }, 'Auxiliary CLI stream cleanup failed');
            message += `; cleanup unresolved: ${String(error)}`;
          } finally {
            if (!consumerCanceled) {
              emit(controller, { error: message });
              controller.close();
            }
            releaseSlot();
          }
        })();
      };

      const timer = setTimeout(() => fail(`Claude CLI timed out after ${timeoutMs}ms`), timeoutMs);
      cancelExecution = async () => {
        consumerCanceled = true;
        if (settled) return ending;
        // The consumer has already closed its side: never enqueue an error or DONE.
        settled = true;
        clearTimeout(timer);
        try {
          await cleanup(true);
        } catch (error) {
          log.error({ error, pid: child.pid }, 'Auxiliary CLI cancellation cleanup failed');
          throw error;
        } finally {
          releaseSlot();
        }
      };

      const handleLine = (line: string) => {
        if (settled) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: {
          type?: string;
          is_error?: boolean;
          subtype?: string;
          result?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        try {
          evt = JSON.parse(trimmed);
        } catch {
          return; // ignore non-JSON noise
        }
        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          for (const block of evt.message!.content!) {
            if (block.type === 'text' && block.text) {
              emittedAny = true;
              emit(controller, { content: block.text });
            }
          }
        } else if (evt.type === 'result') {
          if (
            evt.is_error ||
            evt.subtype === 'error' ||
            (typeof evt.subtype === 'string' && evt.subtype.startsWith('error_'))
          ) {
            fail(
              `Claude CLI reported an error: ${String(evt.result || evt.subtype || 'Unknown error').slice(0, 300)}`,
            );
          } else if (typeof evt.result === 'string') {
            fallbackResult = evt.result;
          }
        }
      };

      child.stdout?.on('data', (chunk: string) => {
        if (settled) return;
        lineBuffer += chunk;
        let idx: number;
        while ((idx = lineBuffer.indexOf('\n')) !== -1) {
          handleLine(lineBuffer.slice(0, idx));
          lineBuffer = lineBuffer.slice(idx + 1);
        }
      });
      let stderr = '';
      child.stderr?.on('data', (d: string) => (stderr += d));
      child.on('error', (err) => fail(`Claude CLI spawn failed: ${err.message}`));
      child.on('close', (code) => {
        if (lineBuffer.trim()) handleLine(lineBuffer);
        if (code === 0) finish();
        else fail(`Claude CLI exited ${code}: ${stderr.slice(0, 300)}`);
      });

      // Feed the prompt now that stdout handlers are attached, then close stdin
      // so the CLI produces output.
      child.stdin?.on('error', (err) =>
        log.warn({ err }, 'Claude CLI stdin error while writing prompt'),
      );
      void confirmed.then(
        () => {
          if (!settled) child.stdin?.end(Buffer.from(prompt, 'utf8'));
        },
        (error) => fail(`Claude CLI ownership failed: ${String(error)}`),
      );
    },
    cancel() {
      return cancelExecution();
    },
  });
}
