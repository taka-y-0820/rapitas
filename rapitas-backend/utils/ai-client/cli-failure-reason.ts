/**
 * CliFailureReason
 *
 * Extracts the human-readable reason out of a failed Claude Code CLI
 * invocation. Pure string handling only — no spawning, no I/O.
 */

/**
 * Extract the last balanced top-level JSON object from CLI output.
 *
 * @param text - Raw CLI stdout/stderr. / CLI の生出力
 * @returns The JSON substring, or null when none is balanced. / JSON文字列、無ければnull
 */
export function extractLastJsonObject(text: string): string | null {
  let depth = 0;
  let end = -1;
  let inString = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) inString = !inString;
    }
    if (inString) continue;
    if (ch === '}') {
      if (depth === 0) end = i;
      depth++;
    } else if (ch === '{') {
      depth--;
      if (depth === 0 && end !== -1) return text.slice(i, end + 1);
    }
  }
  return null;
}

/** Keys the CLI uses for the failure text, in the order we trust them. */
const REASON_KEYS = ['result', 'error', 'message'] as const;

/** Cap so one huge reason cannot flood an error message or a log line. */
const MAX_REASON_CHARS = 300;

/**
 * Extract the human-readable reason from a failed CLI invocation.
 *
 * The CLI reports failures as a JSON envelope whose `result` field holds the
 * actual reason ("You've hit your monthly spend limit", an auth prompt, ...).
 * Blindly slicing the raw text truncated mid-envelope and threw the reason
 * away — every failure logged an identical, useless prefix ending at
 * `"output_tokens":`. Falls back to the raw head when there is no envelope.
 *
 * @param raw - stderr or stdout from the CLI. / CLI の出力
 * @returns A short reason suitable for an error message. / 短い失敗理由
 */
export function describeCliFailure(raw: string): string {
  const jsonText = extractLastJsonObject(raw.trim());
  if (jsonText) {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>;
        for (const key of REASON_KEYS) {
          const v = rec[key];
          if (typeof v === 'string' && v.trim()) return v.trim().slice(0, MAX_REASON_CHARS);
        }
      }
    } catch {
      // Not JSON after all — fall through to the raw head.
    }
  }
  return raw.slice(0, MAX_REASON_CHARS);
}
