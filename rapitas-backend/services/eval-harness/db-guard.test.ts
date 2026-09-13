/**
 * db-guard.test
 *
 * This guard is the only structural defence between the eval harness and the
 * app database the live backend on port 3001 depends on. The cases below pin
 * the two failure modes that would actually happen in practice: forgetting to
 * set the variable at all, and pasting a dev/production connection string into
 * it.
 *
 * A synthetic env object is passed in rather than mutating process.env, so the
 * test cannot disturb the surrounding process.
 */
import { describe, it, expect } from 'bun:test';
import {
  applyEvalDatabaseUrl,
  assertEvalDatabaseSafe,
  EVAL_DATABASE_URL_ENV,
  EvalDatabaseGuardError,
  extractDatabaseName,
} from './db-guard';

const evalUrl = 'postgresql://rapitas:rapitas@localhost:5432/rapitas_eval';

describe('assertEvalDatabaseSafe', () => {
  it('throws when the eval URL is unset', () => {
    expect(() => assertEvalDatabaseSafe({})).toThrow(EvalDatabaseGuardError);
  });

  it('throws when the eval URL is blank', () => {
    expect(() => assertEvalDatabaseSafe({ [EVAL_DATABASE_URL_ENV]: '   ' })).toThrow(
      EvalDatabaseGuardError,
    );
  });

  it('throws for a dev database name', () => {
    expect(() =>
      assertEvalDatabaseSafe({
        [EVAL_DATABASE_URL_ENV]: 'postgresql://rapitas:rapitas@localhost:5432/rapitas_dev',
      }),
    ).toThrow(/does not end in "_eval"/);
  });

  it('throws for a production-looking database name', () => {
    expect(() =>
      assertEvalDatabaseSafe({
        [EVAL_DATABASE_URL_ENV]: 'postgresql://u:p@db.internal:5432/rapitas',
      }),
    ).toThrow(EvalDatabaseGuardError);
  });

  it('throws when no database name can be parsed', () => {
    expect(() =>
      assertEvalDatabaseSafe({ [EVAL_DATABASE_URL_ENV]: 'postgresql://u:p@localhost:5432' }),
    ).toThrow(/Could not determine a database name/);
  });

  it.each([
    ['a plain postgres _eval database', evalUrl],
    ['an _eval database with query parameters', `${evalUrl}?schema=public&connection_limit=5`],
    ['a sqlite file whose name ends in _eval', 'file:./tmp/rapitas_eval.db'],
  ])('accepts %s', (_label, url) => {
    expect(assertEvalDatabaseSafe({ [EVAL_DATABASE_URL_ENV]: url })).toBe(url);
  });

  it('rejects a sqlite file that does not end in _eval', () => {
    expect(() =>
      assertEvalDatabaseSafe({ [EVAL_DATABASE_URL_ENV]: 'file:./rapitas-desktop.db' }),
    ).toThrow(EvalDatabaseGuardError);
  });
});

describe('extractDatabaseName', () => {
  it('reads the database name from a postgres URL', () => {
    expect(extractDatabaseName(evalUrl)).toBe('rapitas_eval');
  });

  it('strips query parameters', () => {
    expect(extractDatabaseName(`${evalUrl}?schema=public`)).toBe('rapitas_eval');
  });

  it('strips the extension from a sqlite path', () => {
    expect(extractDatabaseName('file:/tmp/dir/rapitas_eval.db')).toBe('rapitas_eval');
  });

  it('returns null for an empty string', () => {
    expect(extractDatabaseName('   ')).toBeNull();
  });
});

describe('applyEvalDatabaseUrl', () => {
  it('overwrites DATABASE_URL only after the check passes', () => {
    const env = {
      DATABASE_URL: 'postgresql://rapitas:rapitas@localhost:5432/rapitas_dev',
      [EVAL_DATABASE_URL_ENV]: evalUrl,
    };
    applyEvalDatabaseUrl(env);
    expect(env.DATABASE_URL).toBe(evalUrl);
  });

  it('leaves DATABASE_URL untouched when the check fails', () => {
    const env = {
      DATABASE_URL: 'postgresql://rapitas:rapitas@localhost:5432/rapitas_dev',
      [EVAL_DATABASE_URL_ENV]: 'postgresql://rapitas:rapitas@localhost:5432/rapitas_prod',
    };
    expect(() => applyEvalDatabaseUrl(env)).toThrow(EvalDatabaseGuardError);
    expect(env.DATABASE_URL).toBe('postgresql://rapitas:rapitas@localhost:5432/rapitas_dev');
  });
});
