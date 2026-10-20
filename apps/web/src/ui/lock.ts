// Layar kunci + PIN cepat (Paket B5, 2026-10-20).
//
// Prinsip:
// * Kunci layar adalah UI lock — token API TIDAK dicabut. Tujuannya menjaga
//   layar kasir yang ditinggal, bukan mengganti sesi.
// * Verifikasi ONLINE selalu didahulukan (`POST /api/users/pin/verify`).
//   Verifier lokal PBKDF2 hanya dipakai saat jaringan error (bukan 401/403),
//   dan hanya ada di device yang pernah memasukkan PIN akun itu.
// * Tanpa verifier lokal, auto-lock SENGAJA dimatikan (kalau tidak, kasir
//   bisa terkunci saat WiFi mati tanpa cara membuka). Kunci manual tetap
//   boleh, dengan peringatan.
// * Ganti akun cepat memakai endpoint server (token lama dicabut). Sebelum
//   pindah: outbox harus kosong dan keranjang harus sudah ditahan/dibersihkan
//   supaya nota tidak salah pemilik.

import { apiGet, apiPost, HttpError, outboxCount } from '../api';
import { akunTersimpan, bersihSesi, ruteBawaan, simpanSesiBaru, type Akun } from './auth';
import { confirmDialog } from './confirm';
import { icon } from './icons';
import { toast } from './toast';
import { initials } from './user';
import { getKeranjang } from '../store';

type Ringkas = {
  id: number;
  username: string;
  name: string;
  role: 'owner' | 'kasir';
  avatar: string | null;
  pin_set: boolean;
  /** Ada di Akun (sesi) dan boleh absen di /api/users/ringkas — dipakai
   *  membandingkan verifier offline tanpa memaksa bentuk respons. */
  pin_updated_at?: string | null;
};

type Verifier = { v: 1; salt: string; hash: string; iter: number; at?: string | null };

const KUNCI_LOCK = 'ravaa.lock';
const KUNCI_AUTOLOCK = 'ravaa.autolock';
const KUNCI_VERIFIER = (id: number) => `ravaa.pin-verifier.${id}`;
const AUTO_BAWAAN = 30;
const ITERASI_PBKDF2 = 120_000;
const PANJANG_PIN = 6;

export const AUTO_LOCK_PILIHAN = [
  { menit: 0, label: 'Mati' },
  { menit: 5, label: '5 menit' },
  { menit: 10, label: '10 menit' },
  { menit: 15, label: '15 menit' },
  { menit: 30, label: '30 menit (bawaan)' },
  { menit: 60, label: '60 menit' },
] as const;

export function getAutoLockMenit(): number {
  try {
    const raw = localStorage.getItem(KUNCI_AUTOLOCK);
    if (raw === null || raw === '') return AUTO_BAWAAN;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return AUTO_BAWAAN;
    return Math.min(240, Math.round(n));
  } catch {
    return AUTO_BAWAAN;
  }
}

export function setAutoLockMenit(menit: number): void {
  const n = Number.isFinite(menit) && menit > 0 ? Math.min(240, Math.round(menit)) : 0;
  try {
    localStorage.setItem(KUNCI_AUTOLOCK, String(n));
  } catch {
    /* private mode: abaikan */
  }
  jadwalkanKunci();
  document.dispatchEvent(new CustomEvent('ravaa:autolock'));
}

/* ---------- verifier lokal (PBKDF2 WebCrypto) ---------- */

function b64(data: Uint8Array): string {
  let s = '';
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s);
}

function dariB64(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function adaWebCrypto(): boolean {
  return typeof globalThis.crypto?.subtle?.deriveBits === 'function';
}

async function hitungPin(pin: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<Uint8Array | null> {
  if (!adaWebCrypto()) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      key,
      256,
    );
    return new Uint8Array(bits);
  } catch {
    return null;
  }
}

function bacaVerifier(id: number): Verifier | null {
  try {
    const raw = localStorage.getItem(KUNCI_VERIFIER(id));
    if (!raw) return null;
    const v = JSON.parse(raw) as Verifier;
    if (v?.v !== 1 || typeof v.salt !== 'string' || typeof v.hash !== 'string') return null;
    if (!Number.isFinite(v.iter) || v.iter < 10_000) return null;
    return v;
  } catch {
    return null;
  }
}

