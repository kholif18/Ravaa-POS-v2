import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MiddlewareHandler } from 'hono/types';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { db, dbPath, hashPassword, migrate, peringatkanSkema, pulihkanDari, transaksi, verifyPassword } from './db.js';

migrate();
// Peringatan dini DB lama yang ketinggalan kolom (2026-10-18): tanpa ini,
// baris "listening" menyembunyikan fakta bahwa sebagian endpoint akan gagal
// 500 "no such column" (kejadian nyata: DB laptop pemilik 2026-10-18).
peringatkanSkema();

// Thumbnail foto produk disimpan di samping file DB (ikut DB_PATH, jadi Docker
// / install native / test dengan DB_PATH khusus tidak pernah saling menimpa).
// Dibuat lazy: jarang dipakai, dan folder yang kosong tidak mengganggu git.
const IMG_DIR = path.join(path.dirname(dbPath), 'img');
function imgDir(): string {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  return IMG_DIR;
}

const app = new Hono<{ Variables: { user: Pengguna } }>();
app.use('*', cors({ origin: (process.env.CORS_ORIGIN ?? '*').split(',') }));

// 500 informatif (2026-10-18): error yang lolos dari try/catch halaman —
// terutama "no such column / has no column named" dari DB yang ketinggalan
// migrasi — dibalas JSON {error} supaya api.ts menampilkannya sebagai toast
// yang menjelaskan sebab + arah perbaikan, bukan "Internal Server Error"
// bisu (kasus nyata: halaman 500 tanpa petunjuk di laptop pemilik). Detail
// penuh tetap dicatat di log server.
app.onError((err, c) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[error 500]', msg);
  const skema = /no such column|has no column named|no such table/i.test(msg);
  return c.json(
    {
      error: skema
        ? `database tidak sinkron dengan skema (${msg}) — DB kemungkinan ketinggalan migrasi kolom; periksa peringatan skema di log API / AGENTS §5, atau pulihkan backup terbaru, lalu restart API`
        : `kesalahan server: ${msg}`,
    },
    500,
  );
});

// ---------- login & peran (2026-10-11) ----------
// 2 role: `owner` (semua) dan `kasir` (POS + Riwayat + Stok + Pelanggan +
// Hutang + Retur + shift sendiri). Token acak 32 byte di header
// `Authorization: Bearer <token>`, kedaluwarsa 30 hari. Gagal auth = 401,
// gagal peran = 403. Endpoint yang butuh peranasebutkan eksplisit di bawah
// lewat `hanyaOwner`; yang tidak disebut = kedua peran boleh (kecuali
// login/logout/me yang punya aturan sendiri).
type Pengguna = {
  id: number;
  username: string;
  name: string;
  role: 'owner' | 'kasir';
  /** JSON array izin operasional (Paket B4). NULL = default role. */
  permissions?: string | null;
};
type Sesi = Pengguna & { must_change: number };

const UMUR_SESI_HARI = 30;

// ---------- izin operasional (Paket B4, 2026-10-20) ----------
// Izin CORE sengaja TIDAK masuk kolom users.permissions: empat rute ini tetap
// dijaga `hanyaOwner` (role, bukan izin) supaya kasir yang diberi banyak izin
// operasional tidak pernah bisa mengelola akun/backup/audit/mengubah aturan
// global. Sisanya = izin operasional yang dapat disetel owner per akun.
const IZIN_CORE = ['pengguna.kelola', 'pengaturan.ubah', 'backup.kelola', 'audit.lihat'] as const;
const IZIN_OPERASIONAL = [
  // POS
  'pos.jual', 'pos.diskon', 'pos.harga', 'pos.item_manual', 'pos.topup', 'pos.tarik', 'pos.hold_semua',
  // Riwayat & retur
  'riwayat.lihat', 'riwayat.semua', 'retur.lihat', 'retur.buat', 'retur.batal',
  // Pelanggan & hutang
  'pelanggan.lihat', 'pelanggan.ubah', 'pelanggan.hapus',
  'hutang.lihat', 'hutang.catat', 'hutang.bayar', 'hutang.hapus',
  // Pesanan jasa
  'pesanan.lihat', 'pesanan.buat', 'pesanan.bayar', 'pesanan.batal',
  // Stok & shift
  'stok.lihat', 'stok.restock', 'stok.opname',
  'shift.lihat', 'shift.buka', 'shift.tutup', 'shift.kelola',
  // Manajemen
  'produk.kelola', 'supplier.kelola', 'pembelian.kelola', 'laporan.lihat',
  'pengeluaran.kelola', 'kasmasuk.kelola',
] as const;
type IzinOperasional = (typeof IZIN_OPERASIONAL)[number];
const SET_IZIN = new Set<string>(IZIN_OPERASIONAL);
const SET_CORE = new Set<string>(IZIN_CORE);

// Default kasir "Standar" = perilaku sebelum B4: POS penuh, riwayat/retur,
// pelanggan/hutang, pesanan, stok (lihat/restock/opname), shift sendiri.
// Manajemen (produk/supplier/pembelian/laporan/pengeluaran/kas masuk) dan
// `shift.kelola`/`pos.hold_semua` TIDAK diberikan (dulu memang khusus owner).
const IZIN_KASIR_STANDAR: readonly IzinOperasional[] = IZIN_OPERASIONAL.filter(
  (i) =>
    i !== 'pos.hold_semua' &&
    i !== 'shift.kelola' &&
    i !== 'produk.kelola' &&
    i !== 'supplier.kelola' &&
    i !== 'pembelian.kelola' &&
    i !== 'laporan.lihat' &&
    i !== 'pengeluaran.kelola' &&
    i !== 'kasmasuk.kelola',
);
const SET_STANDAR = new Set<string>(IZIN_KASIR_STANDAR);

function bacaIzinTersimpan(raw: unknown): Set<string> | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return new Set<string>();
    // Nilai asing/core diabaikan saat membaca (data lama/lebih baru tidak
    // boleh membuat kasir mendapat akses core lewat kolom ini).
    return new Set(arr.map(String).filter((x) => SET_IZIN.has(x)));
  } catch {
    // Kolom rusak = fail closed. Jangan diam-diam memberi default penuh.
    console.error('[izin] permissions tidak bisa dibaca — dianggap tanpa izin');
    return new Set<string>();
  }
}

/** Izin efektif sesi. Owner selalu punya SEMUA izin operasional; core tetap
 *  dijaga `hanyaOwner` dan tidak pernah dibaca dari kolom permissions. */
function izinEfektif(u: { role: string; permissions?: string | null }): Set<string> {
  if (u.role === 'owner') return new Set<string>(IZIN_OPERASIONAL);
  const terbaca = bacaIzinTersimpan(u.permissions);
  if (terbaca === null) return new Set<string>(SET_STANDAR);
  return terbaca;
}
function bolehIzin(u: { role: string; permissions?: string | null }, izin: IzinOperasional): boolean {
  return u.role === 'owner' || izinEfektif(u).has(izin);
}

/** Validasi payload izin dari form owner. `undefined` = tidak dikirim (update
 *  mempertahankan nilai lama); null/'' = kembali default role; array = custom. */
function validasiKirimanIzin(raw: unknown): { ok: true; json: string | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, json: null };
  if (raw === null || raw === '') return { ok: true, json: null };
  if (!Array.isArray(raw)) return { ok: false, error: 'permissions harus array izin operasional' };
  const bersih: string[] = [];
  for (const x of raw) {
    const k = String(x ?? '').trim();
    if (!k) continue;
    if (SET_CORE.has(k)) {
      return { ok: false, error: `izin core hanya milik owner: ${k}` };
    }
    if (!SET_IZIN.has(k)) return { ok: false, error: `izin tidak dikenal: ${k}` };
    if (!bersih.includes(k)) bersih.push(k);
  }
  return { ok: true, json: JSON.stringify(bersih) };
}

/** Profil akun yang aman dikirim ke client (tanpa hash sandi/PIN). */
function profilAkun(u: {
  id: number; username: string; name: string; role: string;
  avatar?: string | null; email?: string; permissions?: string | null;
  pin_updated_at?: string | null;
}) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    avatar: u.avatar ?? null,
    email: u.email ?? '',
    permissions: [...izinEfektif(u)],
    permissions_custom: u.permissions !== null && u.permissions !== undefined,
    pin_set: Boolean(u.pin_updated_at),
    pin_updated_at: u.pin_updated_at ?? null,
  };
}

const wajibIzin = (izin: IzinOperasional): MiddlewareHandler => async (c, next) => {
  const u = c.get('user') as Pengguna | undefined;
  if (!u || !bolehIzin(u, izin)) {
    return c.json({ error: `izin ${izin} tidak diberikan untuk akun ini — hubungi owner` }, 403);
  }
  await next();
};

/** Error otorisasi dari dalam transaksi (insertSale) — rute membalas 403,
 *  bukan 400 seperti validasi payload biasa. */
class IzinError extends Error {}

function sesiDariToken(auth: string | undefined): Sesi | null {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(String(auth ?? '').trim());
  if (!m) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.must_change, u.permissions
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now') AND u.is_active = 1`,
  ).get(m[1]) as Sesi | undefined;
  return row ?? null;
}

// Jalur publik (tanpa token): health + login. Semua /api lain wajib token.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/login') return next();
  // Foto produk & avatar pengguna = pengecualian token: dimuat lewat tag
  // `<img src>` (cache-buster ?version) yang TIDAK bisa membawa header
  // Authorization. Keduanya gambar yang memang tampil di layar kasir — bukan
  // data sensitif; id saja tidak membuka apa pun lain. Logo toko (1.6.4)
  // ikut: ditampilkan di kartu Sistem DAN diunduh klien untuk raster struk.
  if (c.req.method === 'GET' && /^\/api\/products\/\d+\/image$/.test(c.req.path)) return next();
  if (c.req.method === 'GET' && /^\/api\/users\/\d+\/avatar$/.test(c.req.path)) return next();
  if (c.req.method === 'GET' && c.req.path === '/api/settings/logo') return next();
  const user = sesiDariToken(c.req.header('Authorization'));
  if (!user) return c.json({ error: 'belum login — masuk dulu di halaman Login' }, 401);
  // Sandi wajib ganti (akun baru/reset): selain ganti-sandi, keluar, dan
  // baca-profil-sendiri, semua ditolak 403 sampai diganti.
  if (
    user.must_change &&
    c.req.path !== '/api/users/password' &&
    c.req.path !== '/api/logout' &&
    c.req.path !== '/api/me'
  ) {
    return c.json({ error: 'wajib ganti sandi dulu sebelum memakai aplikasi' }, 403);
  }
  c.set('user', user);
  await next();
});

/** Guard endpoint khusus owner — pasang sebagai handler kedua:
 *  `app.post('/api/x', hanyaOwner, async (c) => {...)`. Diketik
 *  MiddlewareHandler supaya handler rute di belakangnya tetap membawa tipe
 *  param path-nya (mis. `:nama` tetap string, bukan string|undefined). */
const hanyaOwner: MiddlewareHandler = async (c, next) => {
  const u = c.get('user') as Pengguna | undefined;
  if (!u || u.role !== 'owner') {
    return c.json({ error: 'khusus owner — akun kasir tidak boleh' }, 403);
  }
  await next();
};

const rupiah = (n: number) => `Rp${Number(n || 0).toLocaleString('id-ID')}`;

// ---------- jejak audit (2026-10-16, halaman #/audit) ----------
// "Siapa mengubah apa" untuk mutasi yang risiko-nya tidak terlihat dari tabel
// aslinya: master (produk/kategori/satuan/pelanggan/supplier/pengguna/
// setting), stok (restock/opname), koreksi dokumen uang (pengeluaran/
// piutang/retur dibatalkan), restore backup, dan login. Penjualan/topup/
// pembelian TIDAK dicatat di sini — nota-nota itu sudah tabelnya sendiri.
// ATURAN: pencatatan audit TIDAK PERNAH menggagalkan operasi aslinya; gagal
// tulis = console.error saja (audit metadata, bukan transaksi).
type AksiAudit =
  | 'create' | 'update' | 'delete' | 'restock' | 'opname'
  | 'import' | 'restore' | 'login' | 'login-gagal';

