// Halaman Pengaturan (#/settings) — aturan yang berlaku untuk SEMUA device.
//
// Bedanya dengan "Pengaturan Akun" (ui/user.ts): yang di sana disimpan per
// browser lewat localStorage (nama kasir, nama toko, tema); yang di sini
// disimpan di SERVER lewat POST /api/settings, jadi satu perubahan langsung
// dipakai kasir di HP maupun di PC. Karena itu aturan yang menyangkut data
// (stok, harga, dsb) tidak boleh disimpan di localStorage — dua device bisa
// berbeda pendapat dan penjualan jadi tidak konsisten.
//
// PENGECUALIAN SATU-SATUNYA: kartu "Cetak struk" — sifatnya justru per-device
// (printer tiap PC kasir beda: thermal 58mm, Epson L3110, atau tanpa printer),
// jadi disimpan lewat ui/print-pref.ts di localStorage browser ini.

import { apiGet, apiPost, HttpError } from '../api';
import { confirmDialog } from '../ui/confirm';
import { icon, type IconName } from '../ui/icons';
import { getToko } from '../ui/user';
import {
  LACI_BAWAAN_HEX, getAgentUrl, getAutoPrint, getDrawerKick, getDrawerKickHex,
  getPrintPause, getStrukLayout, setAgentUrl, setAutoPrint, setDrawerKick,
  setDrawerKickBytes, setPrintPause, setStrukLayout, type LayoutStruk,
} from '../ui/print-pref';
import {
  syncDariServerSettings, nomorStrukPendek, type OpsiCetak,
} from '../ui/identitas-struk';
import { switchHtml } from '../ui/switch';
import { toast } from '../ui/toast';
import { hariIni, waktu } from '../ui/waktu';
import { akunTersimpan } from '../ui/auth';
import {
  AUTO_LOCK_PILIHAN, getAutoLockMenit, setAutoLockMenit, verifierTersedia,
} from '../ui/lock';
import { LEBAR_LOGO, resetLogoStrukCache } from '../logo-struk';
import { kirimPrint, rp, strukUntukTercetak, type Struk } from '../escpos';
import { getZonaWaktu, setZonaWaktu, ZONA_WAKTU_PILIHAN, ZONA_WAKTU_BAWAAN, type ZonaWaktu } from '../ui/timezone';
import { getCurrencyFormat, setCurrencyFormat, CURRENCY_BAWAAN, type FormatCurrency } from '../ui/currency';

type Toko = { store_name: string; store_address: string; store_phone: string; store_email: string };
type Settings = OpsiCetak & {
  allow_negative_stock: boolean; tolak_jual_kadaluarsa: boolean;
  store_name: string; store_address: string; store_phone: string; store_email: string;
  /** NAMA file logo di img/ ('' = tanpa logo) — butir ROADMAP 1.6.4. */
  store_logo: string;
  /** Zona waktu tampilan device ini (default Asia/Jakarta). */
  timezone: string;
  /** Format currency tampilan device ini (default Rp Indonesia). */
  currency: string;
};
type BarisBackup = { nama: string; ukuran: number; waktu: string };
type SeksiId = 'transaksi' | 'toko' | 'perangkat' | 'data';

/** Menu seksi (riset 2026-10-20): pola katalog Settings Loyverse + menu
 *  laporan repo ini — nav kiri yang menempel, isi kanan. Empat seksi adalah
 *  batas domain halaman ini; jangan pecah jadi menu yang tidak punya kartu. */
const SEKSI: { id: SeksiId; label: string; judul: string; ikon: IconName; cakupan: string }[] = [
  { id: 'transaksi', label: 'Aturan transaksi', judul: 'Aturan transaksi', ikon: 'stock', cakupan: 'Semua device' },
  { id: 'toko', label: 'Identitas toko', judul: 'Identitas toko', ikon: 'receipt', cakupan: 'Semua device' },
  { id: 'perangkat', label: 'Perangkat & cetak', judul: 'Perangkat & cetak', ikon: 'smartphone', cakupan: 'Server + perangkat' },
  { id: 'data', label: 'Backup & pemulihan', judul: 'Backup & pemulihan', ikon: 'shieldCheck', cakupan: 'Server' },
];

const tokoKosong = (): Toko => ({ store_name: '', store_address: '', store_phone: '', store_email: '' });

const KUNCI_TOKO: Record<string, keyof Toko> = {
  'set-toko-nama': 'store_name',
  'set-toko-alamat': 'store_address',
  'set-toko-telepon': 'store_phone',
  'set-toko-email': 'store_email',
};

/** Draft opsi dokumen & struk (server-wide). Semua disimpan SEKALI lewat
 *  tombol Simpan supaya perubahan judul/footer/toggle tidak setengah jalan. */
const dokKosong = (): OpsiCetak => ({
  invoice_title: 'INVOICE',
  // Footer A4 = teks TAMBAHAN; baris "Dicetak melalui Ravaa POS pada: <tanggal>" selalu
  // dicetak builder dokumen (permintaan pemilik 2026-10-21).
  invoice_footer: '',
  receipt_footer: 'Terima kasih sudah berbelanja',
  receipt_customer: 'name',
  receipt_show_items: true,
  receipt_short_no: false,
  receipt_show_debt: true,
});

const KUNCI_DOK_TEKS: Record<string, 'invoice_title' | 'invoice_footer' | 'receipt_footer'> = {
  'set-dok-judul': 'invoice_title',
  'set-dok-footer-a4': 'invoice_footer',
  'set-dok-footer-struk': 'receipt_footer',
};

const KUNCI_DOK_BOOL: Record<string, 'receipt_show_items' | 'receipt_short_no' | 'receipt_show_debt'> = {
  'set-dok-item': 'receipt_show_items',
  'set-dok-nomor': 'receipt_short_no',
  'set-dok-hutang': 'receipt_show_debt',
};

const URUTAN_PELANGGAN = ['name', 'address', 'phone'] as const;
const LABEL_PELANGGAN: Record<(typeof URUTAN_PELANGGAN)[number], string> = {
  name: 'Nama', address: 'Alamat', phone: 'Telepon',
};

const state = {
  loading: true, error: '', minus: false, kadaluarsa: false,
  backups: [] as BarisBackup[], backupErr: '', backupJalan: false,
  /** Draft form toko (bisa berbeda dari `tokoAsli` bila belum disimpan). */
  toko: tokoKosong(),
  /** Nilai terakhir yang tersimpan di server — dasar penanda "belum disimpan". */
  tokoAsli: tokoKosong(),
  tokoJalan: false,
  /** Draft opsi dokumen & struk (judul/footer/detail pelanggan/toggle). */
  dok: dokKosong(),
  /** Nilai terakhir tersimpan — dasar penanda "belum disimpan". */
  dokAsli: dokKosong(),
  dokJalan: false,
  /** Tombol "Tes cetak" sedang mengirim (menahan klik ganda). */
  tesJalan: false,
  /** Nama file logo struk thermal ('' = belum ada). */
  logo: '',
  /** Zona waktu dan currency — preferensi PER DEVICE (localStorage), bukan server. */
  zonaWaktu: getZonaWaktu(),
  currency: getCurrencyFormat(),
  currencyJalan: false,
  /** Seksi yang sedang ditampilkan (panel mode — hanya satu yang tampil). */
  seksiAktif: 'transaksi' as SeksiId,
};

let host: HTMLElement | null = null;
/** Listener dokumen (Ctrl+K) milik kunjungan terakhir — di-abort saat mount
 *  berikutnya supaya berpindah-pindah halaman tidak menumpuk listener. */
let sinyal: AbortController | null = null;

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

// Lebar penuh ke seluruh body (tanpa max-w/mx-auto) — konsisten dengan
// halaman Stok & Produk.
//
// Kerangka 2026-10-20 (revisi pemilik: "card tersebut tidak ada fungsinya bisa
// di hapus, agar 1 scroll seperti pada halaman laporan"): TIDAK ada kartu
// judul/deskripsi di atas — judul halaman sudah dibawa header shell.
//
// Revisi pemilik 2026-10-20 kedua ("cek halaman laporan, buat layout seperti
// itu"): menu seksi kiri = `<aside>` yang MENGISI tinggi baris grid (tanpa
// `items-start`) dengan kartu `lg:sticky lg:top-0`, persis pola reports.ts —
// jadi kartu menu menempel saat halaman digulir. Toolbar pencarian + ringkasan
// status duduk di atas isi kolom KANAN (bukan di atas kedua kolom), dan seluruh
// halaman tetap satu scroller (`.page`). Toolbar & nav sengaja STATIS di luar
// `#set-body` supaya repaint data tidak membuang fokus ketikan.
function renderPage(): string {
  return `
  <div class="grid gap-3 lg:grid-cols-[220px_1fr]">
    <aside id="set-nav-host" class="min-w-0" aria-label="Menu pengaturan"></aside>
    <div class="min-w-0 space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative w-full sm:w-80">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
          <input id="set-cari" class="input pl-9 pr-9" type="search" enterkeyhint="search"
                 placeholder="Cari pengaturan…"
                 autocomplete="off" aria-label="Cari pengaturan" />
          <button type="button" id="set-cari-hapus" class="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded-md p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                  title="Bersihkan pencarian" aria-label="Bersihkan pencarian">${icon('close')}</button>
        </div>
        <kbd class="kbd hidden shrink-0 sm:inline-flex" title="Fokus ke kolom cari">Ctrl K</kbd>
        <div id="set-ringkas" class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" aria-live="polite"></div>
      </div>
      <div id="set-body"></div>
    </div>
  </div>`;
}

