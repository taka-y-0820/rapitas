/** Health-only maintenance. Never import normal config, routes, Prisma, workers or recovery. */
/* eslint-disable no-console -- the logger lives in the normal import graph this entry must not load */
import { Database } from 'bun:sqlite';
import { isAbsolute } from 'node:path';
import { createApiTokenGuard, createCrossSiteGuard } from '../../middleware/local-auth';

if (process.env.RAPITAS_TASK901_MAINTENANCE !== '1')
  throw Error('Maintenance entry requires explicit mode');
const url = process.env.DATABASE_URL;
if (!url?.startsWith('file:') || !isAbsolute(url.slice(5)))
  throw Error('Maintenance requires an existing absolute SQLite path');
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid maintenance port');
const db = new Database(url.slice(5), { readonly: true, create: false });
db.exec('PRAGMA query_only=ON');
const count = (sql: string) => Number((db.query(sql).get() as { n: number }).n);
function snapshot() {
  db.exec('BEGIN');
  try {
    return {
      activeExecutions: count(
        "SELECT COUNT(*) n FROM AgentExecution WHERE status IN ('running','pending','waiting_for_input','canceling','cancelling')",
      ),
      runningExecutions: count("SELECT COUNT(*) n FROM AgentExecution WHERE status='running'"),
      queueDepth: count(
        "SELECT COUNT(*) n FROM WorkflowQueueItem WHERE status IN ('queued','running','waiting_approval')",
      ),
      automaticThemes: count(
        "SELECT COUNT(*) n FROM ThemeAutoRun WHERE enabled=1 OR status<>'idle'",
      ),
      conductingSessions: count(
        "SELECT COUNT(*) n FROM OrchestraSession WHERE status='conducting'",
      ),
    };
  } finally {
    db.exec('ROLLBACK');
  }
}
try {
  if (Object.values(snapshot()).some((n) => n !== 0))
    throw Error('Maintenance requires stopped execution state');
} catch (error) {
  db.close();
  throw error;
}
const apiGuard = createApiTokenGuard(),
  siteGuard = createCrossSiteGuard();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const watchdog = setTimeout(() => process.exit(1), 5000);
  void Promise.resolve(server.stop(true)).then(
    () => {
      db.close();
      clearTimeout(watchdog);
      console.log(JSON.stringify({ type: 'maintenance-stopped', pid: process.pid }));
      process.exit(0);
    },
    () => {
      db.close();
      process.exit(1);
    },
  );
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    const denied = siteGuard({ request }) ?? apiGuard?.({ request });
    if (denied) return denied;
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') {
      try {
        const state = snapshot(),
          healthy = !stopping && Object.values(state).every((n) => n === 0);
        return Response.json(
          {
            status: healthy ? 'healthy' : 'unhealthy',
            mode: 'task901-maintenance',
            database: 'connected',
            backgroundInitialization: false,
            ...state,
            uptimeSeconds: process.uptime(),
          },
          { status: healthy ? 200 : 503 },
        );
      } catch {
        return Response.json(
          { status: 'unhealthy', mode: 'task901-maintenance', database: 'unavailable' },
          { status: 503 },
        );
      }
    }
    if (request.method === 'POST' && path === '/agents/shutdown') {
      // Match the existing admin policy without importing its agent graph.
      const secret = process.env.ADMIN_SECRET;
      if (
        process.env.NODE_ENV !== 'development' &&
        (!secret || request.headers.get('x-admin-token') !== secret)
      )
        return Response.json({ error: 'Admin authentication required' }, { status: 401 });
      setTimeout(stop, 50);
      return Response.json({ success: true, message: 'Maintenance shutdown initiated' });
    }
    return Response.json({ error: 'Unavailable during Task901 maintenance' }, { status: 503 });
  },
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGBREAK', 'SIGHUP'] as const) process.on(signal, stop);
process.on('exit', () => {
  server.stop(true);
});
console.log(
  JSON.stringify({
    type: 'maintenance-listening',
    pid: process.pid,
    port: server.port,
    backgroundInitialization: false,
  }),
);