function catatAudit(
  c: Context,
  action: AksiAudit,
  entity: string,
  entityId: string | number,
  detail: unknown = '',
  aktor?: { id?: number; username?: string; role?: string },
): void {
  try {
    const u = (c.get('user') as Pengguna | undefined) ?? undefined;
    const a = aktor ?? u ?? {};
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail ?? '');
    db.prepare(
      `INSERT INTO audit_log (user_id, username, role, action, entity, entity_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id ?? null, a.username ?? '', a.role ?? '', action, entity, String(entityId ?? ''), String(d).slice(0, 500));
  } catch (e) {
    console.error('[audit] gagal mencatat:', e instanceof Error ? e.message : e);
  }
}


// ---------- PIN cepat & kunci layar (Paket B5, 2026-10-20) ----------
// PIN 6 digit HANYA untuk membuka kunci layar perangkat dan berpindah akun
// dari sesi yang sudah aktif. BUKAN pengganti sandi/login publik: token API
// tetap milik sesi yang sedang login (kunci layar = lapisan UI, bukan
// pencabutan token). Hash memakai scrypt yang sama dengan sandi.
const PIN_PANJANG = 6;
const PIN_MAKS_GAGAL_SEBELUM_KUNCI = 5;

function tokenDariHeader(auth: string | undefined): string | null {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(String(auth ?? '').trim());
  return m ? m[1] : null;
}

type BarisPin = {
  id: number; username: string; name: string; role: string; is_active: number;
  must_change: number; avatar: string | null; email: string;
  permissions: string | null; pin_hash: string | null; pin_failed: number;
  pin_locked_until: string | null; pin_updated_at: string | null;
};

function detikSampai(until: string | null): number {
  if (!until) return 0;
  const t = Date.parse(`${String(until).replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

function kartuPin(row: BarisPin) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    avatar: row.avatar,
    email: row.email,
    permissions: row.permissions,
    pin_updated_at: row.pin_updated_at,
  };
}

function gagalPin(userId: number, gagalLama: number): { status: number; error: string; retry_after: number } {
  const gagal = gagalLama + 1;
  // Ambang berjenjang (kontrak §3): 5 gagal = 60 dtk, 10 = 300 dtk,
  // 15+ = 900 dtk. Hitungan TIDAK di-reset saat kunci habis — hanya
  // verifikasi berhasil / reset PIN owner yang mengosongkannya.
  const detik = gagal >= 15 ? 900 : gagal >= 10 ? 300 : gagal >= 5 ? 60 : 0;
  if (detik > 0) {
    db.prepare(
      `UPDATE users SET pin_failed = ?, pin_locked_until = datetime('now', ?) WHERE id = ?`,
    ).run(gagal, `+${detik} seconds`, userId);
    return {
      status: 429,
      error: `terlalu banyak percobaan PIN — coba lagi dalam ${detik} detik`,
      retry_after: detik,
    };
  }
  db.prepare('UPDATE users SET pin_failed = ? WHERE id = ?').run(gagal, userId);
  return { status: 401, error: 'PIN salah', retry_after: 0 };
}

/** Verifikasi PIN satu akun. Efek samping: menaikkan penalti saat salah dan
 *  mengosongkan penalti saat benar. Mengembalikan baris user segar saat ok. */
function verifikasiPin(userId: number, pin: string):
  | { ok: true; row: BarisPin }
  | { ok: false; status: number; error: string; retry_after?: number } {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as BarisPin | undefined;
  if (!row) return { ok: false, status: 404, error: 'pengguna tidak ada' };
  if (!row.is_active) return { ok: false, status: 403, error: 'akun ini dinonaktifkan — hubungi owner' };
  if (!row.pin_hash) return { ok: false, status: 400, error: 'PIN belum diatur untuk akun ini' };
  const sisa = detikSampai(row.pin_locked_until);
  if (sisa > 0) {
    return {
      ok: false,
      status: 429,
      error: `terlalu banyak percobaan PIN — coba lagi dalam ${sisa} detik`,
      retry_after: sisa,
    };
  }
  if (!new RegExp(`^\\d{${PIN_PANJANG}}$`).test(String(pin ?? '')) || !verifyPassword(String(pin), row.pin_hash)) {
    return { ok: false, ...gagalPin(userId, Number(row.pin_failed) || 0) };
  }
  db.prepare(
    `UPDATE users SET pin_failed = 0, pin_locked_until = NULL WHERE id = ?`,
  ).run(userId);
  return {
    ok: true,
    row: { ...row, pin_failed: 0, pin_locked_until: null },
  };
}

// ---------- sesi & pengguna (login 2026-10-11) ----------
const BOLEH_SANDI_MIN = 4;

// Masuk: username+password -> token 30 hari. Username tak ada DAN sandi salah
// SAMA-SAMA 401 (jangan membocorkan mana yang salah). Akun nonaktif = 403.
app.post('/api/login', async (c) => {
  try {
    const body = await c.req.json();
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    if (!username || !password) return c.json({ error: 'username dan password wajib diisi' }, 400);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | {
          id: number; username: string; name: string; role: string; password_hash: string;
          is_active: number; must_change: number; avatar: string | null; email: string;
          permissions: string | null; pin_updated_at: string | null;
        }
      | undefined;
    if (!u || !verifyPassword(password, u.password_hash)) {
      catatAudit(c, 'login-gagal', 'session', '', { username });
      return c.json({ error: 'username atau password salah' }, 401);
    }
    if (!u.is_active) return c.json({ error: 'akun ini dinonaktifkan — hubungi owner' }, 403);
    db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
    const token = randomBytes(32).toString('hex');
    db.prepare(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES (?, ?, datetime('now', ?))`,
    ).run(token, u.id, `+${UMUR_SESI_HARI} days`);
    catatAudit(c, 'login', 'session', u.id, { username: u.username }, { id: u.id, username: u.username, role: u.role });
    return c.json({
      data: {
        token,
        user: profilAkun(u),
        must_change: u.must_change === 1,
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal masuk' }, 400);
  }
});

// Keluar: hapus sesi token ini (idempotent — token asing pun dibalas ok).
app.post('/api/logout', (c) => {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(String(c.req.header('Authorization') ?? '').trim());
  if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
  return c.json({ data: { ok: true } });
});

// Profil sesi berjalan (dipakai guard rute + nama kasir di frontend).
app.get('/api/me', (c) => {
  const u = c.get('user') as Sesi;
  // Baca ulang baris user: avatar/email bisa berubah di tengah sesi (edit
  // profil) — jangan pakai snapshot middleware yang hanya memuat 4 kolom.
  const segar = db.prepare(
    'SELECT id, username, name, role, avatar, email, permissions, pin_updated_at FROM users WHERE id = ?',
  ).get(u.id) as
    | { id: number; username: string; name: string; role: string; avatar: string | null; email: string; permissions: string | null; pin_updated_at: string | null }
    | undefined;
  const user = segar ?? {
    id: u.id, username: u.username, name: u.name, role: u.role,
    avatar: null, email: '', permissions: u.permissions ?? null, pin_updated_at: null,
  };
  return c.json({
    data: {
      user: profilAkun(user),
      must_change: u.must_change === 1,
    },
  });
});

function barisUserBersih(r: unknown) {
  const u = r as {
    id: number; username: string; name: string; role: string; is_active: number;
    must_change: number; created_at: string; avatar?: string | null; email?: string;
    permissions?: string | null; pin_updated_at?: string | null;
  };
  return {
    ...profilAkun(u),
    is_active: u.is_active,
    must_change: u.must_change,
    created_at: u.created_at,
  };
}

// Daftar akun (owner saja) — TANPA hash sandi/PIN, jangan pernah dikirim.
app.get('/api/users', hanyaOwner, (c) => {
  const rows = db.prepare(
    `SELECT id, username, name, role, is_active, must_change, created_at, avatar, email,
            permissions, pin_updated_at
       FROM users ORDER BY id`,
  ).all();
  return c.json({ data: (rows as unknown[]).map(barisUserBersih) });
});

// Daftar ringkas untuk layar kunci / pilih akun cepat. Semua akun aktif boleh
// dibaca sesi mana pun (hanya id/nama/peran + status punya PIN; bukan rahasia),
// karena layar kunci memang harus menampilkan pilihan akun tanpa memanggil
// endpoint owner-only.
app.get('/api/users/ringkas', (c) => {
  const rows = db.prepare(
    `SELECT id, username, name, role, avatar, pin_updated_at, is_active
       FROM users WHERE is_active = 1 ORDER BY name COLLATE NOCASE, id`,
  ).all() as { id: number; username: string; name: string; role: string; avatar: string | null; pin_updated_at: string | null; is_active: number }[];
  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      username: r.username,
      name: r.name,
      role: r.role,
      avatar: r.avatar,
      pin_set: Boolean(r.pin_updated_at),
    })),
  });
});

// Atur / ganti PIN sendiri. Bila sudah punya PIN, `old_pin` wajib dan ikut
// kena rate-limit yang sama — tanpa itu siapa pun yang memegang sesi terbuka
// bisa mengganti PIN korban tanpa tahu PIN lama.
app.post('/api/users/pin', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const u = c.get('user') as Sesi;
    const pin = String(body?.pin ?? '').trim();
    if (!new RegExp(`^\\d{${PIN_PANJANG}}$`).test(pin)) {
      return c.json({ error: `PIN harus ${PIN_PANJANG} digit angka` }, 400);
    }
    const lama = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(u.id) as
      { pin_hash: string | null } | undefined;
    if (!lama) return c.json({ error: 'pengguna tidak ada' }, 404);
    if (lama.pin_hash) {
      const oldPin = String(body?.old_pin ?? '').trim();
      if (!oldPin) return c.json({ error: 'PIN lama wajib diisi untuk mengganti PIN' }, 400);
      const v = verifikasiPin(u.id, oldPin);
      if (!v.ok) {
        return c.json({ error: v.error, ...(v.retry_after ? { retry_after: v.retry_after } : {}) }, v.status as 400);
      }
    }
    const row = db.prepare(
      `UPDATE users SET pin_hash = ?, pin_failed = 0, pin_locked_until = NULL,
         pin_updated_at = datetime('now') WHERE id = ? RETURNING pin_updated_at`,
    ).get(hashPassword(pin), u.id) as { pin_updated_at: string };
    catatAudit(c, 'update', 'user', u.id, { pin: true, aksi: 'set-pin' });
    return c.json({ data: { pin_set: true, pin_updated_at: row.pin_updated_at } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal menyimpan PIN' }, 400);
  }
});

// Verifikasi PIN sesi berjalan (membuka kunci layar). Online didahulukan;
// klien boleh jatuh ke verifier lokal HANYA saat jaringan error (bukan 401).
app.post('/api/users/pin/verify', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const u = c.get('user') as Sesi;
    const pin = String(body?.pin ?? '').trim();
    const v = verifikasiPin(u.id, pin);
    if (!v.ok) {
      catatAudit(c, 'login-gagal', 'session', u.id, { pin: true, alasan: v.error });
      return c.json(
        { error: v.error, ...(v.retry_after ? { retry_after: v.retry_after } : {}) },
        v.status as 400,
      );
    }
    return c.json({ data: { ok: true, pin_updated_at: v.row.pin_updated_at } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal verifikasi PIN' }, 400);
  }
});

// Pindah akun cepat dari sesi aktif. Token lama DICABUT, token baru diterbitkan
// untuk target — supaya device yang berpindah tidak meninggalkan sesi akun
// sebelumnya tetap hidup. Target `owner` hanya boleh dipilih dari sesi owner.
app.post('/api/users/pin/switch', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const saya = c.get('user') as Sesi;
    const targetId = Number(body?.user_id);
    if (!Number.isInteger(targetId)) return c.json({ error: 'user_id harus integer' }, 400);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as BarisPin | undefined;
    if (!target) return c.json({ error: 'pengguna tidak ada' }, 404);
    if (!target.is_active) return c.json({ error: 'akun ini dinonaktifkan — hubungi owner' }, 403);
    if (target.role === 'owner' && saya.role !== 'owner') {
      return c.json({ error: 'akun owner hanya bisa dipilih dari sesi owner' }, 403);
    }
    const v = verifikasiPin(targetId, String(body?.pin ?? '').trim());
    if (!v.ok) {
      catatAudit(c, 'login-gagal', 'session', targetId, { pin: true, switch: true, alasan: v.error });
      return c.json(
        { error: v.error, ...(v.retry_after ? { retry_after: v.retry_after } : {}) },
        v.status as 400,
      );
    }
    const token = randomBytes(32).toString('hex');
    const lama = tokenDariHeader(c.req.header('Authorization'));
    transaksi(() => {
      if (lama) db.prepare('DELETE FROM sessions WHERE token = ?').run(lama);
      db.prepare(
        `INSERT INTO sessions (token, user_id, expires_at)
         VALUES (?, ?, datetime('now', ?))`,
      ).run(token, targetId, `+${UMUR_SESI_HARI} days`);
    })();
    catatAudit(c, 'login', 'session', targetId, { switch: true }, {
      id: target.id, username: target.username, role: target.role,
    });
    return c.json({
      data: {
        token,
        user: profilAkun(v.row),
        must_change: target.must_change === 1,
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal pindah akun' }, 400);
  }
});

// Reset / hapus PIN akun (owner). Semua sesi target diputus: PIN adalah kunci
// cepat yang bisa dipakai dari device lain, jadi reset harus memaksa sandi
// ulang di semua device. Owner yang mereset PIN sendiri akan ikut keluar.
app.delete('/api/users/:id/pin', hanyaOwner, (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const ada = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as
    { id: number; username: string } | undefined;
  if (!ada) return c.json({ error: 'pengguna tidak ada' }, 404);
  db.prepare(
    `UPDATE users SET pin_hash = NULL, pin_failed = 0, pin_locked_until = NULL,
       pin_updated_at = NULL WHERE id = ?`,
  ).run(id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  catatAudit(c, 'update', 'user', id, { pin: false, aksi: 'reset-pin', sesi_diputus: true });
  return c.json({ data: { id, pin_set: false, sesi_diputus: true } });
});

// Tambah / ubah akun (owner saja). Tanpa id = baru (password wajib, min 4,
// must_change=1). Dengan id = update parsial (name/role/is_active/password;
// username TAK BISA diganti). Larangan keras: menurunkan/mematikan diri
// sendiri, dan menurunkan/mematikan owner aktif TERAKHIR (toko tanpa
// owner = tak ada yang bisa mengelola).
app.post('/api/users', hanyaOwner, async (c) => {
  try {
    const body = await c.req.json();
    const saya = c.get('user') as Pengguna;
    const id = body?.id === undefined || body?.id === null || body?.id === '' ? null : Number(body.id);
    if (id !== null && !Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
    // `permissions` (B4): undefined = jangan ubah (update) / default role
    // (insert); null/'' = kembali ke default role; array = izin custom.
    const izinKirim = validasiKirimanIzin(body?.permissions);
    if (!izinKirim.ok) return c.json({ error: izinKirim.error }, 400);
    if (id === null) {
      const username = String(body?.username ?? '').trim();
      const name = String(body?.name ?? '').trim() || username;
      const role = body?.role;
      const password = String(body?.password ?? '');
      if (!username) return c.json({ error: 'username wajib diisi' }, 400);
      if (username.length > 32 || !/^[a-z0-9._-]+$/i.test(username)) {
        return c.json({ error: 'username: maks 32 karakter (huruf/angka/titik/strip)' }, 400);
      }
      if (role !== 'owner' && role !== 'kasir') return c.json({ error: "role harus 'owner'|'kasir'" }, 400);
      if (password.length < BOLEH_SANDI_MIN) return c.json({ error: `sandi minimal ${BOLEH_SANDI_MIN} karakter` }, 400);
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        return c.json({ error: 'username sudah dipakai' }, 409);
      }
      const row = db.prepare(
        `INSERT INTO users (username, name, password_hash, role, must_change, permissions)
         VALUES (?, ?, ?, ?, 1, ?)
         RETURNING id, username, name, role, is_active, must_change, created_at, avatar, email,
                   permissions, pin_updated_at`,
      ).get(username, name, hashPassword(password), role, izinKirim.json);
      const bersih = barisUserBersih(row);
      catatAudit(c, 'create', 'user', bersih.id, {
        username: bersih.username, role: bersih.role,
        permissions_custom: bersih.permissions_custom,
      });
      return c.json({ data: bersih }, 201);
    }
    const ada = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | { id: number; username: string; name: string; role: string; is_active: number; pin_hash: string | null }
      | undefined;
    if (!ada) return c.json({ error: 'pengguna tidak ada' }, 404);
    const name = body?.name === undefined ? undefined : String(body.name).trim();
    const role = body?.role;
    const aktif = body?.is_active;
    const password = body?.password === undefined || body?.password === null || body?.password === '' ? undefined : String(body.password);
    if (name !== undefined && !name) return c.json({ error: 'nama tidak boleh kosong' }, 400);
    if (role !== undefined && role !== 'owner' && role !== 'kasir') {
      return c.json({ error: "role harus 'owner'|'kasir'" }, 400);
    }
    if (password !== undefined && password.length < BOLEH_SANDI_MIN) {
      return c.json({ error: `sandi minimal ${BOLEH_SANDI_MIN} karakter` }, 400);
    }
    if (id === saya.id && (role !== undefined && role !== ada.role)) {
      return c.json({ error: 'tidak bisa mengubah peran diri sendiri' }, 400);
    }
    if (id === saya.id && aktif !== undefined && !aktif) {
      return c.json({ error: 'tidak bisa menonaktifkan diri sendiri' }, 400);
    }
    if (ada.role === 'owner' && (role === 'kasir' || aktif === 0)) {
      const lain = (db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1 AND id != ?",
      ).get(id) as { n: number }).n;
      if (lain === 0) return c.json({ error: 'owner aktif terakhir tidak bisa diturunkan/dinonaktifkan' }, 400);
    }
    // Nama tampilan = identitas shift. Mengganti nama saat shift masih terbuka
    // membuat shift itu tidak lagi bisa ditutup oleh pemiliknya (dan kasir bisa
    // "kehilangan" laci). Tutup shift dulu, baru ganti nama.
    if (name !== undefined && name !== ada.name) {
      const buka = db.prepare(
        "SELECT COUNT(*) AS n FROM shifts WHERE cashier = ? AND status = 'open'",
      ).get(ada.name) as { n: number };
      if (buka.n > 0) {
        return c.json({ error: 'nama tidak bisa diubah saat akun ini masih punya shift terbuka — tutup shift dulu' }, 400);
      }
    }
    const row = db.prepare(
      `UPDATE users SET
         name = COALESCE(?, name),
         role = COALESCE(?, role),
         is_active = COALESCE(?, is_active),
         password_hash = COALESCE(?, password_hash),
         email = COALESCE(?, email),
         permissions = CASE WHEN ? = 1 THEN ? ELSE permissions END,
         must_change = CASE WHEN ? IS NOT NULL THEN 1 ELSE must_change END,
         pin_hash = CASE WHEN ? IS NOT NULL THEN NULL ELSE pin_hash END,
         pin_failed = CASE WHEN ? IS NOT NULL THEN 0 ELSE pin_failed END,
         pin_locked_until = CASE WHEN ? IS NOT NULL THEN NULL ELSE pin_locked_until END,
         pin_updated_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE pin_updated_at END
       WHERE id = ?
       RETURNING id, username, name, role, is_active, must_change, created_at, avatar, email,
                 permissions, pin_updated_at`,
    ).get(
      name ?? null, role ?? null, aktif === undefined ? null : aktif ? 1 : 0,
      password === undefined ? null : hashPassword(password),
      body?.email === undefined || body?.email === null ? null : String(body.email).trim(),
      body?.permissions === undefined ? 0 : 1, izinKirim.json,
      password === undefined ? null : 1,
      password === undefined ? null : 1,
      password === undefined ? null : 1,
      password === undefined ? null : 1,
      password === undefined ? null : 1, id,
    );
    const bersih = barisUserBersih(row);
    // Password baru lewat owner = PIN lama dicabut + semua sesi target diputus
    // (user harus masuk ulang dengan sandi baru, bukan PIN lama).
    if (password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    catatAudit(c, 'update', 'user', bersih.id, {
      role: bersih.role, aktif: bersih.is_active, sandi_diubah: password !== undefined,
      permissions_custom: bersih.permissions_custom,
    });
    return c.json({ data: bersih }, 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan pengguna' }, 400);
  }
});

// Reset sandi orang lain (owner saja) — target wajib ganti lagi saat masuk.
app.post('/api/users/:id/password', hanyaOwner, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  try {
    const body = await c.req.json();
    const password = String(body?.password ?? '');
    if (password.length < BOLEH_SANDI_MIN) return c.json({ error: `sandi minimal ${BOLEH_SANDI_MIN} karakter` }, 400);
    const ada = db.prepare('SELECT id FROM users WHERE id = ?').get(id) as { id: number } | undefined;
    if (!ada) return c.json({ error: 'pengguna tidak ada' }, 404);
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change = 1, pin_hash = NULL,
         pin_failed = 0, pin_locked_until = NULL, pin_updated_at = NULL WHERE id = ?`,
    ).run(hashPassword(password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // paksa masuk ulang di semua device
    catatAudit(c, 'update', 'user', id, { reset_sandi: true, pin_dicabut: true, sesi_diputus: true });
    return c.json({ data: { id, reset: true } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal reset sandi' }, 400);
  }
});

// Avatar SENDIRI (semua peran, 2026-10-11): dataURL hasil resize client
// (sisi terpanjang <=256px JPEG, pola foto produk). File di img/ sebelah DB,
// kolom users.avatar = NAMA FILE. '' / null = hapus (kembali ke inisial).
const AVATAR_MAKS_BYTE = 120_000; // 256px JPEG ~10-40KB; batas menahan foto asli HP
app.post('/api/users/me/avatar', async (c) => {
  try {
    const body = await c.req.json();
    const u = c.get('user') as Pengguna;
    const kiriman = body?.image;
    if (kiriman === undefined) return c.json({ error: 'image wajib diisi ("" untuk menghapus)' }, 400);
    const lama = (db.prepare('SELECT avatar FROM users WHERE id = ?').get(u.id) as { avatar: string | null } | undefined)?.avatar ?? null;
    if (kiriman === null || String(kiriman).trim() === '') {
      if (lama) buangFileFoto(lama);
      db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(u.id);
      return c.json({ data: { avatar: null } });
    }
    const val = String(kiriman).trim();
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(val);
    if (!m) return c.json({ error: 'image harus dataURL data:image/...;base64' }, 400);
    const [, mime, b64] = m;
    const buf = Buffer.from(b64, 'base64');
    if (buf.byteLength > AVATAR_MAKS_BYTE) return c.json({ error: 'avatar terlalu besar (maks 120KB setelah resize)' }, 400);
    const ext = mime === 'jpeg' ? 'jpg' : mime;
    const nama = `avatar-${u.id}-${Date.now()}.${ext}`;
    imgDir();
    fs.writeFileSync(path.join(IMG_DIR, nama), buf);
    if (lama) buangFileFoto(lama);
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(nama, u.id);
    return c.json({ data: { avatar: nama } }, 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal unggah avatar' }, 400);
  }
});

// Baca avatar by user id (img tag tak bisa bawa header — pengecualian
// middleware di atas; hanya melayani file gambar, bukan data akun).
app.get('/api/users/:id/avatar', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const row = db.prepare('SELECT avatar FROM users WHERE id = ?').get(id) as { avatar: string | null } | undefined;
  const nama = row?.avatar;
  if (!nama) return c.json({ error: 'tanpa avatar' }, 404);
  const aman = path.basename(nama) === nama && /^avatar-\d+-\d+\.(jpg|png|webp)$/.test(nama);
  if (!aman) return c.json({ error: 'file avatar tidak valid' }, 404);
  const file = path.join(IMG_DIR, nama);
  if (!fs.existsSync(file)) return c.json({ error: 'file avatar hilang' }, 404);
  const ct = nama.endsWith('.png') ? 'image/png' : nama.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return c.body(new Uint8Array(fs.readFileSync(file)), 200, { 'Content-Type': ct });
});

// Edit profil SENDIRI (semua peran — 2026-10-11): hanya `name`. Terpisah
// dari POST /api/users (khusus owner) supaya kasir tetap bisa memperbarui
// nama tampilannya sendiri; username & peran tak tersentuh di sini.
app.post('/api/users/profile', async (c) => {
  try {
    const body = await c.req.json();
    const u = c.get('user') as Pengguna;
    const name = String(body?.name ?? '').trim();
    if (!name) return c.json({ error: 'nama tidak boleh kosong' }, 400);
    if (name.length > 32) return c.json({ error: 'nama maksimal 32 karakter' }, 400);
    const lama = db.prepare('SELECT name FROM users WHERE id = ?').get(u.id) as { name: string } | undefined;
    if (lama && name !== lama.name) {
      const buka = db.prepare(
        "SELECT COUNT(*) AS n FROM shifts WHERE cashier = ? AND status = 'open'",
      ).get(lama.name) as { n: number };
      if (buka.n > 0) {
        return c.json({ error: 'nama tidak bisa diubah saat masih ada shift terbuka — tutup shift dulu' }, 400);
      }
    }
    // Email OPSIONAL: kosong = hapus; isi = divalidasi format sederhana.
    const emailRaw = body?.email === undefined || body?.email === null ? undefined : String(body.email).trim();
    let email: string | undefined;
    if (emailRaw !== undefined) {
      if (emailRaw === '') email = '';
      else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) || emailRaw.length > 64) {
        return c.json({ error: 'email tidak valid' }, 400);
      } else email = emailRaw;
    }
    const row = db.prepare(
      `UPDATE users SET name = ?, email = COALESCE(?, email) WHERE id = ?
       RETURNING id, username, name, role, is_active, must_change, created_at, avatar, email,
                 permissions, pin_updated_at`,
    ).get(name, email ?? null, u.id);
    return c.json({ data: barisUserBersih(row) }, 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan profil' }, 400);
  }
});

// Ganti sandi sendiri (semua peran — satu-satunya jalan keluar dari
// must_change). Selalu membersihkan must_change bila sandi lama benar.
app.post('/api/users/password', async (c) => {
  try {
    const body = await c.req.json();
    const u = c.get('user') as Pengguna;
    const lama = String(body?.old_password ?? '');
    const baru = String(body?.password ?? '');
    if (baru.length < BOLEH_SANDI_MIN) return c.json({ error: `sandi minimal ${BOLEH_SANDI_MIN} karakter` }, 400);
    const cur = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id) as { password_hash: string };
    if (!verifyPassword(lama, cur.password_hash)) return c.json({ error: 'sandi lama salah' }, 401);
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change = 0, pin_hash = NULL,
         pin_failed = 0, pin_locked_until = NULL, pin_updated_at = NULL WHERE id = ?`,
    ).run(hashPassword(baru), u.id);
    catatAudit(c, 'update', 'user', u.id, { ganti_sandi_sendiri: true, pin_dicabut: true });
    return c.json({ data: { ok: true } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal ganti sandi' }, 400);
  }
});

// Hapus akun (owner saja) — diri sendiri dan owner aktif terakhir dilindungi.
app.delete('/api/users/:id', hanyaOwner, (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const saya = (c.get('user') as Pengguna).id;
  if (id === saya) return c.json({ error: 'tidak bisa menghapus diri sendiri' }, 400);
  const ada = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | undefined;
  if (!ada) return c.json({ error: 'pengguna tidak ada' }, 404);
  if (ada.role === 'owner') {
    const lain = (db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1 AND id != ?",
    ).get(id) as { n: number }).n;
    if (lain === 0) return c.json({ error: 'owner aktif terakhir tidak bisa dihapus' }, 400);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions ikut CASCADE
  catatAudit(c, 'delete', 'user', id);
  return c.json({ data: { id, deleted: true } });
});

// ---------- health ----------
app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

// ---------- master ----------
app.get('/api/categories', (c) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
  return c.json({ data: rows });
});

// Tambah / ubah kategori (upsert by slug; slug tidak bisa diganti setelah dibuat).
// track_stock=1 berarti SEMUA produk kategori ini melacak stok (butuh konfirmasi di UI).
// use_expiry=1  berarti form produk kategori ini MENAMPILKAN "Tanggal kadaluarsa"
//   (lihat kolom `categories.use_expiry`) — ini yang menggantikan hardcode snack/eskrim.
// slug opsional: kalau kosong, diturunkan otomatis dari name (huruf kecil + strip).
// Izin = `produk.kelola` (bukan hanyaOwner): kategori DIKELOLA dari dalam form
// Produk (#/products), jadi kasir yang boleh menambah produk TIDAK boleh
// mentok 403 saat harus membuat kategori baru. Kategori tanpa produk tidak
// menyentuh uang; audit tetap mencatat aktor.
app.post('/api/categories', wajibIzin('produk.kelola'), async (c) => {
  try {
    const body = await c.req.json();
    const name = String(body?.name ?? '').trim();
    const slug = String(body?.slug ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    if (!slug || !name) return c.json({ error: 'slug dan name wajib' }, 400);
    if (!/^[a-z0-9-]+$/.test(slug)) return c.json({ error: 'slug hanya huruf kecil, angka, strip' }, 400);
    const track = body?.track_stock ? 1 : 0;
    const sort = Number(body?.sort ?? 0) || 0;
    const cur = db.prepare('SELECT id, use_expiry FROM categories WHERE slug = ?').get(slug) as
      { id: number; use_expiry: number } | undefined;
    // `use_expiry` DIKECUALIKAN dari pola "tidak dikirim = reset": tidak dikirim
    // berarti TIDAK DIUBAH. Kalau direset seperti track_stock, skrip/upsert yang
    // hanya mengganti nama kategori akan diam-diam mematikan tanggal kadaluarsa
    // kategori — dan seluruh produknya mendadak kehilangan field itu di form.
    const useExpiry =
      body?.use_expiry === undefined ? (cur?.use_expiry ?? 0) : body.use_expiry ? 1 : 0;
    const row = db.prepare(
      `INSERT INTO categories (slug, name, track_stock, sort, use_expiry) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, track_stock = excluded.track_stock,
         sort = excluded.sort, use_expiry = excluded.use_expiry
       RETURNING *`,
    ).get(slug, name, track, sort, useExpiry);
    catatAudit(c, cur ? 'update' : 'create', 'category', slug, { name, track_stock: track, use_expiry: useExpiry });
    return c.json({ data: row }, cur ? 200 : 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan kategori' }, 400);
  }
});

// Hapus kategori — DITOLAK bila masih ada produk (FK categories<-products, foreign_keys=ON).
// Produk yang sudah punya riwayat jual tidak bisa dihapus, jadi kategori bekas pakai praktis permanen.
app.delete('/api/categories/:slug', wajibIzin('produk.kelola'), (c) => {
  const slug = c.req.param('slug');
  const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug) as { id: number } | undefined;
  if (!cat) return c.json({ error: 'kategori tidak ada' }, 404);
  const n = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(cat.id) as { n: number };
  if (n.n > 0) return c.json({ error: `kategori dipakai ${n.n} produk — pindahkan/nonaktifkan produknya dulu` }, 400);
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  catatAudit(c, 'delete', 'category', slug);
  return c.json({ data: { slug } });
});

// ---------- Master satuan (dipakai form produk sebagai dropdown) ----------

// `dipakai` dihitung server-side (bukan dari cache client) supaya dialog hapus
// di halaman Satuan tidak pernah berbohong soal produk yang memakainya.
app.get('/api/units', (c) => {
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM products p WHERE p.unit = u.slug) AS dipakai
       FROM units u ORDER BY u.name, u.id`,
    )
    .all();
  return c.json({ data: rows });
});

// Tambah / ubah satuan (upsert by slug; slug tidak bisa diganti setelah dibuat).
// Mirip kategori: slug opsional, kalau kosong diturunkan dari name.
app.post('/api/units', hanyaOwner, async (c) => {
  try {
    const body = await c.req.json();
    const name = String(body?.name ?? '').trim();
    const slug = String(body?.slug ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    if (!slug || !name) return c.json({ error: 'slug dan name wajib' }, 400);
    if (!/^[a-z0-9-]+$/.test(slug)) return c.json({ error: 'slug hanya huruf kecil, angka, strip' }, 400);
    const existed = db.prepare('SELECT id FROM units WHERE slug = ?').get(slug) as { id: number } | undefined;
    const row = db.prepare(
      `INSERT INTO units (slug, name) VALUES (?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name
       RETURNING *`,
    ).get(slug, name);
    catatAudit(c, existed ? 'update' : 'create', 'unit', slug, { name });
    return c.json({ data: row }, existed ? 200 : 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan satuan' }, 400);
  }
});

// Hapus satuan — DITOLAK bila masih dipakai produk (FK units<-products, foreign_keys=ON).
app.delete('/api/units/:slug', hanyaOwner, (c) => {
  const slug = c.req.param('slug');
  const u = db.prepare('SELECT id FROM units WHERE slug = ?').get(slug) as { id: number } | undefined;
  if (!u) return c.json({ error: 'satuan tidak ada' }, 404);
  const n = db.prepare('SELECT COUNT(*) AS n FROM products WHERE unit = ?').get(slug) as { n: number };
  if (n.n > 0) return c.json({ error: `satuan dipakai ${n.n} produk — pindahkan produknya dulu` }, 400);
  db.prepare('DELETE FROM units WHERE id = ?').run(u.id);
  catatAudit(c, 'delete', 'unit', slug);
  return c.json({ data: { slug } });
});

/* ---------- Pelanggan & hutang (piutang) — baru 2026-10-04 ---------- */
// Halaman #/customers (master kontak) dan #/debts (ledger charge/payment).
// Prinsip: saldo TIDAK PERNAH disimpan sebagai angka — sisa selalu dihitung
// `SUM(charge) - SUM(payment)` saat dibaca, supaya hapus 1 baris mutasi tidak
// meninggalkan angka basi. Baca juga AGENTS.md §3 (kontrak endpoint ini).

app.get('/api/customers', wajibIzin('pelanggan.lihat'), (c) => {
  const q = (c.req.query('q') ?? '').trim();
  // Filter multi-kata (pola search produk): SEMUA kata harus cocok di
  // name/phone/note — tidak harus di field atau urutan yang sama.
  const kata = q.split(/\s+/).filter(Boolean);
  const conds = kata.map(() => "(lower(c.name) LIKE ? OR c.phone LIKE ? OR lower(c.note) LIKE ?)");
  const params: unknown[] = [];
  for (const k of kata) {
    const like = `%${k.toLowerCase()}%`;
    params.push(like, `%${k}%`, like);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // Paginasi (2026-10-11): limit default 50 maks 200 (pola shifts/sales);
  // `total` = baris COCOK filter (tanpa limit) — footer "A–B dari N".
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const rows = db
    .prepare(
      `SELECT c.* FROM customers c ${where} ORDER BY c.name COLLATE NOCASE, c.id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM customers c ${where}`).get(...params) as { n: number }).n;
  return c.json({ data: rows, total });
});

// Tambah / ubah pelanggan. `id` dikirim = update (200), tanpa id = baru (201).
// Sengaja TIDAK upsert by phone: dua orang bisa berbagi nomor (keluarga/toko).
//
// Nomor urut OTOMATIS (revisi pemilik 2026-10-04): `CUS-000001` = no customer.
// Diambil dari baris terbesar lewat CAST (pola invoice_no): BUKAN COUNT, jadi
// celah nomor tidak pernah dipakai ulang. Baris lama yang masih kosong diisi
// saat pertama disimpan ulang. `pref` SUDAH termasuk tanda '-' — posisi
// substr/slice dihitung dari panjang prefiks penuh ('CUS-' = 4 -> substr
// posisi 5 / slice(4) = angkanya saja). Tanpa dash di pref, CAST membaca
// '-000001' -> -1 untuk semua baris dan nomor selalu kembali ke 000002 (bug
// yang sempat membuat nomor dobel).
// 2026-10-11: fungsi digeneralisasi (dulu `nomorUrutPelanggan` khusus
// customers) — dipakai juga oleh master suppliers (`SUP-000001`).
function nomorUrut(tabel: 'customers' | 'suppliers', kolom: 'code', pref: 'CUS-' | 'SUP-'): string {
  const last = db
    .prepare(
      `SELECT ${kolom} AS n FROM ${tabel}
        WHERE ${kolom} LIKE ? || '%'
        ORDER BY CAST(substr(${kolom}, ?) AS INTEGER) DESC LIMIT 1`,
    )
    .get(pref, pref.length + 1) as { n: string } | undefined;
  const urut = last ? Number(last.n.slice(pref.length)) + 1 : 1;
  return `${pref}${String(urut).padStart(6, '0')}`;
}

app.post('/api/customers', wajibIzin('pelanggan.ubah'), async (c) => {
  try {
    const body = await c.req.json();
    const name = String(body?.name ?? '').trim();
    const phone = String(body?.phone ?? '').trim();
    const address = String(body?.address ?? '').trim();
    const note = String(body?.note ?? '').trim();
    if (!name) return c.json({ error: 'nama pelanggan wajib diisi' }, 400);
    const id = body?.id === undefined || body?.id === null || body?.id === '' ? null : Number(body.id);
    if (id !== null && !Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
    const codeBaru = nomorUrut('customers', 'code', 'CUS-');
    // Tier harga (2026-10-11): tak dikirim = pertahankan lama (update) /
    // 'ecer' (insert); dikirim selain ecer|grosir = 400.
    const tierRaw = body?.tier;
    if (tierRaw !== undefined && tierRaw !== 'ecer' && tierRaw !== 'grosir') {
      return c.json({ error: "tier harus 'ecer'|'grosir'" }, 400);
    }
    if (id !== null) {
      const ada = db.prepare('SELECT id FROM customers WHERE id = ?').get(id) as { id: number } | undefined;
      if (!ada) return c.json({ error: 'pelanggan tidak ada' }, 404);
      // Nomor lama DIPERTAHANKAN; hanya baris yang belum bernomor (dibuat sebelum
      // fitur ini) yang diisi sekarang — nomor tidak boleh berubah begitu terbit.
      // Kolom `supplier_no` DICABUT 2026-10-11 (pindah ke master suppliers).
      const row = db
        .prepare(
          `UPDATE customers SET name = ?, phone = ?, address = ?, note = ?,
             code = CASE WHEN code = '' THEN ? ELSE code END,
             tier = COALESCE(?, tier),
             updated_at = datetime('now')
           WHERE id = ? RETURNING *`,
        )
        .get(name, phone, address, note, codeBaru, tierRaw ?? null, id);
      catatAudit(c, 'update', 'customer', id, { name });
      return c.json({ data: row }, 200);
    }
    const row = db
      .prepare(
        `INSERT INTO customers (code, tier, name, phone, address, note)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(codeBaru, tierRaw ?? 'ecer', name, phone, address, note);
    catatAudit(c, 'create', 'customer', (row as { id: number }).id, { name });
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan pelanggan' }, 400);
  }
});

// Hapus pelanggan — DITOLAK bila masih punya catatan hutang (riwayat harus
// utuh, pola yang sama dengan hapus produk yang pernah terjual).
app.delete('/api/customers/:id', wajibIzin('pelanggan.hapus'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const ada = db.prepare('SELECT id FROM customers WHERE id = ?').get(id) as { id: number } | undefined;
  if (!ada) return c.json({ error: 'pelanggan tidak ada' }, 404);
  const n = db.prepare('SELECT COUNT(*) AS n FROM customer_debts WHERE customer_id = ?').get(id) as { n: number };
  if (n.n > 0) {
    return c.json(
      { error: `pelanggan ini masih punya ${n.n} catatan hutang — hapus catatannya dulu di halaman Hutang` },
      400,
    );
  }
  // Pesanan jasa (1.6.6) juga menahan hapus: orders.customer_id NOT NULL —
  // tanpa guard ini FK akan meledak sebagai 500 mentah SQLite.
  const no = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?').get(id) as { n: number };
  if (no.n > 0) {
    return c.json(
      { error: `pelanggan ini masih punya ${no.n} pesanan — riwayat pesanan harus utuh` },
      400,
    );
  }
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  catatAudit(c, 'delete', 'customer', id);
  return c.json({ data: { id, deleted: true } });
});

// ---------- master supplier ----------
// Lahir 2026-10-11 dari pencabutan `customers.supplier_no` (perintah pemilik:
// no. supplier tidak pantas di modal customer). Pola CRUD + cari multi-kata +
// penomoran OTOMATIS persis master customers (`SUP-000001` via nomorUrut).
// Dipakai Tahap 3 Pembelian sebagai pilihan pemasok. Hapus = langsung (belum
// ada tabel yang mereferensinya; Tahap 3 wajib menambah guard 400 seperti
// hapus pelanggan berhutang / produk yang pernah terjual).
app.get('/api/suppliers', wajibIzin('supplier.kelola'), (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const kata = q.split(/\s+/).filter(Boolean);
  const conds = kata.map(() => "(lower(s.name) LIKE ? OR s.phone LIKE ? OR lower(s.note) LIKE ?)");
  const params: unknown[] = [];
  for (const k of kata) {
    const like = `%${k.toLowerCase()}%`;
    params.push(like, `%${k}%`, like);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // Paginasi (2026-10-11): limit default 50 maks 200 (pola shifts/sales);
  // `total` = baris COCOK filter (tanpa limit) — footer "A–B dari N".
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const rows = db
    .prepare(`SELECT s.* FROM suppliers s ${where} ORDER BY s.name COLLATE NOCASE, s.id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM suppliers s ${where}`).get(...params) as { n: number }).n;
  return c.json({ data: rows, total });
});

app.post('/api/suppliers', wajibIzin('supplier.kelola'), async (c) => {
  try {
    const body = await c.req.json();
    const name = String(body?.name ?? '').trim();
    const phone = String(body?.phone ?? '').trim();
    const address = String(body?.address ?? '').trim();
    const note = String(body?.note ?? '').trim();
    if (!name) return c.json({ error: 'nama supplier wajib diisi' }, 400);
    const id = body?.id === undefined || body?.id === null || body?.id === '' ? null : Number(body.id);
    if (id !== null && !Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
    const codeBaru = nomorUrut('suppliers', 'code', 'SUP-');
    if (id !== null) {
      const ada = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(id) as { id: number } | undefined;
      if (!ada) return c.json({ error: 'supplier tidak ada' }, 404);
      const row = db
        .prepare(
          `UPDATE suppliers SET name = ?, phone = ?, address = ?, note = ?,
             code = CASE WHEN code = '' THEN ? ELSE code END,
             updated_at = datetime('now')
           WHERE id = ? RETURNING *`,
        )
        .get(name, phone, address, note, codeBaru, id);
      catatAudit(c, 'update', 'supplier', id, { name });
      return c.json({ data: row }, 200);
    }
    const row = db
      .prepare(
        `INSERT INTO suppliers (code, name, phone, address, note)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(codeBaru, name, phone, address, note);
    catatAudit(c, 'create', 'supplier', (row as { id: number }).id, { name });
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan supplier' }, 400);
  }
});

app.delete('/api/suppliers/:id', wajibIzin('supplier.kelola'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const ada = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(id) as { id: number } | undefined;
  if (!ada) return c.json({ error: 'supplier tidak ada' }, 404);
  // Guard Tahap 3: supplier yang pernah dipakai PO tidak bisa dihapus
  // (riwayat kulakan harus utuh — pola hapus pelanggan berhutang).
  const n = db.prepare('SELECT COUNT(*) AS n FROM purchases WHERE supplier_id = ?').get(id) as { n: number };
  if (n.n > 0) {
    return c.json(
      { error: `supplier ini sudah dipakai ${n.n} nota pembelian — hapus/batalkan notanya dulu di halaman Pembelian` },
      400,
    );
  }
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
  catatAudit(c, 'delete', 'supplier', id);
  return c.json({ data: { id, deleted: true } });
});

// Ringkasan saldo hutang per pelanggan (tabel utama halaman #/debts).
// `status` default 'open' = hanya yang sisa > 0; 'semua' menampilkan juga
// riwayat yang sudah lunas (sisa 0). Urutan: sisa terbesar dulu.
//
// AGING (2026-10-16, pengingat pemilik): tiap baris membawa `umur_hari` =
// berapa hari hutang PALING TUA yang masih terbuka (FIFO), dan `lewat30` =
// jumlah pelanggan dengan umur >= 30 hari (SELURUH baris cocok filter, bukan
// cuma halaman ini — chip header harus stabil saat pindah halaman).
const UMUR_HARI_MS = 86_400_000;

/** Umur dokumen dalam hari — created_at SQLite = UTC ("YYYY-MM-DD HH:MM:SS"). */
function umurHari(createdAt: string): number {
  const t = Date.parse(`${String(createdAt).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / UMUR_HARI_MS)) : 0;
}

/** Umur hutang terbuka per pelanggan (pass ledger PENUH, urut per pelanggan
 *  lalu waktu). Metode FIFO: saldo berjalan di-reset saat menyentuh <= 0 —
 *  muatan lama lunas; charge PERTAMA setelah titik nol terakhir = outstanding
 *  tertua yang masih hidup. Pelanggan dengan sisa <= 0 tidak masuk peta. */
function hitungUmurHutang(): Map<number, number> {
  const semua = db
    .prepare(
      `SELECT customer_id, type, amount, created_at
         FROM customer_debts ORDER BY customer_id, created_at, id`,
    )
    .all() as { customer_id: number; type: 'charge' | 'payment'; amount: number; created_at: string }[];
  const hasil = new Map<number, number>();
  let cid = -1;
  let jalan = 0;
  let tertua: string | null = null;
  const tutup = () => {
    if (cid >= 0 && jalan > 0 && tertua) hasil.set(cid, umurHari(tertua));
  };
  for (const m of semua) {
    if (m.customer_id !== cid) {
      tutup();
      cid = m.customer_id;
      jalan = 0;
      tertua = null;
    }
    if (m.type === 'charge') {
      if (jalan <= 0) tertua = m.created_at;
      jalan += m.amount;
    } else {
      jalan -= m.amount;
      if (jalan <= 0) tertua = null;
    }
  }
  tutup();
  return hasil;
}

app.get('/api/customer-debts', wajibIzin('hutang.lihat'), (c) => {
  const status = c.req.query('status') ?? 'open';
  if (!['open', 'semua'].includes(status)) {
    return c.json({ error: `status harus open|semua (dapat: ${status})` }, 400);
  }
  const having = status === 'semua' ? '' : 'HAVING sisa > 0';
  // Paginasi (2026-10-11): `total` TETAP jumlah uang (kartu piutang) — jangan
  // dipakai untuk hitung halaman; pakai `count` (= jumlah pelanggan).
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const dasar = `FROM customers c
         JOIN customer_debts d ON d.customer_id = c.id
        GROUP BY c.id
       ${having}`;
  // Subquery WAJIB memuat agregat `sisa` — HAVING merujuk alias itu, dan
  // SELECT tanpa agregat membuat SQLite 500 "no such column: sisa" (bug nyata
  // yang hanya muncul saat status=open, karena status=semua tanpa HAVING).
  const count = (db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT SUM(CASE WHEN d2.type = 'charge' THEN d2.amount ELSE -d2.amount END) AS sisa
         FROM customers c2 JOIN customer_debts d2 ON d2.customer_id = c2.id
        GROUP BY c2.id
       ${status === 'semua' ? '' : 'HAVING sisa > 0'}
     )`,
  ).get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT c.id AS customer_id, c.name, c.phone,
              COALESCE(SUM(CASE WHEN d.type = 'charge'  THEN d.amount END), 0) AS charge,
              COALESCE(SUM(CASE WHEN d.type = 'payment' THEN d.amount END), 0) AS bayar,
              COALESCE(SUM(CASE WHEN d.type = 'charge'  THEN d.amount
                                ELSE -d.amount END), 0) AS sisa,
              MAX(d.created_at) AS terakhir
       ${dasar}
        ORDER BY sisa DESC, terakhir DESC, c.id
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as { customer_id: number; name: string; phone: string; charge: number; bayar: number; sisa: number; terakhir: string | null }[];
  // totalSisa = SEMUA baris cocok (tanpa limit) — kartu tidak boleh susut
  // saat kasir pindah halaman. Ditulis eksplisit (tanpa sulap replace
  // alias) supaya tiap tabel terikat ke aliasnya sendiri.
  const totalSisa = (db.prepare(
    `SELECT COALESCE(SUM(sisa), 0) AS t FROM (
       SELECT SUM(CASE WHEN d2.type = 'charge' THEN d2.amount ELSE -d2.amount END) AS sisa
         FROM customers c2 JOIN customer_debts d2 ON d2.customer_id = c2.id
        GROUP BY c2.id
       ${status === 'semua' ? '' : 'HAVING sisa > 0'}
     )`,
  ).get() as { t: number }).t;
  // Aging dihitung dari ledger penuh (bukan per liter halaman) supaya tiap
  // baris & chip lewat30 tidak berubah-ubah saat pindah halaman.
  const umurPer = hitungUmurHutang();
  let lewat30 = 0;
  for (const u of umurPer.values()) if (u >= 30) lewat30 += 1;
  const data = rows.map((r) => ({
    ...r,
    umur_hari: r.sisa > 0 ? umurPer.get(r.customer_id) ?? null : null,
  }));
  return c.json({ data, total: totalSisa, count, lewat30 });
});

// Rincian ledger satu pelanggan: baris mutasi + saldo berjalan per baris.
// Urutan tampil terbaru di atas (DESC); saldo berjalan dihitung dari yang
// terlama dulu, lalu dibalik — supaya "sisa setelah baris ini" masuk akal.
app.get('/api/customer-debts/:customerId', wajibIzin('hutang.lihat'), (c) => {
  const customerId = Number(c.req.param('customerId'));
  if (!Number.isInteger(customerId)) return c.json({ error: 'customer_id harus integer' }, 400);
  const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as
    | { id: number; name: string; phone: string }
    | undefined;
  if (!cust) return c.json({ error: 'pelanggan tidak ada' }, 404);
  const asc = db
    .prepare('SELECT * FROM customer_debts WHERE customer_id = ? ORDER BY created_at, id')
    .all(customerId) as { id: number; type: 'charge' | 'payment'; amount: number; note: string; created_at: string }[];
  let jalan = 0;
  const rows = asc.map((r) => {
    jalan += r.type === 'charge' ? r.amount : -r.amount;
    return { ...r, sisa: jalan };
  });
  rows.reverse();
  const charge = asc.reduce((s, r) => s + (r.type === 'charge' ? r.amount : 0), 0);
  const bayar = asc.reduce((s, r) => s + (r.type === 'payment' ? r.amount : 0), 0);
  return c.json({
    data: { customer: cust, rows, charge, bayar, sisa: charge - bayar },
  });
});

// Catat mutasi hutang: type 'charge' = pelanggan berhutang, 'payment' = bayar.
// Validasi pembayaran > sisa DITOLAK (400) — uang lebih dari utang memang tidak
// ada; kalau suatu saat mau jadi saldo awal/kredit, keputusannya ke pemilik dulu.
const simpanMutasiHutang = transaksi(
  (
    customerId: number,
    type: 'charge' | 'payment',
    amount: number,
    note: string,
    shiftId: number | null,
    cashier: string,
  ) => {
    if (type === 'payment') {
      const s = db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN type = 'charge' THEN amount ELSE -amount END), 0) AS sisa
             FROM customer_debts WHERE customer_id = ?`,
        )
        .get(customerId) as { sisa: number };
      if (amount > s.sisa) throw new Error(`pembayaran melebihi sisa hutang (sisa ${s.sisa})`);
    }
    return db
      .prepare(
        `INSERT INTO customer_debts (customer_id, type, amount, note, shift_id, cashier)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(customerId, type, amount, note, shiftId, cashier);
  },
);

app.post('/api/customer-debts', async (c) => {
  try {
    const body = await c.req.json();
    const customerId = Number(body?.customer_id);
    const type = String(body?.type ?? '');
    const amount = Number(body?.amount);
    const note = String(body?.note ?? '').trim();
    if (!Number.isInteger(customerId)) return c.json({ error: 'customer_id harus integer' }, 400);
    if (type !== 'charge' && type !== 'payment') return c.json({ error: 'type harus charge|payment' }, 400);
    const u = c.get('user') as Pengguna;
    const izinAksi: IzinOperasional = type === 'charge' ? 'hutang.catat' : 'hutang.bayar';
    if (!bolehIzin(u, izinAksi)) {
      return c.json({ error: `izin ${izinAksi} tidak diberikan untuk akun ini — hubungi owner` }, 403);
    }
    if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'amount harus angka > 0' }, 400);
    if (!Number.isInteger(amount)) return c.json({ error: 'amount harus bilangan bulat rupiah' }, 400);
    if (note.length > 200) return c.json({ error: `catatan terlalu panjang (maks 200 karakter)` }, 400);
    // Atribusi laci (Paket A): shift OPSIONAL seperti expenses — absen/NULL =
    // tercatat di luar shift (tidak menggerakkan laci mana pun). Baris BARU
    // selalu punya cashier non-kosong, jadi fallback periode waktu di
    // GET /api/shifts hanya menyentuh baris lama (`cashier = ''`).
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    const shiftId = sh.shift_id;
    const cashier = sh.cashier;
    const ada = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId) as { id: number } | undefined;
    if (!ada) return c.json({ error: 'pelanggan tidak ada' }, 404);
    const row = simpanMutasiHutang(customerId, type, amount, note, shiftId, cashier) as Record<string, unknown>;
    catatAudit(c, 'create', 'debt', (row as { id: number }).id, {
      customer_id: customerId, type, amount, note, shift_id: shiftId, cashier,
    });
    return c.json({ data: row }, 201);
  } catch (e) {
    // Pesan "melebihi sisa" sengaja menyebut angka dalam rupiah polos dari
    // throw di atas — format ulang biar konsisten dengan format server lain.
    const m = e instanceof Error ? e.message : 'gagal mencatat hutang';
    const melebihi = /^pembayaran melebihi sisa hutang \(sisa (\d+)\)$/.exec(m);
    if (melebihi) return c.json({ error: `pembayaran melebihi sisa hutang (sisa Rp${melebihi[1]})` }, 400);
    return c.json({ error: m }, 400);
  }
});

// Hapus satu baris mutasi (salah ketik). Tidak butuh pengecekan sisa:
// menghapus 'payment' memperbesar sisa, menghapus 'charge' memperkecil — dua-duanya
// memang diinginkan saat membetulkan kesalahan input.
app.delete('/api/customer-debts/:id', wajibIzin('hutang.hapus'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const ada = db.prepare('SELECT id FROM customer_debts WHERE id = ?').get(id) as { id: number } | undefined;
  if (!ada) return c.json({ error: 'catatan hutang tidak ada' }, 404);
  db.prepare('DELETE FROM customer_debts WHERE id = ?').run(id);
  catatAudit(c, 'delete', 'debt', id);
  return c.json({ data: { id, deleted: true } });
});

// GET /api/products?since=<version>&category=<slug>&q=<teks>&status=<aktif|nonaktif|semua>
// since   -> sinkronisasi inkremental master (client simpan maxVersion lokal)
// status  -> default 'aktif' (WAJIB untuk kasir: produk nonaktif tak boleh muncul di POS).
//            'nonaktif' untuk layar Manage, 'semua' untuk audited. Row nonaktif TIDAK
//            boleh ikut delta sync (?since=) karena client aktif tidak menyimpannya.
app.get('/api/products', (c) => {
  const since = Number(c.req.query('since') ?? 0);
  const category = c.req.query('category');
  const q = (c.req.query('q') ?? '').trim();
  const status = c.req.query('status') ?? 'aktif';
  if (status !== 'aktif' && !bolehIzin(c.get('user') as Pengguna, 'produk.kelola')) {
    return c.json({ error: 'izin produk.kelola tidak diberikan untuk akun ini — hubungi owner' }, 403);
  }
  if (!['aktif', 'nonaktif', 'semua'].includes(status)) {
    return c.json({ error: `status tidak dikenal: ${status} (pakai aktif|nonaktif|semua)` }, 400);
  }
  const conds: string[] = [];
  const params: unknown[] = [];
  const isDelta = since > 0;
  // Mode delta sync (since>0) SELALU dibatasi ke produk aktif: cache kasir tidak
  // menyimpan produk nonaktif, jadi mengirimnya akan resurrect produk di POS.
  //
  // PENGECUALIAN (tombstone): baris deleted_at IS NOT NULL tetap DIKIRIM di mode
  // delta walau is_active-nya apa pun — tujuannya supaya client bisa MEMBUANG
  // produk yang dihapus di server. Tanpa ini tombstone tidak pernah terkirim dan
  // produk mati nempel selamanya di cache IndexedDB kasir. Pada mode biasa
  // (since=0) tombstone tetap DISIMPAN supaya daftar tidak menampilkan yang sudah
  // dihapus.
  if (isDelta) conds.push('(p.is_active = 1 OR p.deleted_at IS NOT NULL)');
  else {
    conds.push('p.deleted_at IS NULL');
    if (status === 'aktif') conds.push('p.is_active = 1');
    else if (status === 'nonaktif') conds.push('p.is_active = 0');
    // status 'semua' tanpa since -> tanpa filter status (dipakai layar Manage).
  }
  if (since > 0) { conds.push('p.version > ?'); params.push(since); }
  if (category) { conds.push('c.slug = ?'); params.push(category); }
  if (q) { conds.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode = ?)'); params.push(`%${q}%`, `%${q}%`, q); }
  const rows = db.prepare(
    `SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.track_stock
     FROM products p JOIN categories c ON c.id = p.category_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
     ORDER BY p.version ASC LIMIT 2000`,
  ).all(...params) as Record<string, unknown>[];
  // Satuan jual alternatif (fitur #3). Disaring dengan kondisi yang SAMA lewat
  // subquery supaya ?since= delta sync ikut menariknya: ubah satuan jual ->
  // products.version++ -> produk terkirim -> unit barisnya ikut terkirim.
  const unitRows = db.prepare(
    `SELECT pu.product_id, pu.unit, pu.factor, pu.price
       FROM product_units pu
      WHERE pu.product_id IN (
        SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id
        ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      )`,
  ).all(...params) as { product_id: number; unit: string; factor: number; price: number | null }[];
  const unitsPerProduct = new Map<number, { unit: string; factor: number; price: number | null }[]>();
  for (const r of unitRows) {
    const arr = unitsPerProduct.get(r.product_id) ?? [];
    arr.push({ unit: r.unit, factor: r.factor, price: r.price });
    unitsPerProduct.set(r.product_id, arr);
  }
  // Harga borongan per qty (2026-10-19) — subquery dengan kondisi yang SAMA
  // supaya `?since=` delta sync ikut menarik perubahannya: ubah borongan ->
  // products.version++ -> produk terkirim -> barisnya ikut. Selalu array
  // (kosong = tanpa aturan) supaya POS tidak perlu menebak.
  const boronganRows = db.prepare(
    `SELECT pb.product_id, pb.qty, pb.price
       FROM product_borongan pb
      WHERE pb.product_id IN (
        SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id
        ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      )
      ORDER BY pb.qty`,
  ).all(...params) as { product_id: number; qty: number; price: number }[];
  const boronganPerProduct = new Map<number, { qty: number; price: number }[]>();
  for (const r of boronganRows) {
    const arr = boronganPerProduct.get(r.product_id) ?? [];
    arr.push({ qty: r.qty, price: r.price });
    boronganPerProduct.set(r.product_id, arr);
  }
  const data = rows.map((r) => ({
    ...r,
    units: unitsPerProduct.get(Number(r.id)) ?? [],
    borongan: boronganPerProduct.get(Number(r.id)) ?? [],
  }));
  const maxVersion = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM products').get() as { v: number };
  return c.json({ data, maxVersion: maxVersion.v });
});

// Hapus produk (soft delete / tombstone).
//
// Guard 1 (aturan Aronium): produk yang PERNAH terjual tidak bisa dihapus —
// riwayat penjualan harus tetap utuh, jadi pakai nonaktifkan saja.
// Guard 2: tombstone, bukan DELETE keras — kolom deleted_at diisi + version++,
// supaya delta sync (?since=) membawanya ke kasir untuk dibuang dari cache.
// Baris sengaja TIDAK dihapus dari DB agar sale_items/stock_moves tetap valid
// secara referensial walau produknya sudah tidak bisa dijual lagi.
app.delete('/api/products/:id', wajibIzin('produk.kelola'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id tidak valid' }, 400);
  const p = db.prepare('SELECT id, sku, name, deleted_at FROM products WHERE id=?').get(id) as
    { id: number; sku: string; name: string; deleted_at: string | null } | undefined;
  if (!p || p.deleted_at) return c.json({ error: 'produk tidak ada' }, 404);
  const sold = (db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE product_id=?').get(id) as { c: number }).c;
  if (sold > 0) {
    return c.json({
      error: `produk ini sudah pernah terjual (${sold} baris penjualan) — riwayatnya harus utuh, jadi pakai nonaktifkan saja`,
    }, 400);
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE products SET deleted_at=datetime('now'), updated_at=datetime('now'),
         version=(SELECT COALESCE(MAX(version),0)+1 FROM products)
       WHERE id=?`,
    ).run(id);
  })();
  catatAudit(c, 'delete', 'product', p.id, { sku: p.sku, name: p.name });
  return c.json({ data: { id: p.id, sku: p.sku, deleted: true } });
});

// SKU kosong -> diisi server dengan nomor urut `PRD00001`, `PRD00002`, ...
// (ala Aronium "default value based on max value"). Pola PRD + 5 digit dipilih
// karena pendek, urut alami walau diurutkan sebagai teks, dan tabrakan nol.
// SKU masih boleh diketik manual — fungsi ini hanya dipanggil saat kolom kosong.
//
// Nomor diambil dari MAX, bukan COUNT: baris produk yang pernah dihapus tetap
// ada di DB (tombstone — wajib, supaya sale_items/stock_moves tetap valid), jadi
// COUNT bisa menghasilkan nomor yang sudah pernah terpakai dan membingungkan
// label yang sudah tercetak. `SUBSTR(sku, 4) GLOB '[0-9]*'` mengecualikan SKU
// manual yang tidak berbentuk urut (mis. `PRD-FOO`), tapi tetap menghitung
// ekor panjang (`PRD100000`) sehingga MAX tidak mundur.
//
// WAJIB unik: SKU adalah kunci upsert, jadi SKU yang bentrok tidak sekadar
// gagal — ia akan menimpa produk lain.
function skuDariUrut(): string {
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(sku, 4) AS INTEGER)) AS n
         FROM products
        WHERE sku LIKE 'PRD%' AND SUBSTR(sku, 4) GLOB '[0-9]*'`,
    )
    .get() as { n: number | null };
  return `PRD${String((row?.n ?? 0) + 1).padStart(5, '0')}`;
}

// Satuan jual ALTERNATIF (fitur #3 Multi satuan).
//
// Satuan dasar IMPLISIT dari products.unit + products.price — sengaja bukan
// baris di sini, supaya produk lama (yang tidak pernah menyentuh fitur ini)
// tetap valid tanpa baris dummy, dan supaya payload lama tanpa field `units`
// tidak menghapus apa pun.
//
// Kontrak `units` di POST /api/products:
//   - `undefined` / tidak dikirim = TIDAK mengubah satuan jual (penting: payload
//     toggle is_active & tiap baris import tidak boleh menghapus satuan)
//   - `[]` (array kosong) = HAPUS semua satuan jual alternatif
//   - `[{unit,factor,price?}]` = ganti seluruh daftar (replace, bukan merge)
function simpanSatuanJual(productId: number, baseUnit: string, rows: unknown[]): void {
  if (!Array.isArray(rows)) throw new Error('units harus berupa array');
  const seen = new Set<string>();
  type Baris = { unit?: unknown; factor?: unknown; price?: unknown };
  const disiapkan: { unit: string; factor: number; price: number | null }[] = [];
  for (const raw of rows as Baris[]) {
    const unit = String(raw?.unit ?? '').trim();
    if (!unit) throw new Error('satuan jual: unit wajib diisi');
    if (unit === baseUnit) {
      throw new Error(`satuan dasar (${baseUnit}) tidak perlu diulang — satuan dasar selalu tersedia`);
    }
    if (seen.has(unit)) throw new Error(`satuan jual duplikat: ${unit}`);
    seen.add(unit);
    const factor = Number(raw?.factor);
    if (!Number.isFinite(factor) || factor <= 0) throw new Error(`satuan ${unit}: factor harus angka > 0`);
    const satu = db.prepare('SELECT 1 FROM units WHERE slug = ?').get(unit);
    if (!satu) throw new Error(`satuan tidak dikenal: ${unit} — buat dulu di halaman Satuan`);
    const pRaw = raw?.price;
    const price = pRaw === undefined || pRaw === null || pRaw === '' ? null : Number(pRaw);
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      throw new Error(`satuan ${unit}: price harus angka >= 0`);
    }
    disiapkan.push({ unit, factor, price });
  }
  // Ganti seluruh daftar. Baris yang menyamai satuan dasar ikut terbuang — dasar
  // baru bisa saja dulunya jadi baris alternatif (mis. dasar pcs -> pack, dan
  // sebelumnya ada baris pack).
  db.prepare('DELETE FROM product_units WHERE product_id = ?').run(productId);
  const ins = db.prepare('INSERT INTO product_units (product_id, unit, factor, price) VALUES (?, ?, ?, ?)');
  for (const b of disiapkan) ins.run(productId, b.unit, b.factor, b.price);
}

// Harga borongan per qty (2026-10-19) — model "kelipatan paket" yang dipakai
// POS: setiap `qty` satuan dasar berharga `price`, kelebihannya harga normal.
// Kontrak `borongan` di POST /api/products mengikuti `units` persis:
//   - `undefined` / tidak dikirim = TIDAK mengubah aturan (payload toggle
//     aktif & tiap baris impor tidak boleh menghapus aturan diam-diam)
//   - `[]` = hapus semua aturan
//   - `[{qty,price}]` = ganti seluruh daftar (replace, bukan merge)
// Validasi (semua 400 lewat throw di dalam transaksi upsert): qty bilangan
// bulat >= 2 & tidak ganda; price bilangan bulat >= 0; dan paket WAJIB lebih
// murah dari qty x harga jual saat ini — aturan "beli banyak" yang tidak lebih
// murah adalah salah input, bukan diskon. Server tidak pernah menghitung
// potongannya sendiri: POS mengirim lewat `items[].discount` (jalur diskon
// baris yang sudah tervalidasi `0 <= discount <= qty*price`).
function simpanBorongan(productId: number, hargaJual: number, rows: unknown[]): void {
  if (!Array.isArray(rows)) throw new Error('borongan harus berupa array');
  const jual = Number(hargaJual);
  if (rows.length > 0 && (!Number.isFinite(jual) || jual <= 0)) {
    throw new Error('borongan: isi harga jual normal (> 0) dulu — aturan borongan harus lebih murah dari harga normal');
  }
  const seen = new Set<number>();
  const disiapkan: { qty: number; price: number }[] = [];
  for (const raw of rows as { qty?: unknown; price?: unknown }[]) {
    const qty = Number(raw?.qty);
    if (!Number.isInteger(qty) || qty < 2) throw new Error('borongan: qty harus bilangan bulat >= 2');
    if (seen.has(qty)) throw new Error(`borongan qty ganda: ${qty}`);
    seen.add(qty);
    const price = Number(raw?.price);
    if (!Number.isInteger(price) || price < 0) {
      throw new Error(`borongan qty ${qty}: harga paket harus angka bulat >= 0`);
    }
    if (price >= qty * jual) {
      throw new Error(
        `borongan qty ${qty}: harga paket harus lebih murah dari ${qty} x harga jual (${qty * jual})`,
      );
    }
    disiapkan.push({ qty, price });
  }
  db.prepare('DELETE FROM product_borongan WHERE product_id = ?').run(productId);
  const ins = db.prepare('INSERT INTO product_borongan (product_id, qty, price) VALUES (?, ?, ?)');
  for (const b of disiapkan) ins.run(productId, b.qty, b.price);
}

// Tambah / ubah master. Naikkan version agar client yang cache bisa sync via ?since=
//
// `opts.pertahankanTidakDikirim` dipasang SATU-SATUNYA oleh /api/products/import.
// Di sana berkas = daftar kolom, jadi kolom yang tidak ada berarti "jangan
// diubah" — BUKAN "setel ke default". Tanpa bendera ini, file CSV tanpa kolom
// Stok/Harga/Satuan akan diam-diam menyetel ulang produk yang sudah ada jadi 0
// / 'pcs' tanpa jejak stock_moves (diuji langsung: stok 7 -> 0, price 1000 -> 0).
// POST /api/products TETAP perilaku lamanya (field kosong -> default server)
// sesuai kontrak AGENTS.md §3, karena form & toggle aktif mengirim payload lenkap.
const upsertProduct = transaksi((
  input: {
    sku?: string; name: string; category_slug: string;
    barcode?: string | null; unit?: string; price?: number; price_grosir?: number;
    cost?: number; markup?: number;
    price_dynamic?: number; stock?: number; min_stock?: number; is_active?: number;
    units?: unknown[];
    borongan?: unknown[];
    image?: string | null; discount_type?: string; discount?: number; expiry_date?: string | null;
    use_note?: number;
  },
  opts?: { pertahankanTidakDikirim?: boolean },
) => {
  const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(input.category_slug) as { id: number } | undefined;
  if (!cat) throw new Error(`kategori tidak dikenal: ${input.category_slug}`);
  const sku = input.sku?.trim() || skuDariUrut();
  const pertahankan = opts?.pertahankanTidakDikirim === true;
  // Baris lama dibaca lebih dulu: satuan ikut diambil dari sini, karena satuan
  // menentukan cek master dan nilai FK — kalau kolom Satuan absen, satuan
  // lama harus dipakai, bukan jatuh ke 'pcs'.
  const existing = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) as
    | ({ id: number } & Record<string, unknown>) | undefined;
  const lama = pertahankan ? existing : undefined;
  /** Kolom tidak dikirim + bendera pasang = nilai lama; baris baru tetap default. */
  const amb = <T>(baru: T | undefined, kunci: string, bawaan: T): T => {
    if (pertahankan && baru === undefined && lama && lama[kunci] !== undefined) {
      return lama[kunci] as T;
    }
    return baru ?? bawaan;
  };
  const unitRaw = input.unit?.trim();
  const unit = unitRaw || amb(undefined, 'unit', 'pcs');
  // Satuan harus ada di master (form produk pakai dropdown). Dicek di sini biar
  // jawabannya 400 yang jelas, bukan error FK mentah dari SQLite.
  const satu = db.prepare('SELECT id FROM units WHERE slug = ?').get(unit) as { id: number } | undefined;
  if (!satu) throw new Error(`satuan tidak dikenal: ${unit} — buat dulu di halaman Satuan`);
  const barcode = amb(input.barcode ?? undefined, 'barcode', null);
  const price = amb(input.price, 'price', 0);
  // Harga grosir (tier pelanggan, 2026-10-11): field BIASA — ikut aturan
  // reset (tidak dikirim = 0 = ikut ecer), jadi wajib dibawa payload
  // form & payloadToggleAktif. Impor CSV tanpa kolom ini dipertahankan
  // lewat bendera pertahankanTidakDikirim (pola kolom lain).
  const priceGrosir = amb(input.price_grosir, 'price_grosir', 0);
  if (!Number.isFinite(priceGrosir) || priceGrosir < 0) throw new Error('price_grosir harus angka >= 0');
  const priceDynamic = amb(input.price_dynamic, 'price_dynamic', 0);
  const cost = amb(input.cost, 'cost', 0);
  const markup = amb(input.markup, 'markup', 0);
  const stock = amb(input.stock, 'stock', 0);
  const minStock = amb(input.min_stock, 'min_stock', 0);
  const isActive = amb(input.is_active, 'is_active', 1);
  // Catatan per baris di POS (0/1) — pola sama dengan `use_expiry` kategori:
  // field biasa, jadi ikut aturan reset (tidak dikirim = kembali default 0)
  // dan wajib dibawa payloadToggleAktif/form.
  const useNote = amb(input.use_note, 'use_note', 0) ? 1 : 0;

  // ---- Foto: aturan KHUSUS, bukan pakai `amb` ----
  // `undefined` = tidak diubah di SEMUA mode (bukan cuma impor). Kalau pakai
  // amb(), payload toggle aktif & tiap baris CSV yang tidak membawa foto akan
  // jatuh ke default '' dan MENGHAPUS FOTO diam-diam — persis kecelakaan yang
  // pernah terjadi pada `units`.
  // File-nya sendiri ditulis oleh POST /api/products/:id/image; endpoint ini
  // hanya menerima nama filenya (dipakai impor & payload yang membawa referensi).
  let image: string | null;
  if (input.image === undefined) image = (existing?.image as string | null) ?? null;
  else if (input.image === null || String(input.image).trim() === '') image = null;
  else {
    const nama = String(input.image).trim();
    // Tanpa slash & tanpa '..': nilai kolom ini nanti dipakai sebagai nama file,
    // jadi `../..` akan membuka jalan path traversal dari payload client.
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(nama) || nama.includes('..')) {
      throw new Error('image: nama file tidak valid');
    }
    image = nama;
  }

  const discountType = String(amb(input.discount_type, 'discount_type', 'rp'));
  if (discountType !== 'rp' && discountType !== 'pct') {
    throw new Error("discount_type harus 'rp' atau 'pct'");
  }
  const discount = Number(amb(input.discount, 'discount', 0));
  if (!Number.isFinite(discount) || discount < 0) throw new Error('discount harus angka >= 0');
  if (discountType === 'pct' && discount > 100) throw new Error('discount persen maksimal 100');

  const expiryRaw = amb<string | null | undefined>(input.expiry_date, 'expiry_date', null);
  const expiry = expiryRaw === null || expiryRaw === undefined || String(expiryRaw).trim() === ''
    ? null
    : String(expiryRaw).trim();
  if (expiry !== null) {
    // `Date.parse` TIDAK menolak `2026-02-31` — ia ROLLOVER jadi 3 Maret, jadi
    // pola regex saja meloloskan tanggal yang tidak ada di kalender. Dibolak-
    // balikkan lewat `toISOString()`: tanggal fiktif bentuknya berbeda setelah
    // dinormalkan. Klien menolaknya lebih dulu (importcsv.parseTanggal), tapi
    // endpoint ini juga dipakai import & payload lain yang bisa datang dari
    // tempelan Excel — validasinya harus sama ketatnya di dua sisi.
    const t = new Date(`${expiry}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)
      || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== expiry) {
      throw new Error('expiry_date harus tanggal YYYY-MM-DD yang valid');
    }
  }

  let pid: number;
  if (!existing) {
    const info = db.prepare(
      `INSERT INTO products (category_id, sku, barcode, name, unit, price, price_grosir, price_dynamic, cost, markup, stock, min_stock,
                             image, discount_type, discount, expiry_date, use_note, is_active, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
         COALESCE((SELECT MAX(version) FROM products), 0) + 1)`,
    ).run(cat.id, sku, barcode, input.name, unit,
      price, priceGrosir, priceDynamic, cost, markup, stock, minStock,
      image, discountType, discount, expiry, useNote, isActive);
    pid = Number(info.lastInsertRowid);
  } else {
    pid = existing.id;
    // deleted_at IKUT di-set NULL di sini: pencarian `existing` (baris 310) tidak
    // memfilter tombstone, jadi baris yang pernah dihapus ketemu dan masuk cabang
    // UPDATE ini. Kalau kolomnya tidak dikosongkan, POST ulang SKU yang sudah
    // dihapus membalas 201 OK tapi produknya tetap MAYAT — tak pernah muncul di
    // `status=aktif|semua` (line ~150) dan tetap terkirim sbg `deleted_at` terisi
    // lewat `?since=` (line ~148), sehingga client justru MEMBUANGNYA dari cache.
    // Konsisten dengan semangat upsert by SKU: menyebut SKU yang sama berarti
    // "produk ini ada (lagi)". version tetap naik supaya delta sync membangkitkan
    // barisnya kembali di semua device (dipertegas di tests bagian E).
    db.prepare(
      `UPDATE products SET category_id=?, barcode=?, name=?, unit=?, price=?, price_grosir=?, price_dynamic=?,
         cost=?, markup=?, stock=?, min_stock=?, image=?, discount_type=?, discount=?, expiry_date=?,
         use_note=?, is_active=?, deleted_at=NULL,
         updated_at=datetime('now'),
         version=(SELECT COALESCE(MAX(version),0)+1 FROM products)
       WHERE id=?`,
    ).run(cat.id, barcode, input.name, unit,
      price, priceGrosir, priceDynamic, cost, markup, stock, minStock,
      image, discountType, discount, expiry, useNote, isActive, pid);
  }
  // units === undefined -> biarkan apa adanya; array (termasuk []) -> ganti semua.
  if (input.units !== undefined) simpanSatuanJual(pid, unit, input.units);
  else db.prepare('DELETE FROM product_units WHERE product_id = ? AND unit = ?').run(pid, unit);
  // borongan === undefined -> biarkan apa adanya; array (termasuk []) -> ganti
  // semua (pola `units` di atas — payload toggle aktif & impor tak menghapus).
  // Validasi memakai harga jual EFEKTIF baris ini (setelah aturan `amb`), jadi
  // impor yang tidak membawa kolom harga memakai harga lama, bukan 0.
  if (input.borongan !== undefined) simpanBorongan(pid, Number(price), input.borongan);
  return db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
});

app.post('/api/products', wajibIzin('produk.kelola'), async (c) => {
  try {
    const body = await c.req.json();
    // sku tidak wajib: kosong berarti server yang menurunkan dari nama (unik).
    if (!body?.name || !body?.category_slug) {
      return c.json({ error: 'name dan category_slug wajib' }, 400);
    }
    // Audit: create vs update dibaca DULU dari SKU yang dikirim (kosong =
    // selalu produk baru bernomor server). Tombstone dihitung 'create'
    // karena operasinya membangkitkan kembali produk yang sudah dihapus.
    const skuKirim = String(body?.sku ?? '').trim();
    const sebelum = skuKirim
      ? (db.prepare('SELECT id, deleted_at FROM products WHERE sku = ?').get(skuKirim) as
          | { id: number; deleted_at: string | null }
          | undefined)
      : undefined;
    const row = upsertProduct(body);
    const hasil = row as { id: number; sku: string };
    catatAudit(c, sebelum && !sebelum.deleted_at ? 'update' : 'create', 'product', hasil.id, {
      sku: hasil.sku, name: String(body?.name ?? ''),
    });
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan produk' }, 400);
  }
});

// ---------- Foto produk: file di disk, DB hanya menyimpan NAMANYA ----------
// Kenapa bukan base64 di kolom: stok saja sudah menaikkan `version`, jadi foto
// yang menempel di baris produk ikut ditarik ulang oleh ?since= tiap penjualan
// /restock. Dengan file terpisah, delta sync cuma membawa nama file, dan isi
// gambar diunduh sekali lalu di-cache client (tampil offline setelah itu).
const IMG_MIME: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const IMG_EXT: Record<string, string> = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };
// Thumbnail 512px hasil resize client ~10-20KB. 300KB masih longgar, tapi
// menahan kasir yang menempel foto asli HP (2-4MB) apa adanya.
const IMG_MAKS_BYTE = 300_000;

function buangFileFoto(nama: string): void {
  const aman = path.basename(nama); // jaring pengaman: nilai kolom tidak boleh keluar dari img/
  try { fs.rmSync(path.join(imgDir(), aman), { force: true }); } catch { /* file mungkin tak ada */ }
}

app.post('/api/products/:id/image', wajibIzin('produk.kelola'), async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id tidak valid' }, 400);
    const p = db.prepare('SELECT id, image FROM products WHERE id=? AND deleted_at IS NULL').get(id) as
      { id: number; image: string | null } | undefined;
    if (!p) return c.json({ error: 'produk tidak ada' }, 404);

    let body: { image?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'body harus JSON' }, 400); }
    const kiriman = body?.image;
    // Tanpa kunci `image` sama sekali = 400, bukan dianggap hapus: menghapus
    // foto karena payload yang tidak lengkap terlalu mahal harganya.
    if (kiriman === undefined) return c.json({ error: 'image wajib diisi ("" untuk menghapus foto)' }, 400);

    const tulis = db.transaction((nama: string | null, lama: string | null) => {
      if (lama) buangFileFoto(lama);
      db.prepare(
        `UPDATE products SET image=?, updated_at=datetime('now'),
           version=(SELECT COALESCE(MAX(version),0)+1 FROM products)
         WHERE id=?`,
      ).run(nama, id);
    });

    if (kiriman === null || String(kiriman).trim() === '') {
      tulis(null, p.image);
      catatAudit(c, 'update', 'product', id, { foto: null });
      return c.json({ data: { image: null } });
    }

    const val = String(kiriman).trim();
    const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(val);
    if (!m) return c.json({ error: 'image harus data URL base64 (data:image/jpeg;base64,...)' }, 400);
    const ext = IMG_EXT[m[1].toLowerCase()];
    if (!ext) return c.json({ error: `format gambar tidak didukung: ${m[1]}` }, 400);
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (!buf.length) return c.json({ error: 'gambar kosong' }, 400);
    if (buf.length > IMG_MAKS_BYTE) {
      return c.json({
        error: `thumbnail terlalu besar (${buf.length} byte, maks ${IMG_MAKS_BYTE}) — resize dulu di client`,
      }, 400);
    }

    const nama = `${id}.${ext}`;
    fs.writeFileSync(path.join(imgDir(), nama), buf);
    // File lama dengan ekstensi berbeda ikut dibuang (png -> jpg meninggalkan
    // barang bukti yang tidak pernah dibaca siapa pun).
    for (const e of new Set(Object.values(IMG_EXT))) {
      if (e !== ext) buangFileFoto(`${id}.${e}`);
    }
    tulis(nama, p.image && p.image !== nama ? p.image : null);
    catatAudit(c, 'update', 'product', id, { foto: nama });
    return c.json({ data: { image: nama } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan foto' }, 400);
  }
});

app.get('/api/products/:id/image', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id tidak valid' }, 400);
  const p = db.prepare('SELECT image, updated_at FROM products WHERE id=?').get(id) as
    { image: string | null; updated_at: string } | undefined;
  if (!p?.image) return c.json({ error: 'foto tidak ada' }, 404);
  const file = path.join(imgDir(), path.basename(p.image));
  if (!fs.existsSync(file)) return c.json({ error: 'file foto hilang' }, 404);
  const etag = `"${p.updated_at}"`;
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  const buf = fs.readFileSync(file);
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': IMG_MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream',
    'ETag': etag,
    // Revalidasi murah (ETag sudah dikirim) dan tidak menyimpan lama di cache —
    // kunci tampilan offline justru di IndexedDB client, bukan di cache browser.
    'Cache-Control': 'no-cache',
  });
});

// ---------- Import massal (CSV / tempelan Excel) ----------
// tiap baris di-upsert lewat upsertProduct YANG SAMA dengan POST /api/products:
// validasi kategori, cek satuan di master, dan turunan SKU tetap satu sumber
// kebenaran, bukan versi kedua yang bisa melenceng.
// SATU-SATUNYA bedanya: bendera `pertahankanTidakDikirim` — di impor, kolom yang
// tidak ada di berkas berarti "biarkan", bukan "setel ke 0".
// `dry_run:true` = hitung hasil tanpa menyimpan: seluruh baris dijalankan dalam
// satu transaksi yang sengaja DIBATALKAN di akhir (rollback lempar error), jadi
// validasinya tetap kode yang sama persis seperti import sungguhan.
app.post('/api/products/import', wajibIzin('produk.kelola'), async (c) => {
  try {
    const body = await c.req.json();
    const rows = Array.isArray(body?.rows) ? body.rows : null;
    if (!rows) return c.json({ error: 'rows wajib berupa array' }, 400);
    if (rows.length === 0) return c.json({ error: 'rows kosong' }, 400);
    if (rows.length > 1000) return c.json({ error: 'maksimal 1000 baris per import' }, 400);
    const dry = body?.dry_run === true;

    const rep = { total: rows.length, ok: 0, baru: 0, update: 0, gagal: 0,
      errors: [] as { baris: number; sku: string; error: string }[] };
    const skuDipakai = new Set<string>();
    const ROLLBACK = '__rollback_dry_run__';

    const kerjakan = () => {
      for (let i = 0; i < rows.length; i++) {
        const r = (rows[i] ?? {}) as Record<string, unknown>;
        const baris = i + 1;
        const sku = typeof r.sku === 'string' ? r.sku.trim() : '';
        // SKU eksplisit yang sama di dalam file yang sama = baris kedua akan
        // MENIMPA yang pertama tanpa disadari — tolak, jangan diam-diam overwrite.
        if (sku && skuDipakai.has(sku)) {
          rep.gagal++;
          rep.errors.push({ baris, sku, error: `SKU "${sku}" muncul lebih dari satu kali di file ini` });
          continue;
        }
        if (sku) skuDipakai.add(sku);
        if (!r.name || !String(r.name).trim()) {
          rep.gagal++; rep.errors.push({ baris, sku, error: 'name wajib diisi' }); continue;
        }
        if (!r.category_slug) {
          rep.gagal++; rep.errors.push({ baris, sku, error: 'category_slug wajib diisi' }); continue;
        }
        try {
          const existed = db.prepare('SELECT 1 FROM products WHERE sku = ?').get(
            sku || skuDariUrut(),
          );
          // pertahankanTidakDikirim: kolom yang tidak ada di berkas = jangan
          // diubah. Lihat komentar upsertProduct — tanpa ini file tanpa kolom
          // Stok/Harga menyetel produk lama jadi 0 diam-diam.
          upsertProduct(r as never, { pertahankanTidakDikirim: true });
          rep.ok++;
          if (existed) rep.update++; else rep.baru++;
        } catch (e) {
          rep.gagal++;
          rep.errors.push({ baris, sku, error: e instanceof Error ? e.message : 'gagal simpan' });
        }
      }
      if (dry) throw new Error(ROLLBACK);
    };

    if (dry) {
      try { db.transaction(kerjakan)(); } catch (e) {
        if (!(e instanceof Error && e.message === ROLLBACK)) throw e;
      }
    } else {
      db.transaction(kerjakan)();
    }
    rep.errors = rep.errors.slice(0, 50);   // jangan kirim ribuan baris error
    // Satu entri ringkasan per import (dry_run tidak menulis apa pun -> tidak diaudit).
    if (!dry) catatAudit(c, 'import', 'product', 'impor', { total: rep.total, baru: rep.baru, update: rep.update, gagal: rep.gagal });
    return c.json({ data: rep });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal import' }, 400);
  }
});

// Restock barang fisik (tidak untuk jasa/topup).
// `harga_beli` OPSIONAL — restock kadang dilakukan tanpa nota beli, dan kalau
// tidak dikirim rata-rata modal harus tetap seperti semula (bukan dianggap 0,
// yang akan membuat HPP jadi nol dan laba palsu). Bila diisi wajib angka >= 0;
// input kosong/huruf ditolak, bukan dianggap 0.
app.post('/api/restock', wajibIzin('stok.restock'), async (c) => {
  const body = await c.req.json();
  const qty = Number(body?.qty ?? 0);
  if (!body?.product_id || !(qty > 0)) return c.json({ error: 'product_id dan qty>0 wajib' }, 400);
  const raw = body?.harga_beli;
  const adaHarga = raw !== undefined && raw !== null && raw !== '';
  const harga = Number(raw);
  if (adaHarga && (!Number.isFinite(harga) || harga < 0)) {
    return c.json({ error: 'harga_beli harus angka >= 0' }, 400);
  }
  const p = db.prepare(
    `SELECT p.*, c.track_stock FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?`,
  ).get(body.product_id) as { track_stock: number; stock: number; avg_cost: number } | undefined;
  if (!p) return c.json({ error: 'produk tidak ada' }, 404);
  if (!p.track_stock) return c.json({ error: 'produk ini tidak dilacak stoknya (jasa/topup/cetak)' }, 400);
  const tx = db.transaction(() => {
    // Modal rata-rata tertimbang. stok_lama diambil SEBELUM update — memakai
    // stok hasil penambahan akan menghitung barang lama seolah ikut terbeli
    // pada harga batch baru.
    const avgBaru = adaHarga
      ? Math.round((p.stock * p.avg_cost + qty * harga) / (p.stock + qty))
      : p.avg_cost;
    // version HARUS naik: perubahan stok tidak terlihat client bila version tetap,
    // karena sync master hanya menarik p.version > since.
    db.prepare(
      `UPDATE products SET stock = stock + ?, avg_cost = ?, updated_at=datetime('now'),
         version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
       WHERE id=?`,
    ).run(qty, avgBaru, body.product_id);
    // unit_cost = harga batch bila dikirim; kalau tidak, rata-rata yang berlaku.
    db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, unit_cost, cashier) VALUES (?, ?, 'restock', ?, ?)`)
      .run(body.product_id, qty, adaHarga ? Math.round(harga) : p.avg_cost,
        cashierEfektif(c, body?.cashier));
  });
  tx();
  catatAudit(c, 'restock', 'stock', Number(body.product_id), {
    qty, harga_beli: adaHarga ? Math.round(harga) : null,
  });
  return c.json({ data: db.prepare('SELECT * FROM products WHERE id=?').get(body.product_id) });
});

