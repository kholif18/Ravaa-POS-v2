import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

function resolveDbPath(): string {
  const fromEnv = process.env.DB_PATH;
  const p = fromEnv
    ? path.isAbsolute(fromEnv) ? fromEnv : path.resolve(root, 'apps/api', fromEnv)
    : path.resolve(root, 'apps/api', 'data', 'data.db');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function loadSql(name: 'schema.sql' | 'seed.sql'): string {
  // Cari db/*.sql: prioritas ../../db (repo), lalu ./db (docker workdir)
  const candidates = [
    path.resolve(root, 'db', name),
    path.resolve(here, '..', '..', 'db', name),
    path.resolve(process.cwd(), 'db', name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  }
  throw new Error(`SQL file not found: ${name} (tried ${candidates.join(', ')})`);
}

export const dbPath = resolveDbPath();
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate(): void {
  db.exec(loadSql('schema.sql'));
}

export function seed(): void {
  migrate();
  db.exec(loadSql('seed.sql'));
}
