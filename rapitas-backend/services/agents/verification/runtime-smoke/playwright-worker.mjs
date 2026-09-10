#!/usr/bin/env node
/**
 * playwright-worker
 *
 * Standalone Node.js script that drives playwright-core against a real
 * system browser (Edge/Chrome). Exists because Bun — the runtime the rest of
 * rapitas-backend runs under — cannot complete Playwright's CDP handshake:
 * confirmed live, both chromium.launch() (pipe transport) and
 * chromium.connectOverCDP() (WebSocket transport) hang until timeout under
 * Bun 1.3.13, while the identical call succeeds in well under a second under
 * plain Node.js. This script is spawned via the system `node` binary (never
 * `bun`) by playwright-worker-client.ts and driven over a line-delimited
 * JSON protocol on stdin/stdout, so no Playwright object ever needs to cross
 * into the Bun process.
 *
 * Protocol: each stdin line is {id, cmd, args}; each stdout line is
 * {id, ok:true, result} or {id, ok:false, error}. Nothing else may ever be
 * written to stdout — it would corrupt the protocol stream (that's why every
 * failure path below reports itself as a normal {ok:false} response instead
 * of throwing to the top level / logging to stdout).
 */
'use strict';

let browser = null;
let context = null;
/** The single "current" page — every command here is used sequentially by one caller, never concurrently. */
let page = null;
let pageEvents = null;

function resetPageEvents() {
  pageEvents = {
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
    failedRequests: [],
    pendingRequests: new Map(),
  };
}

function attachListeners(p) {
  const requestLabel = (request) => {
    const url = new URL(request.url());
    return `${request.method()} ${url.origin}${url.pathname}`;
  };
  p.on('request', (request) => {
    if (['xhr', 'fetch'].includes(request.resourceType())) {
      pageEvents.pendingRequests.set(request, requestLabel(request));
    }
  });
  p.on('requestfinished', (request) => pageEvents.pendingRequests.delete(request));
  p.on('requestfailed', (request) => {
    if (pageEvents.pendingRequests.has(request) && pageEvents.failedRequests.length < 20) {
      pageEvents.failedRequests.push(
        `${requestLabel(request)}: ${request.failure()?.errorText || 'failed'}`,
      );
    }
    pageEvents.pendingRequests.delete(request);
  });
  p.on('pageerror', (err) => pageEvents.pageErrors.push(String(err.message).slice(0, 300)));
  p.on('console', (msg) => {
    if (msg.type() === 'error') pageEvents.consoleErrors.push(msg.text().slice(0, 300));
  });
  p.on('response', (res) => {
    if (res.status() >= 500) pageEvents.serverErrors.push(`${res.status()} ${res.url()}`);
  });
}

