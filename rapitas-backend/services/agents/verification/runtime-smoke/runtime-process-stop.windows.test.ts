import { expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { readRuntimeProcessSnapshot } from './runtime-process-snapshot';
import { stopRuntimeProcesses, terminateRuntimeIdentities } from './runtime-process-stop';

test.skipIf(process.platform !== 'win32')(
  'real Windows batch stops eight owned processes within the stop budget',
  async () => {
    const children = Array.from({ length: 8 }, () =>
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once('spawn', resolve);
              child.once('error', reject);
            }),
        ),
      );
      const snapshot = await readRuntimeProcessSnapshot();
      const pids = new Set(children.map((child) => child.pid));
      const identities = snapshot.processes.filter((row) => pids.has(row.pid));
      expect(identities).toHaveLength(8);
      const started = Date.now();
      const result = await stopRuntimeProcesses(identities, async () => {});
      const elapsed = Date.now() - started;
      console.info(
        `Windows eight-process stop: ${elapsed}ms, stopped=${result.stopped}, reason=${result.reason ?? 'none'}`,
      );
      expect(result.stopped).toBe(true);
      expect(elapsed).toBeLessThan(20_000);
      const after = await readRuntimeProcessSnapshot();
      expect(
        after.processes.filter((row) =>
          identities.some((owned) => owned.pid === row.pid && owned.birth === row.birth),
        ),
      ).toHaveLength(0);
    } finally {
      // These handles were created by this test; never signal unrelated PIDs.
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  },
  45_000,
);

test.skipIf(process.platform !== 'win32')(
  'real Windows helper refuses a mismatched process identity',
  async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const snapshot = await readRuntimeProcessSnapshot();
      const identity = snapshot.processes.find((row) => row.pid === child.pid)!;
      expect(identity).toBeDefined();
      await expect(terminateRuntimeIdentities([{ ...identity, birth: '1' }])).rejects.toThrow();
      const after = await readRuntimeProcessSnapshot();
      expect(
        after.processes.some((row) => row.pid === identity.pid && row.birth === identity.birth),
      ).toBe(true);
    } finally {
      child.kill();
    }
  },
  45_000,
);
