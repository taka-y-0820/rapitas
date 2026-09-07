#!/usr/bin/env bun
/**
 * Tests for port detection utility functions.
 * Tests port availability checking and dynamic port finding.
 *
 * NOTE: This suite used to hardcode ports 45000-45500. On this machine that
 * whole range fails to bind (EADDRINUSE on both `::` and `0.0.0.0`) even
 * though `netstat -ano` shows no listener there — some other process/VM NAT
 * (many worktrees run concurrently on this host, see research.md) holds the
 * range invisibly to netstat. `net.createServer().listen(0)` + close is used
 * to obtain genuinely free ports at run time instead of trusting a fixed
 * range, so the suite no longer depends on which ports happen to be free on
 * a given machine.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { createServer, type Server } from 'net';
import { isPortAvailable, findAvailablePort } from '../../utils/common/find-port';

describe('Port Detection Utilities', () => {
  let testServers: Server[] = [];

  // Helper to create a server on a specific port for testing
  const occupyPort = (port: number): Promise<Server> => {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(port, () => {
        testServers.push(server);
        resolve(server);
      });
      server.on('error', reject);
    });
  };

  // Helper to close a server
  const closeServer = (server: Server): Promise<void> => {
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  };

  const isFreePort = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, () => server.close(() => resolve(true)));
    });
  };

  // Ask the OS for an ephemeral port, then verify `count` consecutive ports
  // starting there are also free — retrying with a new base on collision.
  const getFreePortBlock = async (count: number, maxAttempts = 20): Promise<number> => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const base = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.listen(0, () => {
          const addr = server.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          server.close(() => resolve(port));
        });
        server.on('error', reject);
      });
      let allFree = true;
      for (let i = 1; i < count; i++) {
        if (!(await isFreePort(base + i))) {
          allFree = false;
          break;
        }
      }
      if (allFree) return base;
    }
    throw new Error(`Could not find ${count} consecutive free ports after ${maxAttempts} attempts`);
  };

  afterEach(async () => {
    // Clean up all test servers
    for (const server of testServers) {
      await closeServer(server);
    }
    testServers = [];
  });

  describe('isPortAvailable', () => {
    test('should return true for an available port', async () => {
      const port = await getFreePortBlock(1);
      const available = await isPortAvailable(port);
      expect(available).toBe(true);
    });

    test('should return false for an occupied port', async () => {
      const port = await getFreePortBlock(1);
      await occupyPort(port);

      const available = await isPortAvailable(port);
      expect(available).toBe(false);
    });

    test('should handle invalid port numbers gracefully', async () => {
      // Port numbers above 65535 are invalid
      const available = await isPortAvailable(70000);
      expect(available).toBe(false);
    });
  });

  describe('findAvailablePort', () => {
    test('should return the starting port if it is available', async () => {
      const startPort = await getFreePortBlock(5);
      const foundPort = await findAvailablePort(startPort, 5);
      expect(foundPort).toBe(startPort);
    });

    test('should find the next available port when starting port is occupied', async () => {
      const startPort = await getFreePortBlock(5);
      const expectedPort = startPort + 2;

      // Occupy the starting port and the next one
      await occupyPort(startPort);
      await occupyPort(startPort + 1);

      const foundPort = await findAvailablePort(startPort, 5);
      expect(foundPort).toBe(expectedPort);
    });

    test('should respect the maxTries limit', async () => {
      const startPort = await getFreePortBlock(3);
      const maxTries = 3;

      // Occupy all ports in the range
      for (let i = 0; i < maxTries; i++) {
        await occupyPort(startPort + i);
      }

      await expect(findAvailablePort(startPort, maxTries)).rejects.toThrow(
        `No available port found after trying ${maxTries} ports starting from ${startPort}`,
      );
    });

    test('should use default parameters when not provided', async () => {
      const foundPort = await findAvailablePort();
      expect(foundPort).toBeGreaterThanOrEqual(3001);
      expect(foundPort).toBeLessThan(3011); // default maxTries is 10
    });

    test('should handle edge case with maxTries = 1', async () => {
      const startPort = await getFreePortBlock(1);
      const foundPort = await findAvailablePort(startPort, 1);
      expect(foundPort).toBe(startPort);
    });

    test('should find port when some ports in range are occupied', async () => {
      const startPort = await getFreePortBlock(5);

      // Occupy startPort, startPort+2, startPort+4 (leaving +1, +3 available)
      await occupyPort(startPort);
      await occupyPort(startPort + 2);
      await occupyPort(startPort + 4);

      const foundPort = await findAvailablePort(startPort, 10);
      expect(foundPort).toBe(startPort + 1);
    });
  });
});
