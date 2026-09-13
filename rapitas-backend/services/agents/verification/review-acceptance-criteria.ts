/** Parse the task's acceptanceCriteria JSON-string column into a string[]. */
export function parseAcceptanceCriteria(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p: unknown = JSON.parse(raw);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}
