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

/** Buka koneksi baru ke file DB + pragma wajib (WAL + foreign_keys). */
function bukaKoneksi(p: string) {
  const d = new Database(p);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  return d;
}

// `let` (bukan const) — SATU-SATUNYA alasan: restore backup
// (POST /api/backup/restore) menukar file DB di disk saat API hidup, jadi
// koneksi harus bisa ditutup lalu dibuka ulang (pulihkanDari di bawah).
// ESM live binding: reassignment di sini terlihat oleh `import { db }` di
// index.ts — bukan tebakan, sudah diuji dengan tsx pada setup repo ini.
export let db = bukaKoneksi(dbPath);

/** Bungkus `db.transaction` yang SELALU memakai koneksi `db` terbaru.
 *
 *  `const tx = db.transaction(fn)` di scope modul mengikat instance koneksi
 *  YANG SAAT ITU — setelah `pulihkanDari()` menutup koneksi lama dan membuka
 *  yang baru, `tx` masih menunjuk koneksi tertutup itu dan setiap tulisan
 *  lewat tx gagal "The database connection is not open" (bug nyata: sesudah
 *  restore, POST /api/sales & /api/products & /api/returns & mutasi hutang
 *  mati sampai proses API di-restart). Dengan helper ini transaction dibuat
 *  per pemanggilan, jadi binding live ESM selalu segar. Call site TIDAK
 *  berubah: `const simpanX = transaksi((a, b) => {...})`. */
export function transaksi<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => db.transaction(fn)(...args);
}

export function migrate(): void {
  db.exec(loadSql('schema.sql'));
}

/** Pulihkan DB dari file backup (dipakai POST /api/backup/restore).
 *
 *  Urutan sengaja: SALIN dulu ke file sementara (kalau disk penuh/gagal
 *  baca, DB yang hidup belum tersentuh sama sekali), baru tutup koneksi,
 *  tukar file secara rename (atomik satu filesystem), buang pendamping
 *  -wal/-shm (file backup dibuat ber-mode DELETE, jadi pendamping lama pasti
 *  basi), lalu buka ulang koneksi — termasuk di jalur error, supaya API
 *  tidak pernah tertinggal tanpa koneksi DB. */
export function pulihkanDari(fileBackup: string): void {
  const sementara = `${dbPath}.tmp-restore`;
  fs.copyFileSync(fileBackup, sementara); // bisa throw — DB hidup masih utuh
  db.close();
  try {
    fs.renameSync(sementara, dbPath);
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  } finally {
    db = bukaKoneksi(dbPath);
    fs.rmSync(sementara, { force: true });
  }
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
  // Akun owner bawaan (login 2026-10-11): HANYA bila tabel users masih
  // kosong (idempoten — seed ulang tidak mereset sandi yang sudah diganti).
  // Display name = 'kasir' supaya shift/laporan lama yang berkasir 'kasir'
  // tetap nyambung; wajib ganti sandi saat login pertama (must_change=1).
  // Username DAN role = 'owner' (permintaan pemilik 2026-10-17 — dulu
  // keduanya 'pemilik').
  const nUsers = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (nUsers === 0) {
    db.prepare(
      `INSERT INTO users (username, name, password_hash, role, must_change)
       VALUES ('owner', 'kasir', ?, 'owner', 1)`,
    ).run(hashPassword('admin123'));
  }
}
