/** Per-run command evidence; async-local storage prevents overlapping jobs mixing results. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface CommandEvidence {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  status: 'running' | 'exited' | 'spawn_failed';
  error?: string;
}

const evidenceScope = new AsyncLocalStorage<CommandEvidence[]>();

export function withCommandEvidence<T>(
  records: CommandEvidence[],
  run: () => Promise<T>,
): Promise<T> {
  return evidenceScope.run(records, run);
}

/** Observe actual process events, never infer a process exit code from gate success. */
export function observeCommand(command: string, options: SpawnOptions, child: ChildProcess): void {
  const records = evidenceScope.getStore();
  if (!records) return;
  const record: CommandEvidence = {
    command,
    cwd: String(options.cwd ?? process.cwd()),
    exitCode: null,
    signal: null,
    status: 'running',
  };
  records.push(record);
  child.once('error', (error) => {
    record.status = 'spawn_failed';
    record.error = error.message;
  });
  child.once('close', (code, signal) => {
    if (record.status === 'spawn_failed') return;
    record.status = 'exited';
    record.exitCode = code;
    record.signal = signal;
  });
}
