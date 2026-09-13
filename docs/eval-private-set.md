# 非公開評価セットと故障注入 E2E

Rapitas 専用の非公開評価セット（過去の実タスクから構築したコーパス）と、7 種の故障注入 E2E ハーネスの仕様・実行手順を記述する。

---

## 1. 三つの eval スクリプトの役割分離

本ハーネスは既存の 2 つの eval スクリプトを置き換えるものではない。測定対象が異なる。

| スクリプト | 測定対象 | 実行主体 | 外部依存 |
| --- | --- | --- | --- |
| `scripts/eval-gates.ts` | ゲートの決定的関数（`looksLogPolluted` / `validatePlan` 等）の正誤 | なし（純関数呼び出し） | なし |
| `scripts/eval-judge.ts` | 敵対的レビュージャッジの判定精度 | 実 LLM（`RAPITAS_EVAL_JUDGE=1` でのみ起動） | LLM API |
| `scripts/eval-private-set.ts` | タスク実行の fail-to-pass / pass-to-pass とオーケストレーターの障害耐性 | エージェント（既定はスタブ子プロセス） | 評価専用 DB・ローカル bare リポジトリ |

---

## 2. 実行フロー

```mermaid
flowchart TB
  A[app DB: 完了済み Task] --> B[eval-corpus-seed.ts]
  B --> C[EvalCorpusTask 分類済み・train/eval 分割済み]
  C --> D[eval-private-set.ts]
  D --> E[eval-runner: 1 実行 = 1 コーパス x 1 シナリオ]
  E --> F[EvalRun 行]
  F --> G[metrics-calculator]
  G --> H[EvalMetricSnapshot 9 指標]
```

1. `eval-corpus-seed.ts` が app DB の完了タスクを走査し、git 履歴から fix/base コミットを解決して分類する。
2. 解決できたものだけを `EvalCorpusTask` として評価 DB に凍結保存する。
3. `eval-private-set.ts` が eval 分割の各コーパスを baseline + 7 故障シナリオで実行する。
4. 各実行が `EvalRun` を 1 行残し、`metrics-calculator` が 9 指標を `EvalMetricSnapshot` に集計する。

---

## 3. ローカル実行手順

評価専用 DB を先に用意する。DB 名は `_eval` で終わる必要がある（後述のガード）。

```bash
createdb rapitas_eval

cd rapitas-backend
export RAPITAS_EVAL_DATABASE_URL='postgresql://rapitas:rapitas@localhost:5432/rapitas_eval'

# コーパス投入（30 件未満なら終了コード 1）
bun run scripts/eval-corpus-seed.ts --reset

# 1 件だけ試す
bun run scripts/eval-private-set.ts --sampleSize 1

# eval 分割の全件
bun run scripts/eval-private-set.ts
```

CI では `.github/workflows/eval-private-set.yml` が `workflow_dispatch` と週次スケジュールで実行する。PR ブロッキングゲート（`test-lint.yml`）には含まれない。

---

## 4. DB 分離

| 項目 | 内容 |
| --- | --- |
| 環境変数 | `RAPITAS_EVAL_DATABASE_URL`（必須。未設定ならフォールバックせず起動失敗） |
| DB 名の制約 | 末尾が `_eval` であること。`rapitas_dev` や `rapitas` は起動時に拒否される |
| 実装 | `services/eval-harness/db-guard.ts` が検証し、通過後にのみ `DATABASE_URL` を上書きする |
| 禁止事項 | 評価ハーネスから `config/database.ts` を import しないこと。同モジュールはトップレベルで app DB の `prisma` シングルトンを生成する |

`_eval` サフィックスの強制は、開発/本番の接続文字列をコピーペーストした場合に起動不能にするための機械的な遮断である。

---

## 5. 分類ルール

`Task` モデルに種別カラムが存在しないため、既存シグナルから導出する。複数合致時は表の上から順に採用する。

| 分類 | 判定ルール |
| --- | --- |
| `failure_recovery` | `blocked` から `in_progress` への遷移が存在、またはタイトルに「陳腐化」「テスト修正」を含む |
| `multi_service` | fix コミットが backend / frontend / desktop のうち 2 つ以上に触れている |
| `bug_fix` | タイトルが `[Bug]` で始まる、または fix コミット件名が `fix(` で始まる |
| `feature` | タイトルが `[Idea]` / `[Feature]` で始まる、または fix コミット件名が `feat(` で始まる |
| `investigation_only` | `workflowStatus` が `completed` かつ差分ファイル数が 0 |

