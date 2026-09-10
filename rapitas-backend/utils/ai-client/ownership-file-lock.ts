/** Cross-process lock only; ownership evidence stays in its existing atomic JSON file. */
import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function withOwnershipFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const database = new Database(`${path}.lock.sqlite`);
  // Never let SQLite synchronously wait for another process on the backend event loop.
  let acquired = false;
  const deadline = performance.now() + 15000;
  try {
    database.exec('PRAGMA busy_timeout = 0');
    while (!acquired) {
      try {
        database.exec('BEGIN IMMEDIATE');
        acquired = true;
      } catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY' || performance.now() >= deadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return await action();
  } finally {
    try {
      if (acquired) database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  }
}