/** true = device ini punya verifier offline untuk akun tersebut. */
export function verifierTersedia(id: number): boolean {
  return bacaVerifier(id) !== null;
}

function hapusVerifier(id: number): void {
  try {
    localStorage.removeItem(KUNCI_VERIFIER(id));
  } catch {
    /* abaikan */
  }
}

/** Simpan hash PBKDF2 PIN setelah verifikasi online/set PIN berhasil. */
export async function simpanVerifier(id: number, pin: string, at?: string | null): Promise<void> {
  if (!adaWebCrypto() || !new RegExp(`^\\d{${PANJANG_PIN}}$`).test(pin)) return;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hitungPin(pin, salt, ITERASI_PBKDF2);
  if (!hash) return;
  const v: Verifier = { v: 1, salt: b64(salt), hash: b64(hash), iter: ITERASI_PBKDF2, at: at ?? null };
  try {
    localStorage.setItem(KUNCI_VERIFIER(id), JSON.stringify(v));
  } catch {
    /* private mode: auto-lock akan tetap mati di device ini */
  }
}

/** 'ok' | 'salah' | 'tidak-ada'. Verifier dengan pin_updated_at berbeda
 *  dianggap basi (PIN diubah di device lain): hapus, jangan pernah menerima
 *  PIN lama sebagai kunci offline. */
async function cekVerifier(id: number, pin: string, at?: string | null): Promise<'ok' | 'salah' | 'tidak-ada'> {
  const v = bacaVerifier(id);
  if (!v) return 'tidak-ada';
  if (at && v.at && at !== v.at) {
    hapusVerifier(id);
    return 'tidak-ada';
  }
  const salt = dariB64(v.salt);
  if (!salt) return 'salah';
  const hash = await hitungPin(pin, salt, v.iter);
  if (!hash) return 'tidak-ada';
  return b64(hash) === v.hash ? 'ok' : 'salah';
}

/* ---------- status kunci ---------- */

type StatusKunci = { userId: number; at: number };

function bacaStatus(): StatusKunci | null {
  try {
    const raw = localStorage.getItem(KUNCI_LOCK);
    if (!raw) return null;
    const s = JSON.parse(raw) as StatusKunci;
    if (!s || !Number.isInteger(s.userId)) return null;
    return s;
  } catch {
    return null;
  }
}

function tulisStatus(s: StatusKunci | null): void {
  try {
    if (s) localStorage.setItem(KUNCI_LOCK, JSON.stringify(s));
    else localStorage.removeItem(KUNCI_LOCK);
  } catch {
    /* abaikan */
  }
}

export function sedangTerkunci(): boolean {
  const s = bacaStatus();
  const a = akunTersimpan()?.akun;
  return Boolean(s && a && s.userId === a.id);
}

/* ---------- state UI ---------- */

let akunAktif: Akun | null = null;
let mode: 'pin' | 'switch' = 'pin';
let target: Ringkas | null = null;
let pin = '';
let sibuk = false;
let pesan = '';
let daftarRingkas: Ringkas[] = [];
let layer: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let terpasang = false;
let pernahPeringatVerifier = false;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function avatarHtml(u: { id: number; name: string; avatar?: string | null }, cls: string): string {
  const src = u.avatar ? `/api/users/${u.id}/avatar?${Date.now()}` : '';
  return src
    ? `<span class="${cls} overflow-hidden"><img src="${esc(src)}" alt="${esc(u.name)}" class="size-full object-cover" /></span>`
    : `<span class="${cls}">${esc(initials(u.name || '?'))}</span>`;
}

function dotsHtml(): string {
  return Array.from({ length: PANJANG_PIN })
    .map((_, i) => `<span class="size-3.5 rounded-full ${i < pin.length ? 'bg-primary' : 'bg-gray-200 dark:bg-gray-600'}"></span>`)
    .join('');
}