// Stok opname: kasir MENGGANTI stok dengan hasil hitung fisik (bukan selisih).
// Bedanya dengan restock: restock menambah `qty` yang dikirim, opname menulis
// `qty_fisik` apa adanya — termasuk 0 (semua hilang/rusak).
// `stock_moves.qty` tetap disimpan sebagai SELISIH (fisik - tercatat) supaya
// riwayat mutasi tetap bermakna: + = kelebihan ditemukan, - = kekurangan.
// reason 'opname' memang sudah ada di skema sejak awal (schema.sql) — tidak ada
// kolom/tabel baru, jadi tidak perlu re-create database.
app.post('/api/stock-opname', wajibIzin('stok.opname'), async (c) => {
  const body = await c.req.json();
  const raw = body?.qty_fisik;
  const fisik = Number(raw);
  // Wajib angka dan >= 0. NaN sengaja ditolak: input kosong/huruf tidak boleh
  // dianggap 0, karena 0 berarti "semua barang hilang".
  if (!body?.product_id || raw === undefined || raw === '' || !Number.isFinite(fisik) || fisik < 0) {
    return c.json({ error: 'product_id dan qty_fisik (angka, boleh 0) wajib' }, 400);
  }
  const p = db.prepare(
    `SELECT p.stock, p.avg_cost, c.track_stock FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?`,
  ).get(body.product_id) as { stock: number; avg_cost: number; track_stock: number } | undefined;
  if (!p) return c.json({ error: 'produk tidak ada' }, 404);
  if (!p.track_stock) return c.json({ error: 'produk ini tidak dilacak stoknya (jasa/topup/cetak)' }, 400);

  const selisih = fisik - p.stock;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE products SET stock = ?, updated_at=datetime('now'),
         version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
       WHERE id=?`,
    ).run(fisik, body.product_id);
    // avg_cost TIDAK diubah opname: stok bertambah = barang tambahan yang tidak
    // punya harga beli (dibiarkan pada rata-rata lama), stok berkurang = nilai
    // ikut turun lewat `stock`. unit_cost tetap dicatat sebagai harga buku.
    db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, unit_cost, cashier) VALUES (?, ?, 'opname', ?, ?)`)
      .run(body.product_id, selisih, p.avg_cost, cashierEfektif(c, body?.cashier));
  });
  tx();
  catatAudit(c, 'opname', 'stock', Number(body.product_id), { sebelum: p.stock, sesudah: fisik, selisih });
  return c.json({ data: { product_id: body.product_id, sebelum: p.stock, sesudah: fisik, selisih } });
});

