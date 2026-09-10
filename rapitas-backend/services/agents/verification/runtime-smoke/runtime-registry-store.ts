/** Atomic, serialized runtime ownership records. Read/write failures propagate. */
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

export class RuntimeRegistryStore<T extends { key: string }> {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly validateEntry: (value: unknown) => value is T,
  ) {}

  async read(): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const value = JSON.parse(raw);
    if (
      value?.version !== 1 ||
      !Array.isArray(value.entries) ||
      !value.entries.every(this.validateEntry) ||
      new Set(value.entries.map((entry: T) => entry.key)).size !== value.entries.length
    ) {
      throw new Error('Invalid runtime ownership snapshot');
    }
    return value.entries;
  }

  /** The rejected operation reaches its caller; subsequent repairs may still run. */
  update(change: (entries: T[]) => T[]): Promise<void> {
    const operation = this.tail.then(async () => {
      const entries = change(await this.read());
      if (!entries.every(this.validateEntry)) throw new Error('Invalid runtime ownership entry');
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: 1, entries }), { flag: 'wx' });
        await rename(temp, this.path);
      } finally {
        await unlink(temp).catch(() => {});
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
