import type { NextConfig } from 'next';
import path from 'path';

const isTauriBuild = process.env.TAURI_BUILD === 'true';
const disableTurbopack = process.env.NEXT_TURBO === '0';
const isCI = process.env.CI === 'true';
const isRuntimePreview = process.env.RAPITAS_RUNTIME_PREVIEW === 'true';
const runtimePort = Number(process.env.PORT);
if (
  isRuntimePreview &&
  (isTauriBuild || !Number.isInteger(runtimePort) || runtimePort < 1024 || runtimePort > 65535)
) {
  throw new Error(
    'Runtime preview requires a web server and an explicit PORT between 1024 and 65535.',
  );
}

// NOTE: この config に webpack キー(splitChunks 等)を追加しないこと。Next 16 の Turbopack ビルドは
// 「webpack 設定あり・turbopack 設定なし」を validateTurboNextConfig が検出すると process.exit(1) で
// 強制失敗する(task #553 で実測)。バンドル予算は scripts/check-bundle-size.cjs の eager 限定判定で担保する。
const nextConfig: NextConfig = {
  // Runtime checks and local API links use the IPv4 loopback host. Next's
  // default localhost allowlist otherwise rejects their dev WebSocket/font requests.
  allowedDevOrigins: ['127.0.0.1'],

  // The owned runtime launcher allocates PORT. Serve its API on that same
  // loopback origin so preview ports need no permanent backend CORS grants.
  // Only the explicit dev:runtime command enables this fixed local target.
  ...(isRuntimePreview && {
    env: { NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${runtimePort}/__rapitas_api` },
    rewrites: async () => [
      { source: '/__rapitas_api/:path*', destination: 'http://127.0.0.1:3001/:path*' },
    ],
  }),

  // ビルド出力ディレクトリを環境で分離
  // CI環境では標準の.nextを使用（静的エクスポートは常にoutディレクトリに出力される）
  distDir: !isCI && isTauriBuild ? '.next-tauri' : '.next',

  // Turbopackのルートディレクトリをモノレポルートに設定（警告抑制）
  // CI環境でTurbopackが無効化されている場合はこの設定をスキップ
  // RAPITAS_TURBOPACK_ROOT: git worktree では node_modules が main チェックアウトへの
  // ジャンクションで、実体パスが worktree ルート外になる。runtime-smoke の app-launcher が
  // worktree と実体の共通祖先を算出してこの env に設定し、Turbopack の
  // "points out of the filesystem root" 起動失敗を回避する（未設定時は従来通り）。
  ...(disableTurbopack
    ? {}
    : {
        turbopack: {
          root: process.env.RAPITAS_TURBOPACK_ROOT
            ? path.resolve(process.env.RAPITAS_TURBOPACK_ROOT)
            : path.resolve(__dirname, '..'),
        },
      }),

  // Tauri用の静的エクスポート設定
  ...(isTauriBuild && {
    output: 'export',
    // 静的エクスポート時はImage Optimizationを無効化
    images: {
      unoptimized: true,
    },
  }),
};

export default nextConfig;
