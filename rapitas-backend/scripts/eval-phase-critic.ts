/**
 * Phase Critic Comparison Eval (opt-in, live LLM calls) — task 911
 *
 * Measures whether the research/plan critic gate (services/workflow/phase-critic/)
 * (1) actually detects a narrow research.md that omits task909's real acceptance
 * criteria gap (AC3/4/5 vs the task901 mismatch), (2) does NOT false-bounce an
 * adequate control research.md that addresses every criterion at research depth,
 * and (3) detects task909's real plan's overly narrow mismatch handling.
 * Approval history is not evidence that this defective plan should pass.
 *
 * Because this makes real API calls (cost + non-determinism), it is OPT-IN:
 * set RAPITAS_EVAL_PHASE_CRITIC=1 to run; otherwise it prints a skip notice and
 * exits 0 (never breaks an unconfigured CI).
 *
 * Run: `RAPITAS_EVAL_PHASE_CRITIC=1 bun run scripts/eval-phase-critic.ts`
 */
import { createHash } from 'node:crypto';
import {
  critiquePhase,
  buildCriticUserMessage,
  type CriticContext,
} from '../services/workflow/phase-critic/phase-critic';
import { getDefaultProvider, getDefaultModel } from '../utils/ai-client';
import {
  writePhaseCriticEvalResult,
  type PhaseCriticEvalCaseResult,
} from '../services/observability/eval-phase-critic-results';

/** Task 909's real acceptance criteria (fetched 2026-09-09 via GET /tasks/909). */
const TASK_909_TASK_BRIEF =
  '[監督実測] 受入基準の抽出が調査証跡を実装義務に変換しないようにする\n[監督レビュー・計画前の必須確認]\nこのタスクは.supervisor/というパスだけを拒否する修正では完了しない。初回researchの推奨Bとその追補は、元の受入条件3/4/5を満たさないため設計修正が必要。\n具体例: task901の正当な受入条件は「停止・完了を質問待ちと混同しない」。planはstatus-transition.tsを非対象にしたが、実測でcompleted→awaiting_question上書きが再現された。この要件・計画・検証結果の矛盾は.supervisor/を含まなくても自律再計画で回復すること。正常な無関係の既存失敗と区別し、元の明示条件を削除したり懸念へ移しただけで完了させない。\n「既存コードがパスを参照していない→そのパスを対象とする正当な要件はあり得ない」という研究の推論は不成立。過去の調査証跡と将来の要求を区別し、パス名に依存しない例と、明示的にそのパスを対象にする正当な要求を保存する例で検証すること。\n新しい再計画はsystem由来として監査し、人間のヘッダや指示を偽装しない。停止/完了保護・DB失敗時の停止・競合ガード・回数制限を実装検証する。既存plan guardを安全性検証済みとみなしてコピーしない。\n以下は元のタスク説明と監督記録（保持）:\nタスク906のacceptanceCriteriaが、監督の過去の再現記録（監督用probeを作った、一時テストを撤去した）から抽出され、Rapitasに監督専用ファイルの作成を要求していた。実際の実装要件と分離できず、実行3914は狭いplanを根拠に残存欠陥を懸念9303へ送って成功とした。受入基準生成・plan整合・verifier入力の境界を調査し修正する。証跡: task906の旧acceptanceCriteria、実行3913/3914、監督journal 2026-09-08。\n[監督実測 task901 / execution3926 2026-09-09]';

const TASK_909_ACCEPTANCE_CRITERIA = [
  '過去の調査結果・再現方法・監督側ファイルの説明を将来の実装義務として抽出しない回帰テストがある。',
  '明示的に設定された受入条件が後続の自動抽出で劣化しない。',
  '受入基準と承認済みplanが不整合なら成功宣言せず、正当な計画更新または保留へ進む。',
  '検証者が未達の受入条件を別の懸念へ移しただけで完了しない。',
  '検証で証明された要件と計画の不整合について、人の発行元を偽装せず、回数制限・停止/完了の状態保護・監査記録を伴う自動再計画経路を検証する。DBエラーや競合では進行せず、通常の無関係な既存失敗は誤って再計画しない。',
];