function renderBody(): string {
  if (state.loading) return `<div class="card"><div class="skel h-6 w-56"></div></div>`;
  if (state.error) {
    return `<div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat pengaturan: ${esc(state.error)}</span></div></div>`;
  }

  const isiMinus = state.minus
    ? `Penjualan tetap jalan walaupun stok sudah habis — angka stok boleh menembus
       nol (minus) sampai barang diisi ulang. Cocok kalau hitungan fisik dan sistem
       sering selisih, dan tidak ada lagi pesan "stok kurang" yang menghentikan
       transaksi di meja kasir.`
    : `Begitu jumlah terjual melebihi sisa stok, penjualan <b>ditolak</b> dengan pesan
       "stok kurang: ... (butuh X, sisa Y)". Ini perilaku bawaan dan paling aman
       untuk menjaga stok tercatat sama persis dengan isi rak.`;

  const isiKadaluarsa = state.kadaluarsa
    ? `Baris jual yang tanggal kadaluarsanya sudah lewat <b>ditolak server</b> dengan
       pesan "barang kadaluarsa: ..." — bukan sekadar strip peringatan. Hari kadaluarsa
       sendiri masih boleh dijual. Aktifkan untuk kategori yang pakai tanggal
       kadaluarsa (snack, es krim).`
    : `Barang lewat tanggal kadaluarsa masih <b>boleh terjual</b> — layar kasir hanya
       menampilkan strip & badge peringatan. Matikan/menyalakan aturan ini tidak
       menghapus tanggal yang sudah tercatat di produk.`;

  // Sengaja TANPA badge status di sebelah judul: label saklarnya sendiri sudah
  // membaca "Aktif"/"Nonaktif", jadi badge hanya mengulang teks yang sama.
  // Status = posisi saklar; keterangan = paragraf di atas footer.
  // Kartu dikelompokkan per CAKUPAN lewat kepalaSeksi: "Semua device" (server)
  // vs "Browser ini" — konsep paling penting halaman ini.
  // Menu seksi TIDAK ikut di sini: `#set-nav-host` dirender terpisah (kolom
  // kiri) supaya `#set-body` hanya berisi isi seksi + empty-state pencarian.
  return `
    <div id="set-isi" class="min-w-0 space-y-4">
      <section id="set-sec-transaksi" data-set-sec="transaksi" class="scroll-mt-2 space-y-2" aria-label="Aturan transaksi">
        ${kepalaSeksi('transaksi')}
        <div class="grid items-stretch gap-3 lg:grid-cols-2">
          ${kartuSaklar({
            input: 'set-minus', judul: 'Stok boleh minus', isi: isiMinus,
            aktif: state.minus, label: state.minus ? 'Aktif' : 'Nonaktif',
            ikon: 'stock', tile: 'bg-primary-soft text-primary dark:bg-primary/15',
            cari: 'stok minus negatif habis penjualan aturan server',
          })}
          ${kartuSaklar({
            input: 'set-kadaluarsa', judul: 'Tolak jual kadaluarsa', isi: isiKadaluarsa,
            aktif: state.kadaluarsa, label: state.kadaluarsa ? 'Aktif' : 'Nonaktif',
            ikon: 'calendar', tile: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
            cari: 'kadaluarsa kedaluwarsa expiry tanggal barang basi aturan server',
          })}
        </div>
      </section>
      <section id="set-sec-toko" data-set-sec="toko" class="scroll-mt-2 space-y-2" aria-label="Identitas toko">
        ${kepalaSeksi('toko')}
        ${kartuToko()}
      </section>
      <section id="set-sec-perangkat" data-set-sec="perangkat" class="scroll-mt-2 space-y-2" aria-label="Perangkat dan cetak">
        ${kepalaSeksi('perangkat')}
        <div class="grid items-stretch gap-3 xl:grid-cols-2">
          ${kartuPerangkat()}
          ${kartuCetak()}
          ${renderKartuFormatTampil()}
          ${kartuDokumen()}
          ${kartuPratinjau()}
        </div>
      </section>
      <section id="set-sec-data" data-set-sec="data" class="scroll-mt-2 space-y-2" aria-label="Backup dan pemulihan">
        ${kepalaSeksi('data')}
        ${kartuBackup()}
      </section>
      <div id="set-kosong" class="card" hidden>
        <div class="empty">
          ${icon('search')}
          <span>Tidak ada pengaturan yang cocok dengan pencarian.</span>
          <button type="button" id="set-cari-bersih" class="btn btn-ghost btn-sm">Bersihkan pencarian</button>
        </div>
      </div>
    </div>`;
}

// Menu seksi kiri — dirender ke `<aside id="set-nav-host">` yang mengisi tinggi
// baris grid (pola reports.ts), sehingga kartu `lg:sticky lg:top-0` benar-benar
// menempel saat halaman digulir / chip 2 kolom (mobile). Tombol = navigasi
// dalam halaman, bukan hash — hash milik router (#/settings), jangan anchor.
function navPengaturan(): string {
  const tombol = SEKSI.map((s) => {
    const aktif = state.seksiAktif === s.id;
    return `<button type="button" data-set-nav="${s.id}" class="${kelasNav(aktif)}"${aktif ? ' aria-current="true"' : ''}>
      <span class="shrink-0 [&>svg]:size-4">${icon(s.ikon)}</span><span class="truncate">${s.label}</span>
    </button>`;
  }).join('');
  return `
    <div class="card lg:sticky lg:top-0">
      <p class="form-sec hidden lg:block">Menu pengaturan</p>
      <div id="set-nav" class="grid grid-cols-2 gap-1 lg:mt-2 lg:block lg:gap-0">${tombol}</div>
      <div class="mt-3 hidden border-t border-gray-100 pt-3 dark:border-gray-700/60 lg:block">
        <p class="form-sec">Cakupan</p>
        <p class="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <span class="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>Server — semua device
        </p>
        <p class="mt-1 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <span class="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>Perangkat — browser ini
        </p>
      </div>
    </div>`;
}

const kelasNav = (aktif: boolean): string =>
  `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
    aktif
      ? 'bg-primary-soft font-semibold text-primary dark:bg-primary/15 dark:text-primary'
      : 'font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800'
  }`;

// Kepala seksi: ikon + judul + garis + chip cakupan. Judul sengaja `<p>`
// (bukan h3) supaya asersi test `#set-body h3` tetap hanya berisi judul KARTU
// (kontrak halaman ini sejak 2026-10-16).
function kepalaSeksi(id: SeksiId): string {
  const s = SEKSI.find((x) => x.id === id)!;
  return `
  <div class="flex items-center gap-2 px-0.5">
    <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon(s.ikon)}</span>
    <p class="text-sm font-semibold text-gray-900 dark:text-white">${s.judul}</p>
    <span class="h-px flex-1 bg-gray-200 dark:bg-gray-700" aria-hidden="true"></span>
    <span class="shrink-0 rounded-full border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">${s.cakupan}</span>
  </div>`;
}

/* ---------- ringkasan status (chip toolbar atas) ---------- */

type WarnaChip = 'ok' | 'warn' | 'bad' | 'netral';

function chipRingkas(
  kunci: 'minus' | 'kadaluarsa' | 'cetak' | 'backup',
  target: SeksiId, label: string, nilai: string, warna: WarnaChip, judul: string,
): string {
  const titik = warna === 'ok' ? 'bg-emerald-500'
    : warna === 'warn' ? 'bg-amber-500'
      : warna === 'bad' ? 'bg-red-500' : 'bg-gray-400';
  return `<button type="button" class="chip" data-set-chip="${kunci}" data-set-lompat="${target}" data-set-nilai="${esc(nilai)}" title="${esc(judul)}">
    <span class="size-2 shrink-0 rounded-full ${titik}" aria-hidden="true"></span>
    <span class="text-gray-500 dark:text-gray-400">${label}</span>
    <b class="font-semibold text-gray-700 dark:text-gray-200">${esc(nilai)}</b>
  </button>`;
}

function ringkasBackup(): { nilai: string; warna: WarnaChip; judul: string } {
  const b = state.backups[0];
  if (!b) {
    if (state.backupErr) return { nilai: 'Gagal dibaca', warna: 'bad', judul: state.backupErr };
    return { nilai: 'Belum ada', warna: 'netral', judul: 'Belum ada file backup — buka bagian Backup & pemulihan' };
  }
  const tgl = String(b.waktu ?? '').slice(0, 10);
  const nilai = tgl === hariIni() ? 'hari ini' : waktu(b.waktu).split(' · ')[0];
  return {
    nilai,
    warna: tgl === hariIni() ? 'ok' : 'warn',
    judul: `Backup terakhir: ${waktu(b.waktu)} (${b.nama})`,
  };
}

function ringkasHtml(): string {
  if (state.loading) return `<span class="chip text-gray-400 dark:text-gray-500">Memuat status…</span>`;
  if (state.error) return `<span class="chip"><span class="size-2 rounded-full bg-red-500"></span>Status tidak terbaca</span>`;
  const b = ringkasBackup();
  const jeda = getPrintPause();
  const layout = getStrukLayout() === 'a4' ? 'A4' : 'Thermal';
  return [
    chipRingkas('minus', 'transaksi', 'Stok minus', state.minus ? 'Aktif' : 'Nonaktif',
      state.minus ? 'warn' : 'netral',
      state.minus ? 'Penjualan boleh melewati stok (stok bisa minus)' : 'Penjualan ditolak bila stok kurang'),
    chipRingkas('kadaluarsa', 'transaksi', 'Kadaluarsa', state.kadaluarsa ? 'Ditolak' : 'Boleh',
      state.kadaluarsa ? 'ok' : 'warn',
      state.kadaluarsa ? 'Barang lewat tanggal kadaluarsa ditolak server' : 'Barang lewat tanggal kadaluarsa masih boleh dijual'),
    chipRingkas('cetak', 'perangkat', 'Cetak', jeda ? 'Dijeda' : layout,
      jeda ? 'warn' : 'netral',
      jeda ? 'Semua kirim ke printer ditahan' : `Layout struk: ${layout}`),
    chipRingkas('backup', 'data', 'Backup', b.nilai, b.warna, b.judul),
  ].join('');
}

function paintRingkas(): void {
  const el = host?.querySelector('#set-ringkas');
  if (!el) return;
  el.innerHTML = ringkasHtml();
  el.querySelectorAll<HTMLElement>('[data-set-lompat]').forEach((b) =>
    b.addEventListener('click', () => lompatSeksi(b.dataset.setLompat as SeksiId)));
}

/** Pindah ke seksi: bersihkan filter dulu supaya target pasti tampil. */
function lompatSeksi(id: SeksiId): void {
  if ((host?.querySelector<HTMLInputElement>('#set-cari')?.value ?? '').trim() !== '') bersihkanCari(false);
  setSeksiAktif(id);
}

function setSeksiAktif(id: SeksiId): void {
  if (state.seksiAktif === id) return;
  state.seksiAktif = id;
  paintNavAktif();
  // Panel mode (2026-10-20): seksi non-aktif disembunyikan lewat style.display
  // (bukan atribut hidden — kelas `flex`/`grid` di kartu mengalahkan UA rule).
  host?.querySelectorAll<HTMLElement>('#set-body [data-set-sec]').forEach((sec) => {
    sec.style.display = sec.dataset.setSec === id ? '' : 'none';
  });
}