function pinPadHtml(): string {
  const tombol = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const pindah = Boolean(target && akunAktif && target.id !== akunAktif.id);
  return `
    <div class="mt-5 grid grid-cols-3 gap-2">
      ${tombol
        .map(
          (n) => `<button type="button" class="btn btn-ghost h-14 justify-center text-xl font-semibold" data-lock-digit="${n}">${n}</button>`,
        )
        .join('')}
      <span></span>
      <button type="button" class="btn btn-ghost h-14 justify-center text-xl font-semibold" data-lock-digit="0">0</button>
      <button type="button" class="btn btn-ghost h-14 justify-center" data-lock-back aria-label="Hapus satu digit">${icon('chevL')}</button>
    </div>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <button type="button" class="btn btn-ghost justify-center ${pindah ? '' : 'hidden'}" data-lock-batal>Kembali</button>
      <button type="button" class="btn btn-primary justify-center ${pindah ? '' : 'col-span-2'}" data-lock-ok ${pin.length === PANJANG_PIN && !sibuk ? '' : 'disabled'}>
        ${sibuk ? 'Memeriksa…' : pindah ? 'Pindah akun' : 'Buka kunci'}
      </button>
    </div>`;
}

function daftarHtml(): string {
  const saya = akunAktif;
  return `
    <div class="mt-4 space-y-2">
      ${daftarRingkas
        .map((u) => {
          const aktif = saya?.id === u.id;
          const ownerDariKasir = u.role === 'owner' && saya?.role !== 'owner';
          const mati = !u.pin_set || ownerDariKasir;
          return `
          <button type="button" class="flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
            aktif
              ? 'border-primary bg-primary-soft dark:bg-primary/15'
              : 'border-gray-200 bg-white hover:border-primary/50 hover:bg-primary-soft/40 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-primary/10'
          }" data-lock-pilih="${u.id}" ${mati ? 'disabled' : ''}>
            ${avatarHtml(u, 'flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white')}
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold text-gray-900 dark:text-white">${esc(u.name)}</span>
              <span class="block truncate text-xs text-gray-500 dark:text-gray-400">${u.role === 'owner' ? 'Owner' : 'Kasir'}${aktif ? ' · sedang aktif' : ''}${
                !u.pin_set ? ' · PIN belum diatur' : ownerDariKasir ? ' · hanya dari sesi owner' : ''
              }</span>
            </span>
            ${aktif ? `<span class="chip bg-primary text-white">Aktif</span>` : icon('chevR')}
          </button>`;
        })
        .join('')}
    </div>`;
}

