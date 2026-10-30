// Halaman Label harga (#/labels) — cetak LEMBAR A4/Folio (refactor 2026-10-17).
//
// Keputusan pemilik 2026-10-17: printer label toko = Epson L3110 & L1210
// (inkjet LEMBAR, kertas A4 + Folio 215×330 mm) — bukan thermal 58 mm. Karena
// itu halaman ini tidak lagi memakai print-agent ESC/POS, melainkan dokumen
// HTML ber-`@page` mm yang dicetak browser (`window.print()`, pola invoice A4;
// lihat `labelsheet.ts`). Layar dibagi dua ala Aronium:
//   kiri  = pengaturan kertas/tata letak/isi label + pemilihan produk,
//   kanan = PRATINJAU lembar sesungguhnya (builder yang SAMA dengan cetakan,
//           jadi WYSIWYG) + ringkasan + tombol Cetak.
//
// Masuk lewat toolbar Produk (`#/labels`), shell penuh tanpa sidebar
// (`renderLabelShell`). Produk dibaca dari cache lokal lalu `GET /api/products`
// (pola lama — tetap jalan offline); TIDAK ada endpoint baru.
//
// Cetak menghormati "Jeda semua cetak" (`getPrintPause`, default PAUSED):
// tombol Cetak menolak dengan toast selama dijeda (keputusan asumsi plan A3).

import { apiGet } from '../api';
import { getCachedProducts, type Category, type Product } from '../store';
import {
  CSS_LABEL,
  KERTAS_PRESET,
  cetakLabel,
  denganSalinan,
  getSetelanLabel,
  hitungHalaman,
  hitungTataLetak,
  htmlLembarSemua,
  normalisasiSetelan,
  setSetelanLabel,
  setelanAwal,
  type IsiLabel,
  type Kertas,
  type ProdukCetak,
  type SetelanLabel,
} from '../labelsheet';
import { getPrintPause } from '../ui/print-pref';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { esc } from '../ui/html';
import { errMsg } from '../ui/http';

const rp = (n: number) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;

/** Produk yang bisa dicetak labelnya: harga dinamis tidak punya angka pasti,
 *  dan harga 0 berarti belum diisi (aturan lama, dipertahankan). */
const layak = (p: Product) => p.price_dynamic !== 1 && p.price > 0;

const keCetak = (p: Product): ProdukCetak => ({
  name: p.name,
  sku: p.sku,
  price: p.price,
  unit: p.unit,
  barcode: p.barcode,
  discount_type: p.discount_type,
  discount: p.discount,
});

const state = {
  products: [] as Product[],
  categories: [] as Category[],
  loading: true,
  error: '',
  q: '',
  /** 'all' = tanpa saring kategori. */
  cat: 'all',
  /** id produk yang DICENTANG. DEFAULT KOSONG — jangan pilih semua produk
   *  otomatis (permintaan pemilik 2026-10-17: ribuan produk menghambat/lemot,
   *  biar user memilih sendiri; tombol "Pilih yang tampil" untuk massal). */
  pilih: new Set<number>(),
  setelan: setelanAwal(),
};

let host: HTMLElement | null = null;
let pageAbort: AbortController | null = null;

/** Produk layak yang lolos filter kategori + pencarian (SEMUA kata harus cocok,
 *  konsisten dengan halaman Produk & POS). */
function tampil(): Product[] {
  const q = state.q.trim().toLowerCase();
  const kata = q ? q.split(/\s+/) : [];
  return state.products
    .filter(layak)
    .filter((p) => state.cat === 'all' || p.category_slug === state.cat)
    .filter((p) => {
      if (!kata.length) return true;
      const hay = `${p.name} ${p.sku} ${p.barcode ?? ''}`.toLowerCase();
      return kata.every((k) => hay.includes(k));
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'id'));
}

/** Semua yang dicentang — TIDAK dibatasi filter sekarang (sisa pilihan dari
 *  pencarian sebelumnya tidak boleh hilang diam-diam). */
function dipilihProduk(): Product[] {
  return state.products.filter(layak).filter((p) => state.pilih.has(p.id));
}

/* ---------- Ringkasan (teks di header shell, strip, tombol) ---------- */

