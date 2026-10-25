// Sesi login (2026-10-11): token di localStorage + profil dari /api/me.
//
// Modul ini SENGAJA tidak meng-import api.ts (api.ts yang meng-import
// tokenAuth() dari sini untuk header Authorization — arah sebaliknya akan
// circular). Jadi request di sini memakai fetch mentah + BASE yang sama.
import { setCashier } from './user';
import { punyaIzinAkun } from './izin';

export type Peran = 'owner' | 'kasir';
export interface Akun {
  id: number;
  username: string;
  name: string;
  role: Peran;
  /** Avatar OPSIONAL: nama file di server (img/). Null = inisial nama. */
  avatar?: string | null;
  /** Email opsional profil. */
  email?: string;
  /** Izin operasional efektif (Paket B4). Owner = semua; kasir bisa custom. */
  permissions?: string[];
  /** true = kolom permissions diisi custom (bukan preset default role). */
  permissions_custom?: boolean;
  /** PIN cepat sudah diatur (Paket B5). */
  pin_set?: boolean;
  pin_updated_at?: string | null;
}

const Kunci_TOKEN = 'ravaa.token';
const Kunci_AKUN = 'ravaa.akun';
const Kunci_WAJIB = 'ravaa.wajib-ganti';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export function tokenAuth(): string {
  try {
    return localStorage.getItem(Kunci_TOKEN) ?? '';
  } catch {
    return '';
  }
}

function simpan(token: string, akun: Akun, wajib: boolean): void {
  try {
    localStorage.setItem(Kunci_TOKEN, token);
    localStorage.setItem(Kunci_AKUN, JSON.stringify(akun));
    localStorage.setItem(Kunci_WAJIB, wajib ? '1' : '0');
  } catch {
    /* private mode: abaikan */
  }
  // Identitas kasir mengikuti akun (shift/laporan/struk memakai nama ini).
  setCashier(akun.name);
}

export function bersihSesi(): void {
  meCache = null;
  try {
    localStorage.removeItem(Kunci_TOKEN);
    localStorage.removeItem(Kunci_AKUN);
    localStorage.removeItem(Kunci_WAJIB);
  } catch {
    /* abaikan */
  }
}

/** Profil tersimpan saat login (dibaca SYNC untuk header/sidebar — tanpa
 *  fetch, jadi aman dipanggil dari render tiap navigasi). */
export function akunTersimpan(): { akun: Akun; wajib: boolean } | null {
  try {
    const a = localStorage.getItem(Kunci_AKUN);
    if (!a) return null;
    return { akun: JSON.parse(a) as Akun, wajib: localStorage.getItem(Kunci_WAJIB) === '1' };
  } catch {
    return null;
  }
}

async function posJson(path: string, data: unknown, token = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

let meCache: { akun: Akun; wajib: boolean } | null = null;

/** Masuk: 200 + token tersimpan, atau throw pesan server. */
export async function masuk(username: string, password: string): Promise<{ akun: Akun; wajib: boolean }> {
  const { status, body } = await posJson('/api/login', { username, password });
  const data = body.data as { token?: string; user?: Akun; must_change?: boolean } | undefined;
  if (status !== 200 || !data?.token || !data.user) {
    throw new Error((body.error as string) ?? `HTTP ${status}`);
  }
  const wajib = data.must_change === true;
  simpan(data.token, data.user, wajib);
  meCache = { akun: data.user, wajib };
  return { akun: data.user, wajib };
}

/** Keluar: hapus sesi server (best-effort) + lokal, kembali ke Login. */
export async function keluar(): Promise<void> {
  const t = tokenAuth();
  if (t) {
    try {
      await fetch(`${BASE}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}` },
      });
    } catch {
      /* server mati = sesi lokal tetap dibersihkan */
    }
  }
  bersihSesi();
}