function paintNavAktif(): void {
  host?.querySelectorAll<HTMLElement>('[data-set-nav]').forEach((b) => {
    const aktif = b.dataset.setNav === state.seksiAktif;
    b.className = kelasNav(aktif);
    if (aktif) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
}

/* ---------- pencarian pengaturan (client-side, tanpa API) ---------- */

/** Saring kartu berdasarkan SEMUA kata kunci (pola search produk): kata boleh
 *  ada di atribut `data-cari` maupun teks kartu, tidak harus berurutan. */
function terapkanCari(): void {
  const q = (host?.querySelector<HTMLInputElement>('#set-cari')?.value ?? '').trim();
  const kata = q.toLowerCase().split(/\s+/).filter(Boolean);
  const body = host?.querySelector('#set-body');
  if (!body) return;
  let total = 0;
  body.querySelectorAll<HTMLElement>('[data-set-sec]').forEach((sec) => {
    let tampil = 0;
    sec.querySelectorAll<HTMLElement>('[data-set-card]').forEach((card) => {
      const teks = `${card.dataset.cari ?? ''} ${card.textContent ?? ''}`.toLowerCase();
      const cocok = kata.every((k) => teks.includes(k));
      // style.display, BUKAN atribut hidden — sebagian kartu memakai `flex`
      // (kartuSaklar/kartuPerangkat/kartuCetak) sehingga UA rule
      // `[hidden]{display:none}` kalah oleh author utility `.flex`.
      card.style.display = cocok ? '' : 'none';
      if (cocok) {
        tampil++;
        total++;
      }
    });
    sec.hidden = tampil === 0;
    const nav = host?.querySelector<HTMLElement>(`[data-set-nav="${sec.dataset.setSec}"]`);
    // style.display, BUKAN atribut hidden: tombol nav memakai `flex` (author
    // display) yang mengalahkan UA rule `[hidden]{display:none}` — pelajaran
    // yang sama dengan `.pm-bayarlayer[hidden]` di pos-mobile.css.
    if (nav) nav.style.display = tampil === 0 ? 'none' : '';
  });
  const kosong = body.querySelector<HTMLElement>('#set-kosong');
  if (kosong) kosong.hidden = !(kata.length > 0 && total === 0);
  const hapus = host?.querySelector<HTMLElement>('#set-cari-hapus');
  if (hapus) hapus.classList.toggle('hidden', q === '');
  // Seksi aktif tidak boleh tersembunyi oleh filter.
  const aktif = body.querySelector<HTMLElement>(`[data-set-sec="${state.seksiAktif}"]`);
  if (aktif?.hidden) {
    const pertama = body.querySelector<HTMLElement>('[data-set-sec]:not([hidden])');
    const id = pertama?.dataset.setSec as SeksiId | undefined;
    if (id) setSeksiAktif(id);
  }
}

function bersihkanCari(fokus = true): void {
  const input = host?.querySelector<HTMLInputElement>('#set-cari');
  if (input) {
    input.value = '';
    if (fokus) input.focus();
  }
  terapkanCari();
}

/** Pemasangan sekali per mount: kolom cari ada di toolbar STATIS sehingga
 *  repaint `#set-body` tidak menghapus fokus ketikan. */
function bindCari(): void {
  const input = host?.querySelector<HTMLInputElement>('#set-cari');
  input?.addEventListener('input', terapkanCari);
  input?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    bersihkanCari();
  });
  host?.querySelector('#set-cari-hapus')?.addEventListener('click', () => bersihkanCari());
}

// (Scroll-spy IntersectionObserver DIHAPUS 2026-10-20: halaman memakai panel
// mode — hanya seksi aktif yang tampil, jadi tidak ada posisi gulir untuk
// dipantau. `lompatSeksi`/`setSeksiAktif` yang memegang state seksi.)

// Kartu saklar aturan transaksi: ikon + judul + deskripsi, lalu footer
// pemisah berisi keterangan singkat (kiri) & saklar (kanan) — pola baris
// pengaturan yang seragam dengan kartu-kartu di bawahnya.
function kartuSaklar(opt: {
  input: string; judul: string; isi: string; aktif: boolean; label: string;
  ikon: IconName; tile: string; cari: string;
}): string {
  return `
  <div class="card flex flex-col" data-set-card data-cari="${esc(opt.cari)}">
    <div class="flex flex-1 items-start gap-3">
      <span class="flex size-9 shrink-0 items-center justify-center rounded-xl ${opt.tile} [&>svg]:size-4">${icon(opt.ikon)}</span>
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">${opt.judul}</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">${opt.isi}</p>
      </div>
    </div>
    <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-2.5 dark:border-gray-700/60">
      <span class="text-xs text-gray-400 dark:text-gray-500">Dibaca server pada setiap penjualan</span>
      ${switchHtml(opt.input, opt.aktif, opt.label)}
    </div>
  </div>`;
}

// Kartu "Tampilan perangkat" (2026-10-11, pindahan dari halaman Profil —
// nama toko kepala struk + tema). Per-device localStorage, tanpa API.
function kartuPerangkat(): string {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const storeName = state.toko?.store_name || '';
  const akun = akunTersimpan()?.akun;
  const auto = getAutoLockMenit();
  const opsiAuto = AUTO_LOCK_PILIHAN.map(
    (o) => `<option value="${o.menit}"${o.menit === auto ? ' selected' : ''}>${o.label}</option>`,
  ).join('');
  const pinSet = akun?.pin_set === true;
  const offline = pinSet && akun ? verifierTersedia(akun.id) : false;
  return `
    <div class="card flex flex-col" data-set-card data-cari="tampilan perangkat tema terang gelap browser lokal kunci otomatis autolock pin keamanan layar">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('smartphone')}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Tampilan perangkat ini</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Tema warna dan kunci layar perangkat ini. Nama toko di <b>kepala struk thermal</b> mengikuti
            <b>Identitas toko</b> (halaman ini) dan berlaku untuk semua device.
          </p>
        </div>
      </div>
      <div class="mt-3 grid flex-1 gap-2 sm:grid-cols-2">
        <div class="field-sm">
          <label class="label">Nama toko (struk thermal)</label>
          <div class="input input-sm flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            <span id="set-dev-toko">${esc(storeName || 'RAVA POS')}</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">dari Identitas toko</span>
          </div>
        </div>
        <div class="field-sm">
          <label class="label" for="set-dev-theme">Tema</label>
          <select id="set-dev-theme" class="input input-sm">
            <option value="light" ${theme === 'light' ? 'selected' : ''}>Terang</option>
            <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Gelap</option>
          </select>
        </div>
        <div class="field-sm sm:col-span-2">
          <label class="label" for="set-autolock">Kunci layar otomatis</label>
          <select id="set-autolock" class="input input-sm">${opsiAuto}</select>
          <span class="mt-1 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            ${
              pinSet
                ? offline
                  ? 'PIN aktif dan kunci offline siap di perangkat ini.'
                  : 'PIN aktif, tetapi perangkat ini belum punya kunci offline — buka kunci sekali saat online.'
                : 'Atur PIN 6 digit di halaman Profil dulu. Tanpa PIN, kunci otomatis tidak berjalan.'
            }
            Pilihan ini hanya tersimpan di browser ini.
          </span>
        </div>
      </div>
      <div class="mt-3 flex justify-end">
        <button type="button" id="set-dev-simpan" class="btn btn-primary">${icon('check')}<span>Simpan tampilan</span></button>
      </div>
    </div>`;
}

// Kartu "Pengaturan toko" — kop INVOICE A4 (cetak gaya Aronium). Disimpan di
// SERVER (4 kunci store_* di tabel settings) supaya semua device mencetak kop
// yang sama; nilai awal di-seed dari contoh pemilik. Form biasa + tombol
// Simpan, tanpa konfirmasi swal (non-destruktif seperti Backup).
//
// Sejak butir ROADMAP 1.6.4 (2026-10-19) kartu ini juga memuat unggah LOGO
// STRUK THERMAL: file disimpan di img/ (endpoint POST /api/settings/logo —
// hanya owner), tercetak di awal struk thermal semua jalur cetak. Unggah/hapus
// TIDAK mem-paint ulang form — isian store_* yang belum disimpan tidak boleh
// hilang karena render ulang (pola avatar di halaman Profil).
function logoHtml(): string {
  return state.logo
    ? `<img id="set-logo-img" src="/api/settings/logo?${esc(state.logo)}" alt="Logo toko" class="max-h-16 max-w-full object-contain" />`
    : `<span class="px-2 text-center text-xs text-gray-400 dark:text-gray-500">Belum ada logo</span>`;
}

/** Repaint parsial baris logo (bukan `paint()`): pertahankan ketikan form. */
function tampilLogo(): void {
  const wadah = host?.querySelector('#set-logo-wadah');
  if (wadah) wadah.innerHTML = logoHtml();
  host?.querySelector('#set-logo-hapus')?.classList.toggle('hidden', !state.logo);
  const lbl = host?.querySelector('#set-logo-label');
  if (lbl) lbl.textContent = state.logo ? 'Ganti logo' : 'Unggah logo';
  // Pratinjau struk ikut memperlihatkan gambar terbaru (tanpa repaint form).
  paintPratinjauStruk();
}

/** Baca berkas logo → PNG skala maksimal LEBAR_LOGO (384px, lebar printer
 *  thermal) sebagai dataURL. PNG (bukan JPEG): tepi garis harus tajam karena
 *  raster struk memakai ambang luminance — derau JPEG berubah jadi bercak dot. */
async function kecilkanLogo(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('gambar tidak bisa dibaca'));
      i.src = url;
    });
    const skala = Math.min(1, LEBAR_LOGO / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * skala));
    const h = Math.max(1, Math.round(img.naturalHeight * skala));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('canvas tidak tersedia');
    ctx.fillStyle = '#fff'; // PNG transparan → latar putih, bukan hitam
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Apakah draft form toko berbeda dari nilai terakhir yang tersimpan? */
function tokoKotor(): boolean {
  const t = state.toko;
  const a = state.tokoAsli;
  return (t.store_name ?? '').trim() !== a.store_name
    || (t.store_address ?? '').trim() !== a.store_address
    || (t.store_phone ?? '').trim() !== a.store_phone
    || (t.store_email ?? '').trim() !== a.store_email;
}