function namaKertas(s: SetelanLabel): string {
  return s.kertas === 'custom'
    ? `Kustom ${s.lebarMm}×${s.tinggiMm} mm`
    : KERTAS_PRESET[s.kertas].label;
}

function ringkasTeks(): string {
  const s = state.setelan;
  const t = hitungTataLetak(s);
  if (t.pesan) return t.pesan;
  const n = dipilihProduk().length;
  if (!n) return 'Belum ada produk dicentang';
  const total = n * s.salinan;
  const { halaman, perLembar } = hitungHalaman(total, s);
  return `${total} label · ${halaman} halaman · ${namaKertas(s)} · ${perLembar}/lembar`;
}

/** Perbarui semua teks ringkasan TANPA render ulang (input yang sedang
 *  difokus kasir tidak boleh terganti). Dipanggil setiap perubahan state. */
function updateRingkas(): void {
  const s = state.setelan;
  const t = hitungTataLetak(s);
  const n = dipilihProduk().length;
  const total = n * s.salinan;
  const teks = ringkasTeks();

  const setTeks = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  // #lb-head ada di header shell (di luar #page), sisanya di dalam halaman.
  setTeks('lb-head', teks);
  setTeks('lb-info', teks);
  setTeks('lb-terpilih', `${n} dipilih`);
  setTeks('lb-terpilih-count', `(${n})`);
  setTeks(
    'lb-lt-info',
    t.pesan
      ? '—'
      : `Lebar label ${t.lebarLabelMm.toFixed(1)} mm · ${t.barisPerLembar} baris · ${t.perLembar}/lembar`,
  );

  const pilihBtn = host?.querySelector('#lb-pilih');
  if (pilihBtn) pilihBtn.textContent = `Pilih yang tampil (${tampil().length})`;

  // "N di luar filter" — pilihan dari pencarian/kategori sebelumnya yang
  // tidak terlihat tapi ikut tercetak; harus tampil supaya tidak kaget.
  const diLuar = n - tampil().filter((p) => state.pilih.has(p.id)).length;
  const luarEl = host?.querySelector<HTMLElement>('#lb-diluar');
  if (luarEl) {
    luarEl.classList.toggle('hidden', diLuar <= 0);
    luarEl.textContent = diLuar > 0 ? `${diLuar} di luar filter sekarang (ikut tercetak)` : '';
  }

  const btn = host?.querySelector<HTMLButtonElement>('#lb-cetak');
  if (btn) {
    btn.disabled = Boolean(t.pesan) || n === 0;
    const span = btn.querySelector('span');
    if (span) span.textContent = `Cetak ${total} label`;
  }

  const jeda = host?.querySelector<HTMLElement>('#lb-jeda');
  if (jeda) jeda.classList.toggle('hidden', !getPrintPause());
}

/* ---------- Render ---------- */

