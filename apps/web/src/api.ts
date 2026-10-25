// Client API: fetch JSON + status konektivitas server + outbox (antrian offline)
// untuk sales & topup. ID uuid dibuat di client -> POST ulang aman (server
// idempotent).
//
// KEJUJURAN OFFLINE (2026-10-25) — baca sebelum menambah klaim "offline-first":
// `enqueue()` di bawah BELUM dipanggil jalur tulis mana pun (POS menampilkan
// toast + mematikan tombol bayar saat server tak terjangkau, BUKAN mengantre).
// Antrean localStorage hanya terisi oleh pemanggil yang memanggil enqueue()
// secara eksplisit (saat ini: tidak ada di app; suite test mengisinya langsung
// untuk menguji chip notif). Jadi jangan pernah menulis bahwa penjualan offline
// "masuk antrean lalu terkirim sendiri" sampai wiring itu benar-benar ada.

import { toast } from './ui/toast';
import { akunTersimpan, tokenAuth } from './ui/auth';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** Batas keras satu request app. Server toko berjalan di mesin yang sama /
 *  LAN — 20 detik berarti "tidak merespons", bukan "lambat". Tanpa batas ini
 *  fetch yang menggantung (WiFi putus di tengah POST) membuat POS diam di
 *  status busy tanpa pesan apa pun. */
const BATAS_REQ_MS = 20_000;

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/* ---------- status konektivitas server ----------
 * `true` = request terakhir mendapat JAWABAN (status apa pun, termasuk 401/500
 * — server hidup). `false` = fetch gagal/timeout. Dipakai POS untuk mematikan
 * tombol bayar + banner, supaya kasir tidak menekan Bayar berulang kali
 * sementara transaksi tidak mungkin tersimpan. */
export const EVENT_JARINGAN = 'ravaa:jaringan';
let tersambung = true;
let cekBerjalan: Promise<boolean> | null = null;

export function jaringanTersambung(): boolean {
  return tersambung;
}

function setTersambung(nilai: boolean): void {
  if (nilai === tersambung) return;
  tersambung = nilai;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_JARINGAN, { detail: { tersambung: nilai } }));
}

/** Tembak endpoint API ringan untuk memastikan server benar-benar hidup.
 *  SENGAJA `/api/*` (bukan `/health`): semua instalasi (vite dev & Caddy di
 *  infra/) sudah meneruskan `/api/*` ke proses API, sedangkan `/health` TIDAK
 *  diteruskan sehingga jatuh ke SPA fallback — HTTP 200 berisi index.html,
 *  artinya server mati pun terlihat "hidup". Jawaban JSON dari API =
 *  tersambung walau statusnya 401/500 (server menjawab); 502/503/504 atau
 *  halaman HTML dari proxy = putus.
 *  Satu pengecekan bersamaan saja (klik ganda tidak menumpuk request). */