/** Perbarui penanda & tombol simpan TANPA repaint — fokus ketikan tetap. */
function perbaruiStatusToko(): void {
  const kotor = tokoKotor();
  const status = host?.querySelector<HTMLElement>('#set-toko-status');
  if (status) {
    status.textContent = kotor ? 'Perubahan belum disimpan' : 'Semua perubahan tersimpan';
    status.className = `text-xs ${kotor ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`;
  }
  const btn = host?.querySelector<HTMLButtonElement>('#set-toko-simpan');
  if (btn) btn.disabled = state.tokoJalan || !kotor;
}

function kartuToko(): string {
  const t = state.toko;
  const kotor = tokoKotor();
  const f = (id: string, label: string, nilai: string, opsional?: boolean, lebar?: boolean) => `
    <div class="field-sm${lebar ? ' sm:col-span-2' : ''}">
      <label class="label" for="${id}">${label}${opsional ? ' <span class="font-normal">(opsional)</span>' : ''}</label>
      <input class="input" id="${id}" value="${esc(nilai)}" maxlength="300" autocomplete="off">
    </div>`;
  return `
    <div class="card" data-set-card data-cari="toko identitas nama alamat phone telepon email logo kop invoice struk a4">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('receipt')}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Pengaturan toko</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Kop <b>INVOICE A4</b> (cetak gaya Aronium) memakai empat isian ini.
            <b>Logo</b> di bawah tampil di awal <b>struk thermal</b> dan di sudut
            kanan-atas <b>dokumen A4</b> (invoice, laporan, rekap shift, nota PO,
            rincian hutang). Disimpan di <b>server</b>, jadi seluruh device
            mencetak yang sama.
          </p>
        </div>
      </div>
      <div id="set-toko-form" class="mt-3 grid gap-3 sm:grid-cols-2">
        ${f('set-toko-nama', 'Nama toko', t.store_name)}
        ${f('set-toko-telepon', 'Phone', t.store_phone, true)}
        ${f('set-toko-alamat', 'Alamat', t.store_address, true, true)}
        ${f('set-toko-email', 'Email', t.store_email, true)}
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-gray-100 p-3 dark:border-gray-700/60">
        <div id="set-logo-wadah" class="flex h-16 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800">
          ${logoHtml()}
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-gray-900 dark:text-white">Logo toko</p>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Struk thermal: raster hitam-putih, lebar maks ${LEBAR_LOGO}px.
            Dokumen A4: slot kanan-atas (gambar diskalakan otomatis).
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
          <label class="btn btn-ghost btn-sm relative" for="set-logo-file">
            ${icon('upload')}<span id="set-logo-label">${state.logo ? 'Ganti logo' : 'Unggah logo'}</span>
            <input id="set-logo-file" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" />
          </label>
          <button type="button" id="set-logo-hapus" class="btn btn-ghost btn-sm !text-red-600 dark:!text-red-400 ${state.logo ? '' : 'hidden'}">${icon('trash')}<span>Hapus</span></button>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span id="set-toko-status" aria-live="polite" class="text-xs ${kotor ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}">
          ${kotor ? 'Perubahan belum disimpan' : 'Semua perubahan tersimpan'}
        </span>
        <button type="button" id="set-toko-simpan" class="btn btn-primary disabled:cursor-not-allowed disabled:opacity-60" ${state.tokoJalan || !kotor ? 'disabled' : ''}>
          ${icon('check')}<span>${state.tokoJalan ? 'Menyimpan…' : 'Simpan toko'}</span>
        </button>
      </div>
    </div>`;
}

/** Nilai `receipt_customer` dari checkbox (urutan tetap: nama, alamat,
 *  telepon — urutan itulah yang tercetak di struk). */
function pilihPelangganDari(d: OpsiCetak): Set<string> {
  return new Set(d.receipt_customer.split(',').map((t) => t.trim()).filter(Boolean));
}

function dokKotor(): boolean {
  return JSON.stringify(state.dok) !== JSON.stringify(state.dokAsli);
}

/** Perbarui penanda & tombol simpan TANPA repaint — fokus ketikan tetap. */
function perbaruiStatusDok(): void {
  const kotor = dokKotor();
  const status = host?.querySelector<HTMLElement>('#set-dok-status');
  if (status) {
    status.textContent = kotor ? 'Perubahan belum disimpan' : 'Semua perubahan tersimpan';
    status.className = `text-xs ${kotor ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`;
  }
  const btn = host?.querySelector<HTMLButtonElement>('#set-dok-simpan');
  if (btn) btn.disabled = state.dokJalan || !kotor;
}

function kartuDokumen(): string {
  const d = state.dok;
  const kotor = dokKotor();
  const dipilih = pilihPelangganDari(d);
  const centang = URUTAN_PELANGGAN.map((t) => `
    <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-2 text-sm text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">
      <input type="checkbox" class="size-4 shrink-0 rounded border-gray-300 text-primary focus:ring-primary dark:border-gray-600"
             id="set-dok-cust-${t}" data-dok-cust="${t}" ${dipilih.has(t) ? 'checked' : ''} />
      <span>${LABEL_PELANGGAN[t]}</span>
    </label>`).join('');
  const f = (id: string, label: string, nilai: string, lebar?: boolean) => `
    <div class="field-sm${lebar ? ' sm:col-span-2' : ''}">
      <label class="label" for="${id}">${label}</label>
      <input class="input" id="${id}" value="${esc(nilai)}" maxlength="200" autocomplete="off">
    </div>`;
  return `
    <div class="card xl:col-span-2" data-set-card data-cari="dokumen struk invoice judul footer catatan pelanggan alamat telepon nomor pendek jumlah item hutang a4 thermal semua device percetakan">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400 [&>svg]:size-4">${icon('receipt')}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Dokumen &amp; struk</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Judul <b>invoice A4</b> serta footer <b>dokumen A4</b> (invoice, laporan,
            rekap shift, nota PO, rincian hutang) dan <b>struk thermal</b>. Semua
            tersimpan di <b>server</b> — device kasir mencetak isi yang sama.
          </p>
        </div>
      </div>
      <div id="set-dok-form" class="mt-3 grid gap-3 sm:grid-cols-2">
        ${f('set-dok-judul', 'Judul invoice A4', d.invoice_title)}
        ${f('set-dok-footer-a4', 'Footer dokumen A4', d.invoice_footer)}
        ${f('set-dok-footer-struk', 'Footer struk thermal', d.receipt_footer, true)}
        <div class="field-sm sm:col-span-2">
          <span class="label">Detail pelanggan di struk thermal</span>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">${centang}</div>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Pilih baris kontak yang dicetak di bawah info transaksi. Kosongkan
            semua untuk menyembunyikan detail pelanggan.
          </p>
        </div>
        <div class="sm:col-span-2 grid gap-2 rounded-xl border border-gray-100 p-3 dark:border-gray-700/60 sm:grid-cols-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Jumlah item</p>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Baris ringkas sebelum rincian uang.</p>
            </div>
            ${switchHtml('set-dok-item', d.receipt_show_items, d.receipt_show_items ? 'Cetak' : 'Mati')}
          </div>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Nomor pendek</p>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Hanya urutan harian, tanpa awalan tanggal.</p>
            </div>
            ${switchHtml('set-dok-nomor', d.receipt_short_no, d.receipt_short_no ? 'Pendek' : 'Penuh')}
          </div>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Hutang pelanggan</p>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Sisa hutang nota + total ledger berjalan.</p>
            </div>
            ${switchHtml('set-dok-hutang', d.receipt_show_debt, d.receipt_show_debt ? 'Cetak' : 'Mati')}
          </div>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span id="set-dok-status" aria-live="polite" class="text-xs ${kotor ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}">
          ${kotor ? 'Perubahan belum disimpan' : 'Semua perubahan tersimpan'}
        </span>
        <button type="button" id="set-dok-simpan" class="btn btn-primary disabled:cursor-not-allowed disabled:opacity-60" ${state.dokJalan || !kotor ? 'disabled' : ''}>
          ${icon('check')}<span>${state.dokJalan ? 'Menyimpan…' : 'Simpan dokumen'}</span>
        </button>
      </div>
    </div>`;
}

/** Ambil hanya field dokumen dari respons server (bentuknya Settings penuh). */
function dokDariSettings(s: Settings | null | undefined): OpsiCetak {
  const dasar = dokKosong();
  if (!s) return dasar;
  // Token pelanggan disaring ke yang dikenal — nilai lama 'email' (sempat
  // dicoba) tidak boleh membuat POST berikutnya ditolak server.
  const cust = (s.receipt_customer ?? dasar.receipt_customer)
    .split(',').map((t) => t.trim())
    .filter((t) => (URUTAN_PELANGGAN as readonly string[]).includes(t));
  return {
    invoice_title: s.invoice_title ?? dasar.invoice_title,
    invoice_footer: s.invoice_footer ?? dasar.invoice_footer,
    receipt_footer: s.receipt_footer ?? dasar.receipt_footer,
    receipt_customer: [...new Set(cust)].join(','),
    // `?? dasar` (bukan `=== true`) supaya respons yang belum memuat kunci
    // baru (API lama / cache) memakai perilaku lama: jumlah item & hutang
    // TETAP dicetak.
    receipt_show_items: s.receipt_show_items ?? dasar.receipt_show_items,
    receipt_short_no: s.receipt_short_no ?? dasar.receipt_short_no,
    receipt_show_debt: s.receipt_show_debt ?? dasar.receipt_show_debt,
  };
}