function opsiKategori(): string {
  return `<option value="all">Semua kategori</option>${state.categories
    .map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`)
    .join('')}`;
}

/** Opsi dropdown hasil pencarian — klik = MASUK keranjang "Produk terpilih"
 *  (permintaan pemilik 2026-10-17: "teknisnya seperti keranjang belanja").
 *  Yang sudah terdaftar diberi centang + tidak bereaksi; buangnya lewat ikon
 *  hapus di keranjang. */
function opsiHasil(p: Product): string {
  const on = state.pilih.has(p.id);
  return `<button type="button" data-pilih="${p.id}" class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
    on ? 'cursor-default' : 'hover:bg-primary-soft dark:hover:bg-primary/15'
  }" role="option" aria-selected="${on}">
    <span class="min-w-0">
      <span class="block truncate font-semibold ${on ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-white'}">${esc(p.name)}</span>
      <span class="block text-[11px] text-gray-500 dark:text-gray-400">${esc(p.sku)} · ${rp(p.price)} / ${esc(p.unit)}</span>
    </span>
    <span class="shrink-0 [&>svg]:size-4 ${on ? 'text-emerald-500' : 'text-gray-400'}">${icon(on ? 'check' : 'plus')}</span>
  </button>`;
}

/** Isi dropdown hasil pencarian — HANYA saat ada kata kunci (permintaan
 *  pemilik 2026-10-17: bukan seluruh produk); filter kategori ikut menyaring.
 *  Isi kotak ditimpa `paintHasil()`; buka/tutup diatur `bind()`. */
function hasilHtml(): string {
  if (!state.q.trim()) return '';
  if (state.loading && !state.products.length) {
    return `<div class="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">Memuat produk…</div>`;
  }
  const list = tampil();
  if (!list.length) {
    return `<div class="empty">Tidak ketemu — coba kata lain.</div>`;
  }
  return list.map(opsiHasil).join('');
}

/** Baris di kotak "Produk terpilih" — tanpa centang, ada ikon hapus. */
function barisTerpilih(p: Product): string {
  return `<div class="flex items-center gap-1 rounded-lg border border-gray-200 py-1 pr-1 pl-2 dark:border-gray-700" data-dipilih="${p.id}">
    <span class="min-w-0 flex-1">
      <span class="block truncate text-xs font-medium text-gray-900 dark:text-white" title="${esc(p.name)}">${esc(p.name)}</span>
      <span class="block text-[11px] text-gray-500 dark:text-gray-400">${esc(p.sku)} · ${rp(p.price)} / ${esc(p.unit)}</span>
    </span>
    <button type="button" data-hapus="${p.id}" class="row-btn row-btn-danger" title="Hapus dari pilihan" aria-label="Hapus ${esc(p.name)} dari pilihan">${icon('trash')}</button>
  </div>`;
}

/** Isi kotak "Produk terpilih" — hanya yang DICENTANG (permintaan pemilik
 *  2026-10-17) supaya terlihat apa saja yang akan tercetak; kiri-nya hasil
 *  pencarian untuk menambah. Urut nama = urut hasil pencarian. */
function terpilihHtml(): string {
  const list = dipilihProduk().sort((a, b) => a.name.localeCompare(b.name, 'id'));
  if (!list.length) {
    return `<p class="p-2 text-xs text-gray-500 dark:text-gray-400">Belum ada produk terpilih — cari produk di atas lalu centang.</p>`;
  }
  return list.map(barisTerpilih).join('');
}

/** Isi area pratinjau: empty-state, pesan setelan, atau lembar sesungguhnya. */
function pratinjauHtml(): string {
  if (state.loading && !state.products.length) {
    return `<div class="empty">${icon('info')}<span>Memuat produk…</span></div>`;
  }
  const dipilih = dipilihProduk();
  if (!dipilih.length) {
    return `<div class="empty">${icon('info')}<span>Centang produk di panel kiri untuk melihat pratinjau labelnya.</span></div>`;
  }
  const t = hitungTataLetak(state.setelan);
  if (t.pesan) {
    return `<div class="empty">${icon('alert')}<span>${esc(t.pesan)}</span></div>`;
  }
  // Builder yang SAMA dengan dokumen cetak — pratinjau = hasil cetak.
  return `<div id="lb-zoom" class="mx-auto w-fit">${htmlLembarSemua(
    state.setelan,
    denganSalinan(dipilih.map(keCetak), state.setelan.salinan),
  )}</div>`;
}

/** Skalakan pratinjau agar lembar muat di panel kanan (tidak pernah > 1 —
 *  bila muat, tampil ukuran asli 100%). `zoom` (bukan transform) supaya
 *  guliran & tinggi ikut menyesuaikan. */
function paskanZoom(): void {
  const kont = host?.querySelector<HTMLElement>('#lb-pratinjau');
  const bungkus = host?.querySelector<HTMLElement>('#lb-zoom');
  const lembar = bungkus?.querySelector<HTMLElement>('.lb-lembar');
  if (!kont || !bungkus || !lembar) return;
  bungkus.style.zoom = '1';
  const lebar = lembar.getBoundingClientRect().width;
  if (!lebar) return;
  const tersedia = kont.clientWidth - 32; // p-4 kiri+kanan
  const z = Math.min(1, Math.max(0.25, tersedia / lebar));
  bungkus.style.zoom = String(Math.round(z * 1000) / 1000);
}

function kartuKertas(): string {
  const s = state.setelan;
  return `
    <section class="space-y-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Kertas</h2>
      <div>
        <label class="label" for="lb-kertas">Ukuran kertas</label>
        <select id="lb-kertas" class="input input-sm">
          <option value="a4"${s.kertas === 'a4' ? ' selected' : ''}>${KERTAS_PRESET.a4.label}</option>
          <option value="folio"${s.kertas === 'folio' ? ' selected' : ''}>${KERTAS_PRESET.folio.label}</option>
          <option value="custom"${s.kertas === 'custom' ? ' selected' : ''}>Kustom…</option>
        </select>
      </div>
      <div id="lb-kustom" class="grid grid-cols-2 gap-2${s.kertas === 'custom' ? '' : ' hidden'}">
        <div>
          <label class="label" for="lb-kustom-w">Lebar (mm)</label>
          <input id="lb-kustom-w" class="input input-sm" type="number" inputmode="numeric" min="50" max="600" value="${s.lebarMm}" />
        </div>
        <div>
          <label class="label" for="lb-kustom-h">Tinggi (mm)</label>
          <input id="lb-kustom-h" class="input input-sm" type="number" inputmode="numeric" min="50" max="600" value="${s.tinggiMm}" />
        </div>
      </div>
      <div>
        <label class="label">Margin cetak (mm)</label>
        <div class="grid grid-cols-4 gap-1.5">
          <input id="lb-m-t" class="input input-sm" type="number" inputmode="numeric" min="0" max="40" value="${s.marginAtas}" title="Margin atas" aria-label="Margin atas" />
          <input id="lb-m-r" class="input input-sm" type="number" inputmode="numeric" min="0" max="40" value="${s.marginKanan}" title="Margin kanan" aria-label="Margin kanan" />
          <input id="lb-m-b" class="input input-sm" type="number" inputmode="numeric" min="0" max="40" value="${s.marginBawah}" title="Margin bawah" aria-label="Margin bawah" />
          <input id="lb-m-l" class="input input-sm" type="number" inputmode="numeric" min="0" max="40" value="${s.marginKiri}" title="Margin kiri" aria-label="Margin kiri" />
        </div>
        <p class="mt-1 text-[11px] text-gray-400">Urutan: atas · kanan · bawah · kiri</p>
      </div>
    </section>`;
}

function kartuTataLetak(): string {
  const s = state.setelan;
  return `
    <section class="space-y-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Tata letak</h2>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="label" for="lb-kolom">Kolom</label>
          <input id="lb-kolom" class="input input-sm" type="number" inputmode="numeric" min="2" max="6" value="${s.kolom}" />
        </div>
        <div>
          <label class="label" for="lb-tinggi">Tinggi label (mm)</label>
          <input id="lb-tinggi" class="input input-sm" type="number" inputmode="numeric" min="10" max="120" value="${s.tinggiLabelMm}" />
        </div>
        <div>
          <label class="label" for="lb-jx">Jarak antar kolom</label>
          <input id="lb-jx" class="input input-sm" type="number" inputmode="numeric" min="0" max="10" value="${s.jarakX}" />
        </div>
        <div>
          <label class="label" for="lb-jy">Jarak antar baris</label>
          <input id="lb-jy" class="input input-sm" type="number" inputmode="numeric" min="0" max="10" value="${s.jarakY}" />
        </div>
      </div>
      <p class="text-[11px] text-gray-400" id="lb-lt-info">—</p>
    </section>`;
}

function barisCek(id: string, label: string, on: boolean): string {
  return `<label class="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/50">
    <input type="checkbox" id="${id}" ${on ? 'checked' : ''} class="size-4 accent-current" />
    <span class="text-xs text-gray-700 dark:text-gray-200">${label}</span>
  </label>`;
}

function kartuIsi(): string {
  const s = state.setelan;
  const isi = s.isi;
  return `
    <section class="space-y-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Isi label</h2>
      <div class="grid grid-cols-2 gap-x-1">
        ${barisCek('lb-i-nama', 'Nama', isi.nama)}
        ${barisCek('lb-i-harga', 'Harga', isi.harga)}
        ${barisCek('lb-i-barcode', 'Barcode', isi.barcode)}
        ${barisCek('lb-i-border', 'Garis tepi', isi.border)}
        ${barisCek('lb-i-promo', 'Harga promo (coret)', s.hargaPromo)}
      </div>
      <div class="grid grid-cols-3 gap-2">
        <div>
          <label class="label" for="lb-f-nama">Font nama (pt)</label>
          <input id="lb-f-nama" class="input input-sm" type="number" inputmode="numeric" min="5" max="20" value="${s.fontNamaPt}" />
        </div>
        <div>
          <label class="label" for="lb-f-harga">Font harga (pt)</label>
          <input id="lb-f-harga" class="input input-sm" type="number" inputmode="numeric" min="6" max="48" value="${s.fontHargaPt}" />
        </div>
        <div>
          <label class="label" for="lb-bc-tinggi">Barcode (mm)</label>
          <input id="lb-bc-tinggi" class="input input-sm" type="number" inputmode="numeric" min="4" max="30" value="${s.barcodeTinggiMm}" />
        </div>
      </div>
    </section>`;
}

function kartuSalinan(): string {
  const s = state.setelan;
  return `
    <section class="space-y-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Salinan</h2>
      <div class="flex items-center gap-2">
        <button type="button" id="lb-salinan-minus" class="btn btn-ghost !px-3" aria-label="Kurangi salinan">${icon('minus')}</button>
        <input id="lb-salinan" class="input input-sm w-16 text-center" type="number" inputmode="numeric" min="1" max="50" value="${s.salinan}" aria-label="Salinan tiap label" />
        <button type="button" id="lb-salinan-plus" class="btn btn-ghost !px-3" aria-label="Tambah salinan">${icon('plus')}</button>
        <span class="text-[11px] text-gray-400">tiap label dicetak N kali</span>
      </div>
    </section>`;
}

function kartuProduk(): string {
  return `
    <section class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Produk</h2>
        <span class="chip" id="lb-terpilih">0 dipilih</span>
      </div>
      <div class="relative">
        <div class="search-wrap">
          ${icon('search')}
          <input id="lb-q" class="input input-sm" type="search" placeholder="Cari produk…"
            aria-label="Cari nama, SKU, atau barcode" value="${esc(state.q)}" autocomplete="off" />
        </div>
        <div id="lb-hasil" class="absolute left-0 right-0 top-full z-20 mt-1 hidden max-h-72 overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-pop dark:border-gray-700 dark:bg-gray-800" role="listbox" aria-label="Hasil pencarian produk"></div>
      </div>
      <select id="lb-cat" class="input input-sm">${opsiKategori()}</select>
      <div class="flex flex-wrap gap-2">
        <button type="button" id="lb-pilih" class="btn btn-ghost">Pilih yang tampil</button>
        <button type="button" id="lb-kosong" class="btn btn-ghost">Kosongkan</button>
      </div>
      <p id="lb-diluar" class="hidden text-[11px] font-medium text-amber-600 dark:text-amber-400"></p>
      <div class="space-y-1">
        <p class="text-[11px] font-semibold text-gray-500 dark:text-gray-400">Produk terpilih <span id="lb-terpilih-count"></span></p>
        <div id="lb-dipilih" class="max-h-[42vh] space-y-1.5 overflow-y-auto rounded-lg border border-gray-200 p-1.5 dark:border-gray-700">
          ${terpilihHtml()}
        </div>
      </div>
      <p class="text-[11px] text-gray-400">
        Produk harga dinamis atau belum berharga tidak ikut. Produk tanpa
        barcode memakai SKU-nya sebagai barcode; kode yang terlalu panjang
        tetap tercetak sebagai teks di bawah harganya.
      </p>
    </section>`;
}

function alatHtml(): string {
  return `${kartuKertas()}${kartuTataLetak()}${kartuIsi()}${kartuSalinan()}${kartuProduk()}`;
}

function paint(): void {
  if (!host) return;
  host.innerHTML = `
    <style>
      ${CSS_LABEL}
      #lb-zoom { zoom: 1; }
      #lb-pratinjau .lb-lembar { box-shadow: 0 1px 6px rgb(2 6 23 / .18); margin: 0 auto 10px; }
      #lb-pratinjau .lb-lembar:last-child { margin-bottom: 0; }
    </style>
    <div class="lb-root flex h-full min-h-0 flex-col lg:flex-row">
      <aside class="w-full shrink-0 space-y-5 overflow-y-auto border-b border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800 lg:w-[350px] lg:border-b-0 lg:border-r">
        ${alatHtml()}
      </aside>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-gray-200 bg-white px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800">
          <span class="text-sm font-semibold text-gray-900 dark:text-white">Pratinjau</span>
          <span id="lb-info" class="text-xs text-gray-500 dark:text-gray-400"></span>
          <span id="lb-jeda" class="chip hidden text-amber-700 dark:text-amber-400" title="Semua cetak dijeda di halaman Pengaturan">Cetak dijeda</span>
          <button type="button" id="lb-cetak" class="btn btn-primary ml-auto" title="Buka dialog cetak browser (Ctrl+P)">${icon('print')}<span>Cetak</span></button>
        </div>
        <div id="lb-pratinjau" class="min-h-0 flex-1 overflow-auto bg-gray-100 p-4 dark:bg-gray-950">
          ${pratinjauHtml()}
        </div>
      </div>
    </div>`;
  bind();
  updateRingkas();
  paskanZoom();
}

/* ---------- Repaint parsial ---------- */

function paintHasil(): void {
  const el = host?.querySelector('#lb-hasil');
  if (!el) return;
  el.innerHTML = hasilHtml();
  bindHasil();
}

function paintDipilih(): void {
  const el = host?.querySelector('#lb-dipilih');
  if (!el) return;
  el.innerHTML = terpilihHtml();
  bindDipilih();
}

/** Segarkan SEMUA yang bergantung pada isi pilihan (centang/hapus/pilih
 *  massal): ringkasan + pratinjau + kedua kotak. Aman dipanggil saat fokus
 *  ada di tombol (bukan input yang sedang diketik). */
function segarkanPilihan(): void {
  updateRingkas();
  paintPratinjau();
  paintHasil();
  paintDipilih();
}

function paintPratinjau(): void {
  const el = host?.querySelector('#lb-pratinjau');
  if (!el) return;
  el.innerHTML = pratinjauHtml();
  paskanZoom();
}

/* ---------- Binding ---------- */

/** Ubah setelan: normalisasi (clamp) + simpan per device + segarkan ringkasan
 *  & pratinjau TANPA menyentuh input kiri (fokus kasir tidak boleh hilang). */
function ubahSetelan(patch: Partial<SetelanLabel>): void {
  state.setelan = normalisasiSetelan({ ...state.setelan, ...patch });
  setSetelanLabel(state.setelan);
  updateRingkas();
  paintPratinjau();
}

/** Ikatan input angka: `input` = live (state+pratinjau), `change` = snap nilai
 *  yang sudah diklem balik ke kolom (mis. kolom max 6). */
function bindAngka(id: string, ambil: () => number, patch: (v: number) => Partial<SetelanLabel>): void {
  const el = host?.querySelector<HTMLInputElement>(id);
  if (!el) return;
  el.addEventListener('input', () => {
    const v = el.valueAsNumber;
    ubahSetelan(patch(Number.isFinite(v) ? v : ambil()));
  });
  el.addEventListener('change', () => {
    el.value = String(ambil());
  });
}

function bindPengaturan(): void {
  if (!host) return;
  const s = () => state.setelan;

  const kertas = host.querySelector<HTMLSelectElement>('#lb-kertas');
  kertas?.addEventListener('change', () => {
    ubahSetelan({ kertas: kertas.value as Kertas });
    host?.querySelector<HTMLElement>('#lb-kustom')?.classList.toggle('hidden', kertas.value !== 'custom');
  });

  bindAngka('#lb-kustom-w', () => s().lebarMm, (v) => ({ lebarMm: v }));
  bindAngka('#lb-kustom-h', () => s().tinggiMm, (v) => ({ tinggiMm: v }));
  bindAngka('#lb-m-t', () => s().marginAtas, (v) => ({ marginAtas: v }));
  bindAngka('#lb-m-r', () => s().marginKanan, (v) => ({ marginKanan: v }));
  bindAngka('#lb-m-b', () => s().marginBawah, (v) => ({ marginBawah: v }));
  bindAngka('#lb-m-l', () => s().marginKiri, (v) => ({ marginKiri: v }));
  bindAngka('#lb-kolom', () => s().kolom, (v) => ({ kolom: v }));
  bindAngka('#lb-tinggi', () => s().tinggiLabelMm, (v) => ({ tinggiLabelMm: v }));
  bindAngka('#lb-jx', () => s().jarakX, (v) => ({ jarakX: v }));
  bindAngka('#lb-jy', () => s().jarakY, (v) => ({ jarakY: v }));
  bindAngka('#lb-f-nama', () => s().fontNamaPt, (v) => ({ fontNamaPt: v }));
  bindAngka('#lb-f-harga', () => s().fontHargaPt, (v) => ({ fontHargaPt: v }));
  bindAngka('#lb-bc-tinggi', () => s().barcodeTinggiMm, (v) => ({ barcodeTinggiMm: v }));

  const isiCek = (id: string, kunci: keyof IsiLabel) => {
    const el = host?.querySelector<HTMLInputElement>(id);
    el?.addEventListener('change', () => {
      ubahSetelan({ isi: { ...s().isi, [kunci]: el.checked } });
    });
  };
  isiCek('#lb-i-nama', 'nama');
  isiCek('#lb-i-harga', 'harga');
  isiCek('#lb-i-barcode', 'barcode');
  isiCek('#lb-i-border', 'border');

  const promo = host.querySelector<HTMLInputElement>('#lb-i-promo');
  promo?.addEventListener('change', () => ubahSetelan({ hargaPromo: promo.checked }));

  const salinan = host.querySelector<HTMLInputElement>('#lb-salinan');
  bindAngka('#lb-salinan', () => s().salinan, (v) => ({ salinan: Math.round(v) }));
  const ubahSalinan = (delta: number) => {
    ubahSetelan({ salinan: s().salinan + delta });
    if (salinan) salinan.value = String(s().salinan);
  };
  host.querySelector('#lb-salinan-minus')?.addEventListener('click', () => ubahSalinan(-1));
  host.querySelector('#lb-salinan-plus')?.addEventListener('click', () => ubahSalinan(1));

  host.querySelector('#lb-cetak')?.addEventListener('click', cetak);
}

/** Klik opsi dropdown = masukkan produk ke keranjang "Produk terpilih".
 *  Opsi yang sudah terdaftar sengaja tidak bereaksi (buang lewat ikon
 *  hapus di keranjang — permintaan pemilik). */
function bindHasil(): void {
  if (!host) return;
  host.querySelectorAll<HTMLButtonElement>('#lb-hasil [data-pilih]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.pilih);
      if (state.pilih.has(id)) return;
      state.pilih.add(id);
      segarkanPilihan();
      host?.querySelector<HTMLInputElement>('#lb-q')?.focus();
    });
  });
}

function bindDipilih(): void {
  if (!host) return;
  host.querySelectorAll<HTMLButtonElement>('#lb-dipilih [data-hapus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.pilih.delete(Number(btn.dataset.hapus));
      segarkanPilihan();
    });
  });
}

function bind(): void {
  if (!host) return;
  bindPengaturan();
  bindHasil();
  bindDipilih();

  const q = host.querySelector<HTMLInputElement>('#lb-q');
  const hasil = host.querySelector<HTMLElement>('#lb-hasil');
  let hideTimer = 0;

  /** Buka dropdown hanya saat ada kata kunci (kalau kosong: tidak ada hasil). */
  const buka = () => {
    if (!hasil || !state.q.trim()) return;
    clearTimeout(hideTimer);
    hasil.classList.remove('hidden');
  };
  const tutup = () => {
    clearTimeout(hideTimer);
    hasil?.classList.add('hidden');
  };

  q?.addEventListener('input', () => {
    state.q = q.value;
    updateRingkas();
    paintHasil();
    if (state.q.trim()) buka();
    else tutup();
  });
  // Fokus balik (mis. setelah klik opsi) membatalkan sembunyi-tertunda di bawah.
  q?.addEventListener('focus', buka);
  // Jeda 150ms supaya klik opsi (mousedown -> blur -> click) tetap sampai
  // sebelum dropdown disembunyikan (pola dropdown form PO).
  q?.addEventListener('blur', () => {
    hideTimer = window.setTimeout(() => hasil?.classList.add('hidden'), 150);
  });
  // Klik opsi: mousedown + preventDefault supaya input TIDAK blur — tanpa ini
  // timer blur 150ms menyembunyikan dropdown saat tombol masih ditahan dan
  // click-nya tidak pernah sampai (klik lambat > 150ms = "sudah diklik kok
  // tidak terpilih", laporan pemilik 2026-10-18; pola sama dengan #pos-results
  // di pos.ts:4511).
  hasil?.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest?.('[data-pilih]')) e.preventDefault();
  });
  q?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      hasil?.querySelector<HTMLElement>('[data-pilih]')?.click();
    } else if (e.key === 'Escape' && hasil && !hasil.classList.contains('hidden')) {
      e.preventDefault();
      tutup();
      q.blur();
    }
  });

  host.querySelector<HTMLSelectElement>('#lb-cat')?.addEventListener('change', (e) => {
    state.cat = (e.target as HTMLSelectElement).value;
    updateRingkas();
    paintHasil();
  });

  host.querySelector('#lb-pilih')?.addEventListener('click', () => {
    for (const p of tampil()) state.pilih.add(p.id);
    segarkanPilihan();
  });

  host.querySelector('#lb-kosong')?.addEventListener('click', () => {
    state.pilih.clear();
    segarkanPilihan();
  });

  // paint() ulang saat data menyusul (cache -> server) dengan kolom cari yang
  // sudah berisi: pulihkan isi + buka dropdownnya kembali.
  if (state.q.trim()) {
    paintHasil();
    buka();
  }
}

/* ---------- Cetak ---------- */

/** Buka dialog cetak browser (tab baru) — tanpa print-agent. Dijeda (default
 *  PAUSED di `ui/print-pref.ts`) = tolak dengan arahan; popup diblokir =
 *  toast pesan dari `cetakLabel`. */
function cetak(): void {
  const dipilih = dipilihProduk();
  if (!dipilih.length) return;
  const s = state.setelan;
  const t = hitungTataLetak(s);
  if (t.pesan) {
    toast(t.pesan, 'error');
    return;
  }
  if (getPrintPause()) {
    toast('Semua cetak sedang dijeda — nyalakan dulu di Pengaturan → Cetak struk', 'warning');
    return;
  }
  const total = dipilih.length * s.salinan;
  const { halaman } = hitungHalaman(total, s);
  try {
    cetakLabel(s, denganSalinan(dipilih.map(keCetak), s.salinan));
    toast(`${total} label (${halaman} halaman) — pilih kertas ${namaKertas(s)}, skala 100%`, 'success');
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

/* ---------- Muat data ---------- */

async function load(): Promise<void> {
  try {
    const res = await apiGet<{ data: Product[] }>('/api/products');
    state.products = res.data;
    state.error = '';
  } catch (e) {
    if (!state.products.length) {
      try {
        state.products = await getCachedProducts();
      } catch {
        /* cache juga gagal -> biarkan pesan error tampil */
      }
    }
    state.error = errMsg(e);
  }
  state.loading = false;
  paint();
}

/** Kategori hanya isi dropdown — kalau gagal, daftar label tetap jalan. Diisi
 *  di tempat (bukan paint penuh) supaya pencarian yang sedang diketik aman. */
async function loadKategori(): Promise<void> {
  try {
    const c = await apiGet<{ data: Category[] }>('/api/categories');
    state.categories = c.data;
    const sel = host?.querySelector<HTMLSelectElement>('#lb-cat');
    if (sel) {
      sel.innerHTML = opsiKategori();
      sel.value = state.cat;
    }
  } catch {
    /* dropdown opsional */
  }
}

export async function mountLabelsPage(el: HTMLElement): Promise<void> {
  host = el;
  state.loading = true;
  state.error = '';
  state.setelan = getSetelanLabel();

  // Listener level dokumen: Ctrl+P = buka dialog cetak label (bukan cetak
  // halaman web-nya) + resize untuk paskanZoom. Dibuang saat unmount.
  pageAbort?.abort();
  pageAbort = new AbortController();
  window.addEventListener('resize', paskanZoom, { signal: pageAbort.signal });
  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        cetak();
      }
    },
    { signal: pageAbort.signal },
  );

  paint();

  // Cache dulu (instan, jalan juga saat offline), lalu tarik server (paralel).
  try {
    const cached = await getCachedProducts();
    if (cached.length) {
      state.products = cached;
      paint();
    }
  } catch {
    /* IndexedDB tidak siap -> tunggu server */
  }
  await Promise.all([load(), loadKategori()]);
}

export function unmountLabelsPage(): void {
  host = null;
  pageAbort?.abort();
  pageAbort = null;
}