function bodyHtml(): string {
  const saya = akunAktif;
  if (!saya) return '';
  if (mode === 'switch') {
    return `
      <div class="mt-4 flex items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">Ganti akun cepat</h2>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Pilih akun, lalu masukkan PIN-nya. Nota yang belum terkirim harus selesai dulu.</p>
        </div>
        <button type="button" class="icon-btn" data-lock-tutup aria-label="Tutup">${icon('close')}</button>
      </div>
      ${daftarHtml()}
      <p class="mt-3 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">Akun owner hanya bisa dipilih dari sesi owner. Token akun lama dicabut setelah pindah.</p>`;
  }
  const t = target;
  return `
    <div class="mt-5 text-center">
      <p class="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">${
        t ? 'PIN akun tujuan' : 'Layar terkunci'
      }</p>
      <h2 class="mt-1 text-lg font-bold text-gray-900 dark:text-white">${esc(t ? t.name : saya.name)}</h2>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">${
        t ? 'Masukkan PIN akun ini untuk pindah.' : 'Masukkan PIN 6 digit untuk melanjutkan.'
      }</p>
    </div>
    <div class="mt-5 flex items-center justify-center gap-3" id="lock-dots" aria-label="PIN ${pin.length} dari ${PANJANG_PIN} digit">${dotsHtml()}</div>
    <p class="mt-2 min-h-5 text-center text-sm font-medium text-red-600 dark:text-red-400" id="lock-err" role="alert">${esc(pesan)}</p>
    ${pinPadHtml()}
    <div class="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs">
      ${target ? '' : `<button type="button" class="text-primary underline-offset-2 hover:underline" data-lock-switch>Ganti akun</button>`}
      <button type="button" class="text-gray-400 underline-offset-2 hover:underline dark:text-gray-500" data-lock-lupa>Lupa PIN / keluar</button>
    </div>
    ${
      verifierTersedia(saya.id) || target
        ? ''
        : `<p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">Perangkat ini belum punya kunci PIN offline. Buka kunci membutuhkan internet sampai PIN dimasukkan sekali saat online.</p>`
    }`;
}

function renderLayer(): void {
  if (!layer) return;
  const saya = akunAktif;
  if (!saya) {
    layer.style.display = 'none';
    return;
  }
  layer.innerHTML = `
    <div class="my-auto w-full max-w-[430px] rounded-2xl bg-white p-5 shadow-2xl dark:bg-gray-800 sm:p-6">
      <div class="flex items-center gap-3">
        ${avatarHtml(saya, 'flex size-14 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-bold text-white shadow-lg shadow-primary/30')}
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-gray-900 dark:text-white">${esc(saya.name)}</p>
          <p class="truncate text-xs text-gray-500 dark:text-gray-400">@${esc(saya.username)} · ${saya.role === 'owner' ? 'Owner' : 'Kasir'}</p>
        </div>
        ${
          mode === 'pin'
            ? `<span class="chip bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">${icon('lock')} ${
                target ? 'Ganti akun' : 'Terkunci'
              }</span>`
            : ''
        }
      </div>
      ${bodyHtml()}
    </div>`;
  bindLayer();
}

function pastikanLayer(): void {
  if (layer && document.body.contains(layer)) return;
  layer = document.createElement('div');
  layer.id = 'lock-layer';
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', 'Layar kunci');
  layer.className =
    'fixed inset-0 z-[80] overflow-y-auto bg-[#081533]/95 p-3 backdrop-blur-sm dark:bg-black/90';
  layer.style.display = 'none';
  layer.style.alignItems = 'center';
  layer.style.justifyContent = 'center';
  document.body.appendChild(layer);
}

function tampil(modeBaru: 'pin' | 'switch'): void {
  pastikanLayer();
  mode = modeBaru;
  if (modeBaru === 'pin') target = null;
  pin = '';
  pesan = '';
  sibuk = false;
  if (layer) layer.style.display = 'flex';
  renderLayer();
  void muatDaftar();
  hentikanTimer();
}

function sembunyikan(): void {
  if (layer) layer.style.display = 'none';
  pin = '';
  pesan = '';
  target = null;
  mode = 'pin';
  jadwalkanKunci();
}

async function muatDaftar(): Promise<void> {
  try {
    const r = await apiGet<{ data: Ringkas[] }>('/api/users/ringkas');
    daftarRingkas = r.data ?? [];
  } catch {
    daftarRingkas = [];
  }
  if (mode === 'switch') renderLayer();
}

function pilihTarget(id: number): void {
  const u = daftarRingkas.find((x) => x.id === id);
  if (!u) return;
  if (u.id === akunAktif?.id) {
    mode = 'pin';
    target = null;
    pin = '';
    pesan = '';
    renderLayer();
    return;
  }
  target = u;
  mode = 'pin';
  pin = '';
  pesan = '';
  renderLayer();
}

function cekBolehPindah(): string | null {
  const n = outboxCount();
  if (n > 0) {
    return `Masih ada ${n} transaksi di antrean offline. Selesaikan dulu sebelum ganti akun.`;
  }
  const cart = getKeranjang<{ items?: unknown[]; topups?: unknown[] }>();
  const baris = (cart?.items?.length ?? 0) + (cart?.topups?.length ?? 0);
  if (baris > 0) {
    return 'Keranjang masih berisi barang. Tahan (F7) atau bersihkan dulu sebelum ganti akun.';
  }
  return null;
}

function pesanError(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

async function submitPin(): Promise<void> {
  if (sibuk || pin.length !== PANJANG_PIN || !akunAktif) return;
  sibuk = true;
  pesan = '';
  renderLayer();
  const tujuan = target ?? akunAktif;
  if (!tujuan) {
    sibuk = false;
    renderLayer();
    return;
  }
  const pindah = Boolean(target && target.id !== akunAktif.id);
  try {
    if (pindah) {
      const guard = cekBolehPindah();
      if (guard) throw new HttpError(guard, 400);
      const r = await apiPost<{ data: { token: string; user: Akun; must_change: boolean } }>(
        '/api/users/pin/switch',
        { user_id: target!.id, pin },
      );
      await simpanVerifier(target!.id, pin, r.data.user.pin_updated_at ?? null);
      simpanSesiBaru(r.data.token, r.data.user, r.data.must_change === true);
      try {
        localStorage.removeItem('ravaa.nota-terakhir');
      } catch {
        /* abaikan */
      }
      tulisStatus(null);
      // Reload penuh: state POS/keranjang/hold milik akun lama tidak boleh
      // terbawa. Keranjang & outbox sudah dipastikan kosong di atas.
      location.hash = ruteBawaan(r.data.user);
      setTimeout(() => location.reload(), 40);
      return;
    }
    const r = await apiPost<{ data: { ok: boolean; pin_updated_at?: string | null } }>(
      '/api/users/pin/verify',
      { pin },
    );
    await simpanVerifier(tujuan.id, pin, r.data.pin_updated_at ?? tujuan.pin_updated_at ?? null);
    tulisStatus(null);
    sembunyikan();
    document.dispatchEvent(new CustomEvent('ravaa:unlocked'));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 0;
    if (status === 0 && !pindah) {
      // Offline: verifier lokal satu-satunya jalan. Tidak ada verifier =
      // jangan menebak, minta sambungkan jaringan.
      const v = await cekVerifier(tujuan.id, pin, tujuan.pin_updated_at ?? null);
      if (v === 'ok') {
        tulisStatus(null);
        sembunyikan();
        document.dispatchEvent(new CustomEvent('ravaa:unlocked'));
        return;
      }
      pesan = v === 'tidak-ada'
        ? 'Jaringan mati dan perangkat ini belum punya kunci offline. Sambungkan internet untuk membuka.'
        : 'PIN salah.';
    } else {
      // 401 dari endpoint ini berarti PIN SALAH (bukan sesi mati) — server
      // sengaja memakai 401 juga untuk PIN salah. JANGAN logout di sini:
      // kasir yang salah ketik PIN tidak boleh kehilangan sesi/keranjang.
      // Sesi yang benar-benar mati akan terlihat sebagai pesan "belum login"
      // dan bisa diselesaikan lewat "Lupa PIN / keluar".
      pesan = pesanError(e);
    }
  } finally {
    sibuk = false;
    if (layer?.style.display !== 'none') {
      pin = '';
      renderLayer();
    }
  }
}

function bindLayer(): void {
  if (!layer) return;
  layer.querySelectorAll<HTMLElement>('[data-lock-digit]').forEach((b) => {
    b.addEventListener('click', () => {
      if (sibuk || pin.length >= PANJANG_PIN) return;
      pin += b.dataset.lockDigit ?? '';
      pesan = '';
      if (pin.length === PANJANG_PIN) {
        renderLayer();
        setTimeout(() => void submitPin(), 60);
        return;
      }
      renderLayer();
    });
  });
  layer.querySelector('[data-lock-back]')?.addEventListener('click', () => {
    if (sibuk) return;
    pin = pin.slice(0, -1);
    pesan = '';
    renderLayer();
  });
  layer.querySelector('[data-lock-ok]')?.addEventListener('click', () => void submitPin());
  layer.querySelector('[data-lock-batal]')?.addEventListener('click', () => {
    mode = 'switch';
    target = null;
    pin = '';
    pesan = '';
    renderLayer();
  });
  layer.querySelector('[data-lock-switch]')?.addEventListener('click', () => {
    mode = 'switch';
    target = null;
    pin = '';
    pesan = '';
    renderLayer();
  });
  layer.querySelector('[data-lock-tutup]')?.addEventListener('click', () => {
    // Overlay dari sesi aktif (bukan status terkunci) boleh ditutup.
    if (bacaStatus()) return;
    sembunyikan();
  });
  layer.querySelectorAll<HTMLElement>('[data-lock-pilih]').forEach((b) => {
    b.addEventListener('click', () => pilihTarget(Number(b.dataset.lockPilih)));
  });
  layer.querySelector('[data-lock-lupa]')?.addEventListener('click', () => void lupaPin());
}

async function lupaPin(): Promise<void> {
  const ya = await confirmDialog({
    title: 'Keluar dari akun ini?',
    message:
      'PIN tidak bisa dipulihkan dari layar kunci. Keluar akan memutus sesi di perangkat ini; masuk lagi memakai sandi akun. Keranjang yang belum dibayar bisa hilang.',
    okLabel: 'Ya, keluar',
    cancelLabel: 'Batal',
    danger: true,
  });
  if (!ya) return;
  bersihSesi();
  tulisStatus(null);
  sembunyikan();
  location.hash = '#/login';
}

/* ---------- timer idle ---------- */

function hentikanTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function jadwalkanKunci(): void {
  hentikanTimer();
  const a = akunAktif ?? akunTersimpan()?.akun ?? null;
  if (!a || !a.pin_set) return;
  if (bacaStatus()) return; // sudah terkunci
  if (getAutoLockMenit() <= 0) return;
  if (!verifierTersedia(a.id)) {
    if (!pernahPeringatVerifier) {
      pernahPeringatVerifier = true;
      console.warn(
        '[kunci] auto-lock dimatikan di perangkat ini: belum ada verifier PIN offline. ' +
          'Buka kunci secara online sekali (atau atur PIN di halaman Profil) untuk mengaktifkannya.',
      );
    }
    return;
  }
  timer = setTimeout(() => {
    if (!bacaStatus()) kunciLayar();
  }, getAutoLockMenit() * 60_000);
}

function aktivitas(): void {
  if (bacaStatus() || mode === 'switch' || layer?.style.display === 'flex') return;
  jadwalkanKunci();
}

function pasangEvent(): void {
  if (terpasang) return;
  terpasang = true;
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    document.addEventListener(ev, aktivitas, { passive: true, capture: true });
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KUNCI_LOCK) {
      const s = bacaStatus();
      if (s) tampil('pin');
      else if (layer?.style.display === 'flex') sembunyikan();
    }
    if (e.key === 'ravaa.akun') {
      const a = akunTersimpan()?.akun ?? null;
      if (a) mulaiKunciLayar(a);
    }
  });
  document.addEventListener('ravaa:kunci', () => kunciLayar());
  document.addEventListener('ravaa:ganti-akun', () => bukaGantiAkun());
  document.addEventListener('ravaa:butuh-pin', () => {
    toast('Atur PIN 6 digit dulu di halaman Profil sebelum mengunci layar.', 'warning');
    if (location.hash !== '#/profil') location.hash = '#/profil';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && bacaStatus()) tampil('pin');
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (layer?.style.display !== 'flex') return;
      // Jangan biarkan pintasan POS/admin tembus ke layar kunci.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!bacaStatus()) sembunyikan();
        return;
      }
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        if (sibuk || pin.length >= PANJANG_PIN) return;
        pin += e.key;
        pesan = '';
        if (pin.length === PANJANG_PIN) {
          renderLayer();
          setTimeout(() => void submitPin(), 60);
        } else renderLayer();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        if (!sibuk) {
          pin = pin.slice(0, -1);
          pesan = '';
          renderLayer();
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void submitPin();
        return;
      }
      // Semua tombol lain di layar kunci tidak boleh memicu aksi halaman.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
    },
    { capture: true },
  );
}

/* ---------- API publik ---------- */

/** Dipanggil router tiap render dengan profil segar. */
export function mulaiKunciLayar(akun: Akun): void {
  pasangEvent();
  akunAktif = akun;
  if (!akun.pin_set) {
    hapusVerifier(akun.id);
    if (layer?.style.display === 'flex') sembunyikan();
    return;
  }
  // PIN diubah/direset di device lain: verifier lokal lama tidak boleh
  // menerima PIN lama. Bandingkan stempel waktu dari server.
  const v = bacaVerifier(akun.id);
  if (v && akun.pin_updated_at && v.at && v.at !== akun.pin_updated_at) hapusVerifier(akun.id);
  if (bacaStatus()) {
    tampil('pin');
    return;
  }
  if (layer?.style.display === 'flex') return; // overlay ganti akun aktif
  jadwalkanKunci();
}

export function kunciLayar(): void {
  const akun = akunTersimpan()?.akun ?? akunAktif;
  if (!akun) return;
  if (!akun.pin_set) {
    // Tanpa PIN, kunci layar tidak punya kunci pembuka. Arahkan ke Profil.
    document.dispatchEvent(new CustomEvent('ravaa:butuh-pin'));
    return;
  }
  if (!verifierTersedia(akun.id)) {
    console.warn(
      '[kunci] perangkat ini belum punya verifier offline — kunci manual tetap bisa dibuka saat online.',
    );
  }
  akunAktif = akun;
  target = null;
  tulisStatus({ userId: akun.id, at: Date.now() });
  tampil('pin');
}

export function bukaGantiAkun(): void {
  const akun = akunTersimpan()?.akun ?? akunAktif;
  if (!akun) return;
  akunAktif = akun;
  target = null;
  tampil('switch');
}

/** Hapus preferensi verifier akun (dipakai setelah reset PIN oleh owner). */
export function lupakanVerifier(id: number): void {
  hapusVerifier(id);
}
