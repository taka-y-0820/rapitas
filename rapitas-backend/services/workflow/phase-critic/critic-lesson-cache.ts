/** Persist derived lessons across backend restarts; invalid cache data is a miss. */
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface CriticLessonCacheEntry {
  fingerprint: string;
  at: number;
  bullets: string[];
}

function cachePath(stream: string): string {
  if (!['research', 'plan', 'verify', 'implement'].includes(stream))
    throw new Error('Invalid lesson stream');
  const base = process.env.RAPITAS_DATA_DIR?.trim() || join(homedir(), '.rapitas');
  return join(base, 'cache', `critic-lessons-${stream}.json`);
}

export async function readCriticLessonCache(
  stream: string,
  fingerprint: string,
  ttlMs: number,
): Promise<CriticLessonCacheEntry | undefined> {
  try {
    const entry = JSON.parse(await readFile(cachePath(stream), 'utf8'));
    const age = Date.now() - entry.at;
    if (
      entry.version !== 1 ||
      entry.fingerprint !== fingerprint ||
      !Number.isFinite(entry.at) ||
      age < 0 ||
      age >= ttlMs ||
      !Array.isArray(entry.bullets) ||
      entry.bullets.length > 8 ||
      !entry.bullets.every(
        (bullet: unknown) =>
          typeof bullet === 'string' && bullet.trim().length > 0 && bullet.length <= 160,
      )
    )
      return undefined;
    return { fingerprint: entry.fingerprint, at: entry.at, bullets: entry.bullets };
  } catch {
    return undefined;
  }
}

export async function writeCriticLessonCache(
  stream: string,
  entry: CriticLessonCacheEntry,
): Promise<void> {
  let temporary: string | undefined;
  try {
    const file = cachePath(stream);
    await mkdir(dirname(file), { recursive: true });
    temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, ...entry }), 'utf8');
    await rename(temporary, file);
  } catch {
    // An unwritable cache never blocks a workflow or discards fresh lessons.
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