// ---------- Riwayat stok / product history ----------
// Baris `stock_moves` sudah ditulis sejak awal oleh sale/restock/opname —
// endpoint ini hanya MEMBUKANYannya ke halaman Stok. Read-only: tidak menyentuh
// products.version, jadi tidak ikut delta sync (dan memang tidak perlu — riwayat
// bukan master yang di-cache client; diambil saat dialog dibuka).
app.get('/api/stock-moves', wajibIzin('stok.lihat'), (c) => {
  const pid = Number(c.req.query('product_id'));
  if (!Number.isInteger(pid) || pid <= 0) {
    return c.json({ error: 'product_id wajib (riwayat selalu milik satu produk)' }, 400);
  }
  const reason = (c.req.query('reason') ?? '').trim();
  if (reason && !['sale', 'restock', 'opname', 'rusak'].includes(reason)) {
    return c.json({ error: `reason tidak dikenal: ${reason} (pakai sale|restock|opname|rusak)` }, 400);
  }
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const conds = ['sm.product_id = ?'];
  const params: unknown[] = [pid];
  if (reason) { conds.push('sm.reason = ?'); params.push(reason); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM stock_moves sm ${where}`).get(...params) as { n: number }).n;
  const data = db.prepare(
    `SELECT sm.id, sm.created_at, sm.product_id, p.sku, p.name, sm.qty, sm.reason,
            sm.ref_id,
            (SELECT s.invoice_no FROM sales s WHERE s.id = sm.ref_id) AS ref_invoice,
            sm.unit_cost, sm.cashier
       FROM stock_moves sm JOIN products p ON p.id = sm.product_id
       ${where}
      ORDER BY sm.created_at DESC, sm.id DESC
      LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return c.json({ data, total });
});

// ---------- shift ----------
// Satu shift terbuka per kasir (2 kasir boleh bersamaan, tiap device pakai nama kasir beda).
// Tanpa ?cashier= -> kembalikan shift terbuka terbaru (kompatibilitas).
app.get('/api/shifts/open', wajibIzin('shift.lihat'), (c) => {
  const u = c.get('user') as Pengguna;
  // Tanpa shift.kelola kasir HANYA bisa melihat shiftnya sendiri — query
  // ?cashier= milik kasir lain diabaikan, bukan membocorkan laci orang.
  const cashier = bolehIzin(u, 'shift.kelola') ? c.req.query('cashier') : u.name;
  const row = cashier
    ? db.prepare(`SELECT * FROM shifts WHERE status='open' AND cashier=? LIMIT 1`).get(cashier)
    : db.prepare(`SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1`).get();
  return c.json({ data: row ?? null });
});

// Riwayat shift (menu "Shift Kasir"): daftar + agregat penjualan/topup per
// shift lewat subquery — satu kali baca, bukan N+1. Agregat berasal dari baris
// yang memang terikat `shift_id` (penjualan offline yang masuk lewat outbox
// ikut terhitung setelah tersimpan, karena ikut membawa shift_id).

/**
 * Nilai atribusi satu metode pembayaran untuk agregat shift (split 1.6.5).
 * Membaca `sale_payments` (Σ amount per nota selalu = sales.total); nota LAMA
 * yang belum punya baris jatuh ke fallback `(pay_method, total)`. Karena tiap
 * nota teratribusi penuh ke metodenya, Σ tunai+qris+transfer per shift SELALU
 * = omzet shift — invariant yang dijaga shift-test & recap-test (jangan
 * diganti jadi membaca `sales.pay_method` saja; nota split tercatat
 * 'campuran' dan porsinya akan hilang).
 */
const nilaiMetodeShift = (m: string) =>
  `(SELECT COALESCE(SUM(x.nilai),0) FROM (
      SELECT sp.amount AS nilai FROM sale_payments sp
        JOIN sales sl ON sl.id = sp.sale_id
       WHERE sl.shift_id = s.id AND sp.method='${m}'
      UNION ALL
      SELECT sl.total AS nilai FROM sales sl
       WHERE sl.shift_id = s.id AND sl.pay_method='${m}'
         AND NOT EXISTS (SELECT 1 FROM sale_payments sp2 WHERE sp2.sale_id = sl.id)
    ) x)`;

app.get('/api/shifts', wajibIzin('shift.lihat'), (c) => {
  const status = c.req.query('status') ?? 'semua';
  if (!['semua', 'open', 'closed'].includes(status)) {
    return c.json({ error: 'status harus open|closed|semua' }, 400);
  }
  const u = c.get('user') as Pengguna;
  // shift.kelola = boleh melihat semua kasir; selain itu paksa nama sendiri.
  const cashier = bolehIzin(u, 'shift.kelola') ? c.req.query('cashier') : u.name;
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status !== 'semua') { where.push(`s.status=?`); params.push(status); }
  if (cashier) { where.push(`s.cashier=?`); params.push(cashier); }
  const klausul = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM shifts s ${klausul}`)
    .get(...params) as { n: number }).n;
  const data = db.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM sales sl WHERE sl.shift_id = s.id) AS n_sales,
            (SELECT COALESCE(SUM(sl.total),0) FROM sales sl WHERE sl.shift_id = s.id) AS omzet,
            -- Rincian per metode (keputusan pemilik 2026-10-01: QRIS/transfer
            -- TETAP masuk hitungan laci, wajib tercatat sumbernya) — supaya
            -- dialog tutup shift bisa menampilkan "per sumber" tanpa
            -- menghitung ulang di klien. Sejak 1.6.5 dibaca dari
            -- sale_payments lewat helper nilaiMetodeShift() (nota split
            -- tercatat 'campuran' — porsinya hanya ada di tabel itu; nota
            -- lama tanpa baris jatuh ke fallback (pay_method, total)).
            ${nilaiMetodeShift('tunai')} AS tunai,
            ${nilaiMetodeShift('qris')} AS qris,
            ${nilaiMetodeShift('transfer')} AS transfer,
            (SELECT COUNT(*) FROM topup_txns t WHERE t.shift_id = s.id) AS n_topup,
            -- Gerak kas topup/tarik TERPISAH per kolom & per angka (keputusan
            -- pemilik 2026-10-01): topup = tunai pelanggan -> laci NAIK
            -- (nominal + admin, keduanya dihitung tapi dilaporkan terpisah);
            -- tarik = JANGAN mengurangi laci (cukup dicatat) jadi tidak pernah
            -- masuk rumus expected-cash di klien.
            (SELECT COALESCE(SUM(t.nominal),0) FROM topup_txns t
              WHERE t.shift_id = s.id AND t.kind='topup') AS topup_nominal,
            (SELECT COALESCE(SUM(t.admin),0) FROM topup_txns t
              WHERE t.shift_id = s.id AND t.kind='topup') AS topup_admin,
            (SELECT COALESCE(SUM(t.nominal),0) FROM topup_txns t
              WHERE t.shift_id = s.id AND t.kind='tarik') AS tarik_nominal,
            (SELECT COALESCE(SUM(t.admin),0) FROM topup_txns t
              WHERE t.shift_id = s.id AND t.kind='tarik') AS tarik_admin,
            -- Pengeluaran tunai (Tahap 1, 2026-10-11): kas KELUAR dari laci —
            -- mengurangi expected-cash di kasSeharusnya() (shift-tutup.ts).
            -- Hanya yang terikat shift_id ini; yang NULL (di luar shift)
            -- tetap tercatat + masuk laporan harian, bukan hitungan laci.
            (SELECT COUNT(*) FROM expenses e WHERE e.shift_id = s.id) AS n_expense,
            (SELECT COALESCE(SUM(e.jumlah),0) FROM expenses e WHERE e.shift_id = s.id) AS expense_total,
            -- Kas masuk non-penjualan (butir ROADMAP 1.6.2, 2026-10-19):
            -- kas MASUK ke laci di luar penjualan (injeksi modal / koreksi
            -- laci) — MENAMBAH expected-cash di kasSeharusnya() (shift-tutup.ts).
            -- Hanya yang terikat shift_id ini; yang NULL (di luar shift) tetap
            -- tercatat + masuk laporan harian, bukan hitungan laci.
            (SELECT COUNT(*) FROM kas_masuk k WHERE k.shift_id = s.id) AS n_kas_masuk,
            (SELECT COALESCE(SUM(k.jumlah),0) FROM kas_masuk k WHERE k.shift_id = s.id) AS kas_masuk_total,
            -- Retur tunai (Tahap 2, 2026-10-11): uang KEMBALI ke pelanggan —
            -- mengurangi expected-cash di kasSeharusnya() (keputusan pemilik
            -- (a)). Hanya yang terikat shift_id ini.
            (SELECT COUNT(*) FROM returns r WHERE r.shift_id = s.id) AS n_retur,
            (SELECT COALESCE(SUM(r.total),0) FROM returns r WHERE r.shift_id = s.id) AS retur_total,
            -- Pembelian tunai (Tahap 3, 2026-10-11; BERTAHAP sejak butir 3.7
            -- 2026-10-25): kas KELUAR sebesar yang DIBAYAR, dihitung per
            -- KEDATANGAN — satu PO bisa menerima barang di beberapa shift.
            --   n_purchase = jumlah event kedatangan di shift ini + nota
            --   LAMA (received tanpa baris kedatangan, fitur ini baru) supaya
            --   riwayat lama tetap tampil 1 event di rekap.
            --   purchase_total = Σ dibayar event di shift ini + sisa
            --   pembayaran yang MENEMPEL ke PO (p.shift_id = kedatangan
            --   PERTAMA, dipakai cicilan POST /:id/pay) — dibagi begini agar
            --   uang yang sama tidak dihitung dua kali.
            ((SELECT COUNT(*) FROM purchase_receives r WHERE r.shift_id = s.id)
             + (SELECT COUNT(*) FROM purchases p
                 WHERE p.shift_id = s.id AND p.status = 'received'
                   AND NOT EXISTS (SELECT 1 FROM purchase_receives r2 WHERE r2.purchase_id = p.id))) AS n_purchase,
            ((SELECT COALESCE(SUM(r.dibayar),0) FROM purchase_receives r WHERE r.shift_id = s.id)
             + (SELECT COALESCE(SUM(p.terbayar - COALESCE(
                    (SELECT SUM(r2.dibayar) FROM purchase_receives r2 WHERE r2.purchase_id = p.id), 0)),0)
                  FROM purchases p WHERE p.shift_id = s.id AND p.status <> 'cancel')) AS purchase_total,
            -- Rekap tutup shift ala Z-report Aronium (2026-10-11): rentang
            -- nota + total diskon + hutang terbentuk + piutang terbayar.
            -- invoice_no YYMMDD-NNNNNN urut leksikal = kronologis, jadi
            -- MIN/MAX cukup untuk rentang dokumen (butir 5 Z-report).
            (SELECT MIN(sl.invoice_no) FROM sales sl WHERE sl.shift_id = s.id) AS inv_awal,
            (SELECT MAX(sl.invoice_no) FROM sales sl WHERE sl.shift_id = s.id) AS inv_akhir,
            -- Diskon hari-shift = transaksi + per baris (rumus SAMA dengan
            -- sales.diskon di reports/daily — satu definisi, dua pemakai).
            ((SELECT COALESCE(SUM(sl.discount),0) FROM sales sl WHERE sl.shift_id = s.id) +
             (SELECT COALESCE(SUM(si.discount),0) FROM sale_items si
               JOIN sales sl ON sl.id = si.sale_id WHERE sl.shift_id = s.id)) AS diskon_total,
            -- Hutang TERBENTUK shift ini (butir "credit" Z-report): CASE yang
            -- SAMA PERSIS dengan penanda sisa_hutang di GET /api/sales
            -- (tunai + kurang + pelanggan valid) — laci TIDAK menerima porsi
            -- ini, jadi rumus kasSeharusnya mengurangkannya dari omzet.
            (SELECT COALESCE(SUM(CASE WHEN sl.pay_method='tunai' AND sl.total > sl.cash_in
                   AND sl.customer_id IS NOT NULL
                   AND sl.customer_name <> 'Pelanggan Umum'
                  THEN sl.total - sl.cash_in ELSE 0 END),0)
               FROM sales sl WHERE sl.shift_id = s.id) AS hutang_baru,
            -- Piutang TERBAYAR ke laci shift ini (butir 7-8 Z-report "credit
            -- payments collected"): baris BARU membawa shift_id + cashier
            -- (Paket A 2026-10-20) sehingga atribusinya eksak. Baris LAMA
            -- (shift_id NULL + cashier '') tetap dibaca lewat periode waktu
            -- opened_at..closed_at (format datetime('now') sama, perbandingan
            -- string valid) — sengaja tanpa backfill. Pembayaran baru di luar
            -- shift punya cashier non-kosong, jadi TIDAK jatuh ke shift lain.
            -- Masuk rumus kasSeharusnya (uang fisik masuk laci).
            (SELECT COALESCE(SUM(d.amount),0) FROM customer_debts d
              WHERE d.type = 'payment'
                AND (
                  d.shift_id = s.id
                  OR (d.shift_id IS NULL AND d.cashier = ''
                      AND datetime(d.created_at) >= datetime(s.opened_at)
                      AND (s.closed_at IS NULL OR datetime(d.created_at) <= datetime(s.closed_at)))
                )) AS piutang_bayar,
            -- Pesanan jasa (butir ROADMAP 1.6.6, 2026-10-19): uang pesanan
            -- yang MASUK ke laci shift ini = Σ dp + pelunasan − refund
            -- (refund = uang KELUAR, dikurangkan lewat nilai negatif).
            (SELECT COALESCE(SUM(CASE WHEN op.kind='refund' THEN -op.amount ELSE op.amount END),0)
               FROM order_payments op WHERE op.shift_id = s.id) AS order_masuk_total,
            -- Omzet nota pesanan (nota yang lahir dari take — orders.sale_id):
            -- DIKELUARKAN dari hitungan laci karena uangnya sudah tercatat di
            -- order_masuk_total — tanpa ini uang pesanan terhitung dobel.
            (SELECT COALESCE(SUM(sl.total),0) FROM sales sl
               WHERE sl.shift_id = s.id
                 AND EXISTS (SELECT 1 FROM orders o WHERE o.sale_id = sl.id)) AS order_omzet_total
       FROM shifts s
       ${klausul}
      ORDER BY s.id DESC
      LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return c.json({ data, total });
});

app.post('/api/shifts/open', wajibIzin('shift.buka'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Kasir wajib membuka shift atas nama akunnya sendiri; owner bebas memakai
  // nama kasir lain (kompatibilitas operasional & test).
  const cashier = cashierEfektif(c, body?.cashier);
  try {
    const info = db.prepare(
      `INSERT INTO shifts (modal_awal, cashier, status) VALUES (?, ?, 'open') RETURNING *`,
    ).get(Number(body?.modal_awal ?? 0), cashier);
    return c.json({ data: info }, 201);
  } catch {
    return c.json({ error: `kasir "${cashier}" masih punya shift terbuka, tutup dulu` }, 409);
  }
});

app.post('/api/shifts/:id/close', wajibIzin('shift.tutup'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = Number(c.req.param('id'));
  // Tanpa shift.kelola, kasir hanya boleh menutup shift ATAS NAMA sendiri
  // (banding display name akun vs kolom cashier). `shift.kelola` = wewenang
  // menutup shift kasir lain (owner default punya).
  const u = c.get('user') as Pengguna;
  if (!bolehIzin(u, 'shift.kelola')) {
    const milik = db.prepare('SELECT cashier FROM shifts WHERE id = ?').get(id) as
      { cashier: string } | undefined;
    if (!milik) return c.json({ error: 'shift tidak ditemukan / sudah tutup' }, 404);
    if (milik.cashier !== u.name) {
      return c.json({ error: 'ini shift kasir lain — butuh izin shift.kelola' }, 403);
    }
  }
  const info = db.prepare(
    `UPDATE shifts SET closed_at=datetime('now'), modal_akhir=?, status='closed'
     WHERE id=? AND status='open' RETURNING *`,
  ).get(Number(body?.modal_akhir ?? 0), id);
  if (!info) return c.json({ error: 'shift tidak ditemukan / sudah tutup' }, 404);
  return c.json({ data: info });
});

// ---------- penjualan ----------
// Body: { id?, shift_id, items: [{product_id?, name?, qty, price?, unit?}], pay_method, discount?, cash_in?, cashier? }
// - id uuid dari client: kirim ulang dengan id sama = tidak dobel (idempotent, penting untuk retry offline)
// - price boleh diisi client untuk produk price_dynamic (jasa/cetak/desain); server validasi stok & snapshot nama
// - unit = satuan jual TERPILIH (opsional, default = satuan dasar produk).
//   Server yang menentukan harga & faktor stoknya — harga produk non-dinamis
//   TIDAK boleh ditentukan dari client (lihat cabang `unitJual !== p.unit`).
const insertSale = transaksi((sale: {
  id: string; shift_id: number | null; pay_method: string; discount: number;
  cash_in: number; cashier: string;
  // Pelanggan terpilih di header POS (revisi pemilik 2026-10-04); absen/null =
  // transaksi tanpa kontak (invoice jatuh ke "Pelanggan Umum" di client).
  customer_id?: number | null;
  // Catatan TRANSAKSI per nota (2026-10-10, kolom "Catatan transaksi" modal
  // bayar) — beda dengan items[].note (per baris). Opsional seperti
  // customer_id: absen/'' = tanpa catatan, payload lama tetap sah.
  note?: string;
  items: { product_id?: number; name?: string; qty: number; price?: number; unit?: string; discount?: number; note?: string }[];
  /** Split payment 2+ metode (butir ROADMAP 1.6.5): `amount` = uang
   *  DISERAHKAN per metode — untuk tunai = uang fisik diterima (server yang
   *  mengurangi kembalian). Absen = nota satu metode (perilaku lama: kolom
   *  `pay_method` + `cash_in`). Lihat blok validasi di bawah. */
  payments?: { method?: string; amount?: number }[];
  /** Izin POS akun (B4). Semua opsional supaya pemanggil internal (take
   *  pesanan) bisa menegaskan izin penuh; route penjualan selalu mengisinya. */
  bolehHarga?: boolean;
  bolehDiskon?: boolean;
  bolehManual?: boolean;
  bolehHutang?: boolean;
  /** `true` untuk kasir: uang tunai kurang WAJIB punya pelanggan valid +
   *  izin hutang.catat. Owner `false` = perilaku lama (bebas, test lama). */
  wajibLunas?: boolean;
}) => {
  const dup = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
  if (dup) return { row: dup, duplicate: true };

  // Pelanggan di-SNAPSHOT saat jual: `customer_name` ikut tersimpan supaya
  // cetak ulang struk & invoice A4 tetap menampilkan data pelanggan walau
  // kontaknya kelak diedit/dihapus (pola sama dengan sale_items.name/cost).
  // id tak dikenal = 400, bukan diabaikan diam-diam — POS selalu memilih dari
  // master, jadi id basi berarti payload yang korup (kontrak: unit/produk tak
  // dikenal juga 400).
  let customerId: number | null = null;
  let customerName = '';
  if (sale.customer_id !== undefined && sale.customer_id !== null) {
    const cid = Number(sale.customer_id);
    if (!Number.isInteger(cid)) throw new Error('customer_id harus integer');
    const cust = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(cid) as { id: number; name: string } | undefined;
    if (!cust) throw new Error(`pelanggan tidak dikenal: ${cid}`);
    customerId = cust.id;
    customerName = cust.name;
  }

  // Catatan TRANSAKSI per nota (2026-10-10, kolom "Catatan transaksi" modal
  // bayar): di-TRIM + snapshot seperti customer_name — dibaca ulang Riwayat/
  // struk apa adanya. Batas 200 SAMA dengan catatan baris (satu aturan
  // panjang catatan di API). Absen/'' = tanpa catatan.
  const saleNote = String(sale.note ?? '').trim();
  if (saleNote.length > 200) {
    throw new Error('catatan transaksi terlalu panjang (maks 200 karakter)');
  }

  // Dibaca sekali per penjualan, langsung dari DB: aturan stok tidak boleh
  // berdasarkan cache client, karena client bisa offline dan berbeda pendapat
  // dengan server tentang boleh-tidaknya stok minus. Aturan kadaluarsa dibaca
  // dengan cara yang sama.
  const bolehMinus = settingBool(K_STOK_MINUS, false);
  const tolakKadaluarsa = settingBool(K_TOLAK_KADALUARSA, false);
  // Satu aturan hari UTC (sama dengan history/reports/dashboard): hari
  // kadaluarsa = expiry_date yang sama dengan hari ini MASIH sah, hanya
  // tanggal yang sudah lewat yang ditolak.
  const hariIniUtc = new Date().toISOString().slice(0, 10);

  let subtotal = 0;
  let totalDiscBaris = 0;
  const lines: { product_id: number | null; name: string; qty: number; price: number; amount: number; discount: number; cost: number; unit: string; note: string }[] = [];
  for (const it of sale.items) {
    const qty = Number(it.qty);
    if (!(qty > 0)) throw new Error('qty harus > 0');
    let name = it.name ?? '';
    let price = Number(it.price ?? NaN);
    let pid: number | null = it.product_id ?? null;
    let unitJual = '';
    let cost = 0;
    if (pid) {
      const p = db.prepare(
        `SELECT p.*, c.track_stock FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.is_active=1`,
      ).get(pid) as {
        id: number; name: string; unit: string; price: number; price_dynamic: number; stock: number;
        track_stock: number; avg_cost: number; expiry_date: string | null;
      } | undefined;
      if (!p) throw new Error(`produk #${pid} tidak aktif/tidak ada`);
      name = p.name;
      // Tolak jual kadaluarsa (pengaturan, default MATI): pantau per baris,
      // bukan per transaksi — satu keranjang campuran (snack basi + minuman
      // segar) tetap ditolak seluruhnya dengan nama barang yang jelas. Item
      // manual (pid=null) tidak punya tanggal, jadi tidak kena cek ini.
      if (tolakKadaluarsa && p.expiry_date && p.expiry_date < hariIniUtc) {
        throw new Error(`barang kadaluarsa: ${p.name} (berakhir ${p.expiry_date})`);
      }
      // Resolusi SATUAN & HARGA sepenuhnya di server. Client hanya mengirim
      // unit terpilih + (untuk produk dinamis) harga; harga produk non-dinamis
      // tidak boleh ditentukan dari client.
      const unitMinta = String(it.unit ?? '').trim();
      unitJual = unitMinta || p.unit;
      let factor = 1;
      if (unitJual !== p.unit) {
        const ru = db.prepare('SELECT factor, price FROM product_units WHERE product_id=? AND unit=?')
          .get(pid, unitJual) as { factor: number; price: number | null } | undefined;
        if (!ru) throw new Error(`satuan tidak dijual untuk ${p.name}: ${unitJual}`);
        factor = ru.factor;
        const hargaMasterUnit = Math.round(ru.price ?? Math.round(p.price * factor));
        if (p.price_dynamic) {
          if (!(price >= 0)) {
            // Tanpa izin ubah harga, master price dipakai — bukan error:
            // klien restricted memang tidak mengirim harga (field mati).
            if (sale.bolehHarga) throw new Error(`harga dinamis wajib diisi untuk ${p.name}`);
            price = hargaMasterUnit;
          } else if (!sale.bolehHarga && Math.round(price) !== hargaMasterUnit) {
            throw new IzinError(`izin pos.harga tidak diberikan — harga ${p.name} tidak boleh diubah`);
          }
        } else {
          // price di baris satuan = harga grosir eksplisit; NULL = ikut rumus.
          price = ru.price ?? Math.round(p.price * factor);
        }
      } else if (p.price_dynamic) {
        if (!(price >= 0)) {
          if (sale.bolehHarga) throw new Error(`harga dinamis wajib diisi untuk ${p.name}`);
          price = p.price;
        } else if (!sale.bolehHarga && Math.round(price) !== p.price) {
          throw new IzinError(`izin pos.harga tidak diberikan — harga ${p.name} tidak boleh diubah`);
        }
      } else {
        price = p.price; // harga dikunci dari master, client tidak boleh mengubah
      }
      // HPP per SATUAN JUAL: stok dikeluarkan dalam satuan dasar (qty*factor),
      // jadi HPP baris juga harus dikalikan faktor yang sama.
      cost = Math.round(p.avg_cost * factor);
      const keluar = qty * factor;
      if (p.track_stock) {
        // SATU-SATUNYA pintu "stok kurang" ada di sini. Dilewati bila pengaturan
        // allow_negative_stock aktif: stok dibiarkan menembus 0 (minus) supaya
        // transaksi di meja kasir tidak macet karena selisih hitungan fisik.
        // stock_moves tetap dicatat minus, jadi riwayat tetap jujur.
        if (!bolehMinus && p.stock < keluar) {
          const butuh = Number.isInteger(keluar) ? keluar : Math.round(keluar * 1000) / 1000;
          throw new Error(`stok kurang: ${p.name} (butuh ${butuh} ${unitJual}, sisa ${p.stock})`);
        }
        db.prepare(
          `UPDATE products SET stock = stock - ?,
             version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
           WHERE id = ?`,
        ).run(keluar, pid);
        // stock_moves.qty selalu SATUAN DASAR (riwayat mutasi & opname tetap sebanding).
        db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, ref_id, cashier) VALUES (?, ?, 'sale', ?, ?)`)
          .run(pid, -keluar, sale.id, sale.cashier);
      }
    } else {
      // item manual (misal jasa dadakan): nama + harga wajib. Izin B4
      // `pos.item_manual` ditegakkan server, bukan hanya disembunyikan di UI.
      if (!sale.bolehManual) {
        throw new IzinError('izin pos.item_manual tidak diberikan — item manual tidak bisa ditambahkan');
      }
      if (!name || !(price >= 0)) throw new Error('item manual wajib ada name + price');
      unitJual = '';
    }
    const amount = Math.round(qty * price);
    // Diskon PER BARIS: rupiah mutlak (konversi % -> Rp dilakukan client, server
    // tidak perlu tipe). Dibatasi <= jumlah baris supaya tidak bisa membuat
    // total negatif lewat jalan belakang — batas total masih dicek satu kali lagi
    // di bawah untuk kasus diskon transaksi.
    const discMentah = Number(it.discount ?? 0);
    if (!Number.isFinite(discMentah) || discMentah < 0) {
      throw new Error(`diskon baris tidak valid untuk ${name} (harus angka >= 0)`);
    }
    const discBaris = Math.round(discMentah);
    if (discBaris > 0 && !sale.bolehDiskon) {
      throw new IzinError('izin pos.diskon tidak diberikan — diskon baris tidak boleh diisi');
    }
    if (discBaris > amount) {
      throw new Error(`diskon baris melebihi jumlah baris: ${name} (${discBaris} > ${amount})`);
    }
    // Catatan per baris (POS: input di bawah baris produk use_note=1).
    // Di-snapshot seperti discount — riwayat & struk ulang tidak ikut berubah.
    // Server TIDAK mengecek flag use_note produk: inputnya memang hanya dirender
    // untuk produk yang menyala, tapi payload sah untuk item apa pun (item
    // manual / outbox lama) tidak boleh ditolak karena alasan kosmetik.
    const note = String(it.note ?? '').trim();
    if (note.length > 200) {
      throw new Error(`catatan baris terlalu panjang: ${name} (maks 200 karakter)`);
    }
    subtotal += amount;
    totalDiscBaris += discBaris;
    // HPP disnapshot SEKARANG (avg_cost saat jual), bukan dibaca ulang saat
    // laporan di-query — rata-rata modal berubah tiap restock, kalau dibaca ulang
    // maka laba hari lalu ikut berubah setelah pembelian hari ini.
    // Item manual (pid=null) tidak punya persediaan -> HPP 0.
    lines.push({ product_id: pid, name, qty, price, amount, discount: discBaris, cost, unit: unitJual, note });
  }
  // Nilai BERSIH = kotor - diskon baris - diskon transaksi. `subtotal` yang
  // disimpan ke sales tetap kotor, supaya subtotal - total = seluruh diskon.
  if (sale.discount > 0 && !sale.bolehDiskon) {
    throw new IzinError('izin pos.diskon tidak diberikan — diskon transaksi tidak boleh diisi');
  }
  const total = subtotal - totalDiscBaris - Math.max(0, sale.discount);
  if (total < 0) throw new Error('diskon melebihi subtotal');

  // ---------- pembayaran per metode (split 2+ metode, ROADMAP 1.6.5) ----------
  // `payments[]` OPSIONAL. Bila dikirim, `cash_in` dari body DIABAIKAN —
  // server menjumlahkan sendiri (cash_in = Σ amount, change = Σ − total).
  // Aturan (kontrak §3): metode wajib tunai|qris|transfer tanpa duplikat;
  // nominal bulat >= 0; Σ amount >= total (split WAJIB menutup — uang kurang
  // adalah jalur HUTANG satu metode); porsi NON-TUNAI <= total (kembalian
  // hanya boleh keluar dari tunai — tanpa baris tunai Σ wajib pas).
  // Hasil = baris `sale_payments` ATRIBUSI: Σ amount per nota SELALU = total
  // (tunai = uang diserahkan − kembalian). Tabel ini satu-satunya sumber
  // angka per metode: laporan byMethod & agregat tunai/qris/transfer shift
  // membacanya (dengan fallback (pay_method, total) untuk nota lama — jangan
  // hitung ulang dari `pay_method` tunggal di tempat lain).
  let payMethod = sale.pay_method;
  let cashIn = Number(sale.cash_in ?? 0);
  let change: number;
  const pecahan: { method: string; amount: number }[] = [];
  if (sale.payments !== undefined) {
    const METODE = ['tunai', 'qris', 'transfer'];
    if (!Array.isArray(sale.payments) || sale.payments.length === 0 || sale.payments.length > METODE.length) {
      throw new Error('payments harus array 1..3 metode');
    }
    const dipakai = new Set<string>();
    let jumlah = 0;
    let nonTunai = 0;
    for (const p of sale.payments) {
      const m = String(p?.method ?? '');
      if (!METODE.includes(m)) throw new Error(`metode pembayaran tidak dikenal: ${m || '(kosong)'}`);
      if (dipakai.has(m)) throw new Error(`metode pembayaran duplikat: ${m}`);
      dipakai.add(m);
      const a = Number(p?.amount ?? 0);
      if (!Number.isFinite(a) || a < 0) {
        throw new Error(`nominal pembayaran tidak valid untuk ${m} (harus angka >= 0)`);
      }
      jumlah += Math.round(a);
      if (m !== 'tunai') nonTunai += Math.round(a);
    }
    if (nonTunai > total) {
      throw new Error(
        `pembayaran non-tunai melebihi total nota (kembalian hanya dari tunai; non-tunai ${nonTunai} > total ${total})`,
      );
    }
    if (jumlah < total) {
      throw new Error(
        `split payment tidak menutup total (kurang ${total - jumlah} — uang kurang hanya jalur hutang satu metode tunai)`,
      );
    }
    change = jumlah - total;
    cashIn = jumlah;
    // Porsi tunai yang menempel ke total = total − Σ non-tunai (sisanya
    // kembalian uang fisik — konsisten dengan change = Σ − total di atas).
    const tunaiTerapkan = total - nonTunai;
    for (const p of sale.payments) {
      const m = String(p.method);
      const amount = m === 'tunai' ? tunaiTerapkan : Math.round(Number(p.amount ?? 0));
      if (amount > 0) pecahan.push({ method: m, amount });
    }
    payMethod = pecahan.length > 1 ? 'campuran' : (pecahan[0]?.method ?? payMethod);
  } else {
    change = Math.max(0, cashIn - total);
    // Kasir (B4): uang TUNAI kurang = hutang, wajib pelanggan valid + izin
    // hutang.catat. Owner tidak diperketat (perilaku lama dipertahankan untuk
    // operasional & test lama). Split payment sudah diwajibkan menutup total.
    if (sale.wajibLunas && payMethod === 'tunai' && cashIn < total) {
      if (!customerId || customerName === 'Pelanggan Umum') {
        throw new Error('uang diterima kurang dari total — pilih pelanggan untuk mencatat hutang');
      }
      if (!sale.bolehHutang) {
        throw new IzinError('izin hutang.catat tidak diberikan — uang kurang tidak bisa dicatat sebagai hutang');
      }
    }
    // Nota satu metode — termasuk HUTANG: atribusi PENUH ke metodenya
    // (perilaku lama; agregat tunai/qris/transfer & byMethod tidak berubah,
    // porsi belum dibayar tampil terpisah sebagai sisa_hutang/hutang_baru).
    if (total > 0) pecahan.push({ method: payMethod, amount: total });
  }
  // Nomor invoice = kombinasi TAHUN + BULAN + TANGGAL + nomor urut (revisi
  // pemilik 2026-10-04, sebelumnya `YYMM-NNNNNN` urut per bulan):
  // `YYMMDD-NNNNNN` — mis. `261004-000001`, urut HARIAN UTC (satu aturan waktu
  // dengan created_at default). Ambil lewat CAST per urutan angka — bukan
  // ORDER BY teks ('000010' < '000009' secara lexikal, nomor bisa mundur) dan
  // bukan COUNT (bisa melompat kalau ada celah). Dihitung SETELAH cek duplikat
  // di atas, jadi retry idempotent tidak pernah membakar nomor.
  // Substr offset = panjang prefix (6 digit) + tanda '-' = posisi 8 (SQLite
  // 1-based) / slice(7) di JS — bukan seperti format lama yang salah satu.
  const now = new Date();
  const ymd = `${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const lastInv = db.prepare(
    `SELECT invoice_no FROM sales
      WHERE invoice_no LIKE ? || '-%'
      ORDER BY CAST(substr(invoice_no, 8) AS INTEGER) DESC
      LIMIT 1`,
  ).get(ymd) as { invoice_no: string } | undefined;
  const urut = lastInv ? Number(lastInv.invoice_no.slice(7)) + 1 : 1;
  const invoiceNo = `${ymd}-${String(urut).padStart(6, '0')}`;
  const row = db.prepare(
    `INSERT INTO sales (id, shift_id, invoice_no, pay_method, subtotal, discount, total, cash_in, change, cashier, customer_id, customer_name, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(sale.id, sale.shift_id, invoiceNo, payMethod, subtotal, Math.max(0, sale.discount), total, cashIn, change, sale.cashier, customerId, customerName, saleNote);
  const insItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, name, qty, price, amount, discount, cost, unit, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const l of lines) {
    insItem.run(sale.id, l.product_id, l.name, l.qty, l.price, l.amount, l.discount, l.cost, l.unit, l.note);
  }
  // Rincian pembayaran per metode (split 1.6.5) — SATU transaksi dengan nota
  // (`transaksi` helper), jadi retry idempotent (guard duplikat di atas) dan
  // rollback tidak pernah meninggalkan nota tanpa barisnya / sebaliknya.
  const insBayar = db.prepare('INSERT INTO sale_payments (sale_id, method, amount) VALUES (?, ?, ?)');
  for (const p of pecahan) insBayar.run(sale.id, p.method, p.amount);
  return { row, duplicate: false as const, lines };
});

app.post('/api/sales', wajibIzin('pos.jual'), async (c) => {
  try {
    const body = await c.req.json();
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return c.json({ error: 'items kosong' }, 400);
    }
    const u = c.get('user') as Pengguna;
    // Kasir hanya boleh menulis ke shift miliknya; owner bebas. `cashier`
    // kasir dipaksa nama akun — body tidak bisa mengaku kasir lain.
    const sh = aturShift(c, body.shift_id, body.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    // Divalidasi di sini, bukan di dalam transaksi: `Number('abc')` = NaN, dan
    // NaN lolos cek `total < 0` — penjualan akan tersimpan dengan total NaN.
    const discTransaksi = Number(body.discount ?? 0);
    if (!Number.isFinite(discTransaksi) || discTransaksi < 0) {
      return c.json({ error: 'discount harus angka >= 0' }, 400);
    }
    const { row, duplicate, lines } = insertSale({
      id: body.id ?? randomUUID(),
      shift_id: sh.shift_id,
      pay_method: body.pay_method ?? 'tunai',
      discount: discTransaksi,
      cash_in: Number(body.cash_in ?? 0),
      cashier: sh.cashier,
      // OPSIONAL: client lama / outbox yang belum ter-update boleh tidak
      // mengirim — transaksi tanpa kontak tetap sah (customer_id NULL).
      customer_id: body.customer_id ?? null,
      // Catatan transaksi per nota (2026-10-10) — opsional, '' = tanpa.
      note: body.note ?? '',
      items: body.items,
      // Split payment (1.6.5) — opsional; absen = perilaku lama. Dikirim apa
      // adanya, validasi bentuk di insertSale (di dalam transaction).
      payments: body.payments,
      // Izin POS granular (B4) — ditegakkan di dalam transaksi supaya harga
      // non-dinamis tetap dikunci server, bukan hanya oleh UI.
      bolehHarga: bolehIzin(u, 'pos.harga'),
      bolehDiskon: bolehIzin(u, 'pos.diskon'),
      bolehManual: bolehIzin(u, 'pos.item_manual'),
      bolehHutang: bolehIzin(u, 'hutang.catat'),
      wajibLunas: u.role !== 'owner',
    });
    const items = lines ?? db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all((row as { id: string }).id);
    return c.json({ data: { sale: row, items, duplicate: duplicate ?? true } }, duplicate ? 200 : 201);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'gagal simpan penjualan' },
      e instanceof IzinError ? 403 : 400,
    );
  }
});

// ---------- riwayat transaksi (menu "Riwayat transaksi") ----------
// Filter hari memakai `date(created_at) = date(?)` yang SAMA dengan
// /api/reports/daily, dan defaultnya juga hari UTC yang sama
// (`new Date().toISOString().slice(0,10)`), supaya jumlah baris di halaman
// Riwayat dan angka `sales.n` di Laporan tidak mungkin berbeda.
const RE_TGL = /^\d{4}-\d{2}-\d{2}$/;

type Hari = { ok: true; hari: string; limit: number; offset: number } | { ok: false; error: string };

function bacaHari(query: (k: string) => string | undefined): Hari {
  const hari = query('date') ?? new Date().toISOString().slice(0, 10);
  // Tanggal rusak harus 400, bukan diam-diam: `date('rabu')` = NULL di SQLite
  // dan `date('2026-02-31')` ikut NULL — hasilnya halaman kosong yang seolah
  // hari itu memang tidak ada transaksi. Round-trip memakai pola yang sama
  // dengan validasi `expiry_date` (lihat POST /api/products).
  const d = new Date(`${hari}T00:00:00Z`);
  if (!RE_TGL.test(hari) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== hari) {
    return { ok: false, error: 'date harus format YYYY-MM-DD' };
  }
  const limit = Math.min(Math.max(Number(query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(query('offset') ?? 0) || 0, 0);
  return { ok: true, hari, limit, offset };
}

app.get('/api/sales', wajibIzin('riwayat.lihat'), (c) => {
  const h = bacaHari((k) => c.req.query(k));
  if (!h.ok) return c.json({ error: h.error }, 400);
  // `customer_id` (2026-10-25, riwayat per pelanggan di halaman Pelanggan):
  // filter nota milik satu pelanggan. Bila dikirim TANPA `date`, yang diminta
  // adalah SELURUH riwayat pelanggan itu — bukan diam-diam hari ini saja
  // (`bacaHari` mengisi hari ini saat `date` absen, jadi filter tanggal
  // dipasang manual di bawah). `date` + `customer_id` = nota pelanggan pada
  // hari itu. Nilai bukan integer -> 400 (jangan biarkan SQLite menganggap
  // "abc" = 0 lalu membalas daftar kosong palsu).
  const customerRaw = c.req.query('customer_id');
  let customerId: number | null = null;
  if (customerRaw !== undefined && customerRaw !== '') {
    const n = Number(customerRaw);
    if (!Number.isInteger(n) || n <= 0) {
      return c.json({ error: 'customer_id harus integer' }, 400);
    }
    customerId = n;
  }
  const pakaiTanggal = c.req.query('date') !== undefined || customerId === null;
  // `riwayat.semua` = boleh melihat nota semua kasir. Tanpa izin itu (mis.
  // kasir ketat) daftar dibatasi ke nota atas nama akun sendiri. Filter
  // diterapkan di SQL, bukan setelah paginasi — `total` ikut benar.
  const u = c.get('user') as Pengguna;
  const semua = bolehIzin(u, 'riwayat.semua');
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (pakaiTanggal) {
    where.push('date(s.created_at)=date(?)');
    args.push(h.hari);
  }
  if (!semua) {
    where.push('s.cashier = ?');
    args.push(u.name);
  }
  if (customerId !== null) {
    where.push('s.customer_id = ?');
    args.push(customerId);
  }
  const klausa = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sales s ${klausa}`)
    .get(...args) as { n: number }).n;
  // `n_items` dihitung per baris lewat subquery: daftar riwayat hanya perlu
  // TAHU jumlah item ("3 item") — isi barisnya diambil saat dibuka lewat
  // GET /api/sales/:id, jadi satu hari ratusan nota tidak ditarik sekaligus.
  // `sisa_hutang` (putaran 13, 2026-10-06 — penanda transaksi HUTANG di
  // halaman Riwayat): NOTA INI berhutang, dihitung dari snapshot nota:
  // tunai + total > uang diterima + pelanggan valid (bukan bawaan "Pelanggan
  // Umum") — kondisi PERSIS syarat catat-hutang otomatis di POS, jadi
  // angkanya setara dengan charge yang dikirim ke /api/customer-debts.
  // Sisa aktual ledger BISA berubah (dibayar/dihapus di halaman Hutang) —
  // penanda di sini sengaja menunjuk KEJADIAN saat nota, bukan saldo live.
  // `n_retur`/`retur_total` (2026-10-18, penanda RETUR di halaman Riwayat):
  // jumlah baris retur + uang kembali yang mengattribusi nota ini lewat
  // `returns.sale_id` (indeks `idx_returns_sale`). Hanya retur DARI nota yang
  // terhitung — retur manual (`sale_id` NULL, tanpa nota) memang tidak
  // mengattribusi nota mana pun. Dihitung saat baca (bukan kolom tersimpan):
  // baris retur bisa DIBATALKAN (DELETE /api/returns/:id = salah ketik), jadi
  // penanda ikut hilang persis seperti hutang yang dibayar.
  const data = db.prepare(
    `SELECT s.*,
            CASE WHEN s.pay_method='tunai' AND s.total > s.cash_in
                  AND s.customer_id IS NOT NULL
                  AND s.customer_name <> 'Pelanggan Umum'
                 THEN s.total - s.cash_in
                 -- (1.6.6) Nota pesanan selalu cash_in = total → CASE di atas
                 -- sunyi; sisa hutangnya dibaca dari penanda orders.hutang_sisa.
                 ELSE COALESCE((SELECT o.hutang_sisa FROM orders o WHERE o.sale_id = s.id), 0) END AS sisa_hutang,
            (SELECT o.order_no FROM orders o WHERE o.sale_id = s.id) AS order_no,
            (SELECT COUNT(*) FROM returns r WHERE r.sale_id = s.id) AS n_retur,
            (SELECT COALESCE(SUM(r.total),0) FROM returns r WHERE r.sale_id = s.id) AS retur_total,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS n_items,
            -- Metode pembayaran nota (split 1.6.5): gabungan nama metode
            -- ber-urutan baris sale_payments ("tunai,qris"), NULL untuk nota
            -- lama tanpa baris (klien jatuh ke pay_method tunggal). Dipakai
            -- chip "Jenis" Riwayat menampilkan "Tunai + QRIS" pada campuran.
            (SELECT GROUP_CONCAT(x.m) FROM (
               SELECT sp.method AS m FROM sale_payments sp
                WHERE sp.sale_id = s.id ORDER BY sp.id) x) AS pay_methods
       FROM sales s
      ${klausa}
      ORDER BY s.created_at DESC, s.rowid DESC
      LIMIT ? OFFSET ?`,
  ).all(...args, h.limit, h.offset);
  return c.json({ data, total });
});

