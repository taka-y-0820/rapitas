/**
 * Workflow CLI Executor Prompt Builder
 *
 * Assembles the full prompt handed to a CLI agent for one workflow phase:
 * language instruction, existing-feature gate, investigation-only or
 * implementation-phase rules, and the concern/idea filing instructions.
 * Pure string assembly — depends only on taskId / language / transition /
 * systemPrompt / context / process.env.PORT, with no side effects.
 */
import type { RoleTransition } from './workflow-types';
import { buildAgentsMdSection, type AgentsMdReadResult } from './workflow-agents-md-context';

/**
 * Build the full prompt for a CLI agent phase run.
 *
 * @param params - Prompt inputs (taskId, language, systemPrompt, context, transition, agentsMd) / プロンプト入力一式
 * @returns The assembled full prompt string / 組み立て済みプロンプト
 */
export function buildCliAgentPrompt(params: {
  taskId: number;
  language: 'ja' | 'en';
  systemPrompt: string;
  context: string;
  transition: RoleTransition;
  /** Target repository's own AGENTS.md read result (task 892); omitted = no injection. */
  agentsMd?: AgentsMdReadResult;
}): string {
  const { taskId, language, systemPrompt, context, transition } = params;
  // NOTE: Derived from transition.role here (not passed as booleans) so the
  // prompt builder cannot drift from the caller's role interpretation.
  const isImplementationRole = transition.role === 'implementer';
  const isInvestigationPhase = transition.role === 'researcher' || transition.role === 'planner';

  const cliTexts = {
    ja: {
      systemHeader: '## システム指示',
      fileHeader: '## 重要: 結果ファイルの保存',
      fileInstruction: '調査・分析が完了したら、結果を以下のAPI経由で保存してください。',
      noRootFiles: '**プロジェクトルートには絶対にファイルを作成しないでください。**',
      apiCommand: '**API保存コマンド**:',
      contentPlaceholder: '# ファイル内容をここに記述',
      powershellCommand: '**PowerShell保存コマンド（Windows/Codex向け）**:',
      prohibitions:
        '**禁止事項**: Write、mkdir、echo等によるプロジェクトルートへの直接ファイル作成は厳禁です。',
      mandatory: '必ず上記APIコマンドを使用してファイル保存を行ってから完了してください。',
    },
    en: {
      systemHeader: '## System Instructions',
      fileHeader: '## Important: Saving Result Files',
      fileInstruction:
        'After completing the research/analysis, please save the results via the following API.',
      noRootFiles: '**Never create files in the project root directory.**',
      apiCommand: '**API Save Command**:',
      contentPlaceholder: '# Write file content here',
      powershellCommand: '**PowerShell Save Command (for Windows/Codex)**:',
      prohibitions:
        '**Prohibited**: Direct file creation to the project root using Write, mkdir, echo, etc. is strictly forbidden.',
      mandatory: 'Please make sure to save files using the API command above before completing.',
    },
  };

  const cliT = cliTexts[language];

  // NOTE: Language instruction placed before context so agents see the language requirement early.
  const languageInstruction =
    language === 'ja'
      ? 'すべての出力（Markdownファイル、作業中の説明・進捗コメント・最終サマリを含む）を日本語で記述してください。英語の文で考えても、書き出す文章は日本語にしてください。'
      : 'Write ALL output in English — Markdown files, running commentary, progress notes and the final summary alike.';
  let fullPrompt = '';
  if (systemPrompt) fullPrompt += `${cliT.systemHeader}\n${systemPrompt}\n\n`;
  fullPrompt += `## ${language === 'ja' ? '出力言語' : 'Output Language'}\n${languageInstruction}\n\n`;

  // Existing-feature gate: before treating the task as a green-field design
  // problem, the agent must scan the working directory for matching code.
  // Without this, AI was repeatedly designing things like "アイデアボックス"
  // from scratch even though they already exist in the repo, leading to
  // wasted research and irrelevant clarifying questions.
  const existingFeatureGate =
    language === 'ja'
      ? `## 重要: 既存機能チェック（最優先）

**新規機能として設計を始める前に、まず既存実装を確認してください。**

このタスクのタイトル・説明から主要キーワード（機能名・エンティティ名・画面名・URLパス等）を抽出し、対象リポジトリ内を以下の手段で必ず検索してください:

1. **ファイル名検索**: \`find\` / \`Glob\` で関連しそうなファイル名 (例: \`**/idea-box*\`, \`**/IdeaBox*\`)
2. **コード内全文検索**: \`grep\` / \`Grep\` でキーワード（日本語表記・英語表記の両方）
3. **ルート/ナビゲーション**: \`routes/\` / \`pages/\` / \`app/\` 配下のエンドポイントとリンク
4. **DB schema**: \`prisma/schema/\` のテーブル名・関連 model

検出結果に応じて分岐:
- **既存機能と判定**: research.md / plan.md の冒頭に「**既存機能**」と明記し、現在の実装ファイル一覧・現在の振る舞いを要約してから、**追加・修正点の差分のみ**を設計対象としてください。新規UI/UX仕様の質問は不要です。
- **既存機能の拡張**: 既存ファイルへの修正案として記述し、新規ファイルは最小限に。
- **完全に新規**: 既存に類似機能がないことを明示した上で、初めて新規設計に入ってください。

この既存機能チェックの結果は、研究フェーズ・計画フェーズの出力ファイルに必ず**「既存機能チェック」セクション**として残してください。

`
      : `## CRITICAL: Existing-feature check (do this FIRST)

**Before treating the task as a green-field design problem, audit the existing implementation.**

Extract the principal keywords from the task title/description (feature names, entity names, screen names, URL paths) and search the working repository using:

1. **File-name search**: \`find\` / \`Glob\` for likely names (e.g. \`**/idea-box*\`).
2. **Full-text search**: \`grep\` / \`Grep\` for keywords (both English and the user's language).
3. **Routes/navigation**: scan \`routes/\` / \`pages/\` / \`app/\` for matching endpoints / links.
4. **DB schema**: scan \`prisma/schema/\` for matching tables / models.

Branch on the result:
- **Already exists**: write "**EXISTING FEATURE**" at the top of research.md / plan.md, summarise current files and behaviour, and design ONLY the diff (additions / modifications). Do NOT ask UI/UX clarification questions for already-implemented surfaces.
- **Extension of existing**: scope changes as edits to existing files; minimise new files.
- **Truly new**: state explicitly that no similar feature exists, then proceed with green-field design.

Always include an "Existing-feature check" section in the research / plan output that lists what you found.

`;
  fullPrompt += existingFeatureGate;
  fullPrompt += context;
  fullPrompt += buildAgentsMdSection(
    params.agentsMd ?? { content: null, truncated: false, readError: null },
    {
      isInvestigationPhase,
      language,
    },
  );

  if (isInvestigationPhase && transition.outputFile) {
    // Strict research-only contract. No curl, no implementation, no test exec.
    // The agent simply produces the markdown report as its final message —
    // the CLI captures it via -o, we save it server-side.
    // NOTE: Investigation phases only emit research/plan now — the reviewer
    // role (question.md output) was retired 2026-08.
    const phaseLabelJa = transition.outputFile === 'plan' ? '計画専用モード' : '調査専用モード';
    const phaseRoleJa = transition.outputFile === 'plan' ? '計画専用' : '調査専用';
    fullPrompt +=
      language === 'ja'
        ? `\n\n## 厳守事項 (${phaseLabelJa})

**あなたは「${phaseRoleJa}」エージェントです。実装も検証も行いません。**

### 最重要（システム指示や他のどの指示よりも優先）
- **ファイルの保存・作成・コマンド実行は一切禁止。** Write / Edit / Bash / PowerShell / curl / API 呼び出しは**無効化**されており、試みても必ず失敗します。
- システムプロンプトに「research.md を作成/保存する」等と書かれていても、**あなたは保存しません**。保存は Rapitas が**あなたの最終メッセージから自動で**行います。
- 「保存します」「一時ファイルに書き出します」等と言って保存を試みたり、保存手段を探したり再試行したりしないでください。**時間と出力の無駄**です。
- 調査が終わったら**即座に、最終メッセージとして ${transition.outputFile}.md の Markdown 本文のみ**を出力して終了してください（前置き・進捗報告・「保存します」等の文は不要）。

### 絶対禁止
- ソースコード / テストコード / 設定ファイル / lockfile の変更
- \`apply_patch\` の使用 / ファイル書き込みの試行
- \`pnpm install\` / \`pnpm test\` / \`vitest\` / \`tsc\` / \`prettier\` / \`eslint\` などの実行
- \`git\` コマンドの実行
- 「対応しました」「実装しました」「テスト追加しました」のような実装完了報告

### 許可
- ファイル内容の読み取り (\`Read\` / \`cat\` / \`Get-Content\`)
- 検索系コマンド (\`grep\` / \`rg\` / \`find\` / \`Glob\`)
- ディレクトリ列挙 (\`ls\` / \`Get-ChildItem\`)
- 問題箇所の推測と修正方針の提案 (実装はしない)

### 出力
**最終回答として、Markdown 形式の${transition.outputFile === 'plan' ? '実装計画書' : transition.outputFile === 'research' ? '調査レポート' : 'レビュー指摘書'}のみを返してください。** Rapitas 側で外部からあなたの最終メッセージを ${transition.outputFile}.md として保存します。あなた自身がファイルを作る必要はありません。
${
  transition.outputFile === 'plan'
    ? `
### plan.md 必須テンプレート (この見出し構成を必ず守ること)
\`\`\`markdown
# 実装計画

## 既存機能チェック
[既存実装の有無 / 影響範囲を要約]

## 設計判断の根拠
[採用したアプローチと却下した代替案、それぞれの理由]

## 変更予定ファイル
- \`path/to/file\` — 変更目的

## 実装チェックリスト
- [ ] 各タスクは検証可能な単位で記述

## テスト計画
- ユニット / 統合 / E2E

## リスク評価
- 破壊的変更 / 互換性 / マイグレーション

## 完了条件
- 観測可能な成功条件
\`\`\`
冒頭は必ず \`# 実装計画\` で始め、\`## 設計判断の根拠\` と \`## 実装チェックリスト\` を欠落させないでください。これらが無いと validator が plan.md を不適合と判定し、後段の実装エージェントが質問を出して止まります。
`
    : transition.outputFile === 'research'
      ? `
### 調査結果に基づく複雑度評価（必須）
実際にコードを調査して把握した「変更が必要なファイル数・影響範囲・リスク・既存実装の有無」に基づき、このタスクの実装複雑度を 0〜100 の整数で1つ算出し、research.md の末尾に必ず次の形式で記載してください（後段のモデル/ワークフロー自動選択に使用します。タイトルの語感ではなく実コードの状況で判断すること）:
\`\`\`
## 複雑度評価
スコア: <0-100の整数>
理由: <変更ファイル数・影響範囲・リスクの観点で簡潔に>
\`\`\`
目安: 0-35=軽微（1〜2ファイル・低リスク）、36-70=中規模、71-100=大規模/高リスク（スキーマ・認証・決済・多数ファイル）。

### 調査結果に基づくリスク判定（必須）
モデル選定の risk floor は、タスク説明の語句ではなく**この判定**を使います。実際にコードを読んだ上で、この変更が高リスク領域（DBスキーマ/マイグレーション・認証認可・決済課金・セキュリティ境界）を**実際に変更するか**を判断し、research.md の末尾に必ず次の形式で記載してください:
\`\`\`
## リスク判定
リスク: <高|低>
対象領域: <スキーマ/認証/決済/セキュリティ のうち該当するもの。低の場合は「なし」>
根拠: <変更対象になるファイルを挙げて1〜2行>
\`\`\`
判断基準: **変更するか**であって、話題に出るかではありません。既存の認証コードを読んだだけ、スキーマを参照しただけ、「触らない」と結論した場合は **低** です。実際にそれらのファイルを書き換える場合のみ **高** としてください。`
      : ''
}`
        : `\n\n## STRICT RULES (Investigation-only mode)

**You are an investigation-only agent. You do NOT implement or verify.**

### FORBIDDEN
- Modifying source code / test code / config / lockfile
- Using \`apply_patch\` or attempting any file write
- Running \`pnpm install\` / \`pnpm test\` / \`vitest\` / \`tsc\` / \`prettier\` / \`eslint\`
- Running any \`git\` command
- Saying "対応しました" / "implemented" / "added tests"

### ALLOWED
- Reading files (\`Read\` / \`cat\` / \`Get-Content\`)
- Search (\`grep\` / \`rg\` / \`find\` / \`Glob\`)
- Directory listing (\`ls\` / \`Get-ChildItem\`)
- Reasoning about problems and proposing approaches (NO implementation)

### OUTPUT
**Return ONLY the markdown ${transition.outputFile === 'plan' ? 'implementation plan' : transition.outputFile === 'research' ? 'investigation report' : 'review report'} as your final assistant message.** Rapitas will capture your final message externally and save it as ${transition.outputFile}.md. You do NOT need to create the file yourself.
`;
  } else if (transition.outputFile) {
    // Non-investigation phase OR non-codex agent fallback: keep the legacy
    // "save via curl" instructions so other CLIs (claude-code, gemini) can
    // also produce md files.
    fullPrompt += `\n\n${cliT.fileHeader}\n${cliT.fileInstruction}\n${cliT.noRootFiles}\n\n`;
    fullPrompt += `${cliT.apiCommand}\n\`\`\`bash\n`;
    fullPrompt += `curl -X PUT http://127.0.0.1:${process.env.PORT || '3001'}/workflow/tasks/${taskId}/files/${transition.outputFile} \\\n`;
    fullPrompt += `  -H 'Content-Type: application/json' \\\n`;
    fullPrompt += `  -d '{"content":"${cliT.contentPlaceholder}"}'\n\`\`\`\n\n`;
    if (transition.outputFile === 'verify') {
      fullPrompt +=
        language === 'ja'
          ? '保存後の自動処理（品質ゲート・敵対的レビュー・コミット/PR作成）には数分かかる場合があります。同じ内容を再送信しないでください。\n\n'
          : 'The post-save automation (quality gate, adversarial review, commit/PR creation) can take several minutes. Do not resend the same content.\n\n';
    }
    fullPrompt += `${cliT.powershellCommand}\n\`\`\`powershell\n`;
    fullPrompt += `$content = @'\n${cliT.contentPlaceholder}\n'@\n`;
    fullPrompt += `$body = @{ content = $content } | ConvertTo-Json -Depth 10\n`;
    fullPrompt += `Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:${process.env.PORT || '3001'}/workflow/tasks/${taskId}/files/${transition.outputFile}" -ContentType "application/json; charset=utf-8" -Body $body\n`;
    fullPrompt += `\`\`\`\n\n`;
    fullPrompt += `${cliT.prohibitions}\n${cliT.mandatory}`;
  }

  // Implementation phase: the implementer must EDIT code, never produce a plan.
  // In standard/comprehensive modes plan.md already exists (the plan phase wrote
  // it); in lightweight mode the plan phase is intentionally skipped. Either way
  // the implementer must NOT create plan.md — without this explicit override the
  // agent followed CLAUDE.md's generic research→plan→implement step and wrote a
  // plan.md for a lightweight task instead of implementing (observed: task 225,
  // complexity 8 / lightweight, agent announced "plan.md を作成します").
  if (isImplementationRole) {
    fullPrompt +=
      language === 'ja'
        ? `\n\n## 実装フェーズ（厳守）
**あなたは「実装」エージェントです。research.md（存在すれば plan.md も）に基づき、実際にコードを実装してください。**
- **plan.md を作成しないこと。** 計画フェーズは完了済み（plan.md があればそれに従う）か、このタスクは軽量モードで計画フェーズが意図的にスキップされています。CLAUDE.md に「plan.md を作成する」とあっても、実装フェーズの今は従わないでください。
- Write/Edit で直接コードを変更し、関連テストを追加/更新し、変更を完成させてください（調査・計画だけで終わらせない）。
- 完了後、検証フェーズが自動で続きます。

### git 操作の制限（厳守）
今の作業ディレクトリはこのタスク専用の worktree で、ブランチは開いた PR に紐づいている場合があります。
- **禁止**: \`git push --force\` / \`git reset --hard\` / \`git stash\` / \`git clean\` / ブランチの切替（\`git checkout <branch>\` / \`git switch\`）/ \`.git\` 設定の変更。force-push は開いている PR を閉じて成果を失わせます。
- **許可**: \`git status\` / \`git diff\` / \`git log\` / \`git add\` / 現在のブランチへの \`git commit\`。コミット・push・PR 作成は基本的に Rapitas が自動で行います。`
        : `\n\n## Implementation phase (strict)
**You are the IMPLEMENTER. Based on research.md (and plan.md if present), actually implement the code changes.**
- **Do NOT create plan.md.** The plan phase is already done (follow plan.md if present), or this is a lightweight task whose plan phase is intentionally skipped. Even if CLAUDE.md says to create plan.md, do NOT do so in this implementation phase.
- Edit code directly (Write/Edit), add/update the relevant tests, and complete the change (do not stop at investigation/planning).
- The verification phase follows automatically.

### git restrictions (strict)
Your working directory is a task-dedicated worktree whose branch may back an OPEN pull request.
- **Forbidden**: \`git push --force\` / \`git reset --hard\` / \`git stash\` / \`git clean\` / switching branches (\`git checkout <branch>\` / \`git switch\`) / changing \`.git\` config. A force-push closes the open PR and orphans its work.
- **Allowed**: \`git status\` / \`git diff\` / \`git log\` / \`git add\` / \`git commit\` on the current branch. Rapitas normally creates commits, pushes, and PRs automatically.`;
  }

  // Concern Backlog: agents must FILE out-of-scope issues, never fix them inline.
  // This is what stops "not my task → ignore it" for bugs/risks spotted in passing.
  const port = process.env.PORT || '3001';
  fullPrompt += `

## 起票の振り分け（懸念バックログ と アイデアボックス）
作業中に今回のタスクのスコープ外で何かに気づいたら、その場で直さず（スコープ外の変更は禁止）、内容に応じて次の**どちらか一方**に起票してください。**両方には入れないこと。**
判定ルール: 「壊れている / 壊れうる / 危険」= 不具合・リスク → 懸念バックログ。「壊れてはいないが、こうすればもっと良くなる」= 前向きな改善・新機能 → アイデアボックス。

### 懸念バックログ（不具合・リスク）→ POST /concerns
対象: バグ、脆弱性・セキュリティ問題、データ破壊/クラッシュ/誤動作のリスク、将来バグの温床になりかねないコード、明確なパフォーマンス劣化。
（「リファクタ」は"バグの温床・壊れやすい"ことが理由のときだけ懸念。単に綺麗にしたい/より良くしたいだけならアイデアボックスへ。）
起票（修正は起票されたタスクで別途行う）:
\`\`\`bash
curl -X POST http://127.0.0.1:${port}/concerns \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"簡潔な要約","detail":"何が問題で、なぜ重要か","type":"bug|refactor|security|perf|other","severity":"high|medium|low","location":"path/to/file.ts:行 など","originTaskId":${taskId}}'
\`\`\`

### アイデアボックス（前向きな改善・革新）→ POST /idea-box
対象: 新機能、既存機能のブラッシュアップ、UX改善、革新的なアイデア（今は壊れていないが、あれば品質・生産性・価値が上がるもの）。バグ・リスクは入れない。起票:
\`\`\`bash
curl -X POST http://127.0.0.1:${port}/idea-box \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"簡潔なアイデア名","content":"何を・なぜ・期待される効果","category":"improvement","scope":"global|project","priority":"high|medium|low"}'
\`\`\`
日本語が "?" に化ける場合は、内容を作業ディレクトリの .wf-idea.json に UTF-8 で書いてから --data-binary @.wf-idea.json で送る（.wf-* はコミットされません）。アイデアが無ければ何もしなくて構いません。`;

  return fullPrompt;
}