export async function cekJaringan(): Promise<boolean> {
  if (cekBerjalan) return cekBerjalan;
  cekBerjalan = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${BASE}/api/me`, { cache: 'no-store', signal: ctrl.signal });
      const tipe = res.headers.get('content-type') ?? '';
      const hidup = res.status < 500 || tipe.includes('json');
      setTersambung(hidup);
      return hidup;
    } catch {
      setTersambung(false);
      return false;
    } finally {
      clearTimeout(timer);
      cekBerjalan = null;
    }
  })();
  return cekBerjalan;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  // Token sesi ikut di SEMUA request app (termasuk flush outbox — header
  // dibaca saat kirim, jadi antrean offline tetap sah setelah login ulang).
  const token = tokenAuth();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BATAS_REQ_MS);
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    setTersambung(false);
    const pesan = ctrl.signal.aborted
      ? `server tidak merespons dalam ${BATAS_REQ_MS / 1000} detik`
      : e instanceof Error ? e.message : 'jaringan terputus';
    throw new HttpError(pesan, 0);
  } finally {
    clearTimeout(timer);
  }
  // Ada jawaban = server hidup, walau isinya 4xx/5xx.
  setTersambung(true);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

export const apiGet = <T,>(path: string) => req<T>(path);
export const apiPost = <T,>(path: string, data: unknown) =>
  req<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const apiDelete = <T,>(path: string) => req<T>(path, { method: 'DELETE' });

export function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------- outbox: simpan request gagal, coba lagi tiap 5 detik ----------
type Job = {
  key: string;
  path: string;
  data: unknown;
  ts: number;
  /** Akun pembuat job (Paket B4). Job TIDAK boleh dikirim oleh akun lain —
   *  server memaksa cashier dari sesi, jadi flush setelah ganti akun bisa
   *  salah atribusi. Job lama tanpa userId tetap diproses (kompatibilitas). */
  userId?: number;
  cashier?: string;
};
const LS_KEY = 'ravaa.outbox.v1';

function load(): Job[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as Job[]; }
  catch { return []; }
}
function save(jobs: Job[]) { localStorage.setItem(LS_KEY, JSON.stringify(jobs)); }

export function enqueue(path: string, data: Record<string, unknown>): string {
  const jobs = load();
  const id = (data.id as string) ?? uuid();
  const akun = akunTersimpan()?.akun;
  jobs.push({
    key: id,
    path,
    data: { ...data, id },
    ts: Date.now(),
    ...(akun ? { userId: akun.id, cashier: akun.name } : {}),
  });
  save(jobs);
  updateOutboxBadge();
  return id;
}

export function outboxCount(): number { return load().length; }

export async function flushOutbox(onDone?: (key: string) => void): Promise<void> {
  const jobs = load();
  if (jobs.length === 0) return;
  if (!navigator.onLine) return;
  const saya = akunTersimpan()?.akun;
  // Tanpa sesi jelas jangan menebak pemilik: biarkan antrean utuh.
  if (!saya) return;
  const rest: Job[] = [];
  for (const j of jobs) {
    // Job milik akun lain disimpan apa adanya (pemiliknya melanjutkan saat
    // login lagi). Job lama tanpa tag tetap dikirim — perilaku lama.
    if (j.userId !== undefined && j.userId !== saya.id) {
      rest.push(j);
      continue;
    }
    try {
      await apiPost(j.path, j.data);
      onDone?.(j.key);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      if (status === 401 || status === 403) {
        // Token mati / izin dicabut: JANGAN buang nota pelanggan. Simpan dan
        // hentikan putaran ini (retry berikutnya setelah sesi/izin beres).
        rest.push(j);
        break;
      }
      if (status >= 400 && status < 500) {
        // Gagal validasi permanen (stok kurang, item kosong, dsb) — buang,
        // jangan retry tiap 5 detik selamanya hingga spam console + server.
        console.warn('[outbox] drop poison job', j.key, j.path, e);
        toast(`Antrian dibuang (gagal validasi): ${e instanceof Error ? e.message : e}`, 'error');
        continue;
      }
      rest.push(j); // jaringan mati / server 5xx -> coba lagi nanti
    }
  }
  save(rest);
  updateOutboxBadge();
}

export function updateOutboxBadge(): void {
  const n = outboxCount();
  const el = document.getElementById('outbox-badge');
  if (el) {
    el.textContent = n > 0 ? `antrian ${n}` : 'online';
    el.className = n > 0
      ? 'badge-low'
      : 'hidden sm:inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400';
  }
  // Chip notif POS "n transaksi antre offline" (baris saklar cetak, `#pos-notif`)
  // — teks & visibilitas disegarkan DI SINI supaya tidak basi sampai repaint
  // POS berikutnya (revisi pemilik 2026-10-08, lihat notifChips() di pos.ts).
  // Elemen dirender terus-menerus (hidden saat 0) supaya selalu ada untuk
  // pembaruan ini.
  const ob = document.querySelector<HTMLElement>('a[data-notif-outbox]');
  if (ob) {
    ob.classList.toggle('hidden', n === 0);
    const span = ob.querySelector('span');
    if (span) span.textContent = `${n} transaksi antre offline`;
  }
}

// Jantung konektivitas: `offline` browser tidak selalu akurat (API restart di
// mesin yang sama, WiFi router hidup tapi server mati, kabel LAN putus sesaat).
// Saat putus cek tiap 5 detik supaya tombol Bayar cepat hidup lagi; saat
// tersambung cukup tiap 15 detik (3 tick) — murah dan tidak mengganggu.
let tikJaringan = 0;
setInterval(() => {
  void flushOutbox();
  tikJaringan += 1;
  if (!tersambung || tikJaringan % 3 === 0) void cekJaringan();
}, 5000);
window.addEventListener('online', () => { void cekJaringan(); void flushOutbox(); });
window.addEventListener('offline', () => setTersambung(false));
