import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing required argument ${prefix}<path>`);
  return resolve(value);
}

const source = argument('source');
const target = argument('target');
if (!existsSync(source)) throw new Error(`Source SQLite DB does not exist: ${source}`);
if (existsSync(target)) throw new Error(`Refusing to overwrite backup target: ${target}`);
if (source === target || dirname(target) === source)
  throw new Error('Invalid SQLite backup target');

const db = new Database(source, { readonly: true });
try {
  // VACUUM INTO obtains a consistent SQLite snapshot without mutating the source DB.
  db.run('VACUUM INTO ?', [target]);
  console.log(JSON.stringify({ source, target }));
} finally {
  db.close();
}