どのルールにも合致しない候補は推測せず除外する。

### train / eval 分割

乱数を使わない。分類ごとに `sourceTaskId` 昇順で並べ、インデックスが 3 の倍数の要素を `eval`、残りを `train` とする（約 2:1）。再投入しても構成が変わらないことが非公開評価セットの前提であるため。

---

## 6. 故障注入 7 シナリオ

| シナリオ | 模擬内容 |
| --- | --- |
| `cli_exit_after_stop` | スタブ CLI が標準出力 0 バイトの時点で終了コード 1 で死ぬ |
| `stop_during_verification` | 実行中のスタブ子プロセスに実際に SIGTERM を送る |
| `db_write_failure` | 評価用 Prisma クライアントの N 回目の書込で例外を投げる |
| `duplicate_callback` | 同一完了コールバックが 2 回到達した状態を観測する |
| `response_lost_after_pr` | PR は作成済みだが呼び出し元に応答が返らない |
| `ci_failure` | CI ステータスが常に `failure` を返す |
| `process_restart` | 実行途中でエージェントプロセスを落とし、永続状態から再開できるかを見る |

`baseline`（故障なし）を加えた 8 種で 1 コーパスあたり 8 実行になる。

---

## 7. 9 指標

| 指標 | 算出式 | 対象 |
| --- | --- | --- |
| 初回受入率 | 初回試行のうち `failToPass=true` の割合 | baseline |
| 最終受入率 | 各コーパスの最終試行のうち `failToPass=true` の割合 | baseline |
| 誤完了率 | `outcome='false_complete'` の割合 | 全シナリオ |
| 人の介入率 | `humanInterventionCount > 0` の割合 | 全シナリオ |
| 再修正回数 | `repairAttempts` の平均 | baseline |
| 停止完了 p95 | 故障注入から完了までの ms の 95 パーセンタイル | 故障シナリオのみ |
| 成功 1 件あたり費用 | `costUsd` 合計 / 成功件数 | baseline |
| 成功 1 件あたり時間 | `durationMs` 合計 / 成功件数 | baseline |
| merge 後回帰率 | merge 済みのうち merge 後に回帰が出た割合 | baseline |

分母が 0 の指標は `0` ではなく `null` を保存する。「0% だった」と「一度も測っていない」は判断が正反対になるため、同じ値に潰さない。

---

## 8. 受入テストの改変禁止

`EvalCorpusTask.protectedTestFiles` にコーパス収集時点のテストファイルパスを凍結し、実行後の変更ファイル一覧と突き合わせる。1 つでも含まれていれば `outcome='false_complete'`、`reason='acceptance_test_modified'` として記録する。

実装は `services/eval-harness/acceptance-test-guard.ts` の独立モジュールであり、`services/agents/verification/verification-gate.ts` は変更していない。同ゲートの `protectedTestPathsFromSpec` は逆方向（仕様記載テストの変更を許可する）の機構であり、そこに禁止方向の分岐を混ぜると本番の検証ゲートの意味が全タスクで変わるため。

---

## 9. 既知の限界

| 項目 | 内容 |
| --- | --- |
| 記憶汚染 | 評価コーパスは実在の完了タスク由来のため、その解決内容が自己学習サブシステム（エピソード記憶・ナレッジベース）に既に記録されている可能性がある。実エージェントが正規のコーディングではなく想起で解いた場合、受入率が過大評価される |
| 現状の対処 | `RAPITAS_EVAL_MODE=1` を予約フラグとして設定するのみ。設定箇所は `eval-runner.ts` の `markEvalModeActive()`（エージェント生成の直前）と CI ワークフローの env の2箇所。**現時点ではどこもこのフラグを読んでおらず、何もブロックしない。** 想起の呼び出し箇所を特定次第、そこでこのフラグを見て評価コーパスタスクへの想起を無効化する拡張ポイント |
| 使い捨て Git リモート | ローカル bare リポジトリのみ。実 GitHub 上の使い捨てリポジトリは対象外（認証・レート制限・誤操作リスクを避けるため） |
| PR / CI | `FakePrBackend` によるインメモリ模擬であり、GitHub API の実挙動は検証しない |
| 既定のグレーダー | スタブ実行時はスタブが生成するマーカーファイルの有無で判定する。実コードを評価するグレーダーは baseline シナリオ側で `EvalTestRunner` を差し替えて注入する |
| baseline の実行主体 | `eval-private-set.ts` は `baselineProvider` を注入しないため、baseline シナリオもスタブで実行される。この状態の fail-to-pass / pass-to-pass は**実エージェントのコーディング精度ではない**。バッチ実行時に警告を標準エラーへ出力する。実測するには `executeEvalRun` の `deps.baselineProvider` に実プロバイダを注入する |

