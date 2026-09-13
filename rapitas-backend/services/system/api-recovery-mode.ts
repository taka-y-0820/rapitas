/** Temporary API recovery using the existing single-start maintenance entry. */
export function isApiRecoveryMode(): boolean {
  return process.env.RAPITAS_TASK901_MAINTENANCE === 'api';
}

/** Fail closed: only reviewed ordinary CRUD/read routes are exposed during recovery. */
export function apiRecoveryRequestGuard({ request }: { request: Request }): Response | undefined {
  if (!isApiRecoveryMode()) return;
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (request.method === 'OPTIONS') return;
  if (
    read &&
    (/^\/(health|settings|agents|agents\/resumable-executions|events\/(status|stream))$/.test(
      path,
    ) ||
      /^\/events\/subscribe\/[\w-]+$/.test(path) ||
      /^\/tasks(?:\/\d+)?$/.test(path) ||
      /^\/tasks\/(statistics|executing)$/.test(path) ||
      /^\/tasks\/\d+\/(comments|resources|time-entries|execution-status)$/.test(path) ||
      /^\/(themes|categories|projects|milestones|labels|notifications)(?:\/\d+)?$/.test(path))
  )
    return;
  if (request.method === 'POST' && (path === '/tasks' || path === '/agents/shutdown')) return;
  if ((request.method === 'PUT' || request.method === 'PATCH') && /^\/tasks\/\d+$/.test(path))
    return;
  return Response.json(
    { error: 'This operation is held during API recovery', code: 'API_RECOVERY_HELD' },
    { status: 503 },
  );
}
