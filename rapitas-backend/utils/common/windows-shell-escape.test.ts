/**
 * windows-shell-escape.test
 *
 * Covers `escapeWindowsShellArg` in isolation: quoting is unconditional,
 * the MSVCRT backslash-doubling rule, and the two escaping modes selected
 * by `doubleEscapeMetaChars` (real-quoted command name vs. caret-quoted,
 * doubly-escaped argument). Real `cmd.exe` round-trip parsing (does the
 * escaped text actually decode back to the original argv on a live
 * Windows shell, across both a called program and a `.cmd`-shim's internal
 * `%*` re-parse) is covered separately in
 * process-runner-args.cmd-roundtrip.test.ts, since that requires spawning
 * an actual process — this file only verifies the deterministic string
 * transform.
 */
import { describe, test, expect } from 'bun:test';
import { escapeWindowsShellArg } from './windows-shell-escape';

describe('escapeWindowsShellArg — doubleEscapeMetaChars=false (command-name mode)', () => {
  test('always quotes the result, even for an empty string', () => {
    expect(escapeWindowsShellArg('', false)).toBe('""');
  });

  test('quotes a plain string without altering its content', () => {
    expect(escapeWindowsShellArg('exec', false)).toBe('"exec"');
  });

  test('quotes a path containing spaces without a separate conditional branch', () => {
    expect(escapeWindowsShellArg('C:/Program Files/codex.cmd', false)).toBe(
      '"C:/Program Files/codex.cmd"',
    );
  });

  test('doubles a trailing run of backslashes so the closing quote is not escaped', () => {
    // MSVCRT rule (task #891 / CodeQL fix): a backslash run immediately
    // before the closing quote must double, or the last `\` would escape
    // the quote we add in Step 2 and merge with the next argument.
    expect(escapeWindowsShellArg('C:\\work\\', false)).toBe('"C:\\work\\\\"');
  });

  test('doubles backslashes preceding an embedded quote and escapes the quote', () => {
    expect(escapeWindowsShellArg('say "hi\\', false)).toBe('"say \\"hi\\\\"');
  });

  test('does not alter an interior single backslash with no adjacent quote', () => {
    expect(escapeWindowsShellArg('C:\\work\\file.txt', false)).toBe('"C:\\work\\file.txt"');
  });

  test('leaves the surrounding quotes real (not caret-escaped)', () => {
    // Command-name mode relies on cmd.exe's own boundary detection
    // recognizing a real quote pair to protect an embedded space — see the
    // doc comment on escapeWindowsShellArg for why this differs from the
    // args mode below (verified via process-runner-args.cmd-roundtrip.test.ts).
    const result = escapeWindowsShellArg('a b', false);
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
    expect(result).not.toContain('^"');
  });
});

describe('escapeWindowsShellArg — doubleEscapeMetaChars=true (argument mode)', () => {
  test('caret-escapes the wrapping quotes and doubles the escape pass', () => {
    expect(escapeWindowsShellArg('exec', true)).toBe('^^^"exec^^^"');
    expect(escapeWindowsShellArg('', true)).toBe('^^^"^^^"');
  });

  test.each([
    ['%', '%OPENAI_API_KEY%', '^^^"^^^%OPENAI_API_KEY^^^%^^^"'],
    ['&', 'a&b', '^^^"a^^^&b^^^"'],
    ['|', 'a|b', '^^^"a^^^|b^^^"'],
    ['(', '(group)', '^^^"^^^(group^^^)^^^"'],
    ['^', '^caret^', '^^^"^^^^caret^^^^^^^"'],
  ])('caret-escapes cmd.exe meta character %s (double pass)', (_label, input, expected) => {
    expect(escapeWindowsShellArg(input, true)).toBe(expected);
  });

  test('doubles a trailing backslash run before the caret-escaped closing quote', () => {
    expect(escapeWindowsShellArg('C:\\work\\', true)).toBe('^^^"C:\\work\\\\^^^"');
  });

  test('handles a mix of embedded quote and trailing backslash', () => {
    expect(escapeWindowsShellArg('say "hi\\', true)).toBe('^^^"say \\^^^"hi\\\\^^^"');
  });

  test('preserves a literal newline inside the escaped argument', () => {
    expect(escapeWindowsShellArg('a\nb', true)).toBe('^^^"a\nb^^^"');
  });
});
