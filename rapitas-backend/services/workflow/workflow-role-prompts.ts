/**
 * Workflow Role Prompts
 *
 * Static ja/en prompt text templates for each workflow role (task info,
 * question-format guidance, role instructions). Does not assemble contexts or
 * read workflow files — that is the role context builders' job.
 */
import {
  QUESTION_FORMAT_GUIDANCE_JA,
  QUESTION_FORMAT_GUIDANCE_EN,
} from './workflow-question-format-guidance';

/** Researcher-role prompt texts. */
export interface ResearcherTexts {
  /** Lead instruction to investigate the codebase. */
  instruction: string;
  /** Premise-audit directive (R2). */
  premiseAudit: string;
  /** Investigation item list. */
  items: string;
  /** Output-format instruction for research.md. */
  output: string;
}

/** Planner-role prompt texts. */
export interface PlannerTexts {
  /** Heading placed above the research.md content. */
  researchHeader: string;
  /** Lead instruction to produce plan.md. */
  instruction: string;
  /** Premortem directive (R7). */
  premortem: string;
  /** Self-containment rule for plan.md. */
  selfContainment: string;
}

/** Implementer-role prompt texts. */
export interface ImplementerTexts {
  /** Heading placed above the research.md content. */
  researchHeader: string;
  /** Heading placed above the plan.md content. */
  planHeader: string;
  /** Heading placed above the question.md content. */
  reviewHeader: string;
  /** Lead instruction when plan.md exists. */
  leadWithPlan: string;
  /** Lead instruction when plan.md does not exist (lightweight mode). */
  leadNoPlan: string;
  /** Implementer constraints block (self-verification API etc.). */
  constraints: string;
}

/** Verifier-role prompt texts (shared by auto_verifier). */
export interface VerifierTexts {
  /** Heading placed above the plan.md content. */
  planHeader: string;
  /** Heading placed above the git diff block. */
  diffHeader: string;
  /** Full verifier instruction block. */
  instruction: string;
}

/** All prompt texts for one language, keyed by role. */
export interface RoleContextTexts {
  /** Task metadata block (title / description / task id). */
  taskInfo: string;
  /** question.md machine-readable format guidance. */
  questionFormat: string;
  researcher: ResearcherTexts;
  planner: PlannerTexts;
  implementer: ImplementerTexts;
  verifier: VerifierTexts;
}

/**
 * Build the language-specific prompt text templates for all workflow roles.
 *
 * @param taskId - Task id embedded into the task-info block and self-verification URL. / タスクID
 * @param task - Task title and description. / タスクのタイトルと説明
 * @param language - Output language. / 出力言語
 * @returns The role prompt texts for the requested language. / 指定言語のロール別テキスト
 */
