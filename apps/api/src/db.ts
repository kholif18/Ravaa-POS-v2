import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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

/** Hash sandi format `saltHex:hashHex` (scrypt bawaan node, tanpa dep baru). */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

/** Verifikasi sandi terhadap hash `saltHex:hashHex` (timing-safe). */
export function verifyPassword(pw: string, hash: string): boolean {
  const [salt, hex] = String(hash).split(':');
  if (!salt || !hex) return false;
  try {
    const a = Buffer.from(scryptSync(pw, salt, 64).toString('hex'));
    const b = Buffer.from(hex);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function seed(): void {
  migrate();
  db.exec(loadSql('seed.sql'));
  // Akun pemilik bawaan (login 2026-10-11): HANYA bila tabel users masih
  // kosong (idempoten — seed ulang tidak mereset sandi yang sudah diganti).
  // Display name = 'kasir' supaya shift/laporan lama yang berkasir 'kasir'
  // tetap nyambung; wajib ganti sandi saat login pertama (must_change=1).
  const nUsers = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (nUsers === 0) {
    db.prepare(
      `INSERT INTO users (username, name, password_hash, role, must_change)
       VALUES ('pemilik', 'kasir', ?, 'pemilik', 1)`,
    ).run(hashPassword('admin123'));
  }
}
