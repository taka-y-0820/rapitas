/** Replace text only after flushing a complete same-directory temporary file. */
import { randomUUID } from 'crypto';
import { open, rename, unlink } from 'fs/promises';
import type { FileHandle } from 'fs/promises';

export async function writeAtomicTextFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    for (let retry = 0; ; retry++) {
      try {
        await rename(temporary, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== 'win32' ||
          retry >= 10 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
