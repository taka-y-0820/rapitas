import { expect, test } from 'bun:test';
import { buildFileCommands } from './command-batches';

test('large verification diffs retain every ordered file within the shell limit', () => {
  const files = Array.from(
    { length: 200 },
    (_, i) => `"src/long directory/${'x'.repeat(80)}-${i}.ts"`,
  );
  const prefix = '"C:/tools/eslint.cmd" --format json';
  const commands = buildFileCommands(prefix, files);
  expect(commands.length).toBeGreaterThan(1);
  expect(commands.every((command) => command.length <= 6000)).toBe(true);
  expect(commands.map((command) => command.slice(prefix.length + 1)).join(' ')).toBe(
    files.join(' '),
  );
});

test('empty input does not accidentally check the entire project; oversized single paths fail', () => {
  expect(buildFileCommands('lint', [])).toEqual([]);
  expect(() => buildFileCommands('lint', ['"long-path"'], 10)).toThrow('size limit');
});