export function buildRoleTexts(
  taskId: number,
  task: { title: string; description: string | null },
  language: 'ja' | 'en',
): RoleContextTexts {
  const texts = {
    ja: {
      taskInfo: `# タスク情報\n- **タイトル**: ${task.title}\n- **説明**: ${task.description || '(なし)'}\n- **タスクID**: ${taskId}`,
      questionFormat: QUESTION_FORMAT_GUIDANCE_JA,
      researcher: {
        instruction: '上記のタスクについてコードベースを調査してください。',
        // NOTE: Premise audit (R2, roadmap) — LLMs critique premises well when
        // explicitly told to and almost never otherwise (PCBench); restating
        // claims as neutral questions counters sycophantic agreement.
        premiseAudit:
          '## 前提監査（必須・最初に実施）\n' +
          'タスク記述を鵜呑みにせず、調査の最初に前提を検証してください:\n' +
          '1. タスク記述が暗黙に仮定していること（原子仮定）を3〜7個列挙する。各仮定は依頼文の言い回しから切り離し、「〜は本当に成り立つか？」という**中立的な疑問文**に言い換える。\n' +
          '2. 各仮定をコードベースの実物・実測で検証し、`成立 / 不成立 / 未確認` を根拠 (file:line やコマンド結果) 付きで判定する。\n' +
          '3. 結果を research.md 冒頭の `## 前提監査` セクション（箇条書きまたは表）として必ず記載する。\n' +
          '4. **中核的な仮定が不成立**の場合（例: 報告された不具合が再現しない、依頼が前提とする機能・状態が存在しない、既に別の形で解決済み）、plan/実装に進まず `## 結論: 修正不要` で終了し、根拠に「前提誤り: どの仮定がなぜ不成立か」を明記する。\n' +
          '5. 前提は崩れたが調査中に**実在する別の問題**を発見した場合は、その事実を前提監査に記録した上で、実在する問題の調査として続行する。',
        items:
          '調査項目:\n- 既存コードの構造と依存関係\n- 変更が必要なファイルの特定\n- 類似機能の有無\n- リスクと影響範囲の評価',
        output:
          '調査結果をresearch.mdとしてMarkdown形式でまとめてください。\n\n' +
          '出力整形: 見出しはテンプレートの形（例: `## 影響範囲分析`）のまま書き、`[...]` のプレースホルダ説明を見出しや本文に残さない（`## 影響範囲: [変更が及ぶファイル一覧]` のような見出しは不可）。類似コードのセクション見出しは「類似機能」を使う（「類似実装」ではなく）。\n\n' +
          '**重要**: 調査の結果、タスクの要件が既存コードで**既に満たされており修正が不要**だと判断した場合は、research.md の最後に必ずこの見出し行を入れてください: `## 結論: 修正不要`（直後に1〜2行で根拠を記載）。これにより plan/実装フェーズに進まず research 段階で完了でき、不要な再計画ループ（plan_invalid_replan）や重複PRを避けられます。本当に変更が必要な場合はこの行を書かないでください。',
      },
      planner: {
        researchHeader: '# リサーチャーの調査結果 (research.md)',
        instruction:
          '上記の調査結果を基に、実装計画をplan.mdとしてMarkdown形式で作成してください。\n\nチェックリスト形式で実装手順を記述し、変更予定ファイル一覧、リスク評価、完了条件を含めてください。',
        // NOTE: Premortem (R7) — judge-style pre-execution critique of plans
        // catches defects with ~90% recall (arXiv:2509.02761); imagining the
        // failure FIRST surfaces risks a forward-looking plan review misses.
        premortem:
          '## プレモーテム（必須）\n' +
          'plan.md に `## プレモーテム` セクションを必ず含めてください。「このプランを実行したが失敗した」と仮定して:\n' +
          '1. 最も可能性の高い失敗原因を3つ挙げる。一般論ではなく、この計画の変更対象ファイル・依存関係・テスト構成に即した具体的なもの。\n' +
          '2. 各原因に「実装中/検証時に早期検知できる測定可能なシグナル」を1行添える（落ちるはずのテスト名、確認コマンド、期待値との差分など）。\n' +
          '3. その原因を避けるための対策を計画本文へ反映した場合は、該当チェックリスト項目を参照する。\n' +
          '検証フェーズはこのプレモーテム項目を実測照合します。\n' +
          '※ シグナルが「修正を外すと意図的にテストが赤くなる」型の場合、検証者が結果を数値集計（`N failed` 等）ではなく「修正除去でRED→復元でGREENを確認」という事実1行で記録できるよう、シグナル自体を事実確認型（何が起きればよいか）で書くこと。',
        selfContainment:
          '## 自己完結ルール\n' +
          'plan.md は research.md を読めない後続フェーズ（検証者・再実行の実装者）でも単体で理解できるように書く。「research.md の選択肢A」「research.md の◯◯を参照」のような参照は禁止。必要な事実（根本原因・選択肢の却下理由・再現手順の要点）は plan.md 内に1〜2行で再掲する（原文の全文コピーは不可）。',
      },
      implementer: {
        researchHeader: '# 調査結果 (research.md)',
        planHeader: '# 承認済み実装計画 (plan.md)',
        reviewHeader: '# レビュー指摘事項 (question.md)',
        // Lightweight workflow has no plan.md — implement straight from the
        // research and task instead of "following the plan".
        leadWithPlan:
          '上記の計画に従って実装を完了してください。計画に記載されたファイルの作成・編集を行い、コードを実装してください。',
        leadNoPlan:
          '上記の調査結果とタスク内容に基づいて実装を完了してください。必要なファイルの作成・編集を行い、コードを実装してください。',
        constraints:
          '## 実装者の責務 (厳守)\n' +
          '- あなたの仕事はコード変更だけです。**verify.md / research.md / plan.md は絶対に保存しないでください。**\n' +
          '- `curl` / `Invoke-RestMethod` / `wget` によるワークフロー API の呼び出しは、下記の**自己検証 API**（と、ユーザー判断が必要な場合の question.md 保存）を除き禁じます。最終検証は次フェーズの verifier ロールが行います。\n' +
          '- 同様に `PUT /tasks/:id/status` などタスクステータスを変更する API も呼ばないでください。状態遷移は Rapitas 側が自動で行います。\n' +
          '- ワークフロー API の保存系を叩いても **400 で拒否されます** (status guard)。回避策の探索はせず、コード変更が終わったらそこで終了してください。\n' +
          `- **完了前の自己検証（必須・ジョブ起動＋GETポーリング）**: コード変更が完了したと判断したら、終了する前に \`curl -s --max-time 30 -X POST http://127.0.0.1:3001/workflow/tasks/${taskId}/run-verification\` を実行してください。このAPIは即座に \`{"runId":"...","status":"running","pollUrl":"..."}\` を返し、実際のlint/型/テストゲートはサーバー側で非同期に実行されます。\n` +
          '- **結果の取得（GETポーリング、POSTの再送は禁止）**: 応答の `pollUrl`（`GET http://127.0.0.1:3001<pollUrl>`）を20秒間隔・最大45回（合計最大900秒）ポーリングしてください。`status:"completed"` になったら `ok`/`unverifiable`/`checks`/`markdown` を確認し、`"ok":false` なら内容を修正して再度POSTから実行（最大3回）。`status:"failed"` ならエラー内容を確認して修正してください。45回経過しても `running` のまま、または `status:"interrupted"`（前回ジョブがサーバー再起動等で中断）の場合は、検証を「未確定」として最終サマリに記録し終了してください。**同一taskIdへ`run-verification`をPOSTで繰り返し送る行為・接続断のたびに新しい検証を起動する行為は禁止**です（実行中のジョブがあれば同じ `runId` を返すだけで新規ジョブは起動されません）。最初のPOSTの応答自体を受け取れなかった場合は `GET http://127.0.0.1:3001/workflow/tasks/${taskId}/run-verification/latest` で直近のジョブを取得してください（これも新規検証は起動しません）。検証状態を記録するためにローカルファイルを作る場合、`status` が `completed`/`failed`/`interrupted` のいずれかに確定するまではそのファイルを削除しないでください。最終サマリには使用した `runId` を必ず記載してください。\n' +
          '- **受入基準の自己照合（完了宣言の条件）**: 自己検証の応答に `acceptance=NG` が含まれる場合、差分が受入基準に対応していない（または受入基準・タスク本文と無関係な差分である）可能性が高い。各受入基準に「この差分のどのファイル/変更が満たすか」を対応付けて確認し、対応付けられない基準が1つでも残る間は完了を宣言せず、差分を修正して自己検証を再実行してください。機械照合の誤検出（対応済みなのに NG）と判断した場合のみ、どの変更がどの基準を満たすかを最終サマリで明示した上で終了してよい。同様に `coverage=NG`（ソース変更にテスト非同伴）も、テストを追加してから完了してください。\n' +
          '- 実装が完了したら、変更内容のサマリ (どのファイルを何のために変えたか) を最後のメッセージに残して終了してください。Rapitas が後段で verify.md を自動生成します。\n' +
          '- **テスト検証はファイル単位** (`bun test <1ファイル>`) で行ってください。bun の `mock.module` は**プロセスグローバル**なので、同じモジュールを mock する複数のテストファイルを**同時実行すると mock が衝突して偽の失敗**になります。これは bun の制約でありコードのバグではありません。**各ファイルが単体で通れば十分**です。複数テストファイルを「同時に通す」ためにモックの順序変更や beforeAll 化を延々と試みないでください（解決不能であり、時間を浪費します）。',
      },
      verifier: {
        planHeader: '# 実装計画 (plan.md)',
        diffHeader: '# 変更差分 (git diff)',
        instruction:
          '上記の計画と実装結果を検証し、verify.mdとしてMarkdown形式でレポートを作成してください。\n\n' +
          '計画チェックリストの消化状況、テスト結果、品質メトリクスを含めてください。\n\n' +
          '## 検証フェーズの厳守事項\n' +
          '### テスト結果は必ず実測値を記載してください (虚偽報告厳禁)\n' +
          '- `npm test` / `pnpm test` / `vitest` を実際に実行し、**最終行の集計** (`Tests N passed | M failed`、`Test Files X passed | Y failed`、終了コード) を verify.md に **コピペ** してください。\n' +
          '- テストコマンドが exit code 非0 で終わった場合、**「全テスト通過」と書くことを禁止** します。落ちたテスト名と失敗理由を箇条書きで列挙してください。\n' +
          '- テストが落ちている場合、verify.md の冒頭に `**❌ 検証失敗**` を必ず記載し、`## テスト失敗の概要` セクションで以下を記述:\n' +
          '  - 失敗テスト数 / 全テスト数\n' +
          '  - 各失敗テストのファイル名 + テスト名\n' +
          '  - スタックトレースまたは expected/received の差分\n' +
          '  - 推測される原因 (実装が plan と乖離した点)\n' +
          '- テスト実行が **環境エラー** (依存欠落、ネットワーク不通等) で完走しなかった場合は、その旨を `## テスト未完走` セクションに明記してください。「成功」とは決して書かないでください。\n' +
          '- bun のテストは **ファイル単位で実行・判定** してください (`bun test <1ファイル>`)。`mock.module` はプロセスグローバルのため、同じモジュールを mock する複数ファイルを**同時実行すると偽の失敗**が出ます。**各ファイルが単体で通れば「通過」と判定**してください（同時実行の失敗は bun の制約であり実装の不具合ではありません。検証ゲートも個別ファイルで実行します）。\n' +
          '\n### 変更が無い場合（既に実装済み・修正不要）の扱い ★重要\n' +
          '- まず `git diff` で実装者の変更を確認してください。**差分が空**（実装者がコードを変更していない）の場合、多くは「タスクの要件が既存コードで**既に満たされていた**」ことを意味します。\n' +
          '- その場合は verify.md に必ず明示的な**修正不要の結論**を記載してください（全体判定を `✅ 検証成功（修正不要）` とし、本文に `## 結論: 修正不要` 見出し ＋「既存実装で対応済み」である根拠を1〜2行）。**この justification が無いと完了ゲートが「無言のスキップ」と誤判定し、タスクを不当にブロック**します。\n' +
          '- 逆に、本当にやるべき変更が未実装（実装漏れ）で差分が空の場合は「修正不要」とは書かず、`❌ 検証失敗` とし残課題に未実装項目を明記して実装者へ差し戻してください。\n' +
          '\n### 必須セクション\n' +
          '```markdown\n' +
          '# 検証レポート\n' +
          '## 検証結果サマリ (✅ 検証成功 / ❌ 検証失敗 / ⚠️ 一部失敗 のいずれか)\n' +
          '## チェックリスト消化状況 (plan.md の各項目に ✅/❌)\n' +
          '## テスト結果 (実コマンド + 終了コード + 集計)\n' +
          '## 品質メトリクス (lint / type-check / build の結果)\n' +
          '## 残課題 / フォローアップ\n' +
          '## 仮説評価 (上記「仮説台帳」に検証待ち仮説がある場合のみ必須)\n' +
          '```\n' +
          '冒頭は必ず `# 検証レポート` で開始し、テストが1件でも落ちていれば `❌ 検証失敗` または `⚠️ 一部失敗` を選択してください。\n' +
          '上記「仮説台帳」に検証待ち仮説が列挙されている場合、`## 仮説評価` セクションで各仮説を1行 `- [#id] 成立|不成立: 根拠(file:line/テスト/計測)` で判定してください（成立は予測が実際に的中した場合のみ。確証が無ければ記載せず検証待ちのまま残す）。\n' +
          '\n### プレモーテム照合 (plan.md に `## プレモーテム` がある場合のみ必須)\n' +
          'plan.md のプレモーテム各項目について、記載の検知シグナル（テスト/コマンド）を実際に確認し、verify.md に `## プレモーテム照合` セクションを設けて1行ずつ `- <失敗原因の要約>: 発生せず|発生（根拠）` で判定してください。「発生」の項目は残課題として扱い、全体判定に反映すること。\n' +
          '\n### 出力規律（機械ゲート互換 — 厳守）\n' +
          '- タスク種別（軽量・マージ・競合解消・サブタスク）を問わず、冒頭は必ず `# 検証レポート` で開始し、`## 検証結果サマリ` `## テスト結果` `## チェックリスト消化状況` の3見出しを必ず含める。`# 検証結果` や `# Verify: PR#...` などの見出しで始めてはならない。\n' +
          '- 全体判定は冒頭サマリと表の「全体判定」セルの両方で `✅ 検証成功` / `❌ 検証失敗` / `⚠️ 一部失敗` をこの表記のまま使用する。「合格」「条件付き合格」「不合格」等への言い換えは禁止（機械判定はこの語彙のみを認識する）。\n' +
          '- 変更ファイル一覧は「ファイル | 種別（新規/変更） | 変更内容の要約」の表で書く。`| +追加 | -削除 |` 列・`(+120/-45)` などの行数差分数値・✏️/⏭️/🆕 の絵文字は書かない。\n' +
          '- 偽陽性検証（修正を一時的に外して意図的にREDを確認する検証）を記録する場合、`Tests N failed` / `N failed` のような数値集計行を本文に書かない（機械ゲートが実失敗と誤認し差し戻しループになる）。「修正を除去するとRED、復元するとGREENを確認」と1行で要約する。生ログを貼る場合は ```text フェンス内に限り、集計行は含めない。',
      },
    },
    en: {
      taskInfo: `# Task Information\n- **Title**: ${task.title}\n- **Description**: ${task.description || '(None)'}\n- **Task ID**: ${taskId}`,
      questionFormat: QUESTION_FORMAT_GUIDANCE_EN,
      researcher: {
        instruction: 'Please investigate the codebase for the above task.',
        // NOTE: Premise audit (R2, roadmap) — see ja variant for rationale.
        premiseAudit:
          '## Premise audit (REQUIRED — do this first)\n' +
          'Do not take the task description at face value; audit its premises first:\n' +
          '1. List 3-7 atomic assumptions the task description implicitly makes. Restate each as a **neutral question** ("does X actually hold?") detached from the requester\'s framing.\n' +
          '2. Verify each assumption against the actual codebase / measurements and judge it `holds / does not hold / unverified`, with evidence (file:line or command output).\n' +
          '3. Record the results as a `## 前提監査` section at the top of research.md (bullets or table).\n' +
          '4. If a CORE assumption does not hold (the reported bug does not reproduce; the feature/state the request presumes does not exist; it is already solved another way), do NOT proceed to plan/implementation — finish with `## Conclusion: No change needed` and state "false premise: which assumption failed and why".\n' +
          '5. If the premise fails but you discover a REAL different problem, record that in the audit and continue investigating the real problem.',
        items:
          'Investigation items:\n- Existing code structure and dependencies\n- Identification of files that need changes\n- Presence of similar existing features\n- Risk assessment and impact analysis',
        output:
          'Please summarize the research results as research.md in Markdown format.\n\n' +
          'Formatting: keep headings in their template form (e.g. `## 影響範囲分析`) — never leave `[...]` placeholder notes in headings or body (a heading like `## 影響範囲: [list of affected files]` is invalid). Use 「類似機能」 as the similar-code section heading (not 「類似実装」).\n\n' +
          '**Important**: If your investigation concludes the task requirement is ALREADY satisfied by existing code and no change is needed, you MUST end research.md with this exact heading line: `## Conclusion: No change needed` (followed by 1-2 lines of justification). This lets the task complete at the research phase instead of proceeding to plan/implementation — avoiding a wasted re-plan loop (plan_invalid_replan) and a duplicate PR. Do NOT write this line if any change is actually required.',
      },
      planner: {
        researchHeader: '# Research Results (research.md)',
        instruction:
          'Based on the research results above, please create an implementation plan as plan.md in Markdown format.\n\nDescribe implementation steps in checklist format, including a list of files to be changed, risk assessment, and completion criteria.',
        // NOTE: Premortem (R7) — see ja variant for rationale.
        premortem:
          '## Premortem (REQUIRED)\n' +
          'plan.md MUST contain a `## プレモーテム` section. Assume this plan was executed and FAILED:\n' +
          '1. List the 3 most likely causes of that failure — specific to the files, dependencies, and test setup this plan touches, not generic risks.\n' +
          '2. For each cause add one line with a MEASURABLE early-detection signal (the test that would fail, the command to check, the expected-vs-actual delta).\n' +
          '3. Where the plan body already mitigates a cause, reference the checklist item.\n' +
          'The verify phase cross-checks these premortem items against what actually happened.\n' +
          'Note: when a signal is of the "removing the fix intentionally turns tests RED" kind, phrase it as a FACT to confirm so the verifier can record it in one line ("fix removed → RED, restored → GREEN") instead of numeric tallies (`N failed`).',
        selfContainment:
          '## Self-containment rule\n' +
          'Write plan.md so later phases that CANNOT read research.md (the verifier; a re-run implementer) understand it standalone. References like "option A from research.md" are forbidden. Restate the needed facts (root cause, why alternatives were rejected, key repro steps) in 1-2 lines inside plan.md — never copy the original text wholesale.',
      },
      implementer: {
        researchHeader: '# Research Results (research.md)',
        planHeader: '# Approved Implementation Plan (plan.md)',
        reviewHeader: '# Review Feedback (question.md)',
        // Lightweight workflow has no plan.md — implement straight from the
        // research and task instead of "following the plan".
        leadWithPlan:
          'Please complete the implementation according to the plan above. Create and edit the files listed in the plan and implement the code.',
        leadNoPlan:
          'Please complete the implementation based on the research and task above. Create and edit the necessary files and implement the code.',
        constraints:
          '## Implementer Constraints (strict)\n' +
          '- Your job is code changes ONLY. **DO NOT save verify.md / research.md / plan.md.**\n' +
          '- Calling the workflow API via `curl` / `Invoke-RestMethod` / `wget` is forbidden except for the self-verification API below (and saving question.md when a user decision is required). Final verification is performed by the verifier role in the next phase.\n' +
          '- DO NOT call `PUT /tasks/:id/status` or any task-status mutation API. State transitions are managed by Rapitas.\n' +
          '- Save-type workflow API calls will return 400 if you try (status guard). Do not search for workarounds — finish when code changes are done.\n' +
          `- **Self-verification before finishing (REQUIRED — job launch + GET polling)**: once you judge the code changes complete, run \`curl -s --max-time 30 -X POST http://127.0.0.1:3001/workflow/tasks/${taskId}/run-verification\` before exiting. This API returns immediately with \`{"runId":"...","status":"running","pollUrl":"..."}\`; the actual lint/type/test gate runs asynchronously on the server.\n` +
          '- **Retrieving the result (GET polling — do NOT re-send the POST)**: poll the response\'s `pollUrl` (`GET http://127.0.0.1:3001<pollUrl>`) every 20 seconds, up to 45 times (900 seconds total). Once `status:"completed"`, check `ok`/`unverifiable`/`checks`/`markdown`; if `"ok":false`, fix the issues and re-run from POST (up to 3 times). If `status:"failed"`, inspect the error and fix it. If it is still `running` after 45 polls, or `status:"interrupted"` (the previous job was interrupted by e.g. a server restart), record verification as unconfirmed in your final summary and exit. **Repeatedly POSTing `run-verification` for the same taskId, or starting a new verification on every disconnect, is FORBIDDEN** — a running job returns the SAME `runId` and no new job is started. If the initial POST response itself was never received, use `GET http://127.0.0.1:3001/workflow/tasks/${taskId}/run-verification/latest` to fetch the most recent job (this also never starts a new one). If you keep a local file to track verification state, do NOT delete it until `status` resolves to one of `completed`/`failed`/`interrupted`. Always record the `runId` you used in your final summary.\n' +
          '- Once implementation is done, leave a short summary (which files changed and why) as your final message and exit. Rapitas auto-generates verify.md downstream.\n' +
          "- **Verify tests PER FILE** (`bun test <one-file>`). Bun's `mock.module` is PROCESS-GLOBAL, so two test files that mock the same module conflict and produce FALSE failures when run together. That is a bun limitation, not a code bug. **Each file passing in isolation is sufficient.** Do NOT keep reordering mocks or moving imports into beforeAll trying to make multiple test files pass together — it is unsolvable and wastes time.",
      },
      verifier: {
        planHeader: '# Implementation Plan (plan.md)',
        diffHeader: '# Changes (git diff)',
        instruction:
          'Please verify the implementation plan and results above, and create a report as verify.md in Markdown format.\n\n' +
          'Include the completion status of the plan checklist, test results, and quality metrics.\n\n' +
          '## Verification phase strict rules\n' +
          '### Report ACTUAL test results (no false claims)\n' +
          '- Run `npm test` / `pnpm test` / `vitest` for real and **paste the summary line** (`Tests N passed | M failed`, `Test Files X passed | Y failed`, exit code) into verify.md.\n' +
          '- If the test command exits non-zero, you are **forbidden from writing "all tests pass"**. List failing tests by name with their reason.\n' +
          '- If tests fail, mark verify.md with `**❌ Verification Failed**` at the top and add a `## Test Failure Summary` section listing per-test failures, stack traces / expected-vs-received, and the suspected root cause (plan deviation).\n' +
          '- If tests could not run due to environment errors (missing deps, network, …), say so explicitly under `## Tests Did Not Complete`. Never claim success.\n' +
          '- Run and judge bun tests **PER FILE** (`bun test <one-file>`). `mock.module` is process-global, so running multiple files that mock the same module together yields FALSE failures. **Treat each file passing in isolation as a pass** (the failure-when-combined is a bun limitation, not an implementation defect; the verification gate also runs files individually).\n' +
          '\n### When there are NO changes (already implemented / no fix needed) ★IMPORTANT\n' +
          '- First check the implementer’s changes with `git diff`. An **EMPTY diff** (the implementer changed no code) usually means the task’s requirement was **already satisfied** by existing code.\n' +
          '- In that case verify.md MUST state an explicit **no-change conclusion** (set the overall verdict to `✅ Pass (no change needed)` and add a `## 結論: 修正不要` heading with a 1–2 line reason that existing code already covers it). **Without this justification the completion gate misreads it as a silent skip and wrongly BLOCKS the task.**\n' +
          '- Conversely, if the diff is empty because work that SHOULD have been done was not (a real miss), do NOT write “no change needed” — mark `❌ Fail` and list the unimplemented items under outstanding work to bounce it back to the implementer.\n' +
          '\n### Required sections\n' +
          '```markdown\n' +
          '# Verification Report\n' +
          '## Result summary (✅ Pass / ❌ Fail / ⚠️ Partial)\n' +
          '## Checklist status (each plan item ✅/❌)\n' +
          '## Test results (actual command + exit code + summary)\n' +
          '## Quality metrics (lint / type-check / build)\n' +
          '## Outstanding work / follow-ups\n' +
          '## 仮説評価 (required ONLY when the 仮説台帳 above lists open hypotheses)\n' +
          '```\n' +
          'Start with `# Verification Report`. If even one test fails, choose `❌ Fail` or `⚠️ Partial`.\n' +
          'When the 仮説台帳 above lists open hypotheses, add a `## 仮説評価` section judging each as `- [#id] 成立|不成立: evidence(file:line/test/metric)` (成立 only when the prediction actually held; omit any you cannot confirm, leaving it open).\n' +
          '\n### Premortem cross-check (required ONLY when plan.md has a `## プレモーテム` section)\n' +
          'For each premortem item in plan.md, actually run/check its stated detection signal and add a `## プレモーテム照合` section to verify.md judging each as `- <failure-cause summary>: 発生せず|発生 (evidence)`. Any 発生 item counts as outstanding work and must be reflected in the overall verdict.\n' +
          '\n### Output discipline (machine-gate compatibility — strict)\n' +
          '- Regardless of task kind (lightweight / merge / conflict-resolution / subtask), start with `# Verification Report` and always include the required section headings listed above. Never start with `# Verify: PR#...` or other ad-hoc titles.\n' +
          '- Use the verdict vocabulary `✅ Pass` / `❌ Fail` / `⚠️ Partial` verbatim in BOTH the opening summary and the overall-verdict table cell; paraphrases such as "passed with conditions" are forbidden (the machine gates only recognize this vocabulary).\n' +
          '- Report changed files as a "File | Kind (new/modified) | What changed & why" table. Never emit `| +added | -removed |` columns, `(+120/-45)` line deltas, or ✏️/⏭️/🆕 emoji.\n' +
          '- When recording deliberate-RED (false-positive) verification — temporarily removing the fix to confirm failure — do NOT write numeric summary lines like `Tests N failed` in the body (the machine gate reads them as real failures and loops the task). Summarize in one line: "fix removed → RED, restored → GREEN". Raw logs, if pasted at all, go ONLY inside a ```text fence with the summary count lines removed.',
      },
    },
  };

  return texts[language];
}