app.get('/api/sales/:id', wajibIzin('riwayat.lihat'), (c) => {
  // `sisa_hutang` = penanda "nota ini berhutang" — CASE yang SAMA dengan
  // GET /api/sales (putaran 13) + fallback penanda pesanan (1.6.6); `n_retur`/
  // `retur_total` = penanda retur (2026-10-18) — subquery yang SAMA pula;
  // lihat komentar di sana. `order_no` = nomor pesanan bila nota ini lahir
  // dari take pesanan (dipakai struk ulang/Riwayat menampilkan asalnya).
  // `customer_address`/`customer_phone` (2026-10-20) = data KONTAK LIVE lewat
  // LEFT JOIN, additive: dipakai opsi "Detail pelanggan di struk thermal" saat
  // cetak ulang dari Riwayat. `customer_name` tetap SNAPSHOT kolom sales (nama
  // saat nota dibuat) — alamat/telepon boleh berubah, dan nota lama tanpa
  // pelanggan tetap NULL. Master pelanggan TIDAK punya email (hanya phone +
  // address), jadi jangan menambah alias email di sini.
  const sale = db.prepare(
    `SELECT sales.*,
            c.address AS customer_address,
            c.phone AS customer_phone,
            CASE WHEN pay_method='tunai' AND total > cash_in
                  AND customer_id IS NOT NULL
                  AND customer_name <> 'Pelanggan Umum'
                 THEN total - cash_in
                 ELSE COALESCE((SELECT o.hutang_sisa FROM orders o WHERE o.sale_id = sales.id), 0) END AS sisa_hutang,
            (SELECT o.order_no FROM orders o WHERE o.sale_id = sales.id) AS order_no,
            (SELECT COUNT(*) FROM returns r WHERE r.sale_id = sales.id) AS n_retur,
            (SELECT COALESCE(SUM(r.total),0) FROM returns r WHERE r.sale_id = sales.id) AS retur_total
       FROM sales LEFT JOIN customers c ON c.id = sales.customer_id
      WHERE sales.id=?`,
  ).get(c.req.param('id')) as { cashier?: string } | undefined;
  if (!sale) return c.json({ error: 'tidak ditemukan' }, 404);
  // `riwayat.semua` = boleh membuka nota kasir lain (cetak ulang/invoice).
  // Kasir tanpa izin tetap bisa membuka nota miliknya sendiri.
  const u = c.get('user') as Pengguna;
  if (!bolehIzin(u, 'riwayat.semua') && sale.cashier !== u.name) {
    return c.json({ error: 'nota ini milik kasir lain — butuh izin riwayat.semua' }, 403);
  }
  // base_unit (LEFT JOIN products) ditambahkan 2026-10-01 untuk CETAK ULANG
  // struk dari halaman Riwayat: struk asli hanya mencetak `unit` bila satuan
  // jualnya BUKAN satuan dasar, dan sale_items hanya menyimpan satuan jual —
  // tanpa satuan dasar saat ini, riwayat tidak bisa memutuskan sama persis
  // seperti yang dilakukan POS. Produk terhapus pun tetap ikut (LEFT JOIN).
  // `qty_retur` per baris (2026-10-18): jumlah yang SUDAH diretura untuk baris
  // ini — subquery yang SAMA dengan guard sisa di simpanRetur, satuan jual
  // (return_items.qty seunit dengan sale_items.qty). Dipakai dialog "Buat
  // retur" halaman Riwayat: penanda "sudah retur N · sisa M" + clamp max qty.
  // Retur yang dibatalkan (DELETE) hilang dari penjumlahan.
  const items = db.prepare(
    `SELECT si.*, p.unit AS base_unit, p.sku AS sku,
            (SELECT COALESCE(SUM(ri.qty),0) FROM return_items ri WHERE ri.sale_item_id = si.id) AS qty_retur
       FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id=?`,
  ).all(c.req.param('id'));
  // Rincian pembayaran per metode (split 1.6.5) — SATU baris per metode
  // (Σ = sales.total); [] untuk nota lama tanpa baris (klien jatuh ke
  // `pay_method` tunggal + `cash_in`). Dipakai Riwayat (kartu Pembayaran),
  // cetak ulang struk, dan invoice A4 supaya nota campuran tampil per metode.
  const payments = db.prepare(
    'SELECT method, amount FROM sale_payments WHERE sale_id=? ORDER BY id',
  ).all(c.req.param('id'));
  return c.json({ data: { sale, items, payments } });
});

// ---------- pesanan jasa + DP/status (butir ROADMAP 1.6.6, ACC 19 Okt 2026) ----------
// Halaman #/orders. Lima keputusan pemilik (dikonfirmasi 2026-10-19) yang
// membentuk kontrak ini:
//   1. Omzet DIKAKUI SAAT DIAMBIL — nota penjualan penuh (insertSale, item
//      teks bebas tanpa potong stok) dibuat saat `take`; DP = uang muka.
//   2. Item pesanan = teks bebas — stok tidak pernah disentuh di jalur ini.
//   3. Sisa yang belum dibayar saat diambil dicatat otomatis ke ledger
//      Hutang pelanggan (customer_debts charge) + penanda orders.hutang_sisa.
//   4. Pembayaran satu metode per baris: tunai|qris|transfer.
//   5. Nota pesanan dicetak thermal oleh klien.
// Uang pesanan SATU ledger: order_payments (dp/pelunasan/refund) — agregat
// `order_masuk_total` MENAMBAH laci shift penerima, dan nota pesanan
// DIKELUARKAN dari hitungan laci lewat `order_omzet_total` (uangnya sudah
// dicatat di pembayaran; rumusnya di kasSeharusnya() shift-tutup.ts). Input
// `payments[]` nota penjualan dibangun dari aggregat pembayaran per metode —
// Σ baris SELALU = total nota (aturan atribusi split 1.6.5).

/** Nomor pesanan `ORD-YYMMDD-NNN` — urut HARIAN UTC, pola invoice_no:
 *  MAX lewat CAST(substr(order_no,12)) + pola LIKE (BUKAN COUNT/teks),
 *  dicek dari DB supaya celah nomor tidak dipakai ulang. */
function nomorOrder(): string {
  const ymd = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
  const last = db
    .prepare(
      `SELECT order_no AS n FROM orders
        WHERE order_no LIKE 'ORD-' || ? || '-%'
        ORDER BY CAST(substr(order_no, 12) AS INTEGER) DESC LIMIT 1`,
    )
    .get(ymd) as { n: string } | undefined;
  const urut = last ? Number(last.n.slice(11)) + 1 : 1;
  return `ORD-${ymd}-${String(urut).padStart(3, '0')}`;
}

/** Subquery bobot pesanan yang dipakai berulang (list & detail): `dibayar` =
 *  NET uang diterima kasir (DP + pelunasan − refund; refund hanya muncul di
 *  pesanan batal), `refund` = bagian refund saja, `sisa` = total − dibayar
 *  (0 untuk batal — pesanan yang dibatalkan tidak menagih apa pun). */
const SQL_ORDER_UANG = `
  (SELECT COALESCE(SUM(CASE WHEN op.kind='refund' THEN -op.amount ELSE op.amount END),0)
     FROM order_payments op WHERE op.order_id = o.id) AS dibayar,
  (SELECT COALESCE(SUM(CASE WHEN op.kind='refund' THEN op.amount ELSE 0 END),0)
     FROM order_payments op WHERE op.order_id = o.id) AS refund_total,
  CASE WHEN o.status = 'batal' THEN 0
       ELSE MAX(0, o.total -
         (SELECT COALESCE(SUM(CASE WHEN op.kind='refund' THEN -op.amount ELSE op.amount END),0)
            FROM order_payments op WHERE op.order_id = o.id)) END AS sisa,
  (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS n_items`;

app.get('/api/orders', wajibIzin('pesanan.lihat'), (c) => {
  const status = c.req.query('status') ?? 'semua';
  if (!['semua', 'dikerjakan', 'selesai', 'diambil', 'batal'].includes(status)) {
    return c.json({ error: 'status harus dikerjakan|selesai|diambil|batal|semua' }, 400);
  }
  // Cari multi-kata (pola pelanggan/produk): SEMUA kata harus cocok di
  // nomor pesanan / nama pelanggan / nama item — tidak harus di field yang
  // sama. Nama item ikut supaya kasir bisa menemukan pesanan dari isinya
  // (mis. "banner") tanpa hafal nomor.
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const kata = q.split(/\s+/).filter(Boolean);
  const where: string[] = [];
  const params: unknown[] = [];
  if (status !== 'semua') { where.push('o.status = ?'); params.push(status); }
  // Filter riwayat per pelanggan (butir ROADMAP 1.10, ACC 2026-10-25): modal
  // Riwayat di halaman Pelanggan memakai ini untuk menampilkan pesanan jasa
  // yang BELUM diserah (dikerjakan/selesai) — hal yang tidak bisa dilihat
  // dari GET /api/sales?customer_id. `date` sengaja tidak ikut: riwayat
  // pelanggan = seluruh masa, bukan satu hari.
  const cidQ = c.req.query('customer_id');
  if (cidQ !== undefined && cidQ !== '') {
    const cid = Number(cidQ);
    if (!Number.isInteger(cid) || cid <= 0) return c.json({ error: 'customer_id harus integer' }, 400);
    where.push('o.customer_id = ?');
    params.push(cid);
  }
  for (const k of kata) {
    where.push(`(lower(o.order_no) LIKE ? OR lower(o.customer_name) LIKE ?
      OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND lower(oi.name) LIKE ?))`);
    params.push(`%${k}%`, `%${k}%`, `%${k}%`);
  }
  const klausul = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM orders o ${klausul}`).get(...params) as { n: number }).n;
  const data = db.prepare(
    `SELECT o.*, ${SQL_ORDER_UANG}
       FROM orders o ${klausul}
      ORDER BY o.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  // Ringkasan kepala halaman: jumlah per status (chip filter) + piutang
  // pesanan aktif (Σ sisa status dikerjakan/selesai — cermin kartu halaman).
  const ringkas = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN o.status='dikerjakan' THEN 1 ELSE 0 END),0) AS dikerjakan,
       COALESCE(SUM(CASE WHEN o.status='selesai' THEN 1 ELSE 0 END),0) AS selesai,
       COALESCE(SUM(CASE WHEN o.status='diambil' THEN 1 ELSE 0 END),0) AS diambil,
       COALESCE(SUM(CASE WHEN o.status='batal' THEN 1 ELSE 0 END),0) AS batal,
       COALESCE(SUM(CASE WHEN o.status IN ('dikerjakan','selesai')
         THEN MAX(0, o.total - (SELECT COALESCE(SUM(CASE WHEN op.kind='refund' THEN -op.amount ELSE op.amount END),0)
              FROM order_payments op WHERE op.order_id = o.id)) ELSE 0 END),0) AS piutang
     FROM orders o`,
  ).get();
  return c.json({ data, total, ringkas });
});

app.get('/api/orders/:id', wajibIzin('pesanan.lihat'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const order = db.prepare(`SELECT o.*, ${SQL_ORDER_UANG} FROM orders o WHERE o.id = ?`).get(id);
  if (!order) return c.json({ error: 'tidak ditemukan' }, 404);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  const payments = db.prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY id DESC').all(id);
  return c.json({ data: { order, items, payments } });
});

// Buat pesanan baru (status 'dikerjakan'). Pelanggan WAJIB (keputusan
// pemilik: pesanan butuh identitas pengambil); item = teks bebas, harga
// diketik kasir (TIDAK ada resolusi produk/harga master di jalur ini).
app.post('/api/orders', wajibIzin('pesanan.buat'), async (c) => {
  try {
    const body = await c.req.json();
    const customerId = Number(body?.customer_id);
    if (!Number.isInteger(customerId)) return c.json({ error: 'customer_id harus integer' }, 400);
    const cust = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId) as
      { id: number; name: string } | undefined;
    if (!cust) return c.json({ error: `pelanggan tidak dikenal: ${customerId}` }, 400);
    const itemsMentah = Array.isArray(body?.items) ? (body.items as unknown[]) : [];
    if (itemsMentah.length === 0) return c.json({ error: 'pesanan harus punya minimal 1 item' }, 400);
    if (itemsMentah.length > 100) return c.json({ error: 'maksimal 100 item per pesanan' }, 400);
    const note = String(body?.note ?? '').trim();
    if (note.length > 200) return c.json({ error: 'catatan terlalu panjang (maks 200 karakter)' }, 400);
    const items: { name: string; qty: number; price: number; amount: number; note: string }[] = [];
    for (let i = 0; i < itemsMentah.length; i++) {
      const it = itemsMentah[i] as { name?: unknown; qty?: unknown; price?: unknown; note?: unknown };
      const nama = String(it.name ?? '').trim();
      if (!nama) return c.json({ error: `item ${i + 1}: nama wajib diisi` }, 400);
      const qty = Number(it.qty);
      if (!(qty > 0)) return c.json({ error: `item ${i + 1}: qty harus > 0` }, 400);
      const price = Number(it.price);
      if (!Number.isFinite(price) || price < 0) {
        return c.json({ error: `item ${i + 1}: harga harus angka >= 0` }, 400);
      }
      const catatan = String(it.note ?? '').trim();
      if (catatan.length > 200) {
        return c.json({ error: `catatan baris terlalu panjang: ${nama} (maks 200 karakter)` }, 400);
      }
      items.push({ name: nama, qty, price: Math.round(price), amount: Math.round(qty * Math.round(price)), note: catatan });
    }
    const total = items.reduce((a, b) => a + b.amount, 0);
    const cashier = cashierEfektif(c, body?.cashier);
    const row = transaksi(() => {
      const orderNo = nomorOrder();
      const o = db.prepare(
        `INSERT INTO orders (order_no, customer_id, customer_name, status, total, note, cashier)
         VALUES (?, ?, ?, 'dikerjakan', ?, ?, ?) RETURNING *`,
      ).get(orderNo, cust.id, cust.name, total, note, cashier) as { id: number };
      const insItem = db.prepare(
        'INSERT INTO order_items (order_id, name, qty, price, amount, note) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const it of items) insItem.run(o.id, it.name, it.qty, it.price, it.amount, it.note);
      return db.prepare(`SELECT o.*, ${SQL_ORDER_UANG} FROM orders o WHERE o.id = ?`).get(o.id);
    })();
    catatAudit(c, 'create', 'order', (row as { id: number }).id, {
      order_no: (row as { order_no: string }).order_no, total, items: items.length,
    });
    return c.json({ data: { order: row, items } }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan pesanan' }, 400);
  }
});

/** Identitas kasir efektif (Paket B4): owner bebas memakai nama kasir apa pun
 *  (kompatibilitas operasional/test), kasir SELALU terikat `users.name` milik
 *  akunnya — tidak bisa mengaku kasir lain lewat body. */
function cashierEfektif(c: Context, raw: unknown): string {
  const u = c.get('user') as Pengguna;
  if (u.role === 'owner') {
    return String(raw ?? '').trim() || u.name || process.env.CASHIER_DEFAULT || 'kasir';
  }
  return u.name || 'kasir';
}

type HasilShift =
  | { ok: true; shift_id: number | null; cashier: string }
  | { ok: false; status: 400 | 403; error: string };

/** Validasi shift OPSIONAL + identitas kasir dalam SATU tempat (pola
 *  expenses/kas masuk): absen/NULL = dicatat di luar shift; dikirim = harus
 *  ada dan (untuk kasir) HARUS milik akun itu. Owner bebas memilih shift/nama
 *  kasir; kasir tidak pernah bisa menulis ke laci kasir lain. */
function aturShift(c: Context, rawShift: unknown, rawCashier: unknown): HasilShift {
  const u = c.get('user') as Pengguna;
  const cashier = cashierEfektif(c, rawCashier);
  if (rawShift === undefined || rawShift === null || rawShift === '') {
    return { ok: true, shift_id: null, cashier };
  }
  const sid = Number(rawShift);
  if (!Number.isInteger(sid)) return { ok: false, status: 400, error: 'shift_id harus integer' };
  const s = db.prepare('SELECT id, cashier FROM shifts WHERE id = ?').get(sid) as
    { id: number; cashier: string } | undefined;
  if (!s) return { ok: false, status: 400, error: 'shift tidak dikenal' };
  if (u.role !== 'owner' && s.cashier !== u.name) {
    return { ok: false, status: 403, error: 'shift ini milik kasir lain — tidak bisa dipakai akun ini' };
  }
  return { ok: true, shift_id: sid, cashier };
}

const METODE_ORDER = ['tunai', 'qris', 'transfer'];

/** Catat DP (uang muka) — status masih dikerjakan/selesai. Tidak boleh
 *  melebihi sisa (uang lebih tidak ada; pelunasan penuh lewat `take`). */
app.post('/api/orders/:id/payments', wajibIzin('pesanan.bayar'), async (c) => {
  try {
    const body = await c.req.json();
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
    const o = db.prepare(`SELECT o.*, ${SQL_ORDER_UANG} FROM orders o WHERE o.id = ?`).get(id) as
      { id: number; status: string; order_no: string; total: number; sisa: number } | undefined;
    if (!o) return c.json({ error: 'tidak ditemukan' }, 404);
    if (o.status === 'diambil') return c.json({ error: 'pesanan sudah diambil — tidak bisa menerima pembayaran lagi' }, 400);
    if (o.status === 'batal') return c.json({ error: 'pesanan sudah dibatalkan' }, 400);
    const method = String(body?.method ?? '');
    if (!METODE_ORDER.includes(method)) {
      return c.json({ error: `metode pembayaran tidak dikenal: ${method || '(kosong)'}` }, 400);
    }
    const amount = Number(body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return c.json({ error: 'jumlah harus rupiah bulat > 0' }, 400);
    }
    if (amount > o.sisa) {
      return c.json({ error: `melebihi sisa pesanan (sisa ${o.sisa})` }, 400);
    }
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    const row = db.prepare(
      `INSERT INTO order_payments (order_id, kind, method, amount, shift_id, cashier, note)
       VALUES (?, 'dp', ?, ?, ?, ?, ?) RETURNING *`,
    ).get(id, method, amount, sh.shift_id, sh.cashier,
      String(body?.note ?? '').slice(0, 200));
    catatAudit(c, 'update', 'order', id, { kind: 'dp', method, amount });
    const segar = db.prepare(`SELECT o.*, ${SQL_ORDER_UANG} FROM orders o WHERE o.id = ?`).get(id);
    return c.json({ data: { payment: row, order: segar } }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan pembayaran' }, 400);
  }
});

/** Pindah status antar-dikerjakan/selesai (bolak-balik untuk koreksi).
 *  'diambil' hanya lewat POST /:id/take; 'batal' hanya lewat /:id/cancel. */
app.post('/api/orders/:id/status', wajibIzin('pesanan.buat'), async (c) => {
  try {
    const body = await c.req.json();
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
    const target = String(body?.status ?? '');
    if (!['dikerjakan', 'selesai'].includes(target)) {
      return c.json({ error: 'status harus dikerjakan|selesai (diambil lewat Serahkan, batal lewat Batalkan)' }, 400);
    }
    const o = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(id) as
      { id: number; status: string } | undefined;
    if (!o) return c.json({ error: 'tidak ditemukan' }, 404);
    if (o.status === 'diambil') return c.json({ error: 'pesanan sudah diambil' }, 400);
    if (o.status === 'batal') return c.json({ error: 'pesanan sudah dibatalkan' }, 400);
    db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(target, id);
    catatAudit(c, 'update', 'order', id, { status: target });
    const segar = db.prepare(`SELECT o.*, ${SQL_ORDER_UANG} FROM orders o WHERE o.id = ?`).get(id);
    return c.json({ data: segar });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal ubah status' }, 400);
  }
});

/** Serahkan pesanan (AMBIL) — puncak alur 1.6.6. SATU transaction:
 *   1. nota penjualan penuh dibuat lewat insertSale (omzet dikakui di sini;
 *      item teks bebas tanpa potong stok — `lines` manual, cost 0),
 *   2. pelunasan (bila ada) dicatat sebagai order_payment kind='pelunasan',
 *   3. sisa yang belum dibayar dicatat ke ledger Hutang pelanggan,
 *   4. status -> 'diambil' + sale_id + hutang_sisa.
 *  Atribusi nota (sale_payments): pembayaran pesanan diagregat per metode,
 *  sisa hutang menempel ke metode penyerahan (pola nota hutang POS:
 *  diatribusi penuh) — Σ baris = total nota, invarian split 1.6.5 dijaga. */
app.post('/api/orders/:id/take', wajibIzin('pesanan.bayar'), async (c) => {
  try {
    const body = await c.req.json();
    const u = c.get('user') as Pengguna;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
    const o = db.prepare(`SELECT o.*, ${SQL_ORDER_UANG} FROM orders o WHERE o.id = ?`).get(id) as
      { id: number; order_no: string; status: string; total: number; sisa: number; customer_id: number; note: string } | undefined;
    if (!o) return c.json({ error: 'tidak ditemukan' }, 404);
    if (o.status === 'diambil') return c.json({ error: 'pesanan sudah diambil' }, 400);
    if (o.status === 'batal') return c.json({ error: 'pesanan sudah dibatalkan' }, 400);
    const method = String(body?.method ?? '');
    if (!METODE_ORDER.includes(method)) {
      return c.json({ error: `metode pembayaran tidak dikenal: ${method || '(kosong)'}` }, 400);
    }
    // `diterima` = uang fisik diserahkan pelanggan SAAT INI (>= 0; lebih dari
    // sisa = ada kembalian; kurang = sisanya masuk Hutang). Rupiah bulat.
    const diterima = Number(body?.diterima ?? 0);
    if (!Number.isInteger(diterima) || diterima < 0) {
      return c.json({ error: 'uang diterima harus rupiah bulat >= 0' }, 400);
    }
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    const cashier = sh.cashier;
    const hasil = transaksi(() => {
      const sisa = o.sisa;
      const bayar = Math.min(diterima, sisa);       // yang benar-benar menutup tagihan
      const kembalian = diterima - bayar;           // uang lebih -> dikembalikan
      const hutang = sisa - bayar;                  // sisa -> ledger Hutang
      // Membuat hutang baru butuh izin hutang.catat — `pesanan.bayar` saja
      // tidak boleh menciptakan piutang diam-diam.
      if (hutang > 0 && !bolehIzin(u, 'hutang.catat')) {
        throw new IzinError('izin hutang.catat tidak diberikan — pesanan dengan sisa hutang tidak bisa diserahkan');
      }
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
        .all(id) as { name: string; qty: number; price: number; note: string }[];
      const dpRows = db.prepare(
        `SELECT method, SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END) AS amount
           FROM order_payments WHERE order_id = ? GROUP BY method HAVING amount != 0`,
      ).all(id) as { method: string; amount: number }[];
      // Peta atribusi per metode: DP + pelunasan sekarang + sisa hutang
      // (menempel metode penyerahan). Σ = total nota — invarian dijaga.
      const peta = new Map<string, number>();
      for (const d of dpRows) peta.set(d.method, (peta.get(d.method) ?? 0) + d.amount);
      if (bayar > 0) peta.set(method, (peta.get(method) ?? 0) + bayar);
      if (hutang > 0) peta.set(method, (peta.get(method) ?? 0) + hutang);
      const payments = [...peta].map(([m, amount]) => ({ method: m, amount }));
      const saleId = randomUUID();
      // insertSale mengembalikan `row: unknown` (tipe union dup/non-dup) —
      // cast ke bentuk minimal yang dipakai di sini (id + invoice_no).
      const { row: sale } = insertSale({
        id: saleId,
        shift_id: sh.shift_id,
        pay_method: method,
        discount: 0,
        cash_in: o.total, // diabaikan saat payments[] dikirim — nota dianggap terbayar penuh
        cashier,
        customer_id: o.customer_id,
        note: o.note,     // catatan pesanan ikut jadi catatan transaksi nota
        items: items.map((it) => ({ name: it.name, qty: it.qty, price: it.price, note: it.note })),
        ...(payments.length > 0 ? { payments } : {}),
        // Take = jalur internal tervalidasi (item teks bebas sudah diketik
        // saat pesanan dibuat) — semua izin POS penuh, bukan izin akun.
        bolehHarga: true,
        bolehDiskon: true,
        bolehManual: true,
        bolehHutang: true,
        wajibLunas: false,
      }) as { row: { id: string; invoice_no: string } };
      if (bayar > 0) {
        db.prepare(
          `INSERT INTO order_payments (order_id, kind, method, amount, shift_id, cashier, note)
           VALUES (?, 'pelunasan', ?, ?, ?, ?, ?)`,
        ).run(id, method, bayar, sh.shift_id, cashier, `Pelunasan ${o.order_no}`);
      }
      if (hutang > 0) {
        // Ledger Hutang (keputusan pemilik #3): charge dengan nomor nota +
        // nomor pesanan supaya kasir menemukannya di halaman Hutang. Ikut
        // diatribusikan ke shift serah (Paket A) — pembayaran nanti punya
        // atribusi laci eksak.
        db.prepare(
          `INSERT INTO customer_debts (customer_id, type, amount, note, shift_id, cashier)
           VALUES (?, 'charge', ?, ?, ?, ?)`,
        ).run(o.customer_id, hutang, `Nota ${sale.invoice_no} — sisa pesanan ${o.order_no}`,
          sh.shift_id, cashier);
      }
      db.prepare(
        `UPDATE orders SET status='diambil', taken_at=datetime('now'), updated_at=datetime('now'),
           sale_id=?, hutang_sisa=? WHERE id=?`,
      ).run(saleId, hutang, id);
      return { sale, kembalian, hutang, bayar };
    })();
    catatAudit(c, 'update', 'order', id, {
      status: 'diambil', sale_id: hasil.sale.id, invoice_no: hasil.sale.invoice_no,
      diterima, kembalian: hasil.kembalian, hutang: hasil.hutang,
    });
    const segar = db.prepare(`SELECT o.*, ${SQL_ORDER_UANG} FROM orders o WHERE o.id = ?`).get(id);
    return c.json({ data: { order: segar, sale: hasil.sale, kembalian: hasil.kembalian, hutang: hasil.hutang } });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'gagal serahkan pesanan' },
      e instanceof IzinError ? 403 : 400,
    );
  }
});

/** Batalkan pesanan (koreksi sebelum diambil). DP yang sudah diterima
 *  DIKEMBALIKAN lewat baris order_payments kind='refund' (uang keluar —
 *  mengurangi agregat laci shift penerima refund). Pesanan yang sudah
 *  diambil TIDAK bisa dibatalkan: koreksi barang lewat Retur. */
app.post('/api/orders/:id/cancel', wajibIzin('pesanan.batal'), async (c) => {
  try {
    const body = await c.req.json();
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
    const o = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(id) as
      { id: number; status: string } | undefined;
    if (!o) return c.json({ error: 'tidak ditemukan' }, 404);
    if (o.status === 'diambil') {
      return c.json({ error: 'pesanan sudah diambil — barang/jasanya sekarang tercatat di Riwayat; koreksi lewat Retur' }, 400);
    }
    if (o.status === 'batal') return c.json({ error: 'pesanan sudah dibatalkan' }, 400);
    const batalNote = String(body?.note ?? '').trim();
    if (batalNote.length > 200) return c.json({ error: 'catatan terlalu panjang (maks 200 karakter)' }, 400);
    const method = String(body?.method ?? 'tunai');
    if (!METODE_ORDER.includes(method)) {
      return c.json({ error: `metode pembayaran tidak dikenal: ${method || '(kosong)'}` }, 400);
    }
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    const refund = transaksi(() => {
      const net = (db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END),0) AS d
           FROM order_payments WHERE order_id = ?`,
      ).get(id) as { d: number }).d;
      if (net > 0) {
        db.prepare(
          `INSERT INTO order_payments (order_id, kind, method, amount, shift_id, cashier, note)
           VALUES (?, 'refund', ?, ?, ?, ?, ?)`,
        ).run(id, method, net, sh.shift_id, sh.cashier,
          'Refund pembatalan pesanan');
      }
      db.prepare(
        `UPDATE orders SET status='batal', batal_at=datetime('now'), updated_at=datetime('now'), batal_note=? WHERE id=?`,
      ).run(batalNote, id);
      return net;
    })();
    catatAudit(c, 'update', 'order', id, { status: 'batal', refund });
    const segar = db.prepare(`SELECT o.*, ${SQL_ORDER_UANG} FROM orders o WHERE o.id = ?`).get(id);
    return c.json({ data: { order: segar, refund } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal batalkan pesanan' }, 400);
  }
});