// Kartu "Cetak struk" — preferensi PER DEVICE (localStorage lewat
// ui/print-pref.ts), BUKAN POST /api/settings: printer tiap PC kasir beda
// (thermal 58mm vs Epson L3110 vs HP tanpa printer), jadi menyimpannya
// di server justru memaksa semua device ikut. Tanpa konfirmasi swal —
// non-destruktif dan langsung bisa dibalik (alasan sama dengan kartu Backup).
function kartuCetak(): string {
  const nyala = getAutoPrint();
  const layout = getStrukLayout();
  const jeda = getPrintPause();
  const laci = getDrawerKick();
  const laciBytes = getDrawerKickHex();
  const agent = getAgentUrl();
  const isiSaklar = nyala
    ? `Setiap penjualan selesai, dialog menawarkan <b>[Thermal] [A4] [Tidak]</b> —
        kasir memilih kertas per transaksi. Topup/tarik langsung dicetak sesuai
        layout. Cetak gagal tidak pernah membatalkan penjualan.`
    : `Dialog cetak <b>tidak</b> muncul otomatis. Cetak ulang (Thermal/A4) tetap
        bisa lewat menu Riwayat transaksi — nyalakan lagi kalau device ini sudah
        terpasang printer.`;
  const isiLayout = layout === 'a4'
    ? `<b>Epson L3110 (A4)</b> — 64 kolom, tanpa potong, ditutup eject supaya
        kertas keluar. Dipakai struk topup/tarik via print-agent.`
    : `<b>Thermal 58mm</b> — 32 kolom, diakhiri potong kertas. Dipakai struk
        topup/tarik via print-agent.`;
  const isiJeda = jeda
    ? `JEDA <b>AKTIF</b> — semua kirim ke printer (struk, label, kick laci)
        ditahan; nol kertas terbuang. Invoice A4 lewat browser tetap bisa dicetak.`
    : `Nonaktif — struk, label harga, dan kick laci mengirim ke printer seperti biasa.`;
  return `
    <div class="card flex flex-col" data-set-card data-cari="cetak printer struk thermal 58mm a4 epson l3110 jeda otomatis layout kertas browser perangkat agent alamat laci drawer kick hex byte perintah esc pos">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400 [&>svg]:size-4">${icon('print')}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Cetak struk</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Preferensi <b>device ini</b> — printer tiap PC kasir bisa berbeda
            (thermal 58mm, Epson L3110, atau tanpa printer), jadi tidak ikut ke kasir lain.
          </p>
        </div>
      </div>
      <div class="mt-2 flex-1 divide-y divide-gray-100 dark:divide-gray-700/60">
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Jeda semua cetak</p>
            <p class="mt-0.5 text-xs ${jeda ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}">${isiJeda}</p>
          </div>
          <div class="shrink-0">${switchHtml('set-pause', !jeda, jeda ? 'Dijeda' : 'Cetak ON')}</div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Cetak otomatis setelah bayar</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${isiSaklar}</p>
          </div>
          <div class="shrink-0">${switchHtml('set-cetak', nyala, nyala ? 'Aktif' : 'Nonaktif')}</div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Layout struk</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${isiLayout}</p>
          </div>
          <select id="set-layout" class="input input-sm !w-auto shrink-0" aria-label="Layout struk">
            <option value="thermal"${layout === 'thermal' ? ' selected' : ''}>Thermal 58mm</option>
            <option value="a4"${layout === 'a4' ? ' selected' : ''}>Epson L3110 (A4)</option>
          </select>
        </div>
        <div class="flex flex-wrap items-start justify-between gap-2 py-2.5">
          <div class="min-w-0 flex-1 basis-52">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Alamat print-agent</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              PC ini mengirim struk ke agent di alamat berikut. Bawaan
              <code>http://localhost:9100</code>; isi IP PC kasir bila agent
              berjalan di perangkat lain.
            </p>
          </div>
          <div class="flex w-full shrink-0 flex-wrap items-center gap-1.5 sm:w-auto">
            <input id="set-agent" class="input input-sm min-w-0 flex-1 sm:w-60 sm:flex-none"
                   type="url" inputmode="url" autocomplete="off" spellcheck="false"
                   value="${esc(agent)}" placeholder="http://localhost:9100"
                   aria-label="Alamat print-agent" />
            <button type="button" id="set-agent-simpan" class="btn btn-outline btn-sm shrink-0">Simpan</button>
          </div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Kick laci saat tunai</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              ${laci
                ? `Laci kasir dibuka otomatis setiap penjualan <b>tunai</b> lewat
                   print-agent. QRIS/transfer tidak memicu kick.`
                : `Kick laci <b>dimatikan</b> di device ini — penjualan tunai tetap
                   tercatat, laci dibuka manual. Cocok bila printer tidak terhubung laci.`}
            </p>
          </div>
          <div class="shrink-0">${switchHtml('set-laci', laci, laci ? 'Aktif' : 'Nonaktif')}</div>
        </div>
        <div class="flex flex-wrap items-start justify-between gap-2 py-2.5">
          <div class="min-w-0 flex-1 basis-52">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Perintah kick laci (hex)</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Byte ESC/POS yang dikirim ke print-agent. Bawaan Epson
              <code>${LACI_BAWAAN_HEX}</code>; pisahkan dengan spasi atau koma
              (boleh <code>0x</code>). Kosongkan lalu simpan untuk kembali ke
              bawaan. Berlaku hanya di device ini.
            </p>
          </div>
          <div class="flex w-full shrink-0 flex-wrap items-center gap-1.5 sm:w-auto">
            <input id="set-laci-bytes" class="input input-sm min-w-0 flex-1 font-mono sm:w-60 sm:flex-none"
                   type="text" inputmode="text" autocomplete="off" spellcheck="false"
                   maxlength="320" value="${esc(laciBytes)}" placeholder="${LACI_BAWAAN_HEX}"
                   aria-label="Perintah kick laci (hex)" />
            <button type="button" id="set-laci-bytes-simpan" class="btn btn-outline btn-sm shrink-0">Simpan</button>
          </div>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-2.5 dark:border-gray-700/60">
        <p class="text-xs text-gray-500 dark:text-gray-400">
          Kirim struk contoh lewat print-agent device ini — cara tercepat
          memastikan printer & kertas siap.
        </p>
        <button type="button" id="set-tes-cetak" class="btn btn-outline disabled:cursor-not-allowed disabled:opacity-60" ${state.tesJalan ? 'disabled' : ''}>
          ${icon('print')}<span>${state.tesJalan ? 'Mengirim…' : 'Tes cetak'}</span>
        </button>
      </div>
    </div>`;
  }

  // Kartu "Format & zona waktu" — preferensi PER DEVICE (localStorage), bukan
  // server. Zona waktu memengaruhi tampilan jam/tanggal di layar dan cetak;
  // currency memengaruhi format angka uang (Rp, $, €, dst).
  function renderKartuFormatTampil(): string {
    const zona = state.zonaWaktu ?? ZONA_WAKTU_BAWAAN;
    const cur = state.currency ?? CURRENCY_BAWAAN;
    const opsiZona = ZONA_WAKTU_PILIHAN.map((z) =>
      `<option value="${z.nilai}"${z.nilai === zona ? ' selected' : ''}>${esc(z.label)}</option>`).join('');
    const simbol = esc(cur.simbol ?? 'Rp');
    const kode = esc(cur.kode ?? 'id-ID');
    const desimal = cur.desimal ?? 0;
    return `
    <div class="card flex flex-col" data-set-card data-cari="format zona waktu currency mata uang rupiah tampilan jam tanggal perangkat">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400 [&>svg]:size-4">${icon('clock')}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Format & zona waktu</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Zona waktu menentukan tampilan jam & tanggal di layar & cetak device
            ini. Currency menentukan simbol & pemisah angka uang (default
            <b>Rp Indonesia</b>). Preferensi <b>device ini</b> — tidak ikut ke
            kasir lain.
          </p>
        </div>
      </div>
      <div class="mt-2 flex-1 divide-y divide-gray-100 dark:divide-gray-700/60">
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Zona waktu</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Contoh WIB = Jakarta UTC+7. Mengubah zona waktu tidak mengubah
              data yang tersimpan di server (semua UTC), hanya tampilan.
            </p>
          </div>
          <div class="shrink-0">
            <select id="set-timezone" class="input input-sm !w-auto shrink-0 sm:w-64" aria-label="Zona waktu">
              ${opsiZona}
            </select>
          </div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Simbol currency</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Simbol yang muncul sebelum angka uang (default <b>Rp</b>).
            </p>
          </div>
          <div class="shrink-0">
            <input id="set-currency-simbol" class="input input-sm !w-16 shrink-0" type="text" maxlength="3"
                   value="${simbol}" placeholder="Rp" aria-label="Simbol currency" />
          </div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Kode locale</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              menentukan pemisah ribuan & desimal (contoh <b>id-ID</b> =
              20.000, <b>en-US</b> = 20,000).
            </p>
          </div>
          <div class="shrink-0">
            <input id="set-currency-kode" class="input input-sm !w-24 shrink-0" type="text" maxlength="10"
                   value="${kode}" placeholder="id-ID" aria-label="Kode locale currency" />
          </div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Desimal</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Jumlah angka di belakang koma (default <b>0</b> untuk Rupiah).
            </p>
          </div>
          <div class="shrink-0">
            <input id="set-currency-desimal" class="input input-sm !w-12 shrink-0 text-right" type="number" min="0" max="4"
                   value="${desimal}" aria-label="Desimal currency" />
          </div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5 border-t border-gray-100 pt-2.5 dark:border-gray-700/60">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Contoh tampilan</p>
            <p class="mt-0.5 text-xs font-mono text-gray-700 dark:text-gray-300" id="set-contoh-currency">
              ${formatRupiahContoh(cur)}
            </p>
          </div>
          <button type="button" id="set-format-simpan" class="btn btn-outline btn-sm shrink-0">Simpan format</button>
        </div>
      </div>
    </div>`;
  }

  function formatRupiahContoh(cur: FormatCurrency): string {
    try {
      const angka = 1250000.5;
      return angka.toLocaleString(cur.kode || 'id-ID', {
        minimumFractionDigits: cur.desimal ?? 0,
        maximumFractionDigits: cur.desimal ?? 0,
      });
    } catch {
      return '1.250.000';
    }
  }

// Pratinjau struk (riset 2026-10-20 — pola "receipt visual editor" Shopify POS):
// contoh struk thermal yang MENGIKUTI nama toko device + gambar tersimpan.
// Sengaja contoh statis (bukan nota nyata): memperlihatkan pengaruh pengaturan,
// bukan membuka data penjualan. `paintPratinjauStruk()` memperbaruinya live
// saat nama toko device diketik / gambar diunggah — tanpa menyentuh fokus input.
function namaStrukDevice(): string {
  const fromServer = state.toko?.store_name?.trim();
  return (fromServer && fromServer.length > 0) ? fromServer : (getToko() || 'RAVA POS');
}

