import { describe, expect, test } from 'bun:test';
import { extractLastJsonObject, describeCliFailure } from './cli-failure-reason';

describe('CLI JSON envelope extraction', () => {
  for (const result of ['unfinished {', 'stray }', 'quoted "{ and \\ path', 'escaped \\" }']) {
    test(`preserves braces inside result strings: ${result}`, () => {
      const envelope = JSON.stringify({ result, usage: { output_tokens: 42 } });
      expect(extractLastJsonObject('banner\n{"earlier":true}\n' + envelope)).toBe(envelope);
      expect(describeCliFailure(envelope)).toBe(result);
    });
  }
});