// ---------- topup & tarik tunai ----------
app.post('/api/topups', async (c) => {
  try {
    const body = await c.req.json();
    const kind = body?.kind;
    if (!['topup', 'tarik'].includes(kind)) return c.json({ error: 'kind harus topup|tarik' }, 400);
    const u = c.get('user') as Pengguna;
    // Izin bergantung jenis: topup (uang masuk) vs tarik tunai (uang keluar)
    // dipisah supaya kasir bisa diberi salah satu saja.
    const izinKind: IzinOperasional = kind === 'tarik' ? 'pos.tarik' : 'pos.topup';
    if (!bolehIzin(u, izinKind)) {
      return c.json({ error: `izin ${izinKind} tidak diberikan untuk akun ini — hubungi owner` }, 403);
    }
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    const nominal = Number(body?.nominal ?? 0);
    const admin = Number(body?.admin ?? 0);
    if (!(nominal > 0)) return c.json({ error: 'nominal harus > 0' }, 400);
    if (!(admin >= 0)) return c.json({ error: 'admin harus >= 0' }, 400);
    // `nomor` OPSIONAL sejak 2026-10-06 (permintaan pemilik): e-wallet/pulsa
    // "untuk pencatatan saja tidak perlu nomor HP" dan tarik tunai cukup
    // nominal+admin — kosong = memang tanpa nomor (PLN token/tagihan tetap
    // mengisi no meter/ID pelanggan). `token` = Nomor Token PLN (ikut dicetak
    // di struk belanja); layanan lain mengirim kosong.
    if (!body?.provider) return c.json({ error: 'provider wajib' }, 400);
    const nomor = String(body?.nomor ?? '');
    const token = String(body?.token ?? '');
    // `sale_id` OPSIONAL (Opsi B hybrid, 2026-10-08): id nota penjualan yang
    // dibayar BERSAMA topup/tarik ini. Client meng-stamp-nya sebelum POST
    // /api/sales (id sale = uuid client, jadi sudah diketahui). NULL = topup/
    // tarik mandiri. TANPA validasi FK — baris topup ditulis lebih dulu.
    const saleId = body?.sale_id != null && body.sale_id !== '' ? String(body.sale_id) : null;
    const id = body.id ?? randomUUID();
    const dup = db.prepare('SELECT * FROM topup_txns WHERE id=?').get(id) as
      { cashier: string } | undefined;
    if (dup) {
      if (dup.cashier !== sh.cashier && !bolehIzin(u, 'riwayat.semua')) {
        return c.json({ error: 'transaksi ini milik kasir lain' }, 403);
      }
      return c.json({ data: dup, duplicate: true });
    }
    const total = nominal + admin; // yang dibayar pelanggan
    const row = db.prepare(
      `INSERT INTO topup_txns (id, shift_id, kind, provider, nomor, token, nominal, admin, total, pay_method, cashier, sale_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(id, sh.shift_id, kind, String(body.provider).toUpperCase(), nomor, token,
      nominal, admin, total, body.pay_method ?? 'tunai', sh.cashier, saleId);
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan topup' }, 400);
  }
});

// Riwayat topup/tarik — aturan hari & halaman yang sama dengan GET /api/sales
// di atas (lihat bacaHari), supaya keduanya digabung jadi satu linimasa tanpa
// tanggal yang saling bertengkar.
app.get('/api/topups', wajibIzin('riwayat.lihat'), (c) => {
  const h = bacaHari((k) => c.req.query(k));
  if (!h.ok) return c.json({ error: h.error }, 400);
  const u = c.get('user') as Pengguna;
  const semua = bolehIzin(u, 'riwayat.semua');
  const cond = semua ? '' : ' AND cashier = ?';
  const filter = semua ? [] : [u.name];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM topup_txns WHERE date(created_at)=date(?)${cond}`)
    .get(h.hari, ...filter) as { n: number }).n;
  const data = db.prepare(
    `SELECT * FROM topup_txns
      WHERE date(created_at)=date(?)${cond}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ? OFFSET ?`,
  ).all(h.hari, ...filter, h.limit, h.offset);
  return c.json({ data, total });
});

// Saran admin default (boleh diubah kasir per transaksi)
app.get('/api/topups/suggest-admin', (c) => {
  const nominal = Number(c.req.query('nominal') ?? 0);
  const admin = nominal <= 0 ? 0 : nominal < 50000 ? 3000 : nominal < 200000 ? 5000 : 7000;
  return c.json({ data: { nominal, admin } });
});

// ---------- pengeluaran kas (Tahap 1, 2026-10-11) ----------
// Kas TUNAI keluar untuk operasional (plastik, bensin, listrik, ...).
// Bukan mutasi stok (tidak menyentuh products.version) dan bukan HPP — tapi
// mengurangi laci: agregat `expense_total` dibaca rumus kasSeharusnya() di
// shift-tutup.ts, dan rekap hariannya tampil di GET /api/reports/daily.
// `shift_id` OPSIONAL (pola customer_id di sales): NULL = di luar shift —
// tetap tercatat + masuk laporan harian, hanya tidak mengurangi laci shift
// mana pun. Daftar memakai helper bacaHari (filter tanggal + limit/offset
// round-trip, pola GET /api/sales).
app.get('/api/expenses', wajibIzin('pengeluaran.kelola'), (c) => {
  const h = bacaHari((k) => c.req.query(k));
  if (!h.ok) return c.json({ error: h.error }, 400);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE date(created_at)=date(?)`)
    .get(h.hari) as { n: number }).n;
  const data = db.prepare(
    `SELECT * FROM expenses WHERE date(created_at)=date(?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(h.hari, h.limit, h.offset);
  const jumlahHari = (db.prepare(`SELECT COALESCE(SUM(jumlah),0) AS t FROM expenses WHERE date(created_at)=date(?)`)
    .get(h.hari) as { t: number }).t;
  return c.json({ data, total, jumlah: jumlahHari });
});

app.post('/api/expenses', wajibIzin('pengeluaran.kelola'), async (c) => {
  try {
    const body = await c.req.json();
    const kategori = String(body?.kategori ?? '').trim();
    const note = String(body?.note ?? '').trim();
    const jumlah = Number(body?.jumlah ?? 0);
    if (!kategori) return c.json({ error: 'kategori pengeluaran wajib diisi' }, 400);
    if (!Number.isInteger(jumlah) || jumlah <= 0) return c.json({ error: 'jumlah harus rupiah bulat > 0' }, 400);
    if (note.length > 200) return c.json({ error: 'catatan terlalu panjang (maks 200 karakter)' }, 400);
    // shift_id opsional; bila dikirim harus shift yang benar-benar ada dan
    // (untuk kasir) milik akun itu — aturShift satu pintu.
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    const row = db
      .prepare(
        `INSERT INTO expenses (kategori, jumlah, note, cashier, shift_id)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(kategori, jumlah, note, sh.cashier, sh.shift_id);
    catatAudit(c, 'create', 'expense', (row as { id: number }).id, { kategori, jumlah });
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan pengeluaran' }, 400);
  }
});

// Hapus catatan salah ketik (pola DELETE /api/customer-debts/:id — sengaja
// tanpa cek saldo: menghapus pengeluaran memperbesar kas, itu memang maksud
// koreksi).
app.delete('/api/expenses/:id', wajibIzin('pengeluaran.kelola'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const ada = db.prepare('SELECT id FROM expenses WHERE id = ?').get(id) as { id: number } | undefined;
  if (!ada) return c.json({ error: 'pengeluaran tidak ada' }, 404);
  db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  catatAudit(c, 'delete', 'expense', id);
  return c.json({ data: { id, deleted: true } });
});

// ---------- kas masuk non-penjualan (butir ROADMAP 1.6.2, 2026-10-19) ----------
// PASANGAN pengeluaran kas: uang TUNAI MASUK ke laci di luar penjualan
// (injeksi modal, koreksi laci, setoran pemilik). Bukan omzet, bukan mutasi
// stok (tidak menyentuh products.version), tidak menggerus laba — tapi
// MENAMBAH laci: agregat `kas_masuk_total` dibaca rumus kasSeharusnya() di
// shift-tutup.ts, rekap hariannya tampil di GET /api/reports/daily
// (`kas_masuk`). `shift_id` OPSIONAL (pola expenses): NULL = di luar shift —
// tetap tercatat + masuk laporan harian, hanya tidak menambah laci shift
// mana pun.
app.get('/api/kas-masuk', wajibIzin('kasmasuk.kelola'), (c) => {
  const h = bacaHari((k) => c.req.query(k));
  if (!h.ok) return c.json({ error: h.error }, 400);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM kas_masuk WHERE date(created_at)=date(?)`)
    .get(h.hari) as { n: number }).n;
  const data = db.prepare(
    `SELECT * FROM kas_masuk WHERE date(created_at)=date(?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(h.hari, h.limit, h.offset);
  const jumlahHari = (db.prepare(`SELECT COALESCE(SUM(jumlah),0) AS t FROM kas_masuk WHERE date(created_at)=date(?)`)
    .get(h.hari) as { t: number }).t;
  return c.json({ data, total, jumlah: jumlahHari });
});

app.post('/api/kas-masuk', wajibIzin('kasmasuk.kelola'), async (c) => {
  try {
    const body = await c.req.json();
    const kategori = String(body?.kategori ?? '').trim();
    const note = String(body?.note ?? '').trim();
    const jumlah = Number(body?.jumlah ?? 0);
    if (!kategori) return c.json({ error: 'kategori kas masuk wajib diisi' }, 400);
    if (!Number.isInteger(jumlah) || jumlah <= 0) return c.json({ error: 'jumlah harus rupiah bulat > 0' }, 400);
    if (note.length > 200) return c.json({ error: 'catatan terlalu panjang (maks 200 karakter)' }, 400);
    // shift_id opsional; bila dikirim harus shift yang benar-benar ada dan
    // (untuk kasir) milik akun itu.
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    const row = db
      .prepare(
        `INSERT INTO kas_masuk (kategori, jumlah, note, cashier, shift_id)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(kategori, jumlah, note, sh.cashier, sh.shift_id);
    catatAudit(c, 'create', 'kas_masuk', (row as { id: number }).id, { kategori, jumlah });
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan kas masuk' }, 400);
  }
});

// Hapus catatan salah ketik (pola DELETE /api/expenses/:id — sengaja tanpa
// cek saldo: menghapus kas masuk mengurangi kas, itu memang maksud koreksi).
app.delete('/api/kas-masuk/:id', wajibIzin('kasmasuk.kelola'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const ada = db.prepare('SELECT id FROM kas_masuk WHERE id = ?').get(id) as { id: number } | undefined;
  if (!ada) return c.json({ error: 'kas masuk tidak ada' }, 404);
  db.prepare('DELETE FROM kas_masuk WHERE id = ?').run(id);
  catatAudit(c, 'delete', 'kas_masuk', id);
  return c.json({ data: { id, deleted: true } });
});

// ---------- retur penjualan (Tahap 2, 2026-10-11) ----------
// Barang kembali (stok += qty, version++, stock_moves reason='retur') + uang
// tunai kembali ke pelanggan (mengurangi laci bila terikat shift — keputusan
// pemilik (a)). SEMUA mutasi dalam SATU db.transaction (skala 1-2 kasir:
// atomic cukup, pola simpanMutasiHutang / restock).
//   - Baris ber-nota (`sale_item_id`): harga/nama di-SNAPSHOT dari sale_items
//     (uang yang kembali = harga SAAT JUAL, bukan harga master sekarang);
//     qty ≤ qty terjual − sudah diretura (400 bila lebih).
//   - Baris manual (`product_id` + `price`): untuk retur tanpa nota; produk
//     harus ada, harga wajib dikirim (server tidak menebak harga).
//   - Stok hanya kembali untuk produk track_stock=1 (pola POST /api/sales:
//     jasa/cetak tidak punya stok untuk dikembalikan); uang kembali TETAP
//     dihitung untuk semua baris (jasa yang dibatalkan = refund uang).
type ReturItemIn = { sale_item_id?: number; product_id?: number; qty?: number; price?: number };
const simpanRetur = transaksi(
  (masuk: { sale_id: string | null; items: ReturItemIn[]; note: string; cashier: string; shift_id: number | null }) => {
    // Validasi shift up-front (di luar mutasi stok, pesannya duluan).
    if (masuk.shift_id !== null) {
      const ada = db.prepare('SELECT id FROM shifts WHERE id = ?').get(masuk.shift_id) as { id: number } | undefined;
      if (!ada) throw new Error('shift tidak dikenal');
    }
    let saleId: string | null = null;
    if (masuk.sale_id !== null && masuk.sale_id !== '') {
      const nota = db.prepare('SELECT id FROM sales WHERE id = ?').get(masuk.sale_id) as { id: string } | undefined;
      if (!nota) throw new Error('nota asal tidak dikenal');
      saleId = nota.id;
    }
    if (!masuk.items.length) throw new Error('baris retur kosong');
    // Sisa boleh-diretura per baris nota = terjual − sudah diretura.
    const sisaBaris = (saleItemId: number): number => {
      const jual = db.prepare('SELECT qty FROM sale_items WHERE id = ?').get(saleItemId) as { qty: number } | undefined;
      if (!jual) throw new Error(`baris nota #${saleItemId} tidak dikenal`);
      const sudah = db.prepare('SELECT COALESCE(SUM(qty),0) AS t FROM return_items WHERE sale_item_id = ?').get(saleItemId) as { t: number };
      return jual.qty - sudah.t;
    };
    const baris: { sale_item_id: number | null; product_id: number | null; name: string; qty: number; price: number; amount: number }[] = [];
    for (const [i, it] of masuk.items.entries()) {
      const qty = Number(it.qty ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error(`baris ${i + 1}: qty harus > 0`);
      if (it.sale_item_id !== undefined && it.sale_item_id !== null) {
        const siId = Number(it.sale_item_id);
        if (!Number.isInteger(siId)) throw new Error(`baris ${i + 1}: sale_item_id harus integer`);
        const si = db.prepare(
          `SELECT si.*, c.track_stock FROM sale_items si
             LEFT JOIN products p ON p.id = si.product_id
             LEFT JOIN categories c ON c.id = p.category_id
            WHERE si.id = ?`,
        ).get(siId) as { id: number; sale_id: string; product_id: number | null; name: string; price: number; track_stock: number | null } | undefined;
        if (!si) throw new Error(`baris ${i + 1}: baris nota tidak dikenal`);
        if (saleId !== null && si.sale_id !== saleId) throw new Error(`baris ${i + 1}: bukan baris nota ini`);
        if (qty - sisaBaris(siId) > 1e-9) throw new Error(`baris ${i + 1}: melebihi sisa (${sisaBaris(siId)} ${si.name})`);
        baris.push({ sale_item_id: siId, product_id: si.product_id, name: si.name, qty, price: si.price, amount: Math.round(qty * si.price) });
      } else {
        const pid = Number(it.product_id);
        const price = Number(it.price ?? NaN);
        if (!Number.isInteger(pid)) throw new Error(`baris ${i + 1}: product_id harus integer`);
        if (!Number.isFinite(price) || price < 0) throw new Error(`baris ${i + 1}: harga wajib dikirim (>= 0)`);
        const p = db.prepare(
          `SELECT p.id, p.name, c.track_stock FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
        ).get(pid) as { id: number; name: string; track_stock: number } | undefined;
        if (!p) throw new Error(`baris ${i + 1}: produk tidak dikenal`);
        baris.push({ sale_item_id: null, product_id: pid, name: p.name, qty, price: Math.round(price), amount: Math.round(qty * Math.round(price)) });
      }
    }
    const total = baris.reduce((s, b) => s + b.amount, 0);
    if (total <= 0) throw new Error('total retur harus > 0');
    const ret = db.prepare(
      `INSERT INTO returns (sale_id, total, cashier, shift_id, note) VALUES (?, ?, ?, ?, ?) RETURNING *`,
    ).get(saleId, total, masuk.cashier, masuk.shift_id, masuk.note) as { id: number };
    const insItem = db.prepare(
      `INSERT INTO return_items (return_id, sale_item_id, product_id, name, qty, price, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of baris) {
      insItem.run(ret.id, b.sale_item_id, b.product_id, b.name, b.qty, b.price, b.amount);
      // Stok kembali HANYA untuk barang fisik (track_stock=1, pola sales):
      // jasa/cetak refund uangnya saja. version WAJIB naik (aturan mutasi
      // products — delta sync kasir). unit_cost = avg_cost saat itu (pola
      // sale/opname, bukan harga batch seperti restock).
      if (b.product_id !== null) {
        const p = db.prepare(
          `SELECT p.stock, p.avg_cost, c.track_stock FROM products p
             JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
        ).get(b.product_id) as { stock: number; avg_cost: number; track_stock: number } | undefined;
        if (p?.track_stock) {
          db.prepare(
            `UPDATE products SET stock = stock + ?, updated_at = datetime('now'),
               version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
             WHERE id = ?`,
          ).run(b.qty, b.product_id);
          db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, ref_id, unit_cost, cashier) VALUES (?, ?, 'retur', ?, ?, ?)`)
            .run(b.product_id, b.qty, String(ret.id), p.avg_cost, masuk.cashier);
        }
      }
    }
    return db.prepare('SELECT * FROM returns WHERE id = ?').get(ret.id);
  },
);

app.post('/api/returns', wajibIzin('retur.buat'), async (c) => {
  try {
    const body = await c.req.json();
    const u = c.get('user') as Pengguna;
    const rawItems = body?.items;
    if (!Array.isArray(rawItems) || !rawItems.length) return c.json({ error: 'items wajib array non-kosong' }, 400);
    if (rawItems.length > 200) return c.json({ error: 'maks 200 baris per retur' }, 400);
    const note = String(body?.note ?? '').trim();
    if (note.length > 200) return c.json({ error: 'catatan terlalu panjang (maks 200 karakter)' }, 400);
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    const rawSale = body?.sale_id;
    const saleId = rawSale === undefined || rawSale === null || rawSale === '' ? null : String(rawSale);
    // Retur dari nota kasir lain = butuh riwayat.semua; `retur.buat` saja
    // tidak boleh mengoreksi nota yang tidak pernah dilihat akun itu.
    if (saleId && !bolehIzin(u, 'riwayat.semua')) {
      const nota = db.prepare('SELECT cashier FROM sales WHERE id = ?').get(saleId) as
        { cashier: string } | undefined;
      if (!nota) return c.json({ error: 'nota asal tidak dikenal' }, 404);
      if (nota.cashier !== u.name) {
        return c.json({ error: 'nota ini milik kasir lain — butuh izin riwayat.semua' }, 403);
      }
    }
    const row = simpanRetur({
      sale_id: saleId,
      items: rawItems as ReturItemIn[],
      note,
      cashier: sh.cashier,
      shift_id: sh.shift_id,
    });
    const items = db.prepare('SELECT * FROM return_items WHERE return_id = ? ORDER BY id').all((row as { id: number }).id);
    return c.json({ data: { retur: row, items } }, 201);
  } catch (e) {
    const pesan = e instanceof Error ? e.message : 'gagal simpan retur';
    // "tidak dikenal" = referensi ngawur → 404, KECUALI shift (kontrak:
    // shift_id tak dikenal = 400 "shift tidak dikenal", pola expenses).
    const hilang = /tidak dikenal|tidak ada/.test(pesan) && !/shift/.test(pesan);
    return c.json({ error: pesan }, hilang ? 404 : 400);
  }
});

// Daftar retur per hari (halaman #/returns) — filter tanggal + limit/offset
// via helper bacaHari (pola GET /api/sales); `jumlah` = total uang kembali
// hari itu untuk kartu halaman. Urutan terbaru di atas.
app.get('/api/returns', wajibIzin('retur.lihat'), (c) => {
  const h = bacaHari((k) => c.req.query(k));
  if (!h.ok) return c.json({ error: h.error }, 400);
  const u = c.get('user') as Pengguna;
  const semua = bolehIzin(u, 'riwayat.semua');
  const cond = semua ? '' : ' AND r.cashier = ?';
  const filter = semua ? [] : [u.name];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM returns r WHERE date(r.created_at)=date(?)${cond}`)
    .get(h.hari, ...filter) as { n: number }).n;
  const data = db.prepare(
    `SELECT r.*, s.invoice_no AS invoice_no,
            (SELECT COUNT(*) FROM return_items ri WHERE ri.return_id = r.id) AS n_items
       FROM returns r LEFT JOIN sales s ON s.id = r.sale_id
      WHERE date(r.created_at)=date(?)${cond}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
  ).all(h.hari, ...filter, h.limit, h.offset);
  const jumlah = (db.prepare(`SELECT COALESCE(SUM(r.total),0) AS t FROM returns r WHERE date(r.created_at)=date(?)${cond}`)
    .get(h.hari, ...filter) as { t: number }).t;
  return c.json({ data, total, jumlah });
});

// Isi lengkap satu retur (baris + nota asal bila ada).
app.get('/api/returns/:id', wajibIzin('retur.lihat'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const retur = db.prepare(
    `SELECT r.*, s.invoice_no AS invoice_no FROM returns r LEFT JOIN sales s ON s.id = r.sale_id WHERE r.id = ?`,
  ).get(id) as { cashier: string } | undefined;
  if (!retur) return c.json({ error: 'retur tidak ada' }, 404);
  const u = c.get('user') as Pengguna;
  if (!bolehIzin(u, 'riwayat.semua') && retur.cashier !== u.name) {
    return c.json({ error: 'retur ini milik kasir lain — butuh izin riwayat.semua' }, 403);
  }
  const items = db.prepare('SELECT * FROM return_items WHERE return_id = ? ORDER BY id').all(id);
  return c.json({ data: { retur, items } });
});

// Batalkan retur salah ketik: stok dikembalikan KELUAR lagi (mutasi lawan
// reason='retur', qty negatif + note penanda) lalu baris dihapus — dalam satu
// transaction. Stok yang tidak cukup (barang sudah terjual lagi) = 400,
// bukan diam-diam minus: tanpa guard ini pembatalan mengarang stok dari nol.
app.delete('/api/returns/:id', wajibIzin('retur.batal'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  try {
    db.transaction(() => {
      const r = db.prepare('SELECT * FROM returns WHERE id = ?').get(id) as { id: number; cashier: string } | undefined;
      if (!r) throw new Error('retur tidak ada');
      const u = c.get('user') as Pengguna;
      if (!bolehIzin(u, 'riwayat.semua') && r.cashier !== u.name) {
        throw new IzinError('retur ini milik kasir lain — butuh izin riwayat.semua');
      }
      const items = db.prepare('SELECT * FROM return_items WHERE return_id = ?').all(id) as { product_id: number | null; qty: number; name: string }[];
      for (const it of items) {
        if (it.product_id === null) continue;
        const p = db.prepare(
          `SELECT p.stock, c.track_stock FROM products p
             JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
        ).get(it.product_id) as { stock: number; track_stock: number } | undefined;
        if (p?.track_stock && p.stock - it.qty < 0) {
          const allow = db.prepare(`SELECT value FROM settings WHERE key = 'allow_negative_stock'`).get() as { value: string } | undefined;
          if (!allow || allow.value !== '1') throw new Error(`stok ${it.name} tidak cukup untuk pembatalan (sisa ${p.stock})`);
        }
        if (p?.track_stock) {
          db.prepare(
            `UPDATE products SET stock = stock - ?, updated_at = datetime('now'),
               version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
             WHERE id = ?`,
          ).run(it.qty, it.product_id);
          db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, ref_id, unit_cost, cashier) VALUES (?, ?, 'retur', ?, 0, ?)`)
            .run(it.product_id, -it.qty, `batal-${id}`, r.cashier);
        }
      }
      db.prepare('DELETE FROM returns WHERE id = ?').run(id);
    })();
    catatAudit(c, 'delete', 'return', id);
    return c.json({ data: { id, deleted: true } });
  } catch (e) {
    const pesan = e instanceof Error ? e.message : 'gagal batalkan retur';
    return c.json(
      { error: pesan },
      e instanceof IzinError ? 403 : /tidak ada/.test(pesan) ? 404 : 400,
    );
  }
});

// ---------- pembelian / kulakan (Tahap 3, 2026-10-11) ----------
// Alur: order (catatan pesanan, tanpa stok/kas) -> receive (stok masuk +
// kas keluar sebesar terbayar) -> pay (cicil sisa hutang, bila ada).
// Keputusan pemilik (b): bawaan TUNAI penuh (terbayar=total saat receive);
// kolom hutang (total−terbayar) hanya bila suatu saat terjadi.
// SEMUA mutasi stok/kas dalam SATU db.transaction per aksi (pola retur).
// Kas keluar = `terbayar`, diatribusikan ke shift_id PO ini (bukan shift
// saat bayar susulan — satu PO satu laci penanggung, sederhana & auditabel).
type PoItemIn = { product_id?: number; qty?: number; harga_beli?: number };
type PoTerimaIn = { purchase_item_id?: number; qty?: number };
type PoHitung = {
  id: number; status: string; total: number; terbayar: number;
  shift_id: number | null; received_at: string | null;
  /** Nilai barang yang SUDAH diterima (Σ kedatangan; nota lama = total). */
  diterima: number;
  /** Sisa hutang supplier atas barang yang SUDAH diterima. */
  sisa: number;
  /** Nilai barang yang BELUM datang. */
  sisa_terima: number;
  status_tampil: 'order' | 'sebagian' | 'received' | 'cancel';
  n_terima: number;
};

// Nilai barang yang SUDAH diterima (butir ROADMAP 3.7): Σ kedatangan.
// Nota LAMA berstatus received tidak punya baris kedatangan (fitur ini baru),
// jadi dianggap terkirim penuh lewat fallback `p.total` — tanpa ini seluruh
// nota historis mendadak terlihat "belum diterima" & sisa hutangnya salah.
const SQL_PO_DITERIMA = `COALESCE(
  (SELECT SUM(ri.amount) FROM purchase_receives r
     JOIN purchase_receive_items ri ON ri.receive_id = r.id
    WHERE r.purchase_id = p.id),
  CASE WHEN p.status = 'received' THEN p.total ELSE 0 END)`;

// Satu sumber bentuk baris PO (list/detail/pay/receive): `sisa` dihitung dari
// nilai yang SUDAH diterima (bukan total PO — barang yang belum datang bukan
// hutang), `status_tampil` menurunkan "Sebagian" dari Σ kedatangan tanpa
// menambah nilai CHECK pada kolom status tersimpan.
const SQL_PO_HIT = `
  WITH po AS (
    SELECT p.*, ${SQL_PO_DITERIMA} AS diterima FROM purchases p
  ), hit AS (
    SELECT po.*,
           MAX(0, po.diterima - po.terbayar) AS sisa,
           -- Saat status sudah 'received', tidak ada qty tersisa — nol-kan
           -- eksplisit supaya pembulatan per event (qty pecahan) tidak
           -- memunculkan "Belum diterima Rp1" pada nota yang sudah lengkap.
           CASE WHEN po.status = 'received' THEN 0
                ELSE MAX(0, po.total - po.diterima) END AS sisa_terima,
           CASE WHEN po.status = 'cancel' THEN 'cancel'
                WHEN po.status = 'received' THEN 'received'
                WHEN po.diterima > 0 THEN 'sebagian'
                ELSE 'order' END AS status_tampil,
           (SELECT COUNT(*) FROM purchase_receives r WHERE r.purchase_id = po.id) AS n_terima
      FROM po
  )`;

// Qty yang sudah diterima untuk satu baris PO. Nota lama (received tanpa baris
// kedatangan) = qty penuh; nota lain yang belum punya kedatangan = 0.
const SQL_PO_BARIS_DITERIMA = `CASE
  WHEN NOT EXISTS (SELECT 1 FROM purchase_receives r WHERE r.purchase_id = pi.purchase_id)
    THEN CASE WHEN (SELECT status FROM purchases WHERE id = pi.purchase_id) = 'received'
              THEN pi.qty ELSE 0 END
  ELSE COALESCE((SELECT SUM(ri.qty) FROM purchase_receive_items ri
                   JOIN purchase_receives r ON r.id = ri.receive_id
                  WHERE r.purchase_id = pi.purchase_id AND ri.purchase_item_id = pi.id), 0)
END`;

// Kulakan HANYA barang fisik (track_stock=1, pola restock/retur): jasa tidak
// punya stok untuk ditambah. Validasi dipakai order (awal) & receive (ulang,
// karena produk bisa berubah/dihapus di antaranya).
function cekProdukKulakan(pid: number, i: number): { id: number; name: string } {
  const p = db.prepare(
    `SELECT p.id, p.name, c.track_stock FROM products p
       JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
  ).get(pid) as { id: number; name: string; track_stock: number } | undefined;
  if (!p) throw new Error(`baris ${i + 1}: produk tidak dikenal`);
  if (!p.track_stock) throw new Error(`baris ${i + 1}: ${p.name} bukan barang fisik (jasa tidak bisa dikulak)`);
  return p;
}

// Buat PO (status order): validasi item + hitung total, TANPA sentuhan stok.
app.post('/api/purchases', wajibIzin('pembelian.kelola'), async (c) => {
  try {
    const body = await c.req.json();
    const rawItems = body?.items;
    if (!Array.isArray(rawItems) || !rawItems.length) return c.json({ error: 'items wajib array non-kosong' }, 400);
    if (rawItems.length > 200) return c.json({ error: 'maks 200 baris per nota' }, 400);
    const note = String(body?.note ?? '').trim();
    if (note.length > 200) return c.json({ error: 'catatan terlalu panjang (maks 200 karakter)' }, 400);
    const rawSup = body?.supplier_id;
    const supplierId = rawSup === undefined || rawSup === null || rawSup === '' ? null : Number(rawSup);
    let supplierName = '';
    if (supplierId !== null) {
      if (!Number.isInteger(supplierId)) return c.json({ error: 'supplier_id harus integer' }, 400);
      const sup = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(supplierId) as { id: number; name: string } | undefined;
      if (!sup) return c.json({ error: 'supplier tidak dikenal' }, 404);
      supplierName = sup.name;
    }
    const baris: { product_id: number; name: string; qty: number; harga_beli: number; amount: number }[] = [];
    (rawItems as PoItemIn[]).forEach((it, i) => {
      const pid = Number(it?.product_id);
      const qty = Number(it?.qty ?? 0);
      const harga = Number(it?.harga_beli ?? NaN);
      if (!Number.isInteger(pid)) throw new Error(`baris ${i + 1}: product_id harus integer`);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error(`baris ${i + 1}: qty harus > 0`);
      if (!Number.isFinite(harga) || harga < 0) throw new Error(`baris ${i + 1}: harga_beli wajib dikirim (>= 0)`);
      const p = cekProdukKulakan(pid, i);
      const hb = Math.round(harga);
      baris.push({ product_id: pid, name: p.name, qty, harga_beli: hb, amount: Math.round(qty * hb) });
    });
    const total = baris.reduce((s, b) => s + b.amount, 0);
    if (total <= 0) return c.json({ error: 'total nota harus > 0' }, 400);
    const po = db.transaction(() => {
      const row = db.prepare(
        `INSERT INTO purchases (supplier_id, supplier_name, status, total, terbayar, cashier, note)
         VALUES (?, ?, 'order', ?, 0, ?, ?) RETURNING *`,
      ).get(supplierId, supplierName, total, cashierEfektif(c, body?.cashier), note);
      const ins = db.prepare(
        `INSERT INTO purchase_items (purchase_id, product_id, name, qty, harga_beli, amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const b of baris) ins.run((row as { id: number }).id, b.product_id, b.name, b.qty, b.harga_beli, b.amount);
      return row;
    })();
    const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all((po as { id: number }).id);
    // Bentuk balasan SAMA dengan GET detail (butir 3.7): `diterima`/`sisa`/
    // `sisa_terima`/`status_tampil`/`n_terima` computed ikut sejak POST supaya
    // klien tidak perlu tebak-tebakan (PO baru = order, belum ada kedatangan).
    const segar = db.prepare(`${SQL_PO_HIT} SELECT * FROM hit WHERE id = ?`).get((po as { id: number }).id);
    return c.json({ data: { purchase: segar, items } }, 201);
  } catch (e) {
    const pesan = e instanceof Error ? e.message : 'gagal simpan pembelian';
    return c.json({ error: pesan }, /tidak dikenal/.test(pesan) ? 404 : 400);
  }
});