/** Task 909's real, saved plan.md body (fetched 2026-09-09 via GET /workflow/tasks/909/files). */
const TASK_909_REAL_PLAN: string =
  "# 実装計画\r\n\r\n## タスク概要\r\n\r\ntask906のacceptanceCriteriaが、監督自身の再現調査ナラティブ（`.supervisor/measurements/task906-red.patch`、`task906-validator-probe.ts`等の監督専用スクラッチファイルへの言及）を含む自由記述descriptionから、`deriveTaskSpec()`によってフィルタなしでAI抽出され、実装義務であるかのように保存された。既存の受入基準汚染検出（`spec-coherence-checker.ts`）は「他タスクからの引用」しか検出できず、同一タスク内の自己ナラティブ混入には対応していない。さらに、受入基準↔差分マッチ（`acceptance-self-check.ts`）はADVISORY設計で完了可否を左右せず、verify差し戻し文面は「正規の再計画へ進め」と指示するが、その正規の再計画を行う手段（人間専用の`revise-plan`、`plan_approved`状態での`PUT plan`禁止）がエージェントに一切与えられていない。結果としてexecution 3914は、狭いplan.mdを盾に未達の受入基準を懸念9303へ送るだけで「成功」を宣言した。\r\n\r\n本計画は、(1) 抽出段階での混入防止、(2) 既存基準への防御的な汚染検出拡張、(3) 構造的に充足不可能な受入基準が生き残った場合の、境界付き・監査付き・人間発を偽装しないシステム主導の自動再計画経路、の3層で対処する。\r\n\r\n## 既存機能チェック\r\n\r\n新規機能ではなく、既存の3つのサブシステム（`task-spec-deriver`、`spec-coherence-checker`＋`intake-gate`、`status-transition`のverify遷移）への欠陥修正・拡張である。\r\n\r\n| ファイル | 役割 | 本タスクでの扱い |\r\n| --- | --- | --- |\r\n| `rapitas-backend/services/task/task-spec-deriver.ts` | 自由記述→AI一発抽出でgoals/constraints/acceptanceCriteriaを生成 | 変更対象（`.supervisor/`参照の事後フィルタを追加） |\r\n| `rapitas-backend/services/intake/spec-coherence-checker.ts` | 受入基準汚染検出（他タスク由来の語彙のみ） | 変更対象（同一タスク内の監督専用パス参照を検出する関数を追加） |\r\n| `rapitas-backend/services/intake/intake-gate.ts` | 汚染検出結果→`awaiting_question`一時停止 | 変更対象（`findLiftedCriteria`の呼び出し条件を修正し、新検出器を常時実行） |\r\n| `rapitas-backend/routes/workflow/handlers/file-save/status-transition.ts` | verify.md保存時の状態遷移計算 | 変更対象（新規チェック呼び出し＋分岐を1箇所追加。既存の`validateVerify`severity>=80分岐・`verifyRerunAlreadyDone`ロジックには触れない） |\r\n| `rapitas-backend/services/workflow/verify-requirement-plan-mismatch.ts`（新規） | `.supervisor/`参照の構造的充足不可能性を検出し、境界付き自動再計画を実行 | 新規作成（`workflow-orchestrator-plan-guard.ts`の`plan_invalid_replan`パターンを転用） |\r\n| `rapitas-backend/services/workflow/workflow-requirement-mismatch-context.ts`（新規） | システム発の再計画理由をplanner promptへ注入 | 新規作成（人間発`workflow-plan-revision-context.ts`とは完全に別の経路） |\r\n| `rapitas-backend/services/workflow/workflow-planner-context.ts` | planner用コンテキスト組み立て | 変更対象（新規context-builderの呼び出しを1行追加） |\r\n\r\n> 変更しないファイル: `verify-self-repair.ts`本体、`phase-output-validator.ts`、`completion-gate.ts`、`workflow-plan-revision-context.ts`（人間発の出所検査ロジック）、`workflow-handlers-plan-revision.ts`（`X-Rapitas-Source`ヘッダ検査）。CLAUDE.mdの保護ファイル一覧および制約「既存の人間向け計画変更や状態変更APIの出所検査を偽装・削除しない」を厳守するため、これらは一切変更しない。\r\n\r\n## 設計判断の根拠\r\n\r\n### 採用したアプローチ（research.mdの選択肢B）\r\n\r\n| 観点 | 内容 |\r\n| --- | --- |\r\n| 方針 | (1)抽出時フィルタ＋(2)汚染検出拡張＋(3)`.supervisor/`限定の新規自動再計画パスの3層実装 |\r\n| 採用理由 | 選択肢A（抽出フィルタのみ）はAC#5「自動再計画経路を検証する」を満たさない——task906は非収束カットオフの閾値（同一基準2回以上差し戻し）に達する前の1回目で懸念起票→成功宣言されており、既存の`verify_no_convergence`エスカレーション（`verify-self-repair.ts:163-207`）では捕捉できない。選択肢C（acceptance self-checkの完全ハードゲート化）は`computeOverallOk`の設計意図（日本語受入基準↔パストークンマッチングの偽陽性リスク、task 298と同型の再発）を覆し、無関係な既存失敗を誤って再計画/ブロックするリスクが高く、制約「通常の無関係な既存失敗は誤って再計画しない」に反しやすい。選択肢Bは`.supervisor/`という**構造的に確実で偽陽性ゼロ**なシグナルに新規パスのトリガーを限定するため、既存の非収束カットオフや`acceptance` advisory設計を変更せずに共存できる |\r\n| 却下した代替案 | 上記A・C。詳細はresearch.mdの選択肢表を参照 |\r\n\r\n### データモデル/状態管理の決定\r\n\r\n| 決定 | 内容 | 理由 |\r\n| --- | --- | --- |\r\n| 新規`WorkflowTransition.cause` | `requirement_plan_mismatch_replan`（システム発の再計画） | 既存の`plan_revision_requested`（`PLAN_REVISION_CAUSE`、人間発）とは意図的に別名にする。同じcauseを使うと「人間が計画修正を依頼した」ログと「システムが検出して自動でロールバックした」ログが監査上区別できなくなり、制約「人の発行元を偽装しない」に反する |\r\n| ロールバック先status | `draft`（`plan_invalid_replan`と同じ。plan.mdは`archiveWorkflowFile`で退避） | `research.md`は退避しないため、reuse-check（`isReusableArtifact`）が有効なら再生成されずスキップされ、プランナーだけが再実行される。既存の`plan_invalid_replan`と全く同じ挙動なので新しい状態遷移パターンを増やさない |\r\n| 上限値 | `MAX_REQUIREMENT_REPLANS = 3`（`workflow-orchestrator-plan-guard.ts`の`MAX_PLAN_REPLANS`と同値） | 既存の再計画ループ上限と同じ基準を踏襲し、運用上の一貫性を保つ。60分ウィンドウでのカウントも`plan_invalid_replan`と同じ`countWithFailClosed`パターンを流用する（DBエラー時はfail-closed=上限扱いでブロック側に倒す。制約「DBエラーや競合では進行せず」を満たす） |\r\n| 検出シグナル | 受入基準（`resolveAcceptanceCriteria`で解決した配列）の各要素に`.supervisor/`を含むパスらしきトークンが含まれるか（`extractReferenceTokens`の正規表現ロジックを流用） | research.mdの前提監査#4で確認した通り、Rapitasのバックエンドコードは`.supervisor/`を一切参照しない。ゆえにこのパスへの言及は「監督オペレータの外部スクラッチ領域の記述が要求文に混入した」ことの確実な証拠であり、誤検出リスクが構造的にゼロ |\r\n| 停止状態ガード | `task.status==='todo'`かつ直近transitionのcauseが`manual_execution_stop_revert`/`manual_execution_stop_withdraw`/`auto_run_stop_revert`のいずれかなら、新規再計画パスは何もせず`{done:false}`を返す | `status-transition.ts:62-77`の既存の停止検知パターンをそのまま踏襲。制約「停止中のテーマを変更に伴って自動再開しない」を満たす |\r\n\r\n### 互換性/マイグレーション方針\r\n\r\nスキーマ変更なし（`WorkflowTransition.cause`は既存の自由文字列列、`Task.acceptanceCriteria`は既存のJSON文字列列をそのまま読むだけ）。既存タスクのacceptanceCriteriaに`.supervisor/`参照が既に紛れ込んでいる場合（task906含む）は、次にverify.mdを保存したタイミングで新規チェックが発火し、`awaiting_question`（intake-gate拡張、まだ研究/計画フェーズ未着手なら）または再計画ロールバック（verify段階まで進んでいれば）のいずれかに自然に乗る。過去データへの一括マイグレーションスクリプトは作成しない（スコープ外、必要なら別懸念として起票）。\r\n\r\n### エッジケースの方針\r\n\r\n| ケース | 期待される振る舞い | 理由 |\r\n| --- | --- | --- |\r\n| `.supervisor/`参照が受入基準に含まれるが、intake-gate拡張で既に`awaiting_question`として止められ、ユーザーが基準を訂正して回答済み | 訂正後の基準に`.supervisor/`が残っていなければ以降の新規パスは発火しない。万一残っていても`hasAnsweredIntakeQuestion`と同様のロジックで無限ループにはしない（1回だけ問い、以降は通す） | `intake-gate.ts:89-104`の既存の「一度聞いたら通す」パターンをそのまま踏襲するため |\r\n| `.supervisor/`参照を含まない、通常の（曖昧な）受入基準未達 | 新規再計画パスは発火しない。既存の`verify_no_convergence`（同一基準2回以上差し戻しでエスカレーション、人間へ「revise-planから依頼してください」と通知）に委ねる | 制約「通常の無関係な既存失敗は誤って再計画しない」を満たすため。新規パスのトリガーは`.supervisor/`シグナルのみに厳密に限定する |\r\n| 再計画ロールバック中にDB更新が失敗する | `prisma.task.update`の結果を確認し、失敗時はログを残してその回の遷移をスキップ（次のverify保存で再評価される。`plan_invalid_replan`の`writeBlockedStatusDurable`と同じ「2回失敗したら通知して人手に委ねる」パターンを踏襲） | 制約「DBエラーや競合では進行せず」を満たす |\r\n| `MAX_REQUIREMENT_REPLANS`到達後も`.supervisor/`参照が残っている | `writeBlockedStatusDurable`でblocked化し、通知を出す（`plan_invalid_replan`と同じ）。silent completeやconcern起票だけでの成功宣言は行わない | AC#4「検証者が未達の受入条件を別の懸念へ移しただけで完了しない」を満たす |\r\n| verify.md保存時、`validateVerify`のseverity>=80分岐（自己矛盾等）と新規`.supervisor/`検出が同時に該当する | severity>=80分岐（既存、より一般的な構造検証）を先に評価し、そちらがヒットしたら新規チェックは評価しない（二重の状態遷移記録を避ける） | research.mdの仮説にある「二重の遷移記録」リスクを設計時点で排除するため。既存のverify_repair分岐を優先することで、既存テスト（`status-transition.test.ts`）への影響も最小化できる |\r\n\r\n## 実装チェックリスト\r\n\r\n### 1. 抽出フィルタ（task-spec-deriver.ts）\r\n\r\n- [ ] `parseSpec()`が返す`goals`/`constraints`/`acceptanceCriteria`の各要素から、`.supervisor/`（大文字小文字無視、`\\`区切りも許容）を含む文字列を除外する`filterInvestigationArtifacts(items: string[]): string[]`関数を新規追加し、`parseSpec()`内で適用する\r\n  - 期待動作: AIの生返答に`.supervisor/measurements/task906-red.patch`を含む基準があっても、`deriveTaskSpec()`の戻り値にはそれが含まれない\r\n  - 確認方法: `task-spec-deriver.test.ts`に新規テストを追加し、`mockSendAIMessage`が`.supervisor/`参照込みのJSONを返すケースで検証\r\n- [ ] `SYSTEM_PROMPT`（25-34行目）に「監督/検証者自身の調査手順・再現記録・作業環境のファイルパスへの言及は実装義務として抽出しないこと」という一文を追加する（多層防御。AIの追従性に依存しないが、コスト削減のため一次防御として機能させる）\r\n  - 期待動作: プロンプト変更のみ、既存の空文字/AIエラー系テストには影響しない\r\n  - 確認方法: 既存テストが全てPASSすることを確認（振る舞い変更なし、文言追加のみ）\r\n\r\n### 2. 汚染検出拡張（spec-coherence-checker.ts）\r\n\r\n- [ ] `findSupervisorArtifactCriteria(criteria: string[]): ContaminatedCriterion[]`を新規追加。各criterionに対し`extractReferenceTokens`（`acceptance-self-check.ts`からimport）でトークン抽出し、`.supervisor/`で始まる（または`/.supervisor/`を含む）トークンがあれば`ContaminationKind`に新値`'investigation_artifact'`を追加してヒットとして返す\r\n  - 期待動作: `.supervisor/measurements/task906-red.patch`を含む基準がヒットし、`sourceTaskId`は該当タスク自身のID（他タスク由来ではないため、`ReferencedTask`型を流用せず`sourceTaskId: null`を許容する型拡張が必要——`ContaminatedCriterion.sourceTaskId`を`number | null`に変更）\r\n  - 確認方法: `spec-coherence-checker.test.ts`に新規テストケースを追加\r\n- [ ] `findContaminatedCriteria()`の末尾（207行目付近）で`findSupervisorArtifactCriteria(criteria)`の結果もマージする（`flagged`セットで重複除外は既存パターンをそのまま踏襲）\r\n  - 期待動作: `#id`引用の有無に関わらず、`.supervisor/`参照は必ず検出される\r\n  - 確認方法: 既存の`quoted_title`/`coined_phrase`系テストが全てPASSし続けること＋新規テストがPASSすること\r\n\r\n### 3. intake-gate呼び出し条件の修正\r\n\r\n- [ ] `findLiftedCriteria()`（`intake-gate.ts:160-173`）を修正し、`ids.length === 0`でも`findSupervisorArtifactCriteria(criteria)`だけは実行してマージする（他タスク由来の検出は従来通り`ids.length===0`なら即returnでよいが、監督専用パス検出は`#id`参照の有無と無関係に常時実行する）\r\n  - 期待動作: `#id`参照が皆無のtask906相当のケースでも`contaminated.length > 0`となり、`raiseContaminationQuestion`が呼ばれる\r\n  - 確認方法: `intake-gate.test.ts`に統合テストを追加（`.supervisor/`参照を含むacceptanceCriteriaを持つタスクが`ensureIntakeReady`実行後に`awaiting_question`へ遷移することを確認）\r\n- [ ] `raiseContaminationQuestion()`（`intake-gate.ts:183-238`）の文言を、`kind==='investigation_artifact'`の場合は「別タスクの内容」ではなく「監督/検証者自身の調査記録・専用ファイルへの言及」向けに分岐させる（`sourceTaskId`がnullの場合の表示分岐を追加）\r\n  - 期待動作: 質問文が「タスク#123の用語」ではなく「調査記録・専用ファイルへの言及」であることを正しく説明する\r\n  - 確認方法: 生成されたquestion.md文言のスナップショット的アサーション（既存テストの文字列比較パターンを踏襲）\r\n\r\n### 4. 新規: 境界付き自動再計画（verify-requirement-plan-mismatch.ts）\r\n\r\n- [ ] 新規ファイルを作成し、`detectSupervisorArtifactMismatch(acceptanceCriteria: string[]): boolean`（`.supervisor/`参照の有無を判定、`spec-coherence-checker.ts`の`findSupervisorArtifactCriteria`を再利用）と`attemptRequirementPlanReplan(taskId, currentStatus): Promise<{ replanned: boolean; ... }>`をexportする\r\n  - `attemptRequirementPlanReplan`の内部ロジックは`workflow-orchestrator-plan-guard.ts`の`guardPlanValidity`（44-158行目）を骨格としてコピーではなく再実装し、以下を`import`で共有する: `countWithFailClosed`（`utils/database/fail-closed-count`）, `writeBlockedStatusDurable`（`durable-blocked-write`）, `scheduleWorkflowRedispatch`（`workflow-redispatch`）, `archiveWorkflowFile`（`workflow-file-utils`）\r\n  - 停止状態ガード: `prisma.task.findUnique`で`status`と最新`WorkflowTransition.cause`を取得し、`status-transition.ts:62-77`と同じ判定で停止中なら即`{replanned: false}`を返す\r\n  - カウント対象cause: `requirement_plan_mismatch_replan`（新規、60分ウィンドウ、`MAX_REQUIREMENT_REPLANS=3`）\r\n  - 上限到達時: `writeBlockedStatusDurable` + 通知（`plan_invalid_replan_exhausted`と同型だが新cause）。**silent completeやconcern起票だけでの成功宣言はしない**\r\n  - 期待動作: `.supervisor/`参照を含む受入基準を持つタスクがverify.mdを保存した際、`completed`/`verify_done`ではなく`draft`へロールバックされ、plan.mdが退避される\r\n  - 確認方法: `verify-requirement-plan-mismatch.test.ts`（新規）で(a)検出→ロールバック、(b)3回目でblock、(c)停止中タスクはスキップ、(d)`.supervisor/`を含まない基準では発火しない、の4ケースを検証\r\n- [ ] `recordTransition`呼び出しに`metadata: { criterion: <該当基準文字列>, reason: 'supervisor_artifact_reference' }`を含め、後から監査できるようにする\r\n  - 期待動作: `WorkflowTransition`テーブルを見れば「なぜ再計画されたか」が具体的な基準文字列付きで追跡できる\r\n  - 確認方法: テストで`recordTransition`のmetadata引数をアサート\r\n\r\n### 5. status-transition.tsへの接続\r\n\r\n- [ ] verify分岐（`status-transition.ts`の`else if (fileType === 'verify')`ブロック、既存の`validateVerify`severity>=80チェックの直後）に、severity>=80分岐が発火**しなかった**場合のみ、`task.acceptanceCriteria`を取得して`detectSupervisorArtifactMismatch()`→`attemptRequirementPlanReplan()`を呼ぶ分岐を追加する\r\n  - 期待動作: 通常のverify.md保存（`.supervisor/`参照なし）では新規分岐は完全にスキップされ、既存の遷移ロジックに一切影響しない\r\n  - 確認方法: `status-transition.test.ts`の既存テストが全てPASSし続けること＋新規テストケース（`.supervisor/`参照ありの場合に新分岐が発火すること）を追加\r\n\r\n### 6. plannerコンテキストへの注入（workflow-requirement-mismatch-context.ts + workflow-planner-context.ts）\r\n\r\n- [ ] 新規ファイル`workflow-requirement-mismatch-context.ts`に、`workflow-plan-revision-context.ts`の`renderPlanRevision`/`getPendingPlanRevision`/`buildPlanRevisionContext`と同じ形（ただしcause=`requirement_plan_mismatch_replan`を読む）を持つ`buildRequirementMismatchContext(taskId, currentPlan, language)`を実装する。文言は「システムが検出した要件-計画不整合」であることを明記し、人間の指示であるかのような文言にしない\r\n  - 期待動作: 該当transitionが存在する場合のみplanner promptに注入され、無ければ空文字列\r\n  - 確認方法: `workflow-requirement-mismatch-context.test.ts`（新規）で`renderPlanRevision`相当のpure関数をユニットテスト\r\n- [ ] `workflow-planner-context.ts`の`buildPlanRevisionContext`呼び出し（50-56行目）の直後に、`buildRequirementMismatchContext`の呼び出しを追加する\r\n  - 期待動作: plannerがロールバック理由（`.supervisor/`参照の除去またはplan拡張の要否判断）を読める\r\n  - 確認方法: 既存の`buildPlannerContext`関連テストが全てPASSし続けること\r\n\r\n## 変更予定ファイル\r\n\r\n| # | ファイル | 種別 | 目的と理由 |\r\n| -- | --- | --- | --- |\r\n| 1 | `rapitas-backend/services/task/task-spec-deriver.ts` | 変更 | 抽出結果から`.supervisor/`参照を除外する事後フィルタを追加（一次防御） |\r\n| 2 | `rapitas-backend/services/task/task-spec-deriver.test.ts` | 変更 | フィルタの回帰テスト追加 |\r\n| 3 | `rapitas-backend/services/intake/spec-coherence-checker.ts` | 変更 | 同一タスク内の監督専用パス参照を検出する`findSupervisorArtifactCriteria`を追加。`ContaminatedCriterion.sourceTaskId`を`number \\| null`に型拡張 |\r\n| 4 | `rapitas-backend/services/intake/spec-coherence-checker.test.ts` | 変更 | 新検出関数のテスト追加 |\r\n| 5 | `rapitas-backend/services/intake/intake-gate.ts` | 変更 | `findLiftedCriteria`の呼び出し条件修正＋質問文言の分岐追加 |\r\n| 6 | `rapitas-backend/services/intake/intake-gate.test.ts` | 変更 | `.supervisor/`参照タスクが`awaiting_question`へ遷移する統合テスト追加 |\r\n| 7 | `rapitas-backend/services/workflow/verify-requirement-plan-mismatch.ts` | 新規 | `.supervisor/`限定の構造的充足不可能性検出＋境界付き自動再計画 |\r\n| 8 | `rapitas-backend/services/workflow/verify-requirement-plan-mismatch.test.ts` | 新規 | 上記のユニットテスト（検出/ロールバック/上限/停止ガード/無関係失敗の非発火） |\r\n| 9 | `rapitas-backend/services/workflow/workflow-requirement-mismatch-context.ts` | 新規 | システム発の再計画理由をplanner promptへ注入する関数群（人間発と別経路） |\r\n| 10 | `rapitas-backend/services/workflow/workflow-requirement-mismatch-context.test.ts` | 新規 | 上記のユニットテスト |\r\n| 11 | `rapitas-backend/services/workflow/workflow-planner-context.ts` | 変更 | 新規context-builderの呼び出しを1行追加 |\r\n| 12 | `rapitas-backend/routes/workflow/handlers/file-save/status-transition.ts` | 変更 | verify分岐に新規検出→再計画呼び出しを1箇所追加（既存のseverity>=80分岐がヒットしなかった場合のみ） |\r\n| 13 | `rapitas-backend/routes/workflow/handlers/file-save/status-transition.test.ts` | 変更 | 新規分岐のテスト追加（既存テストは非破壊） |\r\n\r\n> plan.md外のファイルを触りたくなった場合はそれ自体が計画漏れであり、実装を止めて報告すること。特に`verify-self-repair.ts`本体・`phase-output-validator.ts`・`completion-gate.ts`・`workflow-plan-revision-context.ts`・`workflow-handlers-plan-revision.ts`は本計画の対象外であり、変更しないこと。\r\n\r\n## リスク評価と対策\r\n\r\nresearch.mdの「リスク評価」表を継承。追加の実装レベルのリスクのみ以下に記す。\r\n\r\n| 重要度 | リスク | 対策 |\r\n| --- | --- | --- |\r\n| 中 | `status-transition.ts`（389行）への変更で300-500行ファイルサイズ方針に抵触しうる | 新規分岐は`detectSupervisorArtifactMismatch`/`attemptRequirementPlanReplan`の2関数呼び出し＋10行程度の分岐に留め、ロジック本体は新規ファイルに隔離する。それでも500行を超える場合は既存のverify分岐部分を`status-transition-verify.ts`のような形で先に分割してから追加する（実装者判断） |\r\n| 中 | `ContaminatedCriterion.sourceTaskId`の型変更（`number`→`number \\| null`）が既存の呼び出し元（`raiseContaminationQuestion`の`c.sourceTaskId`表示ロジック等）を壊す可能性 | 型変更箇所を`grep -rn \"sourceTaskId\"`で全て洗い出し、`intake-gate.ts`の表示分岐を確実に更新する。tscの型エラーで機械的に検出できる |\r\n| 低 | `MAX_REQUIREMENT_REPLANS`のカウントに使う`countWithFailClosed`のシグネチャが`plan_invalid_replan`専用に書かれている可能性 | 実装前に`utils/database/fail-closed-count.ts`のシグネチャを確認し、汎用（cause文字列を引数化できる）であることを確認する。専用実装であれば汎用化してから両方の呼び出し元で使う |\r\n\r\n## プレモーテム\r\n\r\n想定される失敗原因3つと早期検知シグナル:\r\n\r\n1. **失敗原因**: `.supervisor/`検出という単一シグナルに頼ったことで、監督が今後別のディレクトリ名（例: `.observer/`や絶対パス表記の揺れ）を使い始めると検出漏れが再発する。\r\n   **早期検知シグナル**: 実装完了後、`spec-coherence-checker.test.ts`に「他の想定外パス表記」のテストケースを意図的に含めず、検証フェーズで「このパターンは`.supervisor/`のみを見ている」ことをverify.mdに明記させ、拡張の必要性を懸念として起票させる（本計画のスコープを正直に申告する設計）。\r\n\r\n2. **失敗原因**: 新規再計画パス（`verify-requirement-plan-mismatch.ts`）が`status-transition.ts`に接続される際、既存の`validateVerify`severity>=80分岐との実行順序を誤り、両方が同時に発火して二重の`recordTransition`が記録され、`hasFreshVerifyRejection`（`verify-self-repair.ts:303-329`、最新1件のtransitionしか見ない）が誤判定する。\r\n   **早期検知シグナル**: `status-transition.test.ts`に「severity>=80かつ`.supervisor/`参照ありの複合ケース」を明示的にテストし、`WorkflowTransition`が1件しか記録されないことをアサートする（実装チェックリストの「severity>=80分岐を優先」方針が正しく実装されているかの直接検証）。\r\n\r\n3. **失敗原因**: `attemptRequirementPlanReplan`の停止状態ガードの実装が`status-transition.ts:62-77`のロジックを正確に再現できず（例: `manual_execution_stop_withdraw`のcauseチェック漏れ）、停止中のテーマ/タスクが誤って再開されてしまう（制約違反）。\r\n   **早期検知シグナル**: `verify-requirement-plan-mismatch.test.ts`に、3つの停止系cause（`manual_execution_stop_revert`/`manual_execution_stop_withdraw`/`auto_run_stop_revert`）それぞれについて個別のテストケースを用意し、全てで`replanned: false`（再開しない）ことを確認する。1つでも漏れがあればテストがREDになる。\r\n\r\n## 完了条件 (DoD)\r\n\r\n- [ ] 上記13ファイルの変更/新規作成が完了している\r\n- [ ] `bun test --isolate`（変更ファイルスコープ）で全テストがPASSする\r\n- [ ] `bunx tsc --noEmit`でエラーがない\r\n- [ ] lint/prettierがクリーン\r\n- [ ] research.mdのテスト戦略表に列挙した全ケース（抽出フィルタ回帰テスト、汚染検出テスト、intake統合テスト、明示的基準保護テスト、新規再計画パスの4ケース、status-transition統合テスト）が実装され、PASSしている\r\n- [ ] verify.mdの「仮説評価」セクションでresearch.mdの3件の仮説を判定している\r\n- [ ] 既存の`plan_invalid_replan`・`verify_no_convergence`・人間専用`revise-plan`エンドポイントの挙動に変更がないことをテストで確認している\r\n\r\n## 実装順序\r\n\r\n1. 抽出フィルタ（1.の項目）— 最も独立性が高く、単体で価値がある\r\n2. 汚染検出拡張＋intake-gate接続（2.〜3.の項目）— 1.のフィルタと組み合わせて防御を厚くする\r\n3. 新規再計画パス本体（4.の項目）— 4.のverify-requirement-plan-mismatch.tsを単体でテスト完了させてから\r\n4. status-transition.tsへの接続（5.の項目）— 4.が単体で動くことを確認してから最小限の分岐を追加\r\n5. plannerコンテキスト注入（6.の項目）— 再計画パスがロールバックすることを確認してから、ロールバック後にplannerが理由を読めるようにする\r\n\r\n## 実装者への申し送り事項\r\n\r\n- **`.supervisor/`検出の正規表現は`acceptance-self-check.ts`の`extractReferenceTokens`をそのまま再利用してよい**。新しいパストークン抽出ロジックを一から書く必要はない。抽出したトークン集合に対して`.toLowerCase().includes('.supervisor/')`のような単純な文字列検査を追加するだけでよい。\r\n- **`ContaminatedCriterion.sourceTaskId`の型変更は破壊的変更ではなく拡張**。既存の`coined_phrase`/`quoted_title`系のヒットは常に`number`を返すので、既存コードのロジック自体は変更不要。TypeScriptの型を`number | null`に広げた結果生じるコンパイルエラー箇所（`sourceTaskId`を数値として使っている箇所）だけを個別に確認する。\r\n- **新規`verify-requirement-plan-mismatch.ts`は`workflow-orchestrator-plan-guard.ts`をコピーしない**。似た構造だが、ロールバック先（`plan_approved`→`draft`ではなく、verify段階の任意のstatusから`draft`）・カウントするcause・停止状態ガードの有無が異なる。共通化できるのは`countWithFailClosed`/`writeBlockedStatusDurable`/`scheduleWorkflowRedispatch`/`archiveWorkflowFile`という既存の共有ヘルパー関数のimportのみ。\r\n- **`revise-plan`エンドポイントと`X-Rapitas-Source`ヘッダ検査には絶対に触れないこと**。新規再計画パスはHTTP経由でこのエンドポイントを叩くのではなく、`workflow-orchestrator-plan-guard.ts`と同じく`prisma.task.update` + `recordTransition`を直接呼ぶ。これは「人間発の出所検査を偽装・削除しない」制約を満たすための設計上の核心であり、実装中に「revise-planを内部的に呼べば楽では」という誘惑に負けないこと。\r\n- **status-transition.tsへの接続は最小限に**。389行の既存ファイルに大きなロジックを書き足すのではなく、`detectSupervisorArtifactMismatch()`と`attemptRequirementPlanReplan()`の2つの関数呼び出し＋分岐だけを追加する。ファイルサイズが500行を超えそうならその場で報告し、実装を止めて分割の是非を確認すること（COMPONENT_SPLITTING_POLICY.mdに従う）。\r\n- **既存の`verify_no_convergence`エスカレーション文言（「再計画はエージェントからは実行できません」）は変更しないこと**。これは意図的な設計であり、あいまいな非収束ケース全般を人間に委ねる既存方針を維持する。新規パスは`.supervisor/`という確実な単一シグナルのケースのみを扱う、既存方針を補完する狭い追加である。\r\n- **テストで`.supervisor/`参照を検出させる際、Windowsパス区切り（バックスラッシュ）とUnix区切り（スラッシュ）の両方を試すこと**。task906の実際のdescriptionは`C:/Projects/rapitas/.supervisor/measurements/task906-red.patch`（フォワードスラッシュ表記）だったが、監督が将来バックスラッシュで書く可能性もあるため、正規化（`.replace(/\\\\/g,'/')`）してから判定する。\r\n\r\n";

