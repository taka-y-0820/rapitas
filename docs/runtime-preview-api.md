# ローカルの画面検証

Rapitas 自体の runtimeConfig では次の起動設定を使う。ランチャーが空きポートを確保し、`PORT` 環境変数と `{port}` に同じ値を設定する。

```json
{
  "start": "cd rapitas-frontend && npm run dev:runtime -- -p {port}",
  "url": "http://127.0.0.1:{port}",
  "healthPath": "/",
  "readyTimeoutMs": 120000,
  "checkPaths": ["/"]
}
```

`dev:runtime` は 127.0.0.1 だけにバインドし、画面と同じオリジンの `/__rapitas_api` を `http://127.0.0.1:3001` に転送する。ブラウザーの API URL もこの経路に固定するため、検証ごとに変わるポートをバックエンドの CORS 許可一覧に追加する必要はない。API サーバーは先に起動しておく。通常の開発・配布ビルドではこのプロキシは有効にならない。

HTTP 200 はアプリの準備完了を保証しない。画面の準備完了セレクターを設定し、タスク・フィルターの初期取得、API エラー、実行中プロセスの終了まで確認する。
