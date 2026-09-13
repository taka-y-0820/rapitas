/**
 * Workflow Orchestrator — Metadata Complexity
 *
 * Computes the transient, metadata-only complexity heuristic that seeds the
 * provisional workflow-mode pick before research runs. Moved verbatim from
 * workflow-orchestrator.ts (file-size ratchet, task 627); behavior is unchanged.
 */

/**
 * Compute the METADATA-heuristic complexity (title / description /
 * structured-spec counts) IN MEMORY — never persisted. task.complexityScore is
 * reserved for the research agent's code-grounded assessment; this transient
 * estimate only seeds the provisional workflow-mode pick before research.
 *
 * @param task - Task metadata fields. / タスクのメタデータ
 * @returns Heuristic 0-100 score. / ヒューリスティックスコア
 */
export async function computeMetadataComplexity(task: {
  title: string;
  description: string | null;
  estimatedHours: number | null;
  priority: string | null;
  themeId: number | null;
  labels?: unknown;
  goals?: unknown;
  constraints?: unknown;
  acceptanceCriteria?: unknown;
}): Promise<number> {
  const { analyzeTaskComplexity } = await import('./complexity-analyzer');
  // labels/goals/constraints/acceptanceCriteria are persisted as JSON strings
  // (or already arrays). Parse tolerantly — never throw on malformed data.
  const parseArr = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    if (typeof v === 'string' && v.trim()) {
      try {
        const p: unknown = JSON.parse(v);
        return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  const scored = analyzeTaskComplexity({
    title: task.title,
    description: task.description,
    estimatedHours: task.estimatedHours,
    labels: parseArr(task.labels),
    priority: task.priority ?? undefined,
    themeId: task.themeId,
    goals: parseArr(task.goals),
    constraints: parseArr(task.constraints),
    acceptanceCriteria: parseArr(task.acceptanceCriteria),
  });
  return scored.complexityScore;
}
