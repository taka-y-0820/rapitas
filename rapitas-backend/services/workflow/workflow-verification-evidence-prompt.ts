/** Evidence rules shared by implementer self-checks and verifier reports. */
export function verificationEvidencePrompt(language: 'ja' | 'en'): string {
  return language === 'ja'
    ? '\n### 検証結果の取り違え防止\n' +
        '- 起動時に受け取った runId と pollUrl を保持し、そのURLの最終GET応答で runId が一致することを確認してください。最終サマリの直前にも同じURLをGETし、報告はその応答に基づけてください。別ジョブ・別タスクの結果、実装者のサマリ、過去の一時ファイルを検証の証拠にしないでください。\n' +
        '- ローカル保存が必要なら taskId と runId を含む専用ファイルを新規作成し、本文の runId も照合してください。共有の固定ファイル名を再利用しないでください。起動応答しかない、ファイルが古い、runIdが違う、GETに失敗した場合は結果未確定です。\n' +
        '- checks[].ran が false の検査は「未実行・対象外」です。ok:true でも実行成功とは書かず、実行件数や format など応答にない検査を補わないでください。runtimeの警告・consoleエラーも省略せず、観測できた範囲と制約を記録してください。\n'
    : '\n### Verification evidence identity\n' +
        '- Retain the runId and pollUrl returned at launch. Check that the final GET response from that URL has the same runId. GET that same URL again immediately before the final summary and report its actual response. Never use another job/task, an implementer summary, or an old temporary file as verification evidence.\n' +
        '- If local storage is necessary, create a new file scoped to both taskId and runId and validate the runId inside it. Do not reuse a shared fixed filename. A launch-only response, stale file, mismatched runId, or failed GET leaves the result unconfirmed.\n' +
        '- A check with checks[].ran=false was skipped, not successfully executed, even when ok:true. Do not invent test counts or checks such as format that are absent from the response. Include runtime warnings and console errors and describe the limits of the observation.\n';
}

/**
 * Shell exit-code safety rule shared by implementer and verifier prompts
 * (task 916). Piping a verification command through `tail`/`head` loses the
 * original exit code (Git Bash's `pipefail` is off by default, so
 * `false | tail -1` exits 0) — this happened three times (executions 3934,
 * 3938, 3946) even after task-description-only warnings, so the fix is a
 * concrete alternative command, not another line of prose.
 */
export function shellExitCodeSafetyRule(language: 'ja' | 'en'): string {
  return language === 'ja'
    ? '\n### シェル検証コマンドの終了コード保持（重要）\n' +
        '- `tsc`/`vitest`/`test` 等を手動でシェル実行する際、`| tail` / `| head` / `; echo $?` のような後処理を絶対に付けないでください。Git Bash はパイプの終了コードが最後のコマンド（tail等）のものになり、元コマンドが失敗していても 0 になります（`false | tail -1` の `$?` は 0）。\n' +
        '- 代わりに `node scripts/run-checked.cjs -- <command>` を経由してください。全出力は `.verification-logs/` に保存されつつ、コンソールには末尾のみ表示され、ラッパー自身の終了コードが元コマンドの終了コードと常に一致します。`echo $?`/`echo $LASTEXITCODE` での再取得は不要です。\n' +
        '- `run-checked.cjs` はパイプ・`;`・`&&`・`||` を含むコマンドを exit 2 で拒否します（回避不可）。複数コマンドが必要な場合はスクリプトファイルに切り出し、そのファイルパスを渡してください。\n'
    : '\n### Preserve the shell exit code (important)\n' +
        "- When running `tsc`/`vitest`/`test` manually from a shell, never append `| tail` / `| head` / `; echo $?`. Under Git Bash a pipe reports the LAST command's exit code (e.g. `tail`), which is 0 even when the original command failed (`false | tail -1` exits 0).\n" +
        "- Use `node scripts/run-checked.cjs -- <command>` instead. Full output is saved under `.verification-logs/`, the console shows only the tail, and the wrapper's own exit code always equals the original command's exit code — no need to re-read `$?`/`$LASTEXITCODE`.\n" +
        '- `run-checked.cjs` refuses (exit 2) any command containing a pipe, `;`, `&&`, or `||`. If you need multiple steps, put them in a script file and pass its path instead.\n';
}