function isiPratinjauStruk(): string {
  const d = state.dok;
  const gambar = state.logo
    ? `<img src="/api/settings/logo?${esc(state.logo)}" alt="" class="mx-auto mb-1.5 max-h-12 max-w-[220px] object-contain" />`
    : '';
  const garis = '<div class="my-1.5 border-t border-dashed border-gray-300"></div>';
  const baris = (kiri: string, kanan: string, tebal = false) => `
      <div class="flex justify-between gap-2 ${tebal ? 'font-bold' : ''}">
        <span class="truncate">${esc(kiri)}</span><span class="shrink-0">${esc(kanan)}</span>
      </div>`;
  const tengah = (teks: string) => `<div class="text-center text-gray-400">${esc(teks)}</div>`;
  const kontak: Record<string, string> = {
    name: 'Pelanggan Umum',
    address: 'Gedong, Nganjuk',
    phone: '0822 3333 7766',
  };
  const labelKontak: Record<string, string> = { name: 'Pelanggan', address: 'Alamat', phone: 'Telp' };
  const detail = d.receipt_customer.split(',').map((t) => t.trim()).filter(Boolean)
    .map((t) => tengah(`${labelKontak[t] ?? t}: ${kontak[t] ?? ''}`))
    .join('');
  return `
      ${gambar}
      <div class="text-center font-bold">${esc(namaStrukDevice())}</div>
      <div class="text-center text-gray-400">Contoh tampilan</div>
      ${tengah(`No. ${nomorStrukPendek('261020-000012', d.receipt_short_no)}`)}
      ${detail}
      ${garis}
      ${baris('1 x Contoh barang', rp(10000))}
      ${baris('2 x Contoh kedua', rp(2500))}
      ${d.receipt_show_items ? tengah('Jumlah item: 2 baris · 3 qty') : ''}
      ${garis}
      ${baris('TOTAL', rp(15000), true)}
      ${baris('Tunai', rp(20000))}
      ${baris('Kembali', rp(5000))}
      ${d.receipt_show_debt ? baris('Total hutang', rp(5000)) : ''}
      ${garis}
      ${d.receipt_footer.trim() ? tengah(d.receipt_footer.trim()) : ''}`;
}

function kartuPratinjau(): string {
  const layout = getStrukLayout() === 'a4' ? 'topup/tarik: A4 64 kolom' : 'topup/tarik: thermal 32 kolom';
  return `
    <div class="card flex flex-col xl:col-span-2" data-set-card data-cari="pratinjau preview contoh struk thermal kertas tampilan kepala nama gambar">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('receipt')}</span>
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Pratinjau struk</h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Contoh tampilan struk <b>thermal 58mm</b> device ini — nama toko
              dan gambar tersimpan langsung terlihat di kertas contoh. Isi
              transaksi nyata tetap berasal dari nota, bukan pratinjau ini.
            </p>
          </div>
        </div>
        <span class="chip shrink-0">${layout}</span>
      </div>
      <div class="mt-3 flex flex-1 justify-center">
        <div id="set-preview-struk" class="w-full max-w-[320px] self-start rounded-lg border border-gray-200 bg-white px-4 py-3 font-mono text-xs leading-relaxed text-gray-800 shadow-sm">
          ${isiPratinjauStruk()}
        </div>
      </div>
    </div>`;
}

/** Repaint HANYA isi kertas pratinjau — elemen lain & fokus ketikan aman. */
function paintPratinjauStruk(): void {
  const el = host?.querySelector('#set-preview-struk');
  if (el) el.innerHTML = isiPratinjauStruk();
}

/** Struk contoh tombol "Tes cetak" — dibangun builder yang SAMA dengan struk
 *  penjualan (escpos), jadi yang diuji = jalur cetak sebenarnya. */
function strukContoh(nama: string): Struk {
  const d = state.dok;
  return {
    judul: nama.trim() || 'RAVA POS',
    subjudul: 'TES CETAK',
    meta: [],
    items: [
      { name: 'Contoh barang', qty: 1, price: 10000 },
      { name: 'Contoh kedua', qty: 2, price: 2500 },
    ],
    jumlahItem: d.receipt_show_items ? 'Jumlah item: 2 baris · 3 qty' : undefined,
    baris: [
      { kiri: 'TOTAL', kanan: rp(15000), tebal: true },
      { kiri: 'Tunai', kanan: rp(20000) },
      { kiri: 'Kembali', kanan: rp(5000) },
    ],
    kaki: [
      ...(d.receipt_footer.trim() ? [d.receipt_footer.trim()] : []),
      'Printer & kertas siap dipakai.',
    ],
  };
}

// Format ukuran file: 12 KB / 3,4 MB (id-ID).
function ukuranFile(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
}