// Terima barang — BERTAHAP (butir ROADMAP 3.7, 2026-10-25). Body opsional
// `items:[{purchase_item_id, qty}]`; TANPA `items` = terima SEMUA sisa
// (perilaku lama, pemanggil/klien lama tetap sah). Stok masuk per baris yang
// diterima (RUMUS SAMA PERSIS dengan restock: avg tertimbang + version++ +
// stock_moves 'beli') dan `dibayar` = uang keluar pada KEDATANGAN INI
// (bawaan = nilai kedatangan; maks = nilai kumulatif diterima − terbayar).
// Status tersimpan baru jadi 'received' saat SEMUA qty terpenuhi; selain itu
// tetap 'order' dan tampil "Sebagian" (computed).
app.post('/api/purchases/:id/receive', wajibIzin('pembelian.kelola'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  try {
    const body = await c.req.json().catch(() => ({}));
    // Kas keluar PO menempel ke laci shift penerimaan; kasir hanya boleh
    // memakai shiftnya sendiri, owner bebas (satu-satunya validasi shift).
    const sh = aturShift(c, body?.shift_id, body?.cashier);
    if (!sh.ok) return c.json({ error: sh.error }, sh.status);
    // Kunci idempotensi retry (pola `id` uuid POST /api/sales): kirim ulang
    // request yang sama TIDAK menambah stok/uang dua kali.
    const clientId = String(body?.client_id ?? body?.id ?? '').trim();
    if (clientId.length > 64) return c.json({ error: 'client_id maks 64 karakter' }, 400);
    const note = String(body?.note ?? '').trim();
    if (note.length > 200) return c.json({ error: 'catatan terlalu panjang (maks 200 karakter)' }, 400);
    const rawItems = body?.items;
    if (rawItems !== undefined && (!Array.isArray(rawItems) || rawItems.length === 0)) {
      return c.json({ error: 'items harus array non-kosong (kosongkan untuk terima semua sisa)' }, 400);
    }
    if (Array.isArray(rawItems) && rawItems.length > 200) {
      return c.json({ error: 'maks 200 baris per kedatangan' }, 400);
    }
    const out = transaksi(() => {
      if (clientId) {
        const ada = db.prepare('SELECT * FROM purchase_receives WHERE client_id = ?').get(clientId) as
          { id: number; purchase_id: number } | undefined;
        if (ada) {
          if (ada.purchase_id !== id) throw new Error('client_id sudah dipakai pembelian lain');
          const po = db.prepare(`${SQL_PO_HIT} SELECT * FROM hit WHERE id = ?`).get(id);
          if (!po) throw new Error('pembelian tidak ada');
          const receive = db.prepare('SELECT * FROM purchase_receives WHERE id = ?').get(ada.id);
          return { ...(po as object), receive, duplicate: true };
        }
      }
      const po = db.prepare(`${SQL_PO_HIT} SELECT * FROM hit WHERE id = ?`).get(id) as PoHitung | undefined;
      if (!po) throw new Error('pembelian tidak ada');
      if (po.status === 'cancel') throw new Error('pembelian sudah dibatalkan');
      if (po.status === 'received') throw new Error('pembelian sudah diterima lengkap');
      const itemRows = db.prepare(
        `SELECT pi.*, ${SQL_PO_BARIS_DITERIMA} AS diterima
           FROM purchase_items pi WHERE pi.purchase_id = ? ORDER BY pi.id`,
      ).all(id) as { id: number; product_id: number; name: string; qty: number; harga_beli: number; diterima: number }[];
      const sisaPer = new Map(itemRows.map((it) => [it.id, Math.max(0, it.qty - it.diterima)]));
      const dipilih: { item: (typeof itemRows)[number]; qty: number }[] = [];
      if (rawItems === undefined) {
        // Kompatibilitas penuh: pemanggil lama tidak mengirim items = terima
        // semua sisa sekaligus (dulu selalu 100% karena belum ada kedatangan).
        for (const it of itemRows) {
          const sisa = sisaPer.get(it.id) ?? 0;
          if (sisa > 1e-9) dipilih.push({ item: it, qty: sisa });
        }
      } else {
        const terpakai = new Set<number>();
        (rawItems as PoTerimaIn[]).forEach((raw, i) => {
          const pid = Number(raw?.purchase_item_id);
          const qty = Number(raw?.qty);
          if (!Number.isInteger(pid)) throw new Error(`baris ${i + 1}: purchase_item_id harus integer`);
          const row = itemRows.find((it) => it.id === pid);
          if (!row) throw new Error(`baris ${i + 1}: purchase_item_id tidak dikenal di PO ini`);
          if (terpakai.has(pid)) throw new Error(`baris ${i + 1}: purchase_item_id duplikat`);
          terpakai.add(pid);
          if (!Number.isFinite(qty) || qty <= 0) throw new Error(`baris ${i + 1}: qty harus > 0`);
          const sisa = sisaPer.get(pid) ?? 0;
          if (qty > sisa + 1e-9) throw new Error(`baris ${i + 1}: qty melebihi sisa (sisa ${sisa})`);
          dipilih.push({ item: row, qty });
        });
      }
      if (!dipilih.length) throw new Error('tidak ada qty yang diterima');
      const baris = dipilih.map(({ item, qty }) => ({
        ...item, qty_terima: qty, amount: Math.round(qty * item.harga_beli),
      }));
      const eventTotal = baris.reduce((s, b) => s + b.amount, 0);
      // Sisa hutang setelah event ini = nilai kumulatif diterima − terbayar.
      // Boleh melunasi kekurangan kedatangan sebelumnya, tapi tidak boleh
      // melebihi nilai barang yang benar-benar sudah masuk.
      const maksBayar = Math.max(0, po.diterima + eventTotal - po.terbayar);
      const dibayar = body?.dibayar === undefined || body?.dibayar === null || body?.dibayar === ''
        ? eventTotal
        : Number(body.dibayar);
      if (!Number.isInteger(dibayar) || dibayar < 0 || dibayar > maksBayar) {
        throw new Error(`dibayar harus bulat 0..${maksBayar}`);
      }
      baris.forEach((b, i) => {
        cekProdukKulakan(b.product_id, i);
        const p = db.prepare('SELECT stock, avg_cost FROM products WHERE id = ?').get(b.product_id) as
          { stock: number; avg_cost: number };
        const avgBaru = Math.round((p.stock * p.avg_cost + b.qty_terima * b.harga_beli) / (p.stock + b.qty_terima));
        db.prepare(
          `UPDATE products SET stock = stock + ?, avg_cost = ?, updated_at = datetime('now'),
             version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
           WHERE id = ?`,
        ).run(b.qty_terima, avgBaru, b.product_id);
        db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, ref_id, unit_cost, cashier) VALUES (?, ?, 'beli', ?, ?, ?)`)
          .run(b.product_id, b.qty_terima, `PO-${id}`, Math.round(b.harga_beli), sh.cashier);
      });
      const receive = db.prepare(
        `INSERT INTO purchase_receives (purchase_id, shift_id, cashier, total, dibayar, note, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      ).get(id, sh.shift_id, sh.cashier, eventTotal, dibayar, note, clientId || null) as { id: number };
      const insBaris = db.prepare(
        `INSERT INTO purchase_receive_items (receive_id, purchase_item_id, qty, harga_beli, amount)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const b of baris) insBaris.run(receive.id, b.id, b.qty_terima, b.harga_beli, b.amount);
      // Lengkap = tidak ada baris yang sisa qty-nya masih > 0 (toleransi float).
      const sisaQty = (db.prepare(
        `SELECT COALESCE(SUM(
           CASE WHEN pi.qty - ${SQL_PO_BARIS_DITERIMA} > 0.0000001 THEN 1 ELSE 0 END), 0) AS n
           FROM purchase_items pi WHERE pi.purchase_id = ?`,
      ).get(id) as { n: number }).n;
      const lengkap = sisaQty === 0;
      db.prepare(
        `UPDATE purchases SET status = ?, terbayar = terbayar + ?,
           shift_id = COALESCE(shift_id, ?),
           cashier = CASE WHEN received_at IS NULL THEN ? ELSE cashier END,
           received_at = COALESCE(received_at, datetime('now'))
         WHERE id = ?`,
      ).run(lengkap ? 'received' : 'order', dibayar, sh.shift_id, sh.cashier, id);
      // Bentuk balasan SAMA dengan versi lama (`data` = baris purchases) +
      // field computed & `receive` — klien/pemanggil lama tidak rusak.
      const segar = db.prepare(`${SQL_PO_HIT} SELECT * FROM hit WHERE id = ?`).get(id);
      return { ...(segar as object), receive };
    })();
    return c.json({ data: out });
  } catch (e) {
    const pesan = e instanceof Error ? e.message : 'gagal terima barang';
    return c.json({ error: pesan }, /tidak ada/.test(pesan) ? 404 : 400);
  }
});

// Bayar sisa hutang supplier (cicil): terbayar += amount, maks = nilai yang
// SUDAH diterima − terbayar (barang yang belum datang bukan hutang). Kas
// keluar susulan diatribusikan ke shift_id PO ini (satu PO satu laci) — juga
// berlaku untuk PO yang baru diterima sebagian, supaya kekurangan bayar saat
// kedatangan bisa dilunasi tanpa menunggu seluruh barang datang.
app.post('/api/purchases/:id/pay', wajibIzin('pembelian.kelola'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  try {
    const body = await c.req.json();
    const amount = Number(body?.amount ?? 0);
    if (!Number.isInteger(amount) || amount <= 0) return c.json({ error: 'amount harus rupiah bulat > 0' }, 400);
    const row = transaksi(() => {
      const po = db.prepare(`${SQL_PO_HIT} SELECT * FROM hit WHERE id = ?`).get(id) as PoHitung | undefined;
      if (!po) throw new Error('pembelian tidak ada');
      if (po.status === 'cancel') throw new Error('pembelian sudah dibatalkan');
      if (po.diterima <= 0) throw new Error('belum ada barang yang diterima — tidak ada hutang');
      if (amount > po.sisa) throw new Error(`melebihi sisa hutang (sisa ${po.sisa})`);
      db.prepare(`UPDATE purchases SET terbayar = terbayar + ? WHERE id = ?`).run(amount, id);
      return db.prepare(`${SQL_PO_HIT} SELECT * FROM hit WHERE id = ?`).get(id);
    })();
    return c.json({ data: row });
  } catch (e) {
    const pesan = e instanceof Error ? e.message : 'gagal bayar supplier';
    return c.json({ error: pesan }, /tidak ada/.test(pesan) ? 404 : 400);
  }
});

// Batalkan PO HANYA bila belum ada barang masuk sama sekali. Setelah ada
// penerimaan (walau sebagian) stok & kas sudah bergerak — koreksi lewat
// opname (stok) / retur-pengeluaran (kas), bukan menghapus riwayat.
app.post('/api/purchases/:id/cancel', wajibIzin('pembelian.kelola'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const po = db.prepare(`${SQL_PO_HIT} SELECT * FROM hit WHERE id = ?`).get(id) as PoHitung | undefined;
  if (!po) return c.json({ error: 'pembelian tidak ada' }, 404);
  if (po.status === 'cancel') return c.json({ error: 'pembelian sudah dibatalkan' }, 400);
  if (po.n_terima > 0) {
    return c.json({
      error: 'sudah ada penerimaan barang — PO tidak bisa dibatalkan; koreksi stok lewat opname / kas lewat pengeluaran',
    }, 400);
  }
  if (po.status !== 'order') return c.json({ error: `hanya PO order yang bisa dibatalkan (status: ${po.status})` }, 400);
  const row = db.prepare(`UPDATE purchases SET status = 'cancel' WHERE id = ? RETURNING *`).get(id);
  return c.json({ data: row });
});

// Daftar pembelian: filter status (default semua) + limit/offset (pola
// GET /api/shifts). Urutan id DESC (nota terbaru di atas).
//
// `sisa` = nilai yang SUDAH diterima − terbayar (bukan total − terbayar:
// barang yang belum datang bukan hutang), `sisa_terima` = nilai yang belum
// datang, `status_tampil` = "sebagian" bila sudah ada kedatangan tapi belum
// lengkap. Filter `sebagian` baru; `received` tetap berarti lengkap.
//
// AGING (2026-10-16): `umur_hari` = lama nota DITERIMA-tapi-belum-lunas
// menunggu (dari `received_at` kedatangan PERTAMA; julianday SQLite = UTC).
// `lewat30` = jumlah hutang PO >= 30 hari di SELURUH baris cocok filter.
app.get('/api/purchases', wajibIzin('pembelian.kelola'), (c) => {
  const status = c.req.query('status') ?? 'semua';
  if (!['semua', 'order', 'sebagian', 'received', 'cancel', 'hutang'].includes(status)) {
    return c.json({ error: 'status harus order|sebagian|received|cancel|hutang|semua' }, 400);
  }
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  // `hutang` = nota yang masih bersisa atas barang yang SUDAH diterima —
  // mencakup PO diterima sebagian (barang kurang bukan hutang). Sejalan
  // dengan kolom `sisa`, bukan status tersimpan (permintaan pemilik
  // 2026-10-17 "kebingungan mencari purchasing yang belum lunas").
  const klausul: Record<string, string> = {
    semua: '',
    order: `WHERE status_tampil = 'order'`,
    sebagian: `WHERE status_tampil = 'sebagian'`,
    received: `WHERE status_tampil = 'received'`,
    cancel: `WHERE status_tampil = 'cancel'`,
    hutang: `WHERE status_tampil <> 'cancel' AND sisa > 0`,
  };
  const where = klausul[status];
  const total = (db.prepare(`${SQL_PO_HIT} SELECT COUNT(*) AS n FROM hit ${where}`).get() as { n: number }).n;
  const data = db.prepare(
    `${SQL_PO_HIT}
     SELECT hit.*,
            CASE WHEN hit.sisa > 0 AND hit.received_at IS NOT NULL
                 THEN MAX(0, CAST(julianday('now') - julianday(hit.received_at) AS INTEGER))
                 ELSE NULL END AS umur_hari,
            (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = hit.id) AS n_items
       FROM hit ${where} ORDER BY hit.id DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset);
  const lewat30 = (db.prepare(
    `${SQL_PO_HIT} SELECT COUNT(*) AS n FROM hit
      WHERE sisa > 0 AND status_tampil <> 'cancel' AND received_at IS NOT NULL
        AND julianday('now') - julianday(received_at) >= 30`,
  ).get() as { n: number }).n;
  return c.json({ data, total, lewat30 });
});

// Isi lengkap satu nota pembelian: header + baris (dengan qty diterima/sisa
// per baris) + RIWAYAT KEDATANGAN (butir 3.7) — sumber tabel "Kedatangan" dan
// prefill form Terima di halaman #/purchases/<id>.
app.get('/api/purchases/:id', wajibIzin('pembelian.kelola'), (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id harus integer' }, 400);
  const purchase = db.prepare(`${SQL_PO_HIT} SELECT * FROM hit WHERE id = ?`).get(id) as PoHitung | undefined;
  if (!purchase) return c.json({ error: 'pembelian tidak ada' }, 404);
  const items = db.prepare(
    `SELECT pi.*, ${SQL_PO_BARIS_DITERIMA} AS diterima,
            MAX(0, pi.qty - ${SQL_PO_BARIS_DITERIMA}) AS sisa_terima
       FROM purchase_items pi WHERE pi.purchase_id = ? ORDER BY pi.id`,
  ).all(id);
  const receives = db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM purchase_receive_items ri WHERE ri.receive_id = r.id) AS n_items
       FROM purchase_receives r WHERE r.purchase_id = ? ORDER BY r.id DESC`,
  ).all(id) as { id: number }[];
  const barisTerima = db.prepare(
    `SELECT ri.*, pi.name, pi.qty AS qty_po
       FROM purchase_receive_items ri
       JOIN purchase_receives r ON r.id = ri.receive_id
       JOIN purchase_items pi ON pi.id = ri.purchase_item_id
      WHERE r.purchase_id = ? ORDER BY ri.id`,
  ).all(id) as { receive_id: number }[];
  const petaItems = new Map<number, unknown[]>();
  for (const it of barisTerima) {
    const list = petaItems.get(it.receive_id) ?? [];
    list.push(it);
    petaItems.set(it.receive_id, list);
  }
  return c.json({
    data: { purchase, items, receives: receives.map((r) => ({ ...r, items: petaItems.get(r.id) ?? [] })) },
  });
});

// ---------- Pengaturan toko ----------
// Tabel key/value supaya menambah opsi baru tidak butuh migrasi kolom.
// Nilai disimpan sebagai teks '0'/'1' — angka boolean dilewatkan lewat JSON
// sebagai boolean betulan, karena menebak '1'/true/'ya' dari client adalah
// cara pasti membuat dua device memahami aturan yang berbeda.
const K_STOK_MINUS = 'allow_negative_stock';
const K_TOLAK_KADALUARSA = 'tolak_jual_kadaluarsa';
// Opsi dokumen & struk (riset Aronium 2026-10-20): semuanya SERVER-wide supaya
// semua device mencetak isi yang sama. Teks disimpan sebagai teks biasa,
// pilihan pelanggan sebagai CSV token `name,address,phone` (master pelanggan
// memang tidak punya email — jangan tawarkan token yang tak bisa diisi).
const K_RECEIPT_SHOW_ITEMS = 'receipt_show_items';
const K_RECEIPT_SHORT_NO = 'receipt_short_no';
const K_RECEIPT_SHOW_DEBT = 'receipt_show_debt';
const K_BOOL_SETTING = new Set<string>([
  K_STOK_MINUS, K_TOLAK_KADALUARSA,
  K_RECEIPT_SHOW_ITEMS, K_RECEIPT_SHORT_NO, K_RECEIPT_SHOW_DEBT,
]);
// Kop INVOICE A4 (cetak gaya Aronium) — teks biasa, bukan boolean. Empat kunci
// ini disimpan di server supaya semua device mencetak kop yang sama (beda dengan
// preferensi cetak per-device yang sifatnya hardware). Seed default = contoh
// pemilik; diubah lewat kartu "Pengaturan toko" di halaman #/settings.
const K_STORE = ['store_name', 'store_address', 'store_phone', 'store_email'] as const;
// Teks dokumen tambahan: judul + footer A4, footer struk thermal, dan pilihan
// detail pelanggan di struk thermal. Semua update PARSIAL (kunci yang tidak
// dikirim tidak diubah), sama seperti store_*.
const K_DOKUMEN = ['invoice_title', 'invoice_footer', 'receipt_footer', 'receipt_customer'] as const;
const RE_K_TEKS = new Set<string>([...K_STORE, ...K_DOKUMEN]);
const TOKEN_PELANGGAN = new Set(['name', 'address', 'phone']);

function settingBool(key: string, bawaan: boolean): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value === '1' : bawaan;
}

// `string`: `store_logo` juga dibaca lewat helper ini tapi SENGAJA bukan
// bagian K_STORE — nilainya HANYA boleh ditulis endpoint unggah
// logo, tidak lewat POST /api/settings (nama file di img/ ≠ teks bebas).
function settingStr(key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

/** Beda dengan `settingStr`: baris yang TIDAK ADA memakai bawaan, sedangkan
 *  baris yang ada walau isinya '' dihormati (mis. pemilik mengosongkan footer
 *  untuk menyembunyikannya). */
function settingStrAtau(key: string, bawaan: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : bawaan;
}

function semuaSettings() {
  return {
    allow_negative_stock: settingBool(K_STOK_MINUS, false),
    tolak_jual_kadaluarsa: settingBool(K_TOLAK_KADALUARSA, false),
    store_name: settingStr('store_name'),
    store_address: settingStr('store_address'),
    store_phone: settingStr('store_phone'),
    store_email: settingStr('store_email'),
    // Logo toko untuk struk thermal (butir ROADMAP 1.6.4, 2026-10-19): NAMA
    // file di img/ (pola avatar), bukan isi gambar — '' = tanpa logo.
    store_logo: settingStr('store_logo'),
    // Opsi dokumen & struk (riset Aronium 2026-10-20). Default: judul/footer
    // serta nama pelanggan seperti perilaku lama; jumlah item dan total hutang
    // pelanggan MENYALA supaya fitur baru langsung terlihat (pemilik bisa
    // mematikannya), nomor invoice tetap penuh (short = opt-in).
    invoice_title: settingStrAtau('invoice_title', 'INVOICE'),
    // Footer dokumen A4: baris "Dicetak melalui Ravaa POS pada: <tanggal>" selalu dicetak klien;
    // kunci ini hanya teks TAMBAHAN (default kosong sejak 2026-10-21).
    invoice_footer: settingStrAtau('invoice_footer', ''),
    receipt_footer: settingStrAtau('receipt_footer', 'Terima kasih sudah berbelanja'),
    receipt_customer: settingStrAtau('receipt_customer', 'name'),
    receipt_show_items: settingBool(K_RECEIPT_SHOW_ITEMS, true),
    receipt_short_no: settingBool(K_RECEIPT_SHORT_NO, false),
    receipt_show_debt: settingBool(K_RECEIPT_SHOW_DEBT, true),
  };
}

app.get('/api/settings', (c) => c.json({ data: semuaSettings() }));

// Update PARSIAL: kunci yang tidak dikirim TIDAK diubah, minimal satu wajib ada.
// Boolean harus boolean sungguhan (angka 0/1, "ya", null ditolak); kunci teks
// (store_*/dokumen) harus TEKS (string) — salah tipe = 400 dengan nama kuncinya.
// SEMUA validasi dilakukan sebelum menulis, supaya payload yang sebagian salah
// tidak meninggalkan setengah perubahan.
app.post('/api/settings', hanyaOwner, async (c) => {
  try {
    const body = await c.req.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'payload harus object' }, 400);
    }
    const entries = Object.entries(body ?? {});
    if (!entries.length) {
      return c.json({ error: 'tidak ada pengaturan yang dikirim (boleh: allow_negative_stock, tolak_jual_kadaluarsa, store_*, invoice_*, receipt_*)' }, 400);
    }
    // Validasi nama kunci dulu — kunci tak dikenal tidak boleh menulis apa pun.
    for (const [k] of entries) {
      if (!K_BOOL_SETTING.has(k) && !RE_K_TEKS.has(k)) {
        return c.json({ error: `pengaturan tidak dikenal: ${k}` }, 400);
      }
    }
    const siap = new Map<string, string>();
    for (const [k, v] of entries) {
      if (K_BOOL_SETTING.has(k)) {
        if (typeof v !== 'boolean') {
          return c.json({ error: `${k} harus boolean (true|false)` }, 400);
        }
        siap.set(k, v ? '1' : '0');
        continue;
      }
      if (typeof v !== 'string') {
        return c.json({ error: `${k} harus teks (string)` }, 400);
      }
      let nilai = v.trim();
      if (k === 'receipt_customer') {
        // CSV token; urutan dipertahankan, duplikat dibuang, token asing ditolak
        // (klien lama/tangan nakal tidak boleh membuat struk membaca kolom yang
        // tidak ada).
        const token = nilai.split(',').map((t) => t.trim()).filter(Boolean);
        const asing = token.find((t) => !TOKEN_PELANGGAN.has(t));
        if (asing) {
          return c.json({ error: `receipt_customer tidak dikenal: ${asing} (boleh: name,address,phone)` }, 400);
        }
        nilai = [...new Set(token)].join(',');
      }
      siap.set(k, nilai);
    }
    const simpan = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    // Satu transaction: semua kunci tersimpan bersama, dan audit ikut rollback
    // bila ada kegagalan tulis di tengah.
    transaksi(() => {
      for (const [k, v] of siap) simpan.run(k, v);
      catatAudit(c, 'update', 'setting', Object.keys(body).join('+'), body);
    })();
    return c.json({ data: semuaSettings() });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan pengaturan' }, 400);
  }
});

// ---------- Logo toko untuk struk thermal (butir ROADMAP 1.6.4, ACC pemilik 19 Okt 2026) ----------
// File disimpan di img/ sebelah DB (pola foto produk/avatar — folder dibuat
// sendiri oleh API); tabel settings hanya menyimpan NAMANYA (`store_logo`),
// bukan localStorage: logo milik TOKO, semua device kasir harus mencetak logo
// yang sama. Konversi raster ESC/POS (`GS v 0`) dilakukan di KLIEN saat cetak
// (apps/web/src/logo-struk.ts) — server nol-dependensi tidak mengolah gambar.
const RE_LOGO_NAMA = /^logo-\d+\.(jpg|png|webp)$/;

/** Satu-satunya penulis kunci `store_logo` (nama file) — lihat komentar blok. */
function simpanSettingLogo(nama: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('store_logo', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(nama);
}

app.post('/api/settings/logo', hanyaOwner, async (c) => {
  try {
    const body = await c.req.json();
    const kiriman = body?.image;
    // Tanpa kunci `image` sama sekali = 400, bukan dianggap hapus (pola foto
    // produk): menghapus logo karena payload tidak lengkap terlalu mahal.
    if (kiriman === undefined) return c.json({ error: 'image wajib diisi ("" untuk menghapus logo)' }, 400);
    const lama = settingStr('store_logo');
    if (kiriman === null || String(kiriman).trim() === '') {
      if (lama) buangFileFoto(lama);
      simpanSettingLogo('');
      catatAudit(c, 'update', 'setting', 'store_logo', { logo: null });
      return c.json({ data: { store_logo: '' } });
    }
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(kiriman).trim());
    if (!m) return c.json({ error: 'image harus dataURL data:image/...;base64' }, 400);
    const ext = IMG_EXT[m[1].toLowerCase()];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0) return c.json({ error: 'gambar kosong' }, 400);
    if (buf.length > IMG_MAKS_BYTE) {
      return c.json({
        error: `logo terlalu besar (${buf.length} byte, maks ${IMG_MAKS_BYTE}) — resize dulu di client`,
      }, 400);
    }
    const nama = `logo-${Date.now()}.${ext}`;
    imgDir(); // pastikan folder ada
    fs.writeFileSync(path.join(imgDir(), nama), buf);
    if (lama) buangFileFoto(lama); // nama berganti tiap unggah → file lama dibuang
    simpanSettingLogo(nama);
    catatAudit(c, 'update', 'setting', 'store_logo', { logo: nama });
    return c.json({ data: { store_logo: nama } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal unggah logo' }, 400);
  }
});

app.get('/api/settings/logo', (c) => {
  const nama = settingStr('store_logo');
  // Belum diunggah = 204 TANPA body (sengaja BUKAN 404): jalur cetak thermal
  // memanggil endpoint ini tiap sesi perangkat, dan 404 rutin muncul sebagai
  // "Failed to load resource" di console kasir — sekaligus memerahkan suite
  // e2e "tanpa error console". 404 tetap dipakai untuk nilai KORUP/file hilang.
  if (!nama) return c.body(null, 204);
  // Guard GANDA (pola GET /api/backup/:nama): nilai kolom + basename WAJIB
  // cocok pola — nilai korup tidak boleh jadi jalur baca file sembarangan.
  if (!RE_LOGO_NAMA.test(nama)) return c.json({ error: 'logo tidak ada' }, 404);
  const file = path.join(imgDir(), path.basename(nama));
  if (!fs.existsSync(file)) return c.json({ error: 'file logo hilang' }, 404);
  const etag = `"${nama}"`; // nama berganti tiap unggah → ETag = cache-buster alami
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  const buf = fs.readFileSync(file);
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': IMG_MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream',
    'ETag': etag,
    'Cache-Control': 'no-cache',
  });
});

// ---------- jejak audit (2026-10-16) — daftar untuk halaman #/audit ----------
// Read-only. Khusus owner (memuat aktivitas semua akun). Filter: `entity`
// persis, `q` multi-kata (pola search produk/customers), `date` YYYY-MM-DD
// (divalidasi round-trip `SELECT date(?)` — 2026-02-31 ditolak, bukan halaman
// kosong palsu). Tanpa date = seluruh riwayat. Urutan id DESC (terbaru dulu).
app.get('/api/audit', hanyaOwner, (c) => {
  const entity = (c.req.query('entity') ?? '').trim();
  const q = (c.req.query('q') ?? '').trim();
  const tanggal = (c.req.query('date') ?? '').trim();
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (entity) { conds.push('entity = ?'); params.push(entity); }
  for (const k of q.split(/\s+/).filter(Boolean)) {
    // SEMUA kata harus cocok di gabungan kolom — tidak harus field/urutan sama.
    conds.push(
      `lower(username || ' ' || action || ' ' || entity || ' ' || entity_id || ' ' || detail) LIKE ?`,
    );
    params.push(`%${k.toLowerCase()}%`);
  }
  if (tanggal) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
      return c.json({ error: 'date harus format YYYY-MM-DD' }, 400);
    }
    const sah = db.prepare('SELECT date(?) AS d').get(tanggal) as { d: string | null };
    if (sah.d !== tanggal) return c.json({ error: 'date harus format YYYY-MM-DD' }, 400);
    conds.push('date(at) = date(?)');
    params.push(tanggal);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params) as { n: number }).n;
  const data = db.prepare(
    `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return c.json({ data, total });
});

// ---------- backup DB ----------
// Salin konsisten lewat online backup API better-sqlite3 (`db.backup()` —
// async, snapshot WAL-aman, boleh menimpa file yang sudah ada). File disimpan
// di `backups/` SEBELAH file DB (ikut DB_PATH — pola sama dengan folder img/),
// jadi Docker / install native / test DB_PATH khusus tidak saling menimpa.
const BACKUP_DIR = path.join(path.dirname(dbPath), 'backups');
const KEEP = 14; // retensi: simpan 14 file terbaru
// Nama: data-YYYY-MM-DD-HHMMSS.db (komponen UTC — satu aturan hari UTC dengan
// seluruh repo). Fixed-width -> urut leksikografis = urut kronologis.
const POLA_BACKUP = /^data-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;
// Nama yang sedang/sudah dipilih proses ini (lihat buatBackup) — dua POST pada
// detik yang sama jangan berebut satu nama file dan saling menimpa.
const NAMA_BACKUP_TERPAKAI = new Set<string>();

function backupDir(): string {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return BACKUP_DIR;
}

function daftarBackup(): { nama: string; ukuran: number; waktu: string }[] {
  const dir = backupDir();
  return fs.readdirSync(dir)
    .filter((n) => POLA_BACKUP.test(n))
    .sort().reverse() // terbaru dulu (leksikografis = kronologis utk format ini)
    .map((nama) => {
      const st = fs.statSync(path.join(dir, nama));
      const t = st.mtime.toISOString();
      return { nama, ukuran: st.size, waktu: t };
    });
}

// Buat satu backup + verifikasi + retensi. Hanya dipanggil dari jalankanBackup
// supaya aturan "backup yang rusak jangan disimpan" ada di SATU tempat.
async function buatBackup(): Promise<{ nama: string; ukuran: number; waktu: string }> {
  const dir = backupDir();
  // Nama = detik UTC saat dibuat. Dua backup pada detik YANG SAMA (klik ganda /
  // scheduler + klik manual) akan berebut satu nama dan yang kedua MENIMPA yang
  // pertama — padahal POST dijanjikan selalu membuat file BARU. Reservasi nama
  // sinkron (cek + catat sebelum await pertama): di satu proses Node tidak ada
  // jeda antar-langkah sinkron, jadi klien yang masuk beruntun tidak bisa lolos
  // cek yang sama. Kalau nama sudah terpakai, geser +1 detik (masih urut
  // leksikografis = kronologis, dan detik "ke depan" itu unik sampai dilewati
  // waktu nyata — sementara file sudah ada, jadi cek berikutnya menolaknya).
  const pad = (n: number) => String(n).padStart(2, '0');
  const bentuk = (t: Date) =>
    `data-${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `-${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}.db`;
  let t = new Date();
  let nama = bentuk(t);
  while (NAMA_BACKUP_TERPAKAI.has(nama) || fs.existsSync(path.join(dir, nama))) {
    t = new Date(t.getTime() + 1000);
    nama = bentuk(t);
  }
  NAMA_BACKUP_TERPAKAI.add(nama);
  const file = path.join(dir, nama);
  try {
    await db.backup(file);
  } catch (e) {
    NAMA_BACKUP_TERPAKAI.delete(nama); // gagal total -> nama bebas dipakai lagi
    throw e;
  }

  // Source dalam WAL -> file backup ikut header WAL, jadi setelah dibuka
  // meninggalkan pendamping .db-shm/.db-wal. Restore manual (salin-satu-file)
  // jadi tidak portabel & folder backups ikut kotor. Dipaksa ke DELETE:
  // SQLite checkpoint + menghapus -wal/-shm sendiri saat ganti mode.
  // Integrity check file HASIL dilakukan sesudahnya — file rusak (disk penuh
  // dsb) dibuang, jangan menumpuk sebagai "backup" yang ternyata tidak bisa
  // direstore. Bukan 'ok' -> lempar error (ditangkap pemanggil).
  let parah = false;
  try {
    const cek = new Database(file, { fileMustExist: true });
    cek.pragma('journal_mode = DELETE');
    const hasil = cek.pragma('integrity_check') as { integrity_check: string }[];
    parah = hasil.length !== 1 || hasil[0].integrity_check !== 'ok';
    cek.close();
  } catch {
    parah = true;
  }
  if (parah) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    throw new Error('integrity check gagal — file backup dibuang');
  }

  // Retensi: buang semua kecuali KEEP terbaru (urutan nama = kronologis).
  // Pendamping -shm/-wal (sisa file versi lama) ikut dibuang supaya bersih.
  const semua = fs.readdirSync(dir).filter((n) => POLA_BACKUP.test(n)).sort().reverse();
  for (const lama of semua.slice(KEEP)) {
    fs.rmSync(path.join(dir, lama), { force: true });
    fs.rmSync(path.join(dir, `${lama}-shm`), { force: true });
    fs.rmSync(path.join(dir, `${lama}-wal`), { force: true });
  }
  // Pengaman pembersihan: walau journal_mode=DELETE seharusnya sudah menghapus
  // pendamping, buang sisa apa pun (mis. dari file lama sebelum aturan ini).
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });

  const st = fs.statSync(file);
  return { nama, ukuran: st.size, waktu: st.mtime.toISOString() };
}

// Jadwal harian IDEMPOTEN: cek "sudah ada file data-<hari-UTC>-*.db?"
// Bukan sekadar setInterval(24 jam) — API sering di-restart (tsx watch),
// interval murni bisa tidak pernah mencapai 24 jam atau menumpuk saat restart.
// Cek per jam: gap maksimal ±25 jam, restart bebas berapa kali.
function backupHarian(): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const hari =
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const sudah = fs.readdirSync(backupDir())
      .some((n) => n.startsWith(`data-${hari}-`) && POLA_BACKUP.test(n));
    if (sudah) return;
    void buatBackup()
      .then((r) => console.log(`[backup] ${r.nama} (${r.ukuran} byte)`))
      .catch((e) => console.error('[backup] GAGAL:', e instanceof Error ? e.message : e));
  } catch (e) {
    console.error('[backup] GAGAL:', e instanceof Error ? e.message : e);
  }
}
backupHarian(); // sekali saat API hidup (idempoten — restart aman)
setInterval(backupHarian, 60 * 60 * 1000); // lalu cek tiap jam

// Daftar file backup (terbaru dulu).
app.get('/api/backup', hanyaOwner, (c) => c.json({ data: daftarBackup() }));

// Backup manual — selalu membuat file BARU (tanpa cek "hari ini sudah ada";
// cek harian hanya untuk scheduler). Integrity check + retensi tetap berlaku.
app.post('/api/backup', hanyaOwner, async (c) => {
  try {
    return c.json({ data: await buatBackup() }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'backup gagal' }, 500);
  }
});

// Unduh satu file backup. Guard GANDA (pola sama dengan endpoint foto):
// path.basename MEMASTIKAN tidak bisa keluar folder backups/, lalu whitelist
// pola nama file — nama lain (termasuk traversal yang sudah dinormalisasi)
// tetap 404. Jangan pernah menerima nama file apa pun yang ditulis client.
app.get('/api/backup/:nama', hanyaOwner, (c) => {
  const nama = c.req.param('nama');
  if (path.basename(nama) !== nama || !POLA_BACKUP.test(nama)) {
    return c.json({ error: 'file backup tidak ada' }, 404);
  }
  const file = path.join(backupDir(), nama);
  if (!fs.existsSync(file)) return c.json({ error: 'file backup tidak ada' }, 404);
  const buf = fs.readFileSync(file);
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${nama}"`,
    'Cache-Control': 'no-store',
  });
});

