/** Bound shell command size without dropping or duplicating file arguments. */
export function buildFileCommands(prefix: string, quotedFiles: string[], limit = 6000): string[] {
  const commands: string[] = [];
  let current = prefix;
  for (const file of quotedFiles) {
    if (prefix.length + file.length + 1 > limit) {
      throw new Error('A verification file argument exceeds the command size limit');
    }
    if (current.length + file.length + 1 > limit) {
      commands.push(current);
      current = prefix;
    }
    current += ` ${file}`;
  }
  if (current !== prefix) commands.push(current);
  return commands;
}
