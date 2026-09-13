/**
 * EvalDatabaseGuard
 *
 * Enforces that the private-eval harness can only ever talk to a dedicated
 * evaluation database, never the app/dev database that the live backend on
 * port 3001 depends on. This is the single structural defence for the highest
 * risk in this subsystem: one mistyped connection string writing evaluation
 * rows into the real database.
 *
 * It is NOT responsible for building the Prisma client — see
 * `eval-prisma-client.ts`, which must call `applyEvalDatabaseUrl()` before it
 * loads the resolver.
 */

/** Required suffix on the eval database NAME (not the whole URL). */
export const EVAL_DATABASE_NAME_SUFFIX = '_eval';

/** Environment variable holding the eval-only connection string. */
export const EVAL_DATABASE_URL_ENV = 'RAPITAS_EVAL_DATABASE_URL';

/** Thrown when the configured eval connection string is missing or unsafe. */
export class EvalDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalDatabaseGuardError';
  }
}

/**
 * Extracts the database name from a Postgres URL or a SQLite `file:` URL.
 *
 * @param url - Connection string to inspect / 検査対象の接続文字列
 * @returns The database name, or null when it cannot be determined / DB名（判定不能ならnull）
 */
export function extractDatabaseName(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith('file:')) {
    // SQLite: the "name" is the filename without its extension.
    const filePath = trimmed.slice('file:'.length).split('?')[0] ?? '';
    const base = filePath.split(/[\/]/).pop() ?? '';
    if (base.length === 0) return null;
    return base.replace(/\.[^.]+$/, '');
  }

  // Postgres/MySQL style: <scheme>://<credentials>@<host>/<database>?<params>
  // NOTE: parsed by hand rather than with `new URL()` because passwords in
  // these strings routinely contain characters that make URL() throw.
  const afterScheme = trimmed.includes('://') ? trimmed.split('://')[1] : trimmed;
  if (!afterScheme) return null;
  const pathPart = afterScheme.split('/').slice(1).join('/');
  if (pathPart.length === 0) return null;
  const name = pathPart.split('?')[0] ?? '';
  return name.length > 0 ? name : null;
}

/**
 * Verifies that the eval connection string is present and points at a database
 * whose name ends in `_eval`.
 *
 * @param env - Environment to read from / 読み取り対象の環境変数
 * @returns The validated eval connection string / 検証済みの接続文字列
 * @throws {EvalDatabaseGuardError} When unset, blank, unparseable, or not `*_eval` / 未設定・空・解析不能・`_eval`以外の場合
 */
export function assertEvalDatabaseSafe(env: NodeJS.ProcessEnv = process.env): string {
  const url = env[EVAL_DATABASE_URL_ENV];
  if (!url || url.trim().length === 0) {
    throw new EvalDatabaseGuardError(
      `${EVAL_DATABASE_URL_ENV} is not set. The eval harness refuses to fall back to DATABASE_URL, ` +
        'which would write evaluation rows into the app database.',
    );
  }

  const name = extractDatabaseName(url);
  if (name === null) {
    throw new EvalDatabaseGuardError(
      `Could not determine a database name from ${EVAL_DATABASE_URL_ENV}. ` +
        `Expected a connection string ending in a database named "<something>${EVAL_DATABASE_NAME_SUFFIX}".`,
    );
  }

  if (!name.endsWith(EVAL_DATABASE_NAME_SUFFIX)) {
    throw new EvalDatabaseGuardError(
      `${EVAL_DATABASE_URL_ENV} points at database "${name}", which does not end in ` +
        `"${EVAL_DATABASE_NAME_SUFFIX}". This suffix is mandatory so a copy-pasted app/dev ` +
        'connection string cannot start the harness.',
    );
  }

  return url.trim();
}

/**
 * Runs {@link assertEvalDatabaseSafe} and, on success, redirects `DATABASE_URL`
 * for this process so the Prisma resolver picks the eval database up.
 *
 * Call this BEFORE anything imports `config/prisma-client-resolver`: that
 * module reads `DATABASE_URL` at module-evaluation time to choose between the
 * postgres and sqlite generated clients.
 *
 * @param env - Environment to mutate / 書き換え対象の環境変数
 * @returns The eval connection string now installed as DATABASE_URL / 設定された接続文字列
 * @throws {EvalDatabaseGuardError} Propagated from assertEvalDatabaseSafe / 検証失敗時
 */
export function applyEvalDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = assertEvalDatabaseSafe(env);
  env.DATABASE_URL = url;
  return url;
}
