/**
 * Cross-process serialization and atomic JSON writes for the alpha ledger.
 * SQLite owns only the OS-backed lock and an initialization marker; comparison
 * results and budgets remain in their existing files. A killed worker releases
 * its SQLite lock automatically, so no stale PID lock needs manual removal.
 */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';

type StorageFailure = { issue: 'corrupted' | 'io_error' };

/** Serialize the entire read/modify/write operation, including first creation. */
export function withAlphaLedgerLock<T>(file: string, operation: () => T): T | StorageFailure {
  let db: Database | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true });
    db = new Database(`${file}.lock.sqlite`);
    // Bounded contention returns an I/O hold for the next cycle to retry.
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('CREATE TABLE IF NOT EXISTS ledger_guard (id INTEGER PRIMARY KEY CHECK(id = 1))');
    const lockedDb = db;
    return db
      .transaction((): T | StorageFailure => {
        if (lockedDb.query('SELECT id FROM ledger_guard WHERE id = 1').get() && !existsSync(file)) {
          return { issue: 'corrupted' };
        }
        const result = operation();
        if (existsSync(file)) lockedDb.exec('INSERT OR IGNORE INTO ledger_guard VALUES (1)');
        return result;
      })
      .immediate();
  } catch {
    return { issue: 'io_error' };
  } finally {
    db?.close();
  }
}

/** Flush a same-directory temporary file before replacing the complete ledger. */
export function writeAlphaLedger(file: string, value: unknown): boolean {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx');
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* Renamed or never created. */
    }
  }
}
