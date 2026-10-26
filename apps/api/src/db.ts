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

/** Pisah daftar definisi di dalam CREATE TABLE per koma TERLUAR — koma di
 *  dalam `CHECK (...)` / literal 'a, b' bukan pemisah kolom. */
function pecahTopLevel(isi: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  let inStr = false;
  for (const ch of isi) {
    if (inStr) {
      buf += ch;
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      buf += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** Parser mini db/schema.sql: daftar `{kolom, definisi}` per tabel. Sumber
 *  kebenaran tetap file SQL-nya — sengaja BUKAN daftar kolom hardcode
 *  terpisah yang bisa basi sendiri. */
function kolomDariSchema(teks: string): Map<string, { kolom: string; definisi: string }[]> {
  // Buang komentar `-- ...` dulu (isinya bisa memuat koma/tanda kurung).
  const bersih = teks.replace(/--[^\n]*/g, '');
  const hasil = new Map<string, { kolom: string; definisi: string }[]>();
  const re = /CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bersih))) {
    // Cari ')' penutup definisi tabel (sadar kurung bersarang + string).
    let i = re.lastIndex;
    let depth = 1;
    let inStr = false;
    for (; i < bersih.length && depth > 0; i++) {
      const ch = bersih[i];
      if (inStr) {
        if (ch === "'") inStr = false;
        continue;
      }
      if (ch === "'") inStr = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const isi = bersih.slice(re.lastIndex, i - 1);
    const daftar: { kolom: string; definisi: string }[] = [];
    for (const bagian of pecahTopLevel(isi)) {
      const t = bagian.trim().replace(/\s+/g, ' ');
      if (!t) continue;
      const km = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))(?:\s+([\s\S]+))?$/.exec(t);
      if (!km) continue;
      const nama = km[1] ?? km[2] ?? km[3] ?? km[4];
      // Baris constraint TINGKAT TABEL, bukan kolom.
      if (['CHECK', 'FOREIGN', 'PRIMARY', 'UNIQUE', 'CONSTRAINT'].includes(nama.toUpperCase())) continue;
      daftar.push({ kolom: nama, definisi: (km[5] ?? '').trim() });
    }
    hasil.set(m[1], daftar);
    re.lastIndex = i; // lanjut dari titik setelah ')' penutup
  }
  return hasil;
}

export type KolomHilang = { tabel: string; kolom: string; definisi: string };

/** Kolom yang dituntut db/schema.sql tapi TIDAK ada di tabelnya. DB lama yang
 *  dibuat sebelum sebuah kolom ditambahkan tidak ikut berubah: `migrate()`
 *  hanya `CREATE TABLE IF NOT EXISTS` yang tak menyentuh tabel yang sudah
 *  ada, dan query yang menyebut kolom hilang gagal "no such column" (kejadian
 *  nyata 2026-10-18: DB laptop pemilik ketinggalan products.price_grosir,
 *  sales.invoice_no/customer_name/note, topup_txns.token/sale_id, dst —
 *  halaman Dashboard/Riwayat/Laporan/Shift 500). */
export function kolomHilang(): KolomHilang[] {
  const skema = kolomDariSchema(loadSql('schema.sql'));
  const hilang: KolomHilang[] = [];
  for (const [tabel, daftar] of skema) {
    const ada = new Set(
      (db.prepare('SELECT name FROM pragma_table_info(?)').all(tabel) as { name: string }[]).map((r) => r.name),
    );
    if (ada.size === 0) continue; // tabel belum ada — urusan migrate(), bukan "kolom ketinggalan"
    for (const k of daftar) if (!ada.has(k.kolom)) hilang.push({ tabel, kolom: k.kolom, definisi: k.definisi });
  }
  return hilang;
}

/** Peringatan BESAR saat start bila DB ketinggalan kolom + perintah ALTER
 *  siap tempel. SENGAJA tidak auto-ALTER (kebijakan §5 AGENTS: migrasi
 *  manual, skema ditulis di db/schema.sql — bukan ALTER senyap). Dipanggil
 *  `index.ts` (boot API) dan `seed.ts` — tanpa ini "seed ok" menyesatkan:
 *  pada DB lama semua CREATE TABLE no-op dan keluaran tampak sukses padahal
 *  kolom baru tidak pernah terpasang. */
export function peringatkanSkema(): void {
  const hilang = kolomHilang();
  if (hilang.length === 0) return;
  const perTabel = new Map<string, KolomHilang[]>();
  for (const k of hilang) perTabel.set(k.tabel, [...(perTabel.get(k.tabel) ?? []), k]);
  const baris: string[] = [
    '',
    '='.repeat(76),
    `[SKEMA DB TIDAK SINKRON] ${hilang.length} kolom db/schema.sql tidak ada di ${dbPath}:`,
  ];
  for (const daftar of perTabel.values()) for (const k of daftar) baris.push(`  - ${k.tabel}.${k.kolom}`);
  baris.push('');
  baris.push('Tabel lama tidak pernah diubah otomatis (CREATE TABLE IF NOT EXISTS).');
  baris.push('Endpoint yang menyentuh kolom di atas akan gagal 500 sampai dimigrasi.');
  baris.push('Perintah perbaikan (jalankan saat API mati, lalu start lagi):');
  for (const daftar of perTabel.values()) {
    for (const k of daftar) {
      const manual = /\bPRIMARY KEY\b|\bUNIQUE\b/i.test(k.definisi);
      baris.push(
        manual
          ? `  -- ${k.tabel}.${k.kolom}: migrasi MANUAL (PRIMARY KEY/UNIQUE tidak didukung ADD COLUMN)`
          : `  sqlite3 "${dbPath}" "ALTER TABLE ${k.tabel} ADD COLUMN ${k.kolom} ${k.definisi};"`,
      );
    }
  }
  baris.push('');
  baris.push('Prosedur lengkap: AGENTS §5 (migrasi manual).');
  baris.push('='.repeat(76));
  console.error(baris.join('\n'));
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
    ).run(hashPassword('admin1234'));
  }
}
