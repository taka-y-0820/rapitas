/** Delay a real file write to expose stale flush overwrites deterministically. */
import { expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeAtomicTextFile } from '../../../utils/common/atomic-text-file';
const realWrite = writeAtomicTextFile;
let enter!: () => void;
let release!: () => void;
const entered = new Promise<void>((resolve) => {
  enter = resolve;
});
const released = new Promise<void>((resolve) => {
  release = resolve;
});
let calls = 0;
mock.module('../../../utils/common/atomic-text-file', () => ({
  writeAtomicTextFile: async (file: string, content: string) => {
    if (++calls === 1) {
      enter();
      await released;
    }
    await realWrite(file, content);
  },
}));
const { ExecutionFileLogger } = await import('./index');

test('a later flush cannot finish ahead of the earlier snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flush-order-'));
  const logger = new ExecutionFileLogger(10, 100, 1, 'test', 'codex', undefined, undefined, {
    logDir: directory,
    enableConsolePassthrough: false,
  });
  let first: Promise<string | null> | undefined;
  let second: Promise<string | null> | undefined;
  try {
    logger.log('INFO', 'recovery', 'first snapshot');
    first = logger.flush();
    await entered;
    logger.log('INFO', 'recovery', 'second snapshot');
    second = logger.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    release();
    const [path, latest] = await Promise.all([first, second]);
    expect(path).toBe(latest);
    expect(calls).toBe(2);
    expect(readFileSync(latest!, 'utf8')).toContain('second snapshot');
  } finally {
    release();
    await Promise.all([first, second]);
    rmSync(directory, { recursive: true, force: true });
  }
});