/** Profil sesi berjalan. 401 = token mati -> sesi dibersihkan + null.
 *  Jaringan putus (offline) = pakai simpanan login terakhir supaya kasir
 *  tetap bisa membuka POS dari cache (baca saja). Transaksi TIDAK diantre:
 *  POS menolak menyimpan selama server tak terjangkau — lihat
 *  KEJUJURAN OFFLINE di api.ts. */
export async function profilSaya(): Promise<{ akun: Akun; wajib: boolean } | null> {
  if (!tokenAuth()) return null;
  try {
    const res = await fetch(`${BASE}/api/me`, {
      headers: { Authorization: `Bearer ${tokenAuth()}` },
    });
    if (res.status === 401) {
      bersihSesi();
      meCache = null;
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { user?: Akun; must_change?: boolean } };
    if (!body.data?.user) throw new Error('profil rusak');
    meCache = { akun: body.data.user, wajib: body.data.must_change === true };
    try {
      localStorage.setItem(Kunci_AKUN, JSON.stringify(meCache.akun));
      localStorage.setItem(Kunci_WAJIB, meCache.wajib ? '1' : '0');
    } catch {
      /* abaikan */
    }
    // Nama kasir perangkat IKUT nama akun terkini — ganti nama di halaman
    // Pengguna tercermin di header setelah navigasi berikutnya (shift/laporan
    // memakai nama ini; menyinkronkan di sini = satu sumber: akun server).
    setCashier(meCache.akun.name);
    return meCache;
  } catch (e) {
    if (e instanceof Error && /^HTTP 401/.test(e.message)) {
      bersihSesi();
      meCache = null;
      return null;
    }
    // Jaringan putus / server mati: percaya simpanan terakhir.
    return meCache ?? akunTersimpan();
  }
}

/** Izin akun yang sedang login (cache lokal, sync — aman dipanggil di render). */
export function punyaIzin(kode: string): boolean {
  return punyaIzinAkun(akunTersimpan()?.akun, kode);
}

/** Simpan sesi hasil quick switch (lock.ts): token + profil baru.
 *  Dipakai HANYA setelah server mengonfirmasi PIN target. */
export function simpanSesiBaru(token: string, akun: Akun, wajib: boolean): void {
  simpan(token, akun, wajib);
  meCache = { akun, wajib };
}

/** Rute bawaan per akun (dipakai setelah login & saat guard mengalihkan).
 *  Kasir dengan izin terbatas tidak boleh dilempar ke POS yang tak boleh
 *  dibukanya — cari halaman pertama yang memang diizinkan. */
export function ruteBawaan(akun: Akun | Peran): string {
  const a: { role: Peran; permissions?: string[] | null } =
    typeof akun === 'string' ? { role: akun } : akun;
  if (a.role === 'owner') return '#/dashboard';
  const urutan: { izin: string; rute: string }[] = [
    { izin: 'pos.jual', rute: '#/pos' },
    { izin: 'laporan.lihat', rute: '#/dashboard' },
    { izin: 'riwayat.lihat', rute: '#/history' },
    { izin: 'retur.lihat', rute: '#/returns' },
    { izin: 'pesanan.lihat', rute: '#/orders' },
    { izin: 'pelanggan.lihat', rute: '#/customers' },
    { izin: 'hutang.lihat', rute: '#/debts' },
    { izin: 'stok.lihat', rute: '#/stock' },
    { izin: 'shift.lihat', rute: '#/shifts' },
    { izin: 'pembelian.kelola', rute: '#/purchases' },
    { izin: 'produk.kelola', rute: '#/products' },
    { izin: 'supplier.kelola', rute: '#/suppliers' },
    { izin: 'pengeluaran.kelola', rute: '#/expenses' },
    { izin: 'kasmasuk.kelola', rute: '#/kas-masuk' },
  ];
  const cocok = urutan.find((x) => punyaIzinAkun(a, x.izin));
  return cocok?.rute ?? '#/profil';
}