/** The narrow research.md that omits the AC3/4/5 gap — must be caught (fail). */
const NARROW_RESEARCH_MD = `# 調査結果

## 問題の背景

task906のacceptanceCriteriaに \`.supervisor/measurements/task906-red.patch\` という監督専用スクラッチファイルへの言及が混入していた。原因は \`task-spec-deriver.ts\` の \`deriveTaskSpec()\` が自由記述descriptionからAI一発抽出でacceptanceCriteriaを生成する際、フィルタを一切かけていないため。

## 対応方針

\`parseSpec()\` が返す各要素から \`.supervisor/\` を含む文字列を除外する \`filterInvestigationArtifacts()\` を新規追加する。SYSTEM_PROMPTにも「監督/検証者自身の調査記録は実装義務として抽出しないこと」という一文を追加する。

## 影響範囲

- \`rapitas-backend/services/task/task-spec-deriver.ts\`
- \`rapitas-backend/services/task/task-spec-deriver.test.ts\`

## リスク

低。既存の抽出ロジックへの後処理フィルタ追加のみで、既存テストへの影響は軽微。
`;

/** Adequate control: addresses every real AC at research depth (no code diffs). Must NOT be false-bounced (pass). */
const ADEQUATE_RESEARCH_CONTROL = `# 調査結果

## 問題の背景

task906のacceptanceCriteriaに監督専用スクラッチファイルへの言及（\`.supervisor/measurements/task906-red.patch\`）が混入し、それが実装義務であるかのように扱われた。原因は3層に分かれる。(1) \`task-spec-deriver.ts\` の抽出段階でフィルタが無い。(2) 既存の汚染検出（\`spec-coherence-checker.ts\`）は他タスク由来の引用しか検出できず、同一タスク内の自己ナラティブ混入を検出できない。(3) 受入基準と承認済みplanが構造的に不整合になった場合、それを解消する自動再計画の経路がエージェントに与えられていない（\`revise-plan\`は人間専用、\`plan_approved\`状態での\`PUT plan\`は禁止）。

## AC1: 回帰テストによる将来の抽出義務化防止

\`task-spec-deriver.test.ts\` に \`.supervisor/\` 参照込みのAI応答を与えるケースを追加し、\`deriveTaskSpec()\` の戻り値にそれが含まれないことを確認する回帰テストを新設する。

## AC2: 明示的な受入条件が自動抽出で劣化しない

抽出フィルタは自由記述からのAI一発抽出パスにのみ適用し、ユーザーが明示的に設定した\`Task.acceptanceCriteria\`列を上書き・削除する経路は存在しないことを既存コード(\`task-spec-deriver.ts\`)で確認済み。フィルタ追加後も明示条件のパスは触れない。

## AC3: 受入基準とplanの不整合時に成功宣言しない

現状、\`acceptance-self-check.ts\`はADVISORY設計で完了可否を左右しない。task901の実測（execution 3914）では、狭いplan.mdのまま未達の受入基準を懸念へ送るだけで成功宣言された。この構造的欠陥を解消するには、verify.md保存時に受入基準と承認済みplanの不整合を検出し、正当な計画更新（自動再計画）または保留へ進める新規経路が必要。

## AC4: 検証者が懸念へ逃がすだけの完了を防ぐ

上記AC3の自動再計画経路が実装されれば、検証者が「別の懸念へ移すだけ」で完了扱いにする逃げ道が塞がれる。これはAC3の実装に内包される。

## AC5: 自動再計画経路の検証観点

新規再計画経路は境界付き（上限回数）・監査付き（recordTransitionへのmetadata記録）・人間発を偽装しない（新規causeを人間発のcauseと区別する）ことを満たす必要がある。DBエラーや同時実行競合時はfail-closedで進行させず、停止済み・完了済みのタスクを更新しない。発火条件はパス名ではなく、正当な受入条件と承認計画の不整合が検証で証明されたこととする。task901のように監督ファイルと無関係な正当条件が計画から漏れたケースも対象にする。条件ごとの証拠と計画の対応を確認し、無関係な既存テスト失敗だけでは再計画しない。判定不能なら成功扱いせず保留する。具体的な接続箇所と競合制御は計画で確定する。

## 影響範囲

- \`task-spec-deriver.ts\` / \`.test.ts\`（抽出フィルタ）
- \`spec-coherence-checker.ts\` / \`.test.ts\`（同一タスク内汚染検出の拡張）
- \`intake-gate.ts\` / \`.test.ts\`（拡張検出器の呼び出し条件）
- \`status-transition.ts\` / \`.test.ts\`（verify分岐への新規検出→再計画の接続）
- 新規: 受入基準とplanの構造的不整合を検出し境界付き自動再計画を行うサービス

## リスク

中。既存のガードを安全性検証済みとみなしてコピーしてはならない。

## 既存機構と回復経路の調査

\`verify-self-repair.ts\` の \`verify_no_convergence\` は同じ受入基準が複数回対応されない場合を回数で検出するエスカレーションであり、最初の検証で証明された計画との矛盾を解消するプラン改訂とは責務が異なる。既存の回数計測・監査・状態ガードを再利用できるが、懸念へ移しただけの成功宣言はこの回数条件に届かない。検証結果と計画の対応を確認して再計画または保留にする接続が必要であり、既存の非収束上限は残す。

task901のcompleted→awaiting_questionの再現は、非同期の質問保存と状態更新の競合を検証する必要性を示す。調査時点の \`file-save/status-transition.ts\` は質問保存で現在のtask.status/workflowStatusを読み、todo/in-progress以外を除外し、todoでは停止由来のtransitionを確認する。したがって単にガードがないと結論づけず、このスナップショット取得後に停止・完了した場合も更新時の条件付き書込みで保護されるかを再現検証する。新規再計画も同じ競合を生むため、停止/完了・更新時刻を含む状態確認、競合時は更新しないこと、監査と更新の整合を計画で確定する。過去の再現と既存修正の有無は区別する。

\`revise-plan\` と \`workflow-plan-revision-context.ts\` は人間由来の要求・表示を扱う。システム検出をこのHTTP経路へ人間ヘッダ付きで送る方式は採らず、内部の状態遷移・監査ヘルパーを利用し、system由来の独立したcauseと根拠を保存する。二重の非同期判定が同じ計画を改訂する競合、停止後の再起動、DB失敗で監査だけが残る不整合をリスクとして検証する。具体的なトランザクションと関数配置は設計で決める。
`;