async function cmdLaunch(args) {
  const { chromium } = await import('playwright-core');
  const channels = args.channels || ['msedge', 'chrome'];
  const timeoutMs = args.timeoutMs || 20_000;
  // Only an explicit `false` opts into a real, visible OS window — every
  // existing caller (embedded screenshot preview, runtime smoke checks) omits
  // this and must keep getting the original headless behavior.
  const headless = args.headless !== false;
  let lastErr = '';
  for (const channel of channels) {
    try {
      browser = await chromium.launch({ channel, headless, timeout: timeoutMs });
      context = await browser.newContext({
        viewport: args.viewport || { width: 1280, height: 800 },
      });
      return { channel };
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
  }
  throw new Error(lastErr || 'no browser channel available');
}

async function cmdOpenAndNavigate(args) {
  if (!context) throw new Error('not launched');
  page = await context.newPage();
  resetPageEvents();
  attachListeners(page);
  try {
    await page.goto(args.url, { waitUntil: 'load', timeout: args.timeoutMs || 25_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function cmdScreenshot() {
  if (!page) throw new Error('no page open');
  const buf = await page.screenshot({ type: 'png' });
  return { buffer: buf.toString('base64') };
}

/** Click at page-space coordinates (already scaled from displayed image size by the caller). */
async function cmdClick(args) {
  if (!page) throw new Error('no page open');
  await page.mouse.click(args.x, args.y);
  return { ok: true };
}

/** Type literal text at the current focus (caller should click a field first). */
async function cmdType(args) {
  if (!page) throw new Error('no page open');
  await page.keyboard.type(String(args.text));
  return { ok: true };
}

/** Press a single named key — Playwright key names (e.g. "Enter", "Backspace", "ArrowLeft"). */
async function cmdPressKey(args) {
  if (!page) throw new Error('no page open');
  await page.keyboard.press(args.key);
  return { ok: true };
}

/** Scroll the page by a pixel delta. */
async function cmdScroll(args) {
  if (!page) throw new Error('no page open');
  await page.mouse.wheel(args.deltaX || 0, args.deltaY || 0);
  return { ok: true };
}

/**
 * Check whether a page-space point is (inside) a <select> and, if so, list
 * its options plus its on-page bounding box. A native <select>'s dropdown is
 * drawn by the OS/browser chrome, not the page — it never appears in a CDP
 * screenshot, so a raw mouse.click() "opens" something the user can't see
 * and can't click an option in. The frontend uses this to detect a select
 * BEFORE clicking and render its own dropdown UI instead, positioned/sized
 * from `rect` (previously placed at the raw click point with a fixed
 * min-width, which visibly drifted from the real select whenever the click
 * landed anywhere but its top-left corner).
 */
async function cmdInspectSelect(args) {
  if (!page) throw new Error('no page open');
  return page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const select = el && el.closest ? el.closest('select') : null;
      if (!select) return { isSelect: false };
      const r = select.getBoundingClientRect();
      return {
        isSelect: true,
        value: select.value,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        options: Array.from(select.options).map((o) => ({
          value: o.value,
          label: o.text,
          selected: o.selected,
          disabled: o.disabled,
        })),
      };
    },
    { x: args.x, y: args.y },
  );
}

/** Set a <select>'s value directly (bypasses the native dropdown entirely) and fire input/change so the page's own listeners react normally. */
async function cmdSelectOption(args) {
  if (!page) throw new Error('no page open');
  const ok = await page.evaluate(
    ({ x, y, value }) => {
      const el = document.elementFromPoint(x, y);
      const select = el && el.closest ? el.closest('select') : null;
      if (!select) return false;
      select.value = value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    { x: args.x, y: args.y, value: args.value },
  );
  if (!ok) throw new Error('no <select> element at that position');
  return { ok: true };
}

/** One-shot navigate + settle + collect + screenshot + close, mirroring browser-smoke.ts's per-path check. */
async function cmdCheckPath(args) {
  if (!context) throw new Error('not launched');
  if (page) await page.close().catch(() => {});
  page = await context.newPage();
  resetPageEvents();
  attachListeners(page);

  const finding = {
    httpStatus: 0,
    navigationError: null,
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
    screenshotPath: null,
  };
  try {
    const res = await page.goto(args.url, {
      waitUntil: 'load',
      timeout: args.timeoutMs || 25_000,
    });
    finding.httpStatus = res ? res.status() : 0;
    if (args.readySelector) {
      try {
        await page
          .locator(args.readySelector)
          .first()
          .waitFor({
            state: 'visible',
            timeout: args.readinessTimeoutMs ?? 25_000,
          });
      } catch (error) {
        throw new Error(`Application readiness failed: ${error.message}`);
      }
    }
    await page.waitForTimeout(args.settleMs || 2_000);
    if (args.screenshotPath) {
      await page.screenshot({ path: args.screenshotPath, fullPage: false }).catch(() => {});
      finding.screenshotPath = args.screenshotPath;
    }
  } catch (e) {
    finding.navigationError = (e && e.message ? e.message : String(e)).slice(0, 300);
  }
  finding.pageErrors = pageEvents.pageErrors;
  finding.failedRequests = pageEvents.failedRequests;
  finding.pendingRequests = [...pageEvents.pendingRequests.values()].slice(0, 20);
  if (!finding.screenshotPath && args.screenshotPath) {
    await page
      .screenshot({ path: args.screenshotPath, fullPage: false })
      .then(() => {
        finding.screenshotPath = args.screenshotPath;
      })
      .catch(() => {});
  }
  finding.consoleErrors = pageEvents.consoleErrors;
  finding.serverErrors = pageEvents.serverErrors;
  await page.close().catch(() => {});
  page = null;
  return finding;
}

async function cmdClose() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
  context = null;
  page = null;
  return { ok: true };
}

const HANDLERS = {
  launch: cmdLaunch,
  openAndNavigate: cmdOpenAndNavigate,
  screenshot: cmdScreenshot,
  click: cmdClick,
  type: cmdType,
  pressKey: cmdPressKey,
  scroll: cmdScroll,
  inspectSelect: cmdInspectSelect,
  selectOption: cmdSelectOption,
  checkPath: cmdCheckPath,
  close: cmdClose,
};

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Malformed input must not crash the worker or wedge the protocol.
  }
  const handler = HANDLERS[msg.cmd];
  if (!handler) {
    process.stdout.write(
      `${JSON.stringify({ id: msg.id, ok: false, error: `unknown cmd: ${msg.cmd}` })}\n`,
    );
    return;
  }
  try {
    const result = await handler(msg.args || {});
    process.stdout.write(`${JSON.stringify({ id: msg.id, ok: true, result })}\n`);
    if (msg.cmd === 'close') {
      // Flush the response before exiting so the client's `close` call resolves.
      setImmediate(() => process.exit(0));
    }
  } catch (e) {
    process.stdout.write(
      `${JSON.stringify({ id: msg.id, ok: false, error: e && e.message ? e.message : String(e) })}\n`,
    );
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx = buffer.indexOf('\n');
  while (idx >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) void handleLine(line);
    idx = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