---

## 10. 検証環境の前提と、測定不能項目の扱い

`prisma/schema/eval-harness.prisma` を追加した直後の作業ツリーでは、以下の2項目は**測定できない**。失敗ではなく未到達である。

| 完了条件 | 前提 |
| --- | --- |
| `EvalCorpusTask` に 30 件以上・5 カテゴリ各 1 件以上を投入 | 評価 DB と、生成済み Prisma クライアント内の評価モデルの両方が必要 |
| `eval-private-set.ts --sampleSize 1` が終了コード 0 | 同上 |

理由は、生成済みクライアント（`generated/prisma-postgres` / `generated/prisma-sqlite`）に `EvalCorpusTask` 等のデリゲートがまだ存在しないためである。これらは dev.js が起動時に `prisma db push` と `db:generate` を実行して初めて生成される。CLAUDE.md 第1章が `prisma generate` の手動実行を禁じており（`generated/` は worktree からメインチェックアウトへのリンクで稼働中バックエンドと共有されている）、作業ツリー側から解消する手段はない。

**この2項目は、バックエンド再起動前は `⚠️ 環境ブロック` として扱う。`❌ 失敗` とは記載しない。** 判定の根拠は次のコマンドで機械的に確認できる。

```bash
# 0 が返る間は測定不能（再起動待ち）
grep -c "EvalCorpusTask" rapitas-backend/generated/prisma-postgres/index.d.ts
```

`createEvalPrismaClient()` はこの状態を沈黙して通さず、「モデルが未生成である」旨の明示的な例外で停止する。誤った DB へ書き込むことはない。

再起動後は、次の順で実測できる。

1. 評価用 DB を用意する（DB 名は `_eval` で終わること）
2. `bun run scripts/eval-corpus-seed.ts --reset` を実行し、投入件数を確認する
3. `bun run scripts/eval-private-set.ts --sampleSize 1` の終了コードを確認する

---

## 11. ファイル一覧

| ファイル | 役割 |
| --- | --- |
| `rapitas-backend/prisma/schema/eval-harness.prisma` | `EvalCorpusTask` / `EvalRun` / `EvalMetricSnapshot` の 3 モデル |
| `rapitas-backend/services/eval-harness/db-guard.ts` | 評価 DB 分離の強制 |
| `rapitas-backend/services/eval-harness/eval-prisma-client.ts` | 評価専用 Prisma クライアントのファクトリ |
| `rapitas-backend/services/eval-harness/corpus-classifier.ts` | 5 分類のヒューリスティックと train/eval 分割 |
| `rapitas-backend/services/eval-harness/corpus-collector.ts` | fix/base コミットの解決と候補収集 |
| `rapitas-backend/services/eval-harness/stub-agent-cli.ts` | 故障注入用の疑似 CLI 子プロセス |
| `rapitas-backend/services/eval-harness/stub-agent-provider.ts` | `IAgentProvider` 実装のスタブプロバイダ |
| `rapitas-backend/services/eval-harness/fake-git-remote.ts` | 使い捨て bare リポジトリの作成・マージ・破棄 |
| `rapitas-backend/services/eval-harness/fake-pr-backend.ts` | 疑似 PR 作成と CI ステータス |
| `rapitas-backend/services/eval-harness/db-write-fault-injector.ts` | DB 書込失敗の注入 |
| `rapitas-backend/services/eval-harness/acceptance-test-guard.ts` | 受入テスト改変の検知 |
| `rapitas-backend/services/eval-harness/eval-runner.ts` | 1 実行のオーケストレーション（worktree 準備・プロバイダ選択・故障注入のタイミング） |
| `rapitas-backend/services/eval-harness/eval-run-grading.ts` | 実行結果の判定（PR/CI 経由、テスト実行、merge 後再測定、`EvalRun` 行の書込） |
| `rapitas-backend/services/eval-harness/metrics-calculator.ts` | 9 指標の算出と保存 |
| `rapitas-backend/scripts/eval-corpus-seed.ts` | コーパス投入 CLI |
| `rapitas-backend/scripts/eval-private-set.ts` | 評価バッチ実行 CLI |
| `.github/workflows/eval-private-set.yml` | 週次・手動トリガーの CI ワークフロー |