// Kartu Backup (fitur 1.2): tombol backup manual + daftar file terakhir +
// unduh. BUKAN kartu saklar — tidak ada konfirmasi swal (backup non-destruktif,
// boleh diklik berulang), pola tetap kartu + tombol .btn yang sudah ada.
function kartuBackup(): string {
  const daftar = state.backups.length
    ? `<ul class="mt-2 divide-y divide-gray-100 dark:divide-gray-700" data-backup-list>
        ${state.backups.map((b) => `
        <li class="flex flex-wrap items-center justify-between gap-2 py-2" data-nama="${esc(b.nama)}">
          <div class="min-w-0">
            <div class="truncate text-sm text-gray-700 dark:text-gray-300">${esc(b.nama)}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400">${waktu(b.waktu)} · ${ukuranFile(b.ukuran)}</div>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <!-- Pulihkan (2026-10-16): server verifikasi integritas -> backup
                 pengaman -> ganti DB. Tombol disabilitas saat backup jalan. -->
            <button type="button" data-restore="${esc(b.nama)}" class="btn btn-ghost btn-sm !text-red-600 dark:!text-red-400"
                    ${state.backupJalan ? 'disabled' : ''} title="Kembalikan SELURUH database ke isi file backup ini">
              ${icon('sync')}<span>Pulihkan</span>
            </button>
            <a class="btn btn-outline btn-sm shrink-0" href="/api/backup/${encodeURIComponent(b.nama)}" download>
              ${icon('download')}<span>Unduh</span>
            </a>
          </div>
        </li>`).join('')}
      </ul>`
    : `<p class="mt-2 text-sm text-gray-500 dark:text-gray-400" data-backup-kosong>
         Belum ada file backup. Klik "Backup sekarang" untuk membuat satu —
         atau tunggu jadwal otomatis (dicek tiap jam, 1× sehari).
       </p>`;
  const err = state.backupErr
    ? `<p class="mt-2 text-xs text-red-600 dark:text-red-400">${esc(state.backupErr)}</p>` : '';
  return `
    <div class="card" data-set-card data-cari="backup cadangan pulihkan restore unduh data database salinan otomatis harian">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('shieldCheck')}</span>
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Backup data</h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Salinan utuh database dibuat otomatis <b>1× sehari</b> — <b>14 file</b> terbaru
              disimpan. <b>Pulihkan</b> mengembalikan SELURUH database ke isi file itu: data
              setelah backup (penjualan, stok, hutang) hilang dan device bisa diminta login
              ulang; server membuat backup pengaman lebih dulu.
            </p>
            <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
              API mati? Restore manual = salin file backup saat API berhenti (lihat README).
            </p>
          </div>
        </div>
        <button type="button" id="set-backup" class="btn btn-outline w-full shrink-0 sm:w-auto" ${state.backupJalan ? 'disabled' : ''}>
          ${icon('sync')}<span>${state.backupJalan ? 'Membuat backup…' : 'Backup sekarang'}</span>
        </button>
      </div>
      ${err}
      ${daftar}
    </div>`;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function paint(): void {
  const navHost = host?.querySelector('#set-nav-host');
  if (navHost) navHost.innerHTML = navPengaturan();
  const body = host?.querySelector('#set-body');
  if (!body) return;
  body.innerHTML = renderBody();
  bind();
  terapkanCari();
  // Panel mode: hanya seksi aktif yang tampil, tidak mengikuti scroll
  body.querySelectorAll<HTMLElement>('[data-set-sec]').forEach((sec) => {
    const aktif = sec.dataset.setSec === state.seksiAktif;
    sec.style.display = aktif ? '' : 'none';
  });
  paintRingkas();
}

function bind(): void {
  // Navigasi seksi (tombol, bukan anchor — hash milik router).
  host?.querySelectorAll<HTMLElement>('[data-set-nav]').forEach((b) =>
    b.addEventListener('click', () => lompatSeksi(b.dataset.setNav as SeksiId)));
  host?.querySelector('#set-cari-bersih')?.addEventListener('click', () => bersihkanCari());

  // Draft form toko: setiap ketikan disimpan di state supaya repaint dari
  // toggle lain (mis. Jeda cetak) TIDAK membuang isian yang belum disimpan.
  const formToko = host?.querySelector<HTMLElement>('#set-toko-form');
  formToko?.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    const kunci = KUNCI_TOKO[el.id];
    if (!kunci) return;
    state.toko[kunci] = el.value;
    perbaruiStatusToko();
  });

  // Draft opsi dokumen & struk. Teks/checkbox pelanggan tidak mem-paint ulang
  // supaya fokus ketikan selamat; toggle saklar di-paint ulang karena teks
  // "Cetak/Mati" & "Pendek/Penuh" ikut berubah.
  const formDok = host?.querySelector<HTMLElement>('#set-dok-form');
  formDok?.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    const kunciTeks = KUNCI_DOK_TEKS[el.id];
    if (kunciTeks) {
      state.dok[kunciTeks] = el.value;
      perbaruiStatusDok();
      paintPratinjauStruk();
      return;
    }
    if (el.dataset.dokCust) {
      const dipilih = pilihPelangganDari(state.dok);
      const token = el.dataset.dokCust;
      if (el.checked) dipilih.add(token);
      else dipilih.delete(token);
      state.dok.receipt_customer = URUTAN_PELANGGAN.filter((t) => dipilih.has(t)).join(',');
      perbaruiStatusDok();
      paintPratinjauStruk();
      return;
    }
    const kunciBool = KUNCI_DOK_BOOL[el.id];
    if (kunciBool) {
      state.dok[kunciBool] = el.checked;
      paint();
    }
  });

  // Kedua saklar pola sama: konfirmasi -> POST HANYA kunci yang diubah
  // (endpoint menerima update parsial) -> snapshot state -> paint ulang.
  const saklar: {
    id: keyof typeof state; input: string; key: 'allow_negative_stock' | 'tolak_jual_kadaluarsa';
    tanya: (n: boolean) => { title: string; message: string; okLabel: string; danger: boolean };
    sukses: (n: boolean) => string;
  }[] = [
    {
      id: 'minus', input: '#set-minus', key: 'allow_negative_stock',
      tanya: (n) => ({
        title: n ? 'Izinkan stok minus?' : 'Kembalikan aturan stok ketat?',
        message: n
          ? 'Penjualan akan terus berjalan walau stok sudah habis, dan angka stok bisa menjadi negatif. Anda tetap bisa mematikannya kapan saja.'
          : 'Penjualan yang melebihi stok akan ditolak lagi dengan pesan "stok kurang". Stok yang sudah minus tidak otomatis dikembalikan.',
        okLabel: n ? 'Ya, izinkan' : 'Ya, kembalikan',
        danger: n,
      }),
      sukses: (n) => (n ? 'Stok boleh minus: aktif' : 'Stok tidak boleh minus: aktif lagi'),
    },
    {
      id: 'kadaluarsa', input: '#set-kadaluarsa', key: 'tolak_jual_kadaluarsa',
      tanya: (n) => ({
        title: n ? 'Tolak jual barang kadaluarsa?' : 'Bolehkan jual barang kadaluarsa lagi?',
        message: n
          ? 'Server akan menolak penjualan yang memuat barang lewat tanggal kadaluarsa (pesan "barang kadaluarsa: ..."). Hari kadaluarsa masih boleh dijual. Strip peringatan di layar kasir tetap tampil.'
          : 'Barang lewat tanggal kadaluarsa kembali boleh terjual; layar kasir hanya menampilkan peringatan visual. Tanggal di produk tidak dihapus.',
        okLabel: n ? 'Ya, tolak' : 'Ya, izinkan',
        danger: n,
      }),
      sukses: (n) => (n ? 'Tolak jual kadaluarsa: aktif' : 'Tolak jual kadaluarsa: nonaktif lagi'),
    },
  ];
  for (const s of saklar) {
    const input = host?.querySelector<HTMLInputElement>(s.input);
    if (!input) continue;
    input.addEventListener('change', async () => {
      const next = input.checked;
      const { title, message, okLabel, danger } = s.tanya(next);
      const yes = await confirmDialog({
        title, message, okLabel, cancelLabel: 'Batal, jangan diubah', danger,
      });
      if (!yes) {
        input.checked = !next;
        return;
      }
      try {
        await apiPost('/api/settings', { [s.key]: next });
        (state as Record<string, unknown>)[s.id] = next;
        toast(s.sukses(next), 'success');
        paint();
      } catch (e) {
        input.checked = !next;
        toast(`Gagal simpan: ${errMsg(e)}`, 'error');
      }
    });
  }

  // Kartu "Pengaturan toko": baca 4 field lalu POST sekali (endpoint menerima
  // update parsial multi-kunci). Respon dijadikan snapshot state supaya nilai
  // yang tampil = nilai TRIM hasil server, bukan hasil ketik kasar.
  host?.querySelector('#set-toko-simpan')?.addEventListener('click', async () => {
    if (state.tokoJalan) return;
    const val = (id: string) => (host?.querySelector<HTMLInputElement>(id)?.value ?? '').trim();
    const payload: Toko = {
      store_name: val('#set-toko-nama'),
      store_address: val('#set-toko-alamat'),
      store_phone: val('#set-toko-telepon'),
      store_email: val('#set-toko-email'),
    };
    // Simpan draft ke state SEBELUM paint: nilai yang dikirim = nilai yang
    // tampil (sudah di-trim), dan status "belum disimpan" tetap benar bila POST
    // gagal (draft tidak boleh hilang karena kegagalan jaringan).
    state.toko = { ...payload };
    state.tokoJalan = true;
    paint();
    try {
      const r = await apiPost<{ data: Settings }>('/api/settings', payload);
      state.toko = {
        store_name: r.data.store_name ?? '',
        store_address: r.data.store_address ?? '',
        store_phone: r.data.store_phone ?? '',
        store_email: r.data.store_email ?? '',
      };
      state.tokoAsli = { ...state.toko };
      // Sinkron nama toko + opsi dokumen ke cache jalur cetak.
      syncDariServerSettings(r.data);
      toast('Pengaturan toko disimpan — kop invoice A4 memakai nilai ini', 'success');
    } catch (e) {
      toast(`Gagal simpan pengaturan toko: ${errMsg(e)}`, 'error');
    } finally {
      state.tokoJalan = false;
      if (host?.isConnected) paint();
    }
  });

  // Simpan opsi dokumen & struk: satu POST untuk semua kunci (update parsial
  // di server, tapi dari sini sengaja lengkap supaya toggle & teks konsisten).
  host?.querySelector('#set-dok-simpan')?.addEventListener('click', async () => {
    if (state.dokJalan) return;
    state.dokJalan = true;
    paint();
    try {
      const r = await apiPost<{ data: Settings }>('/api/settings', { ...state.dok });
      state.dok = dokDariSettings(r.data);
      state.dokAsli = { ...state.dok };
      syncDariServerSettings(r.data);
      toast('Pengaturan dokumen & struk disimpan — semua device memakai nilai ini', 'success');
    } catch (e) {
      toast(`Gagal simpan pengaturan dokumen: ${errMsg(e)}`, 'error');
    } finally {
      state.dokJalan = false;
      if (host?.isConnected) paint();
    }
  });

  // Logo struk thermal (butir ROADMAP 1.6.4): unggah diproses di klien dulu
  // (PNG ≤384px) lalu POST /api/settings/logo; sukses/gagal TIDAK mem-paint
  // ulang form — ketikan store_* yang belum disimpan harus tetap utuh.
  // resetLogoStrukCache() supaya struk berikutnya memakai logo terbaru.
  host?.querySelector<HTMLInputElement>('#set-logo-file')?.addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // pilih berkas yang sama dua kali tetap memicu change
    if (!file) return;
    try {
      const dataUrl = await kecilkanLogo(file);
      const r = await apiPost<{ data: { store_logo: string } }>('/api/settings/logo', { image: dataUrl });
      state.logo = r.data.store_logo ?? '';
      resetLogoStrukCache();
      tampilLogo();
      toast('Logo disimpan — struk thermal berikutnya mencetak logo ini', 'success');
    } catch (e) {
      toast(`Gagal unggah logo: ${errMsg(e)}`, 'error');
    }
  });
  // Hapus logo: tanpa swal (pola avatar — non-destruktif, berkasnya bisa
  // diunggah ulang kapan saja; swal repo ini untuk aksi yang menghilangkan data).
  host?.querySelector('#set-logo-hapus')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/settings/logo', { image: '' });
      state.logo = '';
      resetLogoStrukCache();
      tampilLogo();
      toast('Logo dihapus — struk thermal kembali tanpa logo', 'success');
    } catch (e) {
      toast(`Gagal hapus logo: ${errMsg(e)}`, 'error');
    }
  });

  // Pratinjau struk mengikuti nama toko dari server (Identitas toko).
  // Tidak ada input nama toko per-device lagi.

  // Tombol "Tes cetak" (riset 2026-10-20 — pola printer setup Shopify/Square):
  // kirim struk CONTOH lewat print-agent yang sama dengan transaksi asli.
  // Menghormati "Jeda semua cetak" — tolak dengan toast, nol kertas terbuang.
  host?.querySelector('#set-tes-cetak')?.addEventListener('click', async () => {
    if (state.tesJalan) return;
    if (getPrintPause()) {
      toast('Tes cetak ditolak: "Jeda semua cetak" sedang aktif — nyalakan dulu di kartu ini', 'warning');
      return;
    }
    state.tesJalan = true;
    paint();
    try {
      await kirimPrint(await strukUntukTercetak(strukContoh(getToko()), getStrukLayout()));
      toast('Tes cetak terkirim ke print-agent device ini', 'success');
    } catch (e) {
      toast(`Gagal tes cetak: ${errMsg(e)}`, 'error');
    } finally {
      state.tesJalan = false;
      if (host?.isConnected) paint();
    }
  });

  // Kartu "Format & zona waktu": simpan ke localStorage per-device, tanpa API.
  host?.querySelector('#set-timezone')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (ZONA_WAKTU_PILIHAN.some((z) => z.nilai === v)) {
      state.zonaWaktu = v as ZonaWaktu;
      setZonaWaktu(v as ZonaWaktu);
      state.currencyJalan = true;
      paint();
    }
  });
  host?.querySelector('#set-currency-simbol')?.addEventListener('input', (e) => {
    const cur = { ...state.currency };
    cur.simbol = (e.target as HTMLInputElement).value;
    state.currency = cur;
  });
  host?.querySelector('#set-currency-kode')?.addEventListener('input', (e) => {
    const cur = { ...state.currency };
    cur.kode = (e.target as HTMLInputElement).value;
    state.currency = cur;
  });
  host?.querySelector('#set-currency-desimal')?.addEventListener('input', (e) => {
    const cur = { ...state.currency };
    cur.desimal = Number((e.target as HTMLInputElement).value) || 0;
    state.currency = cur;
    // Update contoh tampilan langsung
    const contoh = host?.querySelector('#set-contoh-currency');
    if (contoh) contoh.textContent = formatRupiahContoh(cur);
  });
  host?.querySelector('#set-format-simpan')?.addEventListener('click', async () => {
    const cur = state.currency ?? CURRENCY_BAWAAN;
    setCurrencyFormat(cur);
    state.currencyJalan = false;
    paint();
    toast('Format currency & zona waktu disimpan — device ini', 'success');
  });

  // Kartu "Cetak struk": preferensi per-device, langsung tersimpan tanpa
  // konfirmasi (non-destruktif & bisa dibalik — alasan sama dengan Backup).
  // Di-paint ulang supaya label saklar ("Aktif"/"Nonaktif") ikut terbarui.
  // Kartu "Tampilan perangkat ini": localStorage saja (tanpa API) — pindahan
  // dari halaman Profil (2026-10-11). applyTheme + event ravaa:theme agar
  // sidebar/header ikut tercatat ulang seketika.
  host?.querySelector('#set-dev-simpan')?.addEventListener('click', () => {
    const t = (host?.querySelector<HTMLSelectElement>('#set-dev-theme')?.value ?? 'light') === 'dark' ? 'dark' : 'light';
    // Nama toko mengikuti Identitas toko (server) — tidak disimpan per device lagi
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('ravaa.theme', t); } catch { /* abaikan */ }
    document.dispatchEvent(new CustomEvent('ravaa:theme'));
    toast('Tampilan perangkat disimpan', 'success');
  });
  host?.querySelector<HTMLSelectElement>('#set-autolock')?.addEventListener('change', (e) => {
    const menit = Number((e.currentTarget as HTMLSelectElement).value);
    setAutoLockMenit(menit);
    toast(
      menit > 0 ? `Kunci layar otomatis: ${menit} menit tanpa aktivitas` : 'Kunci layar otomatis dimatikan',
      'info',
    );
  });
  host?.querySelector<HTMLInputElement>('#set-pause')?.addEventListener('change', (e) => {
    const nyala = (e.target as HTMLInputElement).checked;
    setPrintPause(!nyala); // saklar menyala = CETAK menyala = pause mati
    toast(
      nyala
        ? 'Jeda cetak DIMATIKAN — struk/label/kick laci kirim ke printer lagi'
        : 'Jeda cetak AKTIF — semua kirim ke printer ditahan (kertas aman)',
      nyala ? 'success' : 'warning',
    );
    paint();
  });
  host?.querySelector<HTMLInputElement>('#set-cetak')?.addEventListener('change', (e) => {
    const nyala = (e.target as HTMLInputElement).checked;
    setAutoPrint(nyala);
    toast(nyala ? 'Cetak otomatis: aktif (device ini)' : 'Cetak otomatis: nonaktif (device ini)', 'success');
    paint();
  });
  host?.querySelector<HTMLSelectElement>('#set-layout')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    const layout: LayoutStruk = v === 'a4' ? 'a4' : 'thermal';
    setStrukLayout(layout);
    toast(
      layout === 'a4' ? 'Layout struk: Epson L3110 (A4) — eject tanpa potong' : 'Layout struk: Thermal 58mm',
      'success',
    );
    paint();
  });

  // Alamat print-agent (per-device). Tombol/Enter memvalidasi URL dulu supaya
  // salah ketik tidak membuat SEMUA cetak gagal tanpa petunjuk. Kosong =
  // kembali ke bawaan localhost:9100. Tanpa paint: fokus & ketikan lain aman.
  const simpanAgent = (): void => {
    const el = host?.querySelector<HTMLInputElement>('#set-agent');
    if (!el) return;
    const mentah = el.value.trim();
    const calon = mentah || 'http://localhost:9100';
    let u: URL;
    try {
      u = new URL(calon);
    } catch {
      toast('Alamat print-agent tidak valid — contoh: http://192.168.1.10:9100', 'error');
      el.focus();
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      toast('Alamat print-agent harus diawali http:// atau https://', 'error');
      el.focus();
      return;
    }
    if (u.search || u.hash) {
      toast('Alamat print-agent tidak boleh memuat ?query atau #hash', 'error');
      el.focus();
      return;
    }
    setAgentUrl(calon);
    el.value = getAgentUrl();
    toast(`Print-agent device ini: ${getAgentUrl()}`, 'success');
  };
  host?.querySelector('#set-agent-simpan')?.addEventListener('click', simpanAgent);
  host?.querySelector<HTMLInputElement>('#set-agent')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      simpanAgent();
    }
  });

  // Perintah kick laci (Paket A, 2026-10-20): hex divalidasi sebelum disimpan.
  // Kosong = kembali ke byte Epson bawaan. Tanpa paint — fokus & ketikan
  // preferensi lain (alamat agent) tetap utuh.
  const simpanLaciBytes = (): void => {
    const el = host?.querySelector<HTMLInputElement>('#set-laci-bytes');
    if (!el) return;
    const mentah = el.value.trim();
    if (!setDrawerKickBytes(mentah)) {
      toast('Perintah kick laci tidak valid — isi byte hex 00–FF, mis. 1B 70 00 19 FA', 'error');
      el.focus();
      return;
    }
    el.value = getDrawerKickHex();
    toast(
      mentah
        ? `Perintah kick laci device ini: ${el.value}`
        : `Perintah kick laci kembali ke bawaan Epson: ${LACI_BAWAAN_HEX}`,
      'success',
    );
  };
  host?.querySelector('#set-laci-bytes-simpan')?.addEventListener('click', simpanLaciBytes);
  host?.querySelector<HTMLInputElement>('#set-laci-bytes')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      simpanLaciBytes();
    }
  });

  host?.querySelector<HTMLInputElement>('#set-laci')?.addEventListener('change', (e) => {
    const nyala = (e.target as HTMLInputElement).checked;
    setDrawerKick(nyala);
    toast(
      nyala
        ? 'Kick laci: aktif — penjualan tunai membuka laci lewat print-agent'
        : 'Kick laci: nonaktif di device ini (penjualan tunai tetap tercatat)',
      nyala ? 'success' : 'warning',
    );
    paint();
  });

  // Tombol Backup sekarang: POST -> refresh daftar -> toast. Tanpa konfirmasi
  // (non-destruktif; retensi 14 file di server yang menjaga jumlah).
  host?.querySelector('#set-backup')?.addEventListener('click', async () => {
    if (state.backupJalan) return;
    state.backupJalan = true;
    state.backupErr = '';
    paint();
    try {
      const r = await apiPost<{ data: BarisBackup }>('/api/backup', {});
      toast(`Backup dibuat: ${r.data.nama} (${ukuranFile(r.data.ukuran)})`, 'success');
      await muatBackup();
    } catch (e) {
      state.backupErr = `Gagal backup: ${errMsg(e)}`;
      toast(state.backupErr, 'error');
    } finally {
      state.backupJalan = false;
      if (host?.isConnected) paint();
    }
  });
  // Tombol "Pulihkan" per baris backup (2026-10-16): operasi PALING berbahaya
  // di halaman ini — konfirmasi danger, lalu server verifikasi integritas +
  // membuat backup pengaman sebelum mengganti database. Setelah sukses,
  // halaman DI-Reload: seluruh cache & angka di layar sudah basi.
  host?.querySelectorAll<HTMLElement>('[data-restore]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (state.backupJalan) return;
      const nama = btn.dataset.restore ?? '';
      if (!nama) return;
      const yes = await confirmDialog({
        title: `Pulihkan database dari ${nama}?`,
        message:
          'SELURUH database dikembalikan ke isi file backup ini. Semua data yang dibuat ' +
          'SETELAH backup (penjualan, stok, hutang, pengguna baru) akan HILANG dan tidak ' +
          'bisa dikembalikan. Server membuat backup pengaman lebih dulu, dan device bisa ' +
          'diminta login ulang. Lakukan hanya saat pemilik memerintahkan.',
        okLabel: 'Ya, pulihkan',
        cancelLabel: 'Batal, jangan dipulihkan',
        danger: true,
      });
      if (!yes) return;
      state.backupJalan = true;
      state.backupErr = '';
      paint();
      try {
        const r = await apiPost<{ data: { nama: string; pengaman: string } }>('/api/backup/restore', { nama });
        toast(
          `Database dipulihkan dari ${r.data.nama} · pengaman: ${r.data.pengaman}`,
          'success',
        );
        // Tunda sebentar supaya toast terbaca, lalu muat ulang halaman.
        window.setTimeout(() => location.reload(), 1500);
      } catch (e) {
        state.backupErr = `Gagal memulihkan: ${errMsg(e)}`;
        toast(state.backupErr, 'error');
        state.backupJalan = false;
        if (host?.isConnected) paint();
      }
    }),
  );
}

