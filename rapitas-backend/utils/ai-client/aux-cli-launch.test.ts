import { expect, test } from 'bun:test';
import { prepareAuxCli } from './aux-cli-launch';

test('unsupported ownership observation cannot silently select uncontained spawning', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'darwin' });
  try {
    await expect(prepareAuxCli('fixture', '/tmp', {})).rejects.toThrow('unavailable on darwin');
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