// Pulihkan DB dari file backup (2026-10-16, tombol "Pulihkan" di #/settings).
// Urutan KESELAMATAN yang tidak boleh diubah:
//   1. nama divalidasi guard GANDA (basename + whitelist POLA_BACKUP);
//   2. file diverifikasi READ-ONLY (integrity_check === 'ok') — file korup
//      tidak pernah sampai menggantikan DB hidup;
//   3. backup PENGAMAN dibuat dari state sekarang (kalau restore salah pilih,
//      keadaan sebelumnya masih bisa diunduh/dipulihkan balik);
//   4. baru pulihkanDari (db.ts) — salin sementara dulu, tukar file, buka ulang.
// CATATAN PENTING: tabel `sessions` ikut ter-restore, jadi semua device (termasuk
// pemanggil) bisa ter-logout dan harus masuk ulang — perilakunya wajar, bukan bug.
// Baris audit 'restore' ditulis SESUDAH pulihkan supaya tersimpan di DB hasil
// restore (kalau ditulis sebelum, ia ikut terhapus oleh pemulihan itu sendiri).
app.post('/api/backup/restore', hanyaOwner, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const nama = String(body?.nama ?? '');
  if (path.basename(nama) !== nama || !POLA_BACKUP.test(nama)) {
    return c.json({ error: 'file backup tidak ada' }, 404);
  }
  const file = path.join(backupDir(), nama);
  if (!fs.existsSync(file)) return c.json({ error: 'file backup tidak ada' }, 404);
  try {
    const cek = new Database(file, { readonly: true, fileMustExist: true });
    const hasil = cek.pragma('integrity_check') as { integrity_check: string }[];
    cek.close();
    if (hasil.length !== 1 || hasil[0].integrity_check !== 'ok') {
      return c.json({ error: 'file backup rusak (integrity check gagal) — tidak dipulihkan' }, 400);
    }
  } catch {
    return c.json({ error: 'file backup tidak bisa dibaca — tidak dipulihkan' }, 400);
  }
  let pengaman: { nama: string };
  try {
    pengaman = await buatBackup();
  } catch (e) {
    return c.json(
      { error: `gagal membuat backup pengaman sebelum restore: ${e instanceof Error ? e.message : e}` },
      500,
    );
  }
  try {
    pulihkanDari(file);
  } catch (e) {
    return c.json({ error: `gagal memulihkan: ${e instanceof Error ? e.message : e}` }, 500);
  }
  catatAudit(c, 'restore', 'backup', nama, { pengaman: pengaman.nama });
  return c.json({ data: { nama, pengaman: pengaman.nama } });
});

// ---------- laporan harian ----------
/** Satu sumber agregat laporan (daily + summary range, 2026-10-11): bentuk
 *  kembaliannya IDENTIK — bedanya hanya jendela tanggal (`=` sehari vs
 *  `BETWEEN` rentang). `piutang` = hutang TERBENTUK (CASE sisa_hutang persis
 *  GET /api/sales) + TERBAYAR (ledger payment) — butir credit Z-report. */
function laporanRentang(dari: string, sampai: string) {
  const dl = (kol: string) => `date(${kol}) BETWEEN date(?) AND date(?)`;
  const ps: [string, string] = [dari, sampai];
  const sales = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS omzet, COALESCE(SUM(discount),0) AS diskon
     FROM sales WHERE ${dl('created_at')}`,
  ).get(...ps) as { n: number; omzet: number; diskon: number };
  // `diskon` = diskon transaksi + diskon PER BARIS. Tanpa penjumlahan ini angka
  // diskon menyembunyikan potongan per baris padahal omzet sudah menguranginya,
  // lalu `subtotal - total` di layar laporan tidak pernah cocok dengan angka ini.
  sales.diskon += (db.prepare(
    `SELECT COALESCE(SUM(si.discount),0) AS d
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE ${dl('s.created_at')}`,
  ).get(...ps) as { d: number }).d;
  // Rincian per metode (split 1.6.5): dibaca dari `sale_payments` — tiap nota
  // teratribusi penuh ke metodenya, jadi Σ total tetap = omzet; nota lama
  // tanpa baris jatuh ke (pay_method, total). `n` = COUNT(DISTINCT sale_id):
  // satu nota split terhitung di SETIAP metodenya sehingga Σ n >= sales.n
  // (bukan bug — laporan-test menguji `tMethod === omzet` yang tetap eksak).
  const byMethod = db.prepare(
    `SELECT metode AS pay_method, COUNT(DISTINCT sale_id) AS n, COALESCE(SUM(amount),0) AS total
       FROM (
         SELECT sp.method AS metode, sp.sale_id AS sale_id, sp.amount AS amount
           FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
          WHERE ${dl('s.created_at')}
         UNION ALL
         SELECT s.pay_method AS metode, s.id AS sale_id, s.total AS amount
           FROM sales s
          WHERE ${dl('s.created_at')}
            AND NOT EXISTS (SELECT 1 FROM sale_payments sp2 WHERE sp2.sale_id = s.id)
       ) x
      GROUP BY metode
      ORDER BY metode`,
  ).all(...ps, ...ps) as { pay_method: string; n: number; total: number }[];
  const topup = db.prepare(
    `SELECT kind, COUNT(*) AS n, COALESCE(SUM(nominal),0) AS nominal, COALESCE(SUM(admin),0) AS admin
     FROM topup_txns WHERE ${dl('created_at')} GROUP BY kind`,
  ).all(...ps);
  // Dikelompokkan per (name, unit) — tanpa `unit`, penjualan "2 pack" dan
  // "3 btl" produk sama jadi satu baris qty=5 campur satuan.
  // `hpp`/`laba` per baris DIHITUNG SERVER (2026-10-17): rumus laba per produk
  // hanya boleh hidup di satu tempat, supaya kartu Harian dan menu Produk
  // tidak bisa menampilkan angka berbeda. laba = Σ(amount − diskon baris) − HPP
  // baris; diskon TRANSAKSI tidak dialokasikan ke baris (tidak diketahui porsi
  // per produknya) — jadi Σ laba baris ≥ laba rekap saat ada diskon transaksi.
  const topItems = db.prepare(
    `SELECT si.name, si.unit, SUM(si.qty) AS qty, SUM(si.amount) AS amount,
            CAST(ROUND(SUM(si.qty * si.cost)) AS INTEGER) AS hpp,
            CAST(ROUND(SUM(si.amount - si.discount) - SUM(si.qty * si.cost)) AS INTEGER) AS laba
     FROM sale_items si JOIN sales s ON s.id=si.sale_id
     WHERE ${dl('s.created_at')} GROUP BY si.name, si.unit ORDER BY amount DESC LIMIT 10`,
  ).all(...ps);
  // Penjualan per KATEGORI (roadmap 2.2, 2026-10-18 — menu "Kategori" halaman
  // Laporan): sumbangsih tiap kategori dalam rentang (jasa/cetak vs barang
  // fisik terlihat beda). Rumus amount/hpp/laba SAMA PERSIS dengan topItems/
  // menu Produk (laba = Σ(amount − diskon baris) − HPP baris; diskon TRANSAKSI
  // tidak dialokasikan ke baris). Baris manual (product_id NULL) tidak punya
  // kategori → dikelompokkan "Tanpa kategori" supaya Σ tabel tetap menutup
  // seluruh baris penjualan. `GROUP BY c.id` (bukan nama) + tanpa LIMIT —
  // kategori master terbatas.
  const byCategory = db.prepare(
    `SELECT COALESCE(c.name, 'Tanpa kategori') AS name,
            SUM(si.amount) AS amount,
            CAST(ROUND(SUM(si.qty * si.cost)) AS INTEGER) AS hpp,
            CAST(ROUND(SUM(si.amount - si.discount) - SUM(si.qty * si.cost)) AS INTEGER) AS laba
     FROM sale_items si JOIN sales s ON s.id=si.sale_id
     LEFT JOIN products p ON p.id=si.product_id
     LEFT JOIN categories c ON c.id=p.category_id
     WHERE ${dl('s.created_at')} GROUP BY c.id ORDER BY amount DESC`,
  ).all(...ps);
  // Penjualan per JAM (menu Harian + grafik 24 batang, 2026-10-17). 24 ember
  // 0..23 SELALU terisi — server yang menambal jam kosong (klien/chart tidak
  // perlu menghitung ulang). Jam = UTC apa adanya, aturan waktu repo
  // (ui/waktu.ts): laporan, riwayat, dan struk membaca jam yang sama.
  const petaJam = new Map(
    (db.prepare(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS jam,
              COUNT(*) AS n, COALESCE(SUM(total),0) AS omzet
         FROM sales WHERE ${dl('created_at')} GROUP BY jam`,
    ).all(...ps) as { jam: number; n: number; omzet: number }[]).map((b) => [b.jam, b]),
  );
  const byHour = Array.from({ length: 24 }, (_, jam) => petaJam.get(jam) ?? { jam, n: 0, omzet: 0 });
  const lowStock = db.prepare(
    `SELECT p.sku, p.name, p.stock, p.min_stock FROM products p
     JOIN categories c ON c.id=p.category_id
     WHERE c.track_stock=1 AND p.is_active=1 AND p.stock <= p.min_stock ORDER BY p.stock ASC LIMIT 20`,
  ).all();
  // HPP = jumlah qty*cost baris yang sudah di-snapshot saat jual (lihat insertSale).
  // Dibulatkan ke integer rupiah: qty REAL x cost INTEGER bisa pecahan.
  const hpp = Math.round((db.prepare(
    `SELECT COALESCE(SUM(si.qty * si.cost), 0) AS hpp
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE ${dl('s.created_at')}`,
  ).get(...ps) as { hpp: number }).hpp);
  // laba = omzet SETELAH diskon - HPP. Jasa/cetak punya cost 0, jadi seluruh
  // penjualannya dihitung sebagai laba (tidak ada biaya persediaan yang dilacak).
  const laba = (sales as { omzet: number }).omzet - hpp;
  // Pengeluaran kas (Tahap 1, 2026-10-11) — dilaporkan TERPISAH,
  // tidak menggerus laba (laba = laba kotor dagang, definisi lama tetap).
  const expense = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(jumlah),0) AS total
     FROM expenses WHERE ${dl('created_at')}`,
  ).get(...ps) as { n: number; total: number };
  // Kas masuk non-penjualan (butir ROADMAP 1.6.2, 2026-10-19) — pasangan
  // pengeluaran; dilaporkan TERPISAH, tidak menambah omzet/laba.
  const kasMasuk = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(jumlah),0) AS total
     FROM kas_masuk WHERE ${dl('created_at')}`,
  ).get(...ps) as { n: number; total: number };
  // Retur (Tahap 2, 2026-10-11) — dilaporkan TERPISAH + dipakai kartu
  // "Omzet bersih" (keputusan (c) hybrid: kotor + retur + bersih). Total =
  // uang kembali (SUM returns.total), bukan qty.
  const retur = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total
     FROM returns WHERE ${dl('created_at')}`,
  ).get(...ps) as { n: number; total: number };
  // Pembelian yang DITERIMA (Tahap 3, 2026-10-11; BERTAHAP sejak butir 3.7
  // 2026-10-25) — per KEDATANGAN, bukan per nota: satu PO yang datang
  // bertahap tercatat 1 kedatangan di hari masing-masing (nilai = barang yang
  // benar-benar masuk hari itu). Nota LAMA (received tanpa baris kedatangan,
  // fitur ini baru) tetap dihitung 1 event lewat tanggal `received_at` —
  // tanpa fallback ini seluruh riwayat pembelian hilang dari laporan.
  const purchase = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM purchase_receives r WHERE ${dl('r.created_at')})
       + (SELECT COUNT(*) FROM purchases p
           WHERE p.status = 'received' AND NOT EXISTS (
             SELECT 1 FROM purchase_receives r2 WHERE r2.purchase_id = p.id)
             AND ${dl('p.received_at')}) AS n,
       (SELECT COALESCE(SUM(r.total),0) FROM purchase_receives r WHERE ${dl('r.created_at')})
       + (SELECT COALESCE(SUM(p.total),0) FROM purchases p
           WHERE p.status = 'received' AND NOT EXISTS (
             SELECT 1 FROM purchase_receives r2 WHERE r2.purchase_id = p.id)
             AND ${dl('p.received_at')}) AS total`,
  ).get(...ps, ...ps, ...ps, ...ps) as { n: number; total: number };
  // Piutang (butir credit Z-report Aronium): TERBENTUK = porsi tunai tak
  // masuk laci (CASE persis penanda sisa_hutang) + hutang serah pesanan jasa
  // (butir ROADMAP 1.6.6, 2026-10-19: orders.hutang_sisa saat diserahkan —
  // piutang baru hanya tercatat sekali di hari SERAH, bukan hari DP);
  // TERBAYAR = payment ledger (termasuk pelunasan hutang pesanan).
  const piutangBaru = (db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN pay_method='tunai' AND total > cash_in
       AND customer_id IS NOT NULL AND customer_name <> 'Pelanggan Umum'
      THEN total - cash_in ELSE 0 END),0) AS t
     FROM sales WHERE ${dl('created_at')}`,
  ).get(...ps) as { t: number }).t
    + (db.prepare(
      `SELECT COALESCE(SUM(hutang_sisa),0) AS t FROM orders
        WHERE status = 'diambil' AND hutang_sisa > 0 AND ${dl('taken_at')}`,
    ).get(...ps) as { t: number }).t;
  const piutangBayar = (db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS t FROM customer_debts
     WHERE type = 'payment' AND ${dl('created_at')}`,
  ).get(...ps) as { t: number }).t;
  return {
    sales, hpp, laba, byMethod, topup, topItems, lowStock, expense, kas_masuk: kasMasuk, retur, purchase, byHour, byCategory,
    piutang: { baru: piutangBaru, bayar: piutangBayar },
  };
}

/** Validasi rentang tanggal YYYY-MM-DD (pola round-trip bacaHari): keduanya
 *  valid, dari <= sampai, dan maksimal 366 hari (anti-abu query setahun). */
function bacaRentang(query: (k: string) => string | undefined):
  | { ok: true; dari: string; sampai: string }
  | { ok: false; error: string } {
  const hariIni = new Date().toISOString().slice(0, 10);
  const dari = query('from') ?? query('date') ?? hariIni;
  const sampai = query('to') ?? query('date') ?? hariIni;
  for (const h of [dari, sampai]) {
    const d = new Date(`${h}T00:00:00Z`);
    if (!RE_TGL.test(h) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== h) {
      return { ok: false, error: 'from/to harus format YYYY-MM-DD' };
    }
  }
  if (dari > sampai) return { ok: false, error: 'from tidak boleh sesudah to' };
  const beda = (new Date(`${sampai}T00:00:00Z`).getTime() - new Date(`${dari}T00:00:00Z`).getTime()) / 86400000;
  if (beda > 366) return { ok: false, error: 'rentang maksimal 366 hari' };
  return { ok: true, dari, sampai };
}

app.get('/api/reports/daily', wajibIzin('laporan.lihat'), (c) => {
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return c.json({ data: { date, ...laporanRentang(date, date) } });
});

/** Rekap rentang tanggal (menu laporan ala Aronium, 2026-10-11): bentuk
 *  SAMA dengan daily, jendela `from..to` inklusif. `lowStock` snapshot kini
 *  (bukan per tanggal — stok adalah keadaan sekarang). */
app.get('/api/reports/summary', wajibIzin('laporan.lihat'), (c) => {
  const r = bacaRentang((k) => c.req.query(k));
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json({ data: { from: r.dari, to: r.sampai, ...laporanRentang(r.dari, r.sampai) } });
});

/** Penjualan per kasir dalam rentang (menu Kasir): n + omzet + diskon
 *  (transaksi + per baris, rumus konsisten dengan sales.diskon). */
app.get('/api/reports/cashiers', wajibIzin('laporan.lihat'), (c) => {
  const r = bacaRentang((k) => c.req.query(k));
  if (!r.ok) return c.json({ error: r.error }, 400);
  const dl = `date(s.created_at) BETWEEN date(?) AND date(?)`;
  const rows = db.prepare(
    `SELECT s.cashier, COUNT(*) AS n, COALESCE(SUM(s.total),0) AS omzet,
            COALESCE(SUM(s.discount),0) +
            COALESCE((SELECT SUM(si.discount) FROM sale_items si
                       JOIN sales s2 ON s2.id = si.sale_id
                      WHERE s2.cashier = s.cashier
                        AND date(s2.created_at) BETWEEN date(?) AND date(?)),0) AS diskon
       FROM sales s WHERE ${dl} GROUP BY s.cashier ORDER BY omzet DESC`,
  ).all(r.dari, r.sampai, r.dari, r.sampai) as
    { cashier: string; n: number; omzet: number; diskon: number }[];
  const total = rows.reduce(
    (a, x) => ({ n: a.n + x.n, omzet: a.omzet + x.omzet, diskon: a.diskon + x.diskon }),
    { n: 0, omzet: 0, diskon: 0 },
  );
  return c.json({ data: { from: r.dari, to: r.sampai, rows, total } });
});

/** Produk dalam rentang (menu Produk): per (nama, satuan) qty + omzet + HPP +
 *  laba. `laba` DIHITUNG SERVER sejak 2026-10-17 dengan rumus yang sama
 *  persis dengan topItems kartu Harian (Σ(amount − diskon baris) − HPP baris;
 *  diskon transaksi tidak dialokasikan ke baris) — jangan dihitung ulang di
 *  klien. `q` multi-kata pola customers; limit 50/200. */
app.get('/api/reports/products', wajibIzin('laporan.lihat'), (c) => {
  const r = bacaRentang((k) => c.req.query(k));
  if (!r.ok) return c.json({ error: r.error }, 400);
  const q = (c.req.query('q') ?? '').trim();
  const kata = q.split(/\s+/).filter(Boolean);
  const conds = kata.map(() => 'lower(si.name) LIKE ?');
  const params: unknown[] = [];
  for (const k of kata) params.push(`%${k.toLowerCase()}%`);
  const qcari = conds.length ? `AND ${conds.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const dl = `date(s.created_at) BETWEEN date(?) AND date(?)`;
  const rows = db.prepare(
    `SELECT si.name, si.unit, SUM(si.qty) AS qty, SUM(si.amount) AS amount,
            CAST(ROUND(SUM(si.qty * si.cost)) AS INTEGER) AS hpp,
            CAST(ROUND(SUM(si.amount - si.discount) - SUM(si.qty * si.cost)) AS INTEGER) AS laba
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE ${dl} ${qcari} GROUP BY si.name, si.unit ORDER BY amount DESC LIMIT ? OFFSET ?`,
  ).all(r.dari, r.sampai, ...params, limit, offset);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE ${dl} ${qcari} GROUP BY si.name, si.unit)`,
  ).get(r.dari, r.sampai, ...params) as { n: number };
  return c.json({ data: { from: r.dari, to: r.sampai, rows, total: total.n } });
});

/** Laba per hari + per transaksi (menu Laba, 2026-10-17). HPP per NOTA dihitung
 *  lewat subquery agregat per `s.id` DULU — join sale_items langsung ke sales
 *  akan menggandakan `s.total` per baris produk sehingga "omzet per transaksi"
 *  salah. `days` selalu memuat SELURUH hari berisi penjualan di rentang (dasar
 *  angka kartu total); `trx` sengaja dibatasi 200 nota terbaru (layar, bukan
 *  arsip — arsipnya menu Riwayat) dan `total.n` memberi tahu bila terpotong. */
app.get('/api/reports/profit', wajibIzin('laporan.lihat'), (c) => {
  const r = bacaRentang((k) => c.req.query(k));
  if (!r.ok) return c.json({ error: r.error }, 400);
  const dasar = `
    SELECT s.id, s.created_at, s.invoice_no, s.cashier, s.total,
           CAST(ROUND(COALESCE(SUM(si.qty * si.cost), 0)) AS INTEGER) AS hpp
      FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
     WHERE date(s.created_at) BETWEEN date(?) AND date(?)
     GROUP BY s.id`;
  const days = db.prepare(
    `SELECT date(created_at) AS date, COUNT(*) AS n,
            COALESCE(SUM(total),0) AS omzet, COALESCE(SUM(hpp),0) AS hpp,
            COALESCE(SUM(total) - SUM(hpp),0) AS laba
       FROM (${dasar}) GROUP BY date(created_at) ORDER BY date ASC`,
  ).all(r.dari, r.sampai) as { date: string; n: number; omzet: number; hpp: number; laba: number }[];
  const trx = db.prepare(
    `SELECT id, created_at, invoice_no, cashier, total, hpp, total - hpp AS laba
       FROM (${dasar}) ORDER BY created_at DESC, id DESC LIMIT 200`,
  ).all(r.dari, r.sampai);
  const total = days.reduce(
    (a, d) => ({ n: a.n + d.n, omzet: a.omzet + d.omzet, hpp: a.hpp + d.hpp, laba: a.laba + d.laba }),
    { n: 0, omzet: 0, hpp: 0, laba: 0 },
  );
  return c.json({ data: { from: r.dari, to: r.sampai, total, days, trx } });
});

/* Menu Analitik (butir ROADMAP 1.6.7, ACC pemilik 2026-10-19) — LAPORAN
 * PERSEDIAAN, dua bagian dalam SATU endpoint:
 *   (1) `valuasi` = snapshot stok KINI per kategori barang fisik
 *       (`categories.track_stock=1`; jasa/cetak/desain/topup tidak berstok):
 *       `hpp` = Σ stok × avg_cost (modal tertimbang — angka yang sama dengan
 *       HPP jual) dan `jual` = Σ stok × price (satuan dasar; harga grosir/
 *       pack sengaja tidak dikira-kira di sini). Produk nonaktif & tombstone
 *       TIDAK ikut: stoknya sudah tidak di rak. Kategori dihitung hanya bila
 *       ada item berstok ≠ 0 supaya "n item" bermakna (bukan ratusan SKU
 *       berstok 0); item berstok MINUS (allow_negative_stock) ikut apa adanya.
 *   (2) `dead` = barang fisik berstok > 0 yang TIDAK ada penjualan dalam
 *       rentang from..to — "tidak laku N hari" = pilih preset rentang.
 *       `rows` urut nilai stok (stok × avg_cost) DESC (modal menganggur
 *       terbesar di atas), `last_sold` = penjualan terakhir ALL-TIME
 *       (null = belum pernah laku) supaya terlihat musiman vs mati. `n`/
 *       `nilai` dihitung dari SELURUH baris sedangkan `rows` dibatasi
 *       BARIS_ANALITIK_MAKS + `terpotong` — angka kartu selalu penuh. */
const BARIS_ANALITIK_MAKS = 200;
// Menu ke-8 halaman Laporan — izinnya sama dengan laporan lain
// (`laporan.lihat`). Sebelumnya hanyaOwner padahal UI menampilkannya untuk
// siapa pun yang bisa membuka #/reports → 403 di tengah menu (mismatch B4).
app.get('/api/reports/analytics', wajibIzin('laporan.lihat'), (c) => {
  const r = bacaRentang((k) => c.req.query(k));
  if (!r.ok) return c.json({ error: r.error }, 400);

  const valuasiRows = db.prepare(
    `SELECT c.name AS category,
            SUM(CASE WHEN p.stock <> 0 THEN 1 ELSE 0 END) AS n_items,
            COALESCE(SUM(p.stock), 0) AS qty,
            COALESCE(SUM(p.stock * p.avg_cost), 0) AS hpp,
            COALESCE(SUM(p.stock * p.price), 0) AS jual
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = 1 AND p.deleted_at IS NULL AND c.track_stock = 1
      GROUP BY c.id
     HAVING SUM(CASE WHEN p.stock <> 0 THEN 1 ELSE 0 END) > 0
      ORDER BY hpp DESC, c.name COLLATE NOCASE`,
  ).all() as { category: string; n_items: number; qty: number; hpp: number; jual: number }[];
  const valuasiTotal = valuasiRows.reduce(
    (a, v) => ({ n_items: a.n_items + v.n_items, qty: a.qty + v.qty, hpp: a.hpp + v.hpp, jual: a.jual + v.jual }),
    { n_items: 0, qty: 0, hpp: 0, jual: 0 },
  );

  // Klausul WHERE dipakai DUA query (baris + ringkasan) — satu variabel,
  // jangan disalin ulang (salinan pernah jadi sumber selisih di laporan lain).
  const whereTidakLaku = `
      FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.is_active = 1 AND p.deleted_at IS NULL AND c.track_stock = 1
       AND p.stock > 0
       AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                        WHERE si.product_id = p.id
                          AND date(s.created_at) BETWEEN date(?) AND date(?))`;
  const deadRows = db.prepare(
    `SELECT p.id, p.sku, p.name, p.unit, p.stock, p.min_stock, p.avg_cost, p.price,
            p.stock * p.avg_cost AS nilai,
            (SELECT MAX(s2.created_at) FROM sale_items si2 JOIN sales s2 ON s2.id = si2.sale_id
              WHERE si2.product_id = p.id) AS last_sold
       ${whereTidakLaku}
      ORDER BY nilai DESC, p.name COLLATE NOCASE
      LIMIT ${BARIS_ANALITIK_MAKS}`,
  ).all(r.dari, r.sampai) as {
    id: number;
    sku: string;
    name: string;
    unit: string;
    stock: number;
    min_stock: number;
    avg_cost: number;
    price: number;
    nilai: number;
    last_sold: string | null;
  }[];
  const deadRingkas = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(p.stock * p.avg_cost), 0) AS nilai ${whereTidakLaku}`,
  ).get(r.dari, r.sampai) as { n: number; nilai: number };

  return c.json({
    data: {
      from: r.dari,
      to: r.sampai,
      valuasi: { rows: valuasiRows, total: valuasiTotal },
      dead: {
        n: deadRingkas.n,
        nilai: deadRingkas.nilai,
        rows: deadRows,
        terpotong: deadRingkas.n > deadRows.length,
      },
    },
  });
});

const port = Number(process.env.PORT ?? 3001);
const server = serve({ fetch: app.fetch, port });

// Tanpa handler ini, EADDRINUSE muncul sebagai "Unhandled 'error' event" + stack trace
// panjang yang menyesatkan (terdapat beberapa kali di repo ini).
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[PORT ${port} SUDAH DIPAKAI PROSES LAIN]\n` +
        `  lihat pemakainya : ss -tlnp | grep :${port}\n` +
        `  matikan           : kill -9 <PID>\n` +
        `  atau port lain    : PORT=3002 npm run dev:api\n` +
        `  CATATAN: jangan Ctrl+Z (menyuspend -> proses yatim tetap memegang port). Pakai Ctrl+C.`,
    );
    process.exit(1);
  }
  throw err;
});

server.on('listening', () => {
  console.log(`ravaa-pos-api listening on :${port}  (db: ${process.env.DB_PATH ?? './data/data.db'})`);
  console.log(`cek: curl localhost:${port}/health`);
});