// Ambil daftar backup — gagal TIDAK menggagalkan halaman (kartu saklar tetap
// jalan), cukup pesan inline di kartu Backup.
async function muatBackup(): Promise<void> {
  try {
    const r = await apiGet<{ data: BarisBackup[] }>('/api/backup');
    state.backups = Array.isArray(r.data) ? r.data : [];
    state.backupErr = '';
  } catch (e) {
    state.backupErr = `Gagal memuat daftar backup: ${errMsg(e)}`;
  }
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  // Settings dan daftar backup paralel — daftar tidak memblokir kartu saklar.
  const [s, _] = await Promise.allSettled([
    apiGet<{ data: Settings }>('/api/settings'),
    muatBackup(),
  ]);
  if (s.status === 'fulfilled') {
    state.minus = s.value.data?.allow_negative_stock === true;
    state.kadaluarsa = s.value.data?.tolak_jual_kadaluarsa === true;
    state.toko = {
      store_name: s.value.data?.store_name ?? '',
      store_address: s.value.data?.store_address ?? '',
      store_phone: s.value.data?.store_phone ?? '',
      store_email: s.value.data?.store_email ?? '',
    };
    // Snapshot server = pembanding penanda "belum disimpan".
    state.tokoAsli = { ...state.toko };
    state.dok = dokDariSettings(s.value.data);
    state.dokAsli = { ...state.dok };
    state.logo = s.value.data?.store_logo ?? '';
    // Sinkron nama toko + opsi dokumen/struk ke cache jalur cetak.
    syncDariServerSettings(s.value.data);
  } else {
    state.error = errMsg(s.reason);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

export async function mountSettingsPage(el: HTMLElement): Promise<void> {
  host = el;
  // Kunjungan baru selalu mulai dari atas & tanpa filter; state modul dipakai
  // ulang antar-navigasi, jadi jangan biarkan seksi/filter kunjungan lalu bocor.
  state.seksiAktif = 'transaksi';
  state.error = '';
  state.backupErr = '';
  // Ctrl+K = fokus kolom cari (pola dashboard POS populer: Square/Shopify).
  // Listener dokumen milik kunjungan terakhir di-abort dulu supaya berpindah
  // halaman tidak menumpuk listener; dialog yang menutupi halaman memegang
  // pintasannya sendiri (jangan direbut).
  sinyal?.abort();
  sinyal = new AbortController();
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (String(e.key).toLowerCase() !== 'k') return;
    // Sudah pindah halaman (host lama dilepas router): lepas listener ini
    // supaya Ctrl+K tidak terus ditahan (preventDefault) di halaman lain.
    if (!host?.isConnected) {
      sinyal?.abort();
      return;
    }
    if (document.querySelector('.modal-overlay:not(.is-closing), .swal2-popup')) return;
    e.preventDefault();
    host?.querySelector<HTMLInputElement>('#set-cari')?.focus();
  }, { signal: sinyal.signal });
  el.innerHTML = renderPage();
  bindCari();
  await load();
}
