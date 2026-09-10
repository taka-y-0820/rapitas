// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('RAPITAS_RUNTIME_PREVIEW', 'false');
  vi.stubEnv('TAURI_BUILD', 'false');
  vi.stubEnv('PORT', '');
});
afterEach(() => vi.unstubAllEnvs());

test('normal web and desktop configurations do not expose the preview proxy', async () => {
  let config = (await import('../../next.config')).default;
  expect(config.rewrites).toBeUndefined();
  expect(config.env).toBeUndefined();
  vi.resetModules();
  vi.stubEnv('TAURI_BUILD', 'true');
  config = (await import('../../next.config')).default;
  expect(config.rewrites).toBeUndefined();
  expect(config.output).toBe('export');
});

test('preview uses its allocated loopback origin and a fixed local API target', async () => {
  vi.stubEnv('RAPITAS_RUNTIME_PREVIEW', 'true');
  vi.stubEnv('PORT', '51494');
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://unrelated.example');
  const config = (await import('../../next.config')).default;
  expect(config.env?.NEXT_PUBLIC_API_BASE_URL).toBe('http://127.0.0.1:51494/__rapitas_api');
  expect(await config.rewrites?.()).toEqual([
    { source: '/__rapitas_api/:path*', destination: 'http://127.0.0.1:3001/:path*' },
  ]);
});

test.each(['', '0', '3001.5', '65536', 'invalid'])(
  'preview rejects an invalid allocated port: %s',
  async (port) => {
    vi.stubEnv('RAPITAS_RUNTIME_PREVIEW', 'true');
    vi.stubEnv('PORT', port);
    await expect(import('../../next.config')).rejects.toThrow('explicit PORT');
  },
);

test('preview cannot be combined with a desktop static export', async () => {
  vi.stubEnv('RAPITAS_RUNTIME_PREVIEW', 'true');
  vi.stubEnv('TAURI_BUILD', 'true');
  vi.stubEnv('PORT', '51494');
  await expect(import('../../next.config')).rejects.toThrow('web server');
});
