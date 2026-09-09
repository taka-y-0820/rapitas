import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnPlaywrightWorker } from './playwright-worker-client';

// Match production: one browser serves all checked paths in a smoke pass.
const worker = spawnPlaywrightWorker();
beforeAll(async () => {
  await worker.launch({
    channels: [
      process.env.RAPITAS_TEST_BROWSER_CHANNEL ||
        (process.platform === 'win32' ? 'msedge' : 'chrome'),
    ],
    timeoutMs: 20000,
  });
}, 30000);
afterAll(async () => {
  await worker.close();
});

test('a permanent loading screen is not a successful runtime check', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('<html><body>Loading...</body></html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  });
  try {
    const options = {
      url: `http://127.0.0.1:${server.port}`,
      timeoutMs: 3000,
      settleMs: 50,
      readySelector: '[data-app-ready="true"]',
      readinessTimeoutMs: 1000,
    };
    const finding = await worker.checkPath(options);
    expect(finding.httpStatus).toBe(200);
    expect(finding.navigationError).not.toBeNull();
  } finally {
    await server.stop(true);
  }
}, 30000);

test.each(['ready', 'cors', 'pending'])(
  'readiness evidence for %s application',
  async (mode) => {
    const api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    const html =
      mode === 'ready'
        ? '<body>Loading<script>setTimeout(() => document.body.innerHTML = `<button data-app-ready="true">Ready</button>`, 350)</script></body>'
        : `<body>Loading<script>fetch('${mode === 'cors' ? `http://127.0.0.1:${api.port}/api?secret=redacted` : '/pending'}').catch(() => {})</script></body>`;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === '/pending'
          ? new Promise<Response>(() => {})
          : new Response(html, { headers: { 'Content-Type': 'text/html' } }),
    });
    try {
      const result = await worker.checkPath({
        url: `http://127.0.0.1:${server.port}`,
        timeoutMs: 3000,
        settleMs: 50,
        readySelector: '[data-app-ready="true"]',
        readinessTimeoutMs: 1000,
      });
      if (mode === 'ready') {
        expect(result.navigationError).toBeNull();
        expect(result.failedRequests).toEqual([]);
      } else {
        expect(result.navigationError).toContain('Application readiness failed');
        if (mode === 'cors') {
          expect(result.failedRequests?.length).toBeGreaterThan(0);
          expect(result.failedRequests?.join(' ')).not.toContain('secret=');
        } else expect(result.pendingRequests?.join(' ')).toContain('/pending');
      }
    } finally {
      await server.stop(true);
      await api.stop(true);
    }
  },
  30000,
);
