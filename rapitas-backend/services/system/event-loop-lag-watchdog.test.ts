/**
 * event-loop-lag-watchdog ユニットテスト
 *
 * 閾値超過時にWARNが発火すること、およびメッセージが常に固定の小数点以下1桁の
 * digit shape ("~#.#s") に正規化されること（#864: 秒数埋め込みによる懸念シグネチャ
 * 分裂の再発防止）を検証する。
 */
import { describe, it, test, expect, mock, afterEach } from 'bun:test';

type WarnCall = [Record<string, unknown>, string];

const warnCalls: WarnCall[] = [];
const noopLogger = {
  info: () => {},
  error: () => {},
  warn: (fields: Record<string, unknown>, msg: string) => {
    warnCalls.push([fields, msg]);
  },
  debug: () => {},
  fatal: () => {},
};

mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

const { formatEventLoopLagMessage, startEventLoopLagWatchdog, stopEventLoopLagWatchdog } =
  await import('./event-loop-lag-watchdog');

function normalize(msg: string): string {
  return msg.replace(/\d+/g, '#');
}

/** Advance the real watchdog callback with an exact, controlled clock. */
function triggerLag(lagMs: number): void {
  const realNow = Date.now;
  const realInterval = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let clockMs = 10_000;
  let tick: (() => void) | undefined;
  let intervalMs = 0;
  Date.now = () => clockMs;
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    tick = callback;
    intervalMs = ms;
    return 1;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    startEventLoopLagWatchdog();
    expect(intervalMs).toBe(500);
    expect(tick).toBeDefined();
    clockMs += intervalMs + lagMs;
    tick!();
  } finally {
    stopEventLoopLagWatchdog();
    Date.now = realNow;
    globalThis.setInterval = realInterval;
    globalThis.clearInterval = realClear;
  }
}
describe('formatEventLoopLagMessage', () => {
  it('formats a fractional-second lag with one decimal place', () => {
    expect(formatEventLoopLagMessage(2161)).toBe('Event loop stalled ~2.2s');
  });

  it('formats an integer-second lag with a trailing .0 (not bare seconds)', () => {
    expect(formatEventLoopLagMessage(2001)).toBe('Event loop stalled ~2.0s');
  });

  it('normalizes integer-second and fractional-second lags to the same signature', () => {
    const integerLagMsg = formatEventLoopLagMessage(2001);
    const fractionalLagMsg = formatEventLoopLagMessage(2161);
    expect(normalize(integerLagMsg)).toBe(normalize(fractionalLagMsg));
    expect(normalize(integerLagMsg)).toBe('Event loop stalled ~#.#s');
  });

  it('normalizes a large lag (11354ms) to the same signature shape', () => {
    expect(normalize(formatEventLoopLagMessage(11354))).toBe('Event loop stalled ~#.#s');
  });
});

describe('event-loop-lag-watchdog', () => {
  afterEach(() => {
    stopEventLoopLagWatchdog();
    warnCalls.length = 0;
  });

  test('does not warn at the threshold and warns immediately above it', () => {
    triggerLag(2000);
    expect(warnCalls).toHaveLength(0);
    triggerLag(2001);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][0].lagMs).toBe(2001);
  });

  test('閾値超過時にWARNが発火し、lagMsは構造化フィールドとして保持される', async () => {
    triggerLag(5000);

    expect(warnCalls.length).toBeGreaterThan(0);
    const [fields, msg] = warnCalls[0];
    expect(msg).toBe(formatEventLoopLagMessage(fields.lagMs as number));
    expect(typeof fields.lagMs).toBe('number');
    expect(fields.lagMs as number).toBeGreaterThan(2000);
  });

  test('lagMsの値(整数秒/小数秒)によらずメッセージのシグネチャは同一になる', async () => {
    triggerLag(2001);
    stopEventLoopLagWatchdog();
    const firstMsg = warnCalls[0]?.[1];
    warnCalls.length = 0;

    triggerLag(2700);
    const secondMsg = warnCalls[0]?.[1];

    expect(firstMsg).toBeDefined();
    expect(secondMsg).toBeDefined();
    expect(normalize(firstMsg as string)).toBe(normalize(secondMsg as string));
    expect(normalize(firstMsg as string)).toBe('Event loop stalled ~#.#s');
  });
});