interface Fixture {
  name: string;
  expectedVerdict: 'pass' | 'fail';
  phase: 'research' | 'plan';
  content: string;
  context?: CriticContext;
}

const FIXTURES: Fixture[] = [
  {
    name: 'narrow-task909',
    expectedVerdict: 'fail',
    phase: 'research',
    content: NARROW_RESEARCH_MD,
    context: { taskBrief: TASK_909_TASK_BRIEF, acceptanceCriteria: TASK_909_ACCEPTANCE_CRITERIA },
  },
  {
    name: 'adequate-research-control',
    expectedVerdict: 'pass',
    phase: 'research',
    content: ADEQUATE_RESEARCH_CONTROL,
    context: { taskBrief: TASK_909_TASK_BRIEF, acceptanceCriteria: TASK_909_ACCEPTANCE_CRITERIA },
  },
  {
    name: 'real-plan-narrow-mismatch',
    expectedVerdict: 'fail',
    phase: 'plan',
    content: TASK_909_REAL_PLAN,
    context: { taskBrief: TASK_909_TASK_BRIEF, acceptanceCriteria: TASK_909_ACCEPTANCE_CRITERIA },
  },
];

async function main(): Promise<void> {
  const enabled = ['1', 'true', 'on'].includes(
    (process.env.RAPITAS_EVAL_PHASE_CRITIC || '').trim().toLowerCase(),
  );
  if (!enabled) {
    console.log(
      '⏭  Phase critic eval skipped — set RAPITAS_EVAL_PHASE_CRITIC=1 to run (makes live LLM calls).',
    );
    return;
  }

  const provider = await getDefaultProvider();
  const requestedModel = await getDefaultModel(provider);
  console.log(`Phase critic eval — provider=${provider}, ${FIXTURES.length} cases\n`);

  const cases: PhaseCriticEvalCaseResult[] = [];
  for (const f of FIXTURES) {
    const start = Date.now();
    const result = await critiquePhase(f.phase, f.content, f.context);
    const input = buildCriticUserMessage(f.content, f.context).message;
    const elapsedMs = Date.now() - start;
    const got: 'pass' | 'fail' | 'unknown' = result.verdict;
    const ok = got === f.expectedVerdict && result.evaluationComplete === true;
    cases.push({
      name: f.name,
      expectedVerdict: f.expectedVerdict,
      gotVerdict: got,
      ok,
      severity: result.severity,
      inputTruncated: result.inputTruncated ?? false,
      evaluationComplete: result.evaluationComplete === true,
      requestedModel,
      inputChars: input.length,
      inputSha256: createHash('sha256').update(input).digest('hex'),
      elapsedMs,
    });
    console.log(
      `${ok ? '✅' : '❌'} ${f.name} → got=${got}, expected=${f.expectedVerdict}, severity=${result.severity}, inputTruncated=${result.inputTruncated ?? false}, ${elapsedMs}ms`,
    );
  }

  const narrowCases = cases.filter(
    (c) => FIXTURES.find((f) => f.name === c.name)?.expectedVerdict === 'fail',
  );
  const controlCases = cases.filter(
    (c) => FIXTURES.find((f) => f.name === c.name)?.expectedVerdict === 'pass',
  );
  const detectionRate =
    narrowCases.length > 0 ? narrowCases.filter((c) => c.ok).length / narrowCases.length : 0;
  const falseBounceRate =
    controlCases.length > 0
      ? controlCases.filter((c) => c.gotVerdict === 'fail').length / controlCases.length
      : 0;

  writePhaseCriticEvalResult({
    timestamp: new Date().toISOString(),
    provider,
    cases,
    detectionRate,
    falseBounceRate,
  });

  console.log(
    `\ndetectionRate=${detectionRate} falseBounceRate=${falseBounceRate} (${cases.filter((c) => c.ok).length}/${cases.length} matched expected)`,
  );

  if (cases.some((c) => !c.ok)) {
    console.error('One or more fixtures did not match the expected verdict — see cases above.');
    process.exit(1);
  }
}

void main();
