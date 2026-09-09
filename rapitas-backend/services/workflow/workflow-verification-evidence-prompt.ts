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
