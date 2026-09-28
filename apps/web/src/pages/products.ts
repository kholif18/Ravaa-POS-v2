// Halaman Produk: sidebar kategori + status, toolbar cari, tabel produk.
// Data: cache IndexedDB (instant) lalu delta sync dari server (?since=maxVersion).
//
// Catatan `type` produk (barang|jasa|cetak|desain|topup) SUDAH DIHAPUS 2026-09-26:
// nature produk sudah tercermin dari kategori (categories.track_stock).

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { getCachedProducts, removeProductBySku, syncMaster, type Category, type Product, type Unit } from '../store';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { switchHtml } from '../ui/switch';
import { toast } from '../ui/toast';
import { CONTOH_KOLOM, mapRows, parseTable, type BarisImpor } from '../importcsv';
import { COLS, gabungLabel, kirimPrint, teksLabel, urlAgent, type ProdukLabel } from '../escpos';

const SIDE_KEY = 'ravaa.prodside';

/** Jumlah baris saat tabel pertama dibuka. 50 baris selalu jauh melebihi tinggi
 *  layar mana pun, jadi area tabel pasti bisa di-scroll dan sisa baris selalu
 *  terjangkau tanpa tombol "Muat lagi". */
const PAGE = 50;

/** Tambahan baris tiap kali infinite scroll menyentuh bawah. Lebih kecil dari
 *  PAGE supaya tidak melompat terlalu jauh dan counter tidak berubah tiap
 *  digeser. */
const STEP = 25;

/** Status filter: 'aktif' = default kasir/manage, 'nonaktif' = arsip, 'semua' = gabungan. */
type StatusFilter = 'aktif' | 'nonaktif' | 'semua';
const STATUSES: { key: StatusFilter; label: string }[] = [
  { key: 'aktif', label: 'Aktif' },
  { key: 'nonaktif', label: 'Nonaktif' },
  { key: 'semua', label: 'Semua' },
];

type EditCat = { isNew: boolean; slug: string; name: string; track_stock: number };

const state = {
  products: [] as Product[],
  /** Produk nonaktif: diambil dari server saat dibutuhkan, TIDAK disimpan di cache. */
  inactive: [] as Product[],
  categories: [] as Category[],
  /** Master satuan (dropdown form produk). Diklik вместе kategori saat load. */
  units: [] as Unit[],
  q: '',
  cat: 'all',
  status: 'aktif' as StatusFilter,
  side: readSide(),
  catEditing: null as EditCat | null,
  syncedAt: '' as string,
  syncedNote: '' as string,
  /** Berapa baris yang sudah dirender. Infinite scroll menambahnya per PAGE. */
  limit: PAGE,
};

function readSide(): boolean {
  try {
    const v = localStorage.getItem(SIDE_KEY);
    if (v) return v !== 'hidden';
    // Default: tampil di desktop, sembunyi di HP (sidebar memakan 256px di layar 390px).
    return window.matchMedia('(min-width: 1024px)').matches;
  } catch {
    return true;
  }
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const rp = (n: number) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/* ---------- MARKUP ---------- */

/** Produk yang sedang ditampilkan, sesuai filter status (aktif/nonaktif/semua). */
function visibleProducts(): Product[] {
  if (state.status === 'aktif') return state.products;
  if (state.status === 'nonaktif') return state.inactive;
  return [...state.products, ...state.inactive].sort((a, b) => a.name.localeCompare(b.name, 'id'));
}

/** Pendingin: setelah status + kategori + pencarian. Dipakai baris DAN penghitung
 *  supaya angka "menampilkan X dari Y" tidak pernah berbeda dengan isi tabel. */
function filteredProducts(): Product[] {
  const q = state.q.trim().toLowerCase();
  // Kata dipisah: "aqua 600" atau "kopi kapal" harusnya ketemu juga. Semua kata
  // wajib cocok di nama/SKU/barcode, tidak harus di field atau urutan sama.
  const terms = q.split(/\s+/).filter(Boolean);
  return visibleProducts().filter((p) => {
    if (state.cat !== 'all' && p.category_slug !== state.cat) return false;
    if (!terms.length) return true;
    const n = p.name.toLowerCase();
    const s = p.sku.toLowerCase();
    const c = (p.barcode ?? '').toLowerCase();
    return terms.every((x) => n.includes(x) || s.includes(x) || c.includes(x));
  });
}

/** Teks footer: "18 produk aktif" atau "Menampilkan 50 dari 137 produk aktif". */
function countText(): string {
  const noun = state.status === 'nonaktif' ? 'produk nonaktif' : state.status === 'semua' ? 'produk' : 'produk aktif';
  const total = filteredProducts().length;
  if (total <= state.limit) return `${total} ${noun}`;
  return `Menampilkan ${state.limit} dari ${total} ${noun}`;
}

/** Sisa baris yang bisa dimuat berikutnya (0 = sudah habis). */
function remaining(): number {
  return Math.max(0, filteredProducts().length - state.limit);
}

function categorySidebar(): string {
  const list = visibleProducts();
  const counts = new Map<string, number>();
  for (const p of list) counts.set(p.category_slug, (counts.get(p.category_slug) ?? 0) + 1);
  const total = list.length;

  return `
  <div class="flex h-full flex-col">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Kategori</h2>
      <button type="button" id="cat-new" class="row-btn" title="Tambah kategori" aria-label="Tambah kategori">${icon('plus')}</button>
    </div>
    <div class="side-list">
      <button type="button" data-cat="all" class="side-item${state.cat === 'all' ? ' is-active' : ''}">
        <span class="min-w-0 flex-1 truncate">Semua</span><span class="side-count">${total}</span>
      </button>
      ${state.categories
        .map(
          (c) => `
        <div class="group relative">
          <button type="button" data-cat="${esc(c.slug)}" class="side-item${state.cat === c.slug ? ' is-active' : ''} w-full">
            <span class="min-w-0 flex-1 truncate" title="${esc(c.name)}">${esc(c.name)}</span>
            <span class="side-count">${counts.get(c.slug) ?? 0}</span>
          </button>
          <span class="side-actions">
            <button type="button" data-cat-edit="${esc(c.slug)}" class="row-btn" title="Ubah kategori" aria-label="Ubah ${esc(c.name)}">${icon('pencil')}</button>
            <button type="button" data-cat-del="${esc(c.slug)}" class="row-btn row-btn-danger" title="Hapus kategori" aria-label="Hapus ${esc(c.name)}">${icon('trash')}</button>
          </span>
        </div>`,
        )
        .join('')}
    </div>

    <div class="mt-auto flex items-center justify-end pt-3">
      <span class="text-xs text-gray-400">${state.categories.length} kategori</span>
    </div>
  </div>`;
}

function productRows(): string {
  const list = filteredProducts();

  if (list.length === 0) {
    const msg =
      state.status === 'nonaktif'
        ? 'Tidak ada produk nonaktif. Bagus — semua produk masih aktif.'
        : 'Tidak ada produk yang cocok dengan filter.';
    return `<tr><td colspan="5"><div class="empty">${icon('products')}<span>${msg}</span></div></td></tr>`;
  }

  // Infinite scroll: potong dulu, baru render. Baris baru hanya ditambahkan di
  // BAWAH, jadi scrollTop pengguna tidak bergeser saat halaman berikutnya dimuat.
  return list
    .slice(0, state.limit)
    .map((p) => {
      const off = p.is_active === 0;
      // min_stock = 0 berarti TIDAK ada ambang batas -> jangan tulis "/ min 0",
      // dan jangan tandai "stok menipis" (0 <= 0 akan selalu salah alarms).
      const low = p.track_stock && p.min_stock > 0 && p.stock <= p.min_stock;
      const stockBadge = !p.track_stock
        ? `<span class="badge-off">tidak dilacak</span>`
        : low
          ? `<span class="badge-low">${icon('alert')}<span>${p.stock} / min ${p.min_stock}</span></span>`
          : `<span class="badge-ok">${icon('check')}<span>${p.stock}</span></span>`;
      const priceBadge = p.price_dynamic
        ? `<span class="badge-dyn">harga dinamis</span>`
        : `<span class="td-num block font-semibold text-gray-900 tabular-nums dark:text-white">${rp(p.price)}</span>`;
      return `
      <tr class="tr${off ? ' opacity-60' : ''}" data-row="${p.id}">
        <td class="td">
          <div class="cell-strong">${esc(p.name)}${off ? ` <span class="badge-off ml-1">nonaktif</span>` : ''}</div>
          <div class="cell-sub">${esc(p.sku)}${p.unit && p.unit !== '-' ? ` · ${esc(p.unit)}` : ''}${p.barcode ? ` · ${esc(p.barcode)}` : ''}</div>
        </td>
        <td class="td">${esc(p.category_name)}</td>
        <td class="td">${priceBadge}</td>
        <td class="td">${stockBadge}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            ${off
              ? `<button type="button" data-on="${p.id}" class="row-btn row-btn-ok" title="Aktifkan kembali" aria-label="Aktifkan kembali ${esc(p.name)}">${icon('check')}</button>`
              : p.track_stock
                ? `<button type="button" data-restock="${p.id}" class="row-btn" title="Stok &amp; opname" aria-label="Stok dan opname ${esc(p.name)}">${icon('truck')}</button>`
                : ''}
            <button type="button" data-edit="${p.id}" class="row-btn" title="Ubah" aria-label="Ubah ${esc(p.name)}">${icon('pencil')}</button>
            ${off
              ? ''
              : `<button type="button" data-off="${p.id}" class="row-btn row-btn-danger" title="Nonaktifkan" aria-label="Nonaktifkan ${esc(p.name)}">${icon('close')}</button>`}
            <button type="button" data-del="${p.id}" class="row-btn row-btn-danger" title="Hapus produk" aria-label="Hapus ${esc(p.name)}">${icon('trash')}</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

function tableCard(): string {
  return `
  <div class="card-flush lg:flex lg:min-h-0 lg:flex-col">
    <div class="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
      <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Status</span>
      ${STATUSES.map(
        (s) =>
          `<button type="button" data-status="${s.key}" class="chip ${state.status === s.key ? '!border-primary !text-primary' : ''}">${s.label}</button>`,
      ).join('')}
      <span class="ml-auto text-xs text-gray-500 dark:text-gray-400">${
        state.status === 'nonaktif'
          ? 'Produk nonaktif disembunyikan dari kasir. Tombol hijau mengaktifkannya kembali.'
          : 'Produk nonaktif tidak muncul di kasir.'
      }</span>
    </div>
    <div class="table-wrap table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th class="th th-sticky">Produk</th>
            <th class="th th-sticky">Kategori</th>
            <th class="th th-sticky text-right">Harga</th>
            <th class="th th-sticky">Stok</th>
            <th class="th th-sticky text-right">Aksi</th>
          </tr>
        </thead>
        <tbody id="rows">${productRows()}</tbody>
      </table>
    </div>
    <div class="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
      <span id="count" aria-live="polite">${countText()}</span>
      <span id="sync-info">${state.syncedAt ? `sinkron ${state.syncedAt} · ${state.syncedNote}` : 'memuat data…'}</span>
    </div>
  </div>`;
}

export function renderProductsPage(): string {
  // Judul + breadcrumb + subjudul sudah ada di header shell (bukan di body),
  // supaya area kerja tabel mendapat tinggi penuh.
  //
  // Layout (>= lg): halaman TIDAK scroll — hanya tbody tabel yang scroll
  // (.table-scroll). Toolbar, filter status, header tabel, dan footer karena
  // itu tidak pernah keluar layar.
  // Rantai `lg:h-full` + `lg:min-h-0` itu wajib: tanpa min-h-0, isi tabel
  // memaksa elemen ikut memanjang dan .page ikut scroll.
  // Di mobile: halaman scroll normal, toolbar tetap lengket (sticky).
  //
  // Jarak toolbar -> app-header memakai PADDING YANG SAMA dengan .page
  // (`p-4 sm:p-6` = 16px / 24px), bukan angka lain. Wrapper jadi mencerminkan
  // padding .page persis: `-mx-4 -mt-4 px-4 pt-4` (mobile) dan
  // `sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6` (>= sm). Negative margin +
  // padding sepadan = background wrapper terangkat INTO padding .page, jadi
  // kartu toolbar tetap duduk di offset 16/24px dari header (= padding .page)
  // tanpa menyisakan celah yang bisa dilewati sel tabel.
  //
  // Di mobile/tablet wrapper `sticky`, dan ini yang tricky: `position: sticky`
  // di .page (overflow-y:auto) mem-pin BORDER box di CONTENT box .page + offset
  // `top` - bukan padding box, bukan margin box (hasil ukur
  // getBoundingClientRect, bukan asumsi). Karena itu `top` harus negatif
  // (`-top-4 sm:-top-6`) dan sama besar dengan margin negatifnya: begitu
  // posisi diam = posisi lengket (tidak ada lompatan saat mulai scroll) dan
  // background menutup penuh dari 64px ke bawah. Dengan `top:0` toolbar
  // terdorong ke content box dan sel tabel bocor melewati padding .page -
  // dulu ditutup pseudo-element `before`, sekarang tidak perlu.
  //
  // Di lg semua jadi `lg:static`: halaman tidak pernah scroll di desktop
  // (hanya tbody tabel yang scroll), jadi sticky tidak berguna. Rantai
  // `lg:h-full` + `lg:min-h-0` yang menjaga kartu tabel mengisi tinggi
  // halaman; tanpa min-h-0 isi tabel memaksa elemen ikut memanjang dan .page
  // ikut scroll.
  return `
    <div class="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div class="sticky -top-4 sm:-top-6 z-20 -mx-4 -mt-4 shrink-0 bg-canvas px-4 pt-4 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6 dark:bg-gray-900 lg:static">
        <div class="card !p-3">
          <div class="toolbar">
            <button type="button" id="side-toggle" class="side-collapse-btn" title="Tampilkan/sembunyikan kategori" aria-label="Tampilkan atau sembunyikan sidebar kategori" aria-expanded="${state.side}">
              ${icon('menu')}
            </button>
            <div class="search-wrap">
              ${icon('search')}
              <input id="q" class="input input-sm" type="search" placeholder="Cari nama, SKU, atau barcode..." value="${esc(state.q)}" />
            </div>
            <button type="button" id="sync" class="btn btn-ghost" title="Sinkronkan master produk">${icon('sync')}<span class="hidden sm:inline">Sinkron</span></button>
            <button type="button" id="prod-import" class="btn btn-ghost" title="Impor produk dari CSV atau tempelan Excel">${icon('upload')}<span class="hidden sm:inline">Impor</span></button>
            <button type="button" id="prod-label" class="btn btn-ghost" title="Cetak label harga untuk produk di filter ini">${icon('print')}<span class="hidden sm:inline">Label</span></button>
            <button type="button" id="prod-new" class="btn btn-primary ml-auto">${icon('plus')}<span>Produk</span></button>
          </div>
        </div>
      </div>
      <div class="mt-6 flex flex-col items-stretch gap-4 lg:min-h-0 lg:flex-1 lg:flex-row lg:items-stretch">
        <div class="prod-side-wrap shrink-0" data-open="${state.side}">
          <aside class="card w-64 max-w-full !p-3 lg:overflow-y-auto">${categorySidebar()}</aside>
        </div>
        <div class="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">${tableCard()}</div>
      </div>
    </div>`;
}

/* ---------- MODAL FORM ---------- */

/** Satuan yang sering dipakai toko. Field tetap teks bebas (pakai <datalist>),
 *  daftar ini cuma saran isian supaya kasir tidak perlu mengetik. */
/** Opsi dropdown satuan dari master (#/satuan). Produk lama bisa punya satuan
 *  yang tak ada di master (mis. master dihapus paksa): satuan itu tetap
 *  jadi opsi, supaya membuka Edit tidak diam-diam mengubah satuannya. */
function unitOptions(current?: string): string {
  const units = state.units;
  const orphan = current !== undefined && !units.some((u) => u.slug === current);
  const list = orphan
    ? [{ slug: current, name: `${current} (tak ada di master)`, dipakai: 0 }, ...units]
    : units;
  // Default produk baru = `pcs` (bukan opsi pertama). Tanpa urutan kustom, opsi
  // pertama adalah yang alfabetis ("Batang"), jadi `list[0]` jadi default yang
  // tidak masuk akal. Kalau `pcs` dihapus dari master, jatuh ke opsi pertama.
  const sel = current ?? (units.some((u) => u.slug === 'pcs') ? 'pcs' : list[0]?.slug) ?? 'pcs';
  return list
    .map((u) => `<option value="${esc(u.slug)}" ${u.slug === sel ? 'selected' : ''}>${esc(u.name)}</option>`)
    .join('');
}

/** Cerminan aturan server (index.ts:skuDariNama) untuk pratinjau di form.
 *  Hanya pratinjau: server yang memastikan SKU benar-benar unik. */
function skuOtomatis(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'PRODUK'
  );
}

/* ---------- IMPOR CSV / TEMPELAN EXCEL ---------- */

/** Lencana aksi per baris di pratinjau. Warna beda supaya "timpa" (mengubah
 *  data lama) tidak samar dengan "baru" — menimpa produk aktif adalah hal yang
 *  harus terlihat sebelum kasir menekan Impor. */
function badgeImpor(a: BarisImpor['aksi']): string {
  if (a === 'gagal') return '<span class="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-900/50 dark:text-red-300">gagal</span>';
  if (a === 'timpa') return '<span class="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">timpa</span>';
  return '<span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">baru</span>';
}

/** Tabel pratinjau. Maks 50 baris dirender: file 1000 baris tidak boleh
 *  menelannya DOM saat kasir cuma mau melihat beberapa baris pertama. */
function previewImpor(rows: BarisImpor[]): string {
  if (!rows.length) {
    return '<p class="text-gray-500 dark:text-gray-400">Tidak ada baris terbaca. Pastikan baris pertama adalah judul kolom.</p>';
  }
  const gagal = rows.filter((r) => r.aksi === 'gagal').length;
  const baru = rows.filter((r) => r.aksi === 'baru').length;
  const timpa = rows.filter((r) => r.aksi === 'timpa').length;
  const tampil = rows.slice(0, 50);
  return `
    <p class="mb-2 font-semibold text-gray-700 dark:text-gray-200">
      ${rows.length - gagal} baris siap diimpor (${baru} baru, ${timpa} menimpa)
      ${gagal ? `<span class="font-semibold text-red-600 dark:text-red-400">· ${gagal} gagal</span>` : ''}
    </p>
    <div class="table-scroll max-h-56 overflow-y-auto rounded border border-gray-200 dark:border-gray-700">
      <table class="table">
        <thead><tr>
          <th class="th">Baris</th><th class="th">Aksi</th><th class="th">SKU</th>
          <th class="th">Nama</th><th class="th">Kategori</th>
          <th class="th text-right">Harga</th><th class="th">Keterangan</th>
        </tr></thead>
        <tbody>
          ${tampil
            .map(
              (r) => `
            <tr>
              <td class="px-2 py-1.5 text-gray-500 dark:text-gray-400">${r.baris}</td>
              <td class="px-2 py-1.5">${badgeImpor(r.aksi)}</td>
              <td class="px-2 py-1.5 font-mono text-xs">${esc(r.sku)}</td>
              <td class="px-2 py-1.5">${esc(r.data?.name ?? '')}</td>
              <td class="px-2 py-1.5">${esc(r.data?.category_slug ?? '')}</td>
              <td class="px-2 py-1.5 text-right">${r.data?.price !== undefined ? esc(r.data.price) : '—'}</td>
              <td class="px-2 py-1.5 text-red-600 dark:text-red-400">${esc(r.error ?? '')}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    ${rows.length > tampil.length ? `<p class="mt-1 text-gray-500 dark:text-gray-400">… ${rows.length - tampil.length} baris lainnya tidak ditampilkan, tetap ikut diimpor.</p>` : ''}`;
}

/** Dialog impor: dua langkah di satu dialog — "Baca & tinjau" dulu, baru "Impor"
 *  mengirim. Tombol Impor sengaja MATI sampai pratinjau ada, supaya tidak ada
 *  jalan menembak teks mentah ke server tanpa dilihat dulu.
 *
 *  Tidak pakai .xlsx: file itu ZIP+XML dan butuh dependensi parser yang memang
 *  dilarang untuk repo ini. Yang didukung: tempel langsung dari Excel (tab) dan
 *  file CSV — dua jalur yang menutup pekerjaan harian toko. */
function importForm(): void {
  let hasil: BarisImpor[] = [];
  /** Pratinjau yang tampil SEKARANG masih mencerminkan isi textarea. */
  let sudahBaca = false;
  /** Pernah membaca sama sekali — DILEKATKAN (tidak pernah direset oleh ketikan),
   *  supaya pesan tidak balik jadi "Belum dibaca" saat kasir terus mengetik.
   *  Tanpa bendera terpisah, ketikan kedua membaca sudahBaca yang barusan direset
   *  dan panel salah bilang belum pernah dibaca. */
  let pernahBaca = false;

  const api = openModal({
    title: 'Impor produk',
    okLabel: 'Impor',
    wide: true,
    body: `
      <div class="space-y-3">
        <p class="form-sec">1. Isi data</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          Salin tabel dari Excel lalu tempel di kotak ini, atau pilih file CSV.
          Baris pertama = judul kolom. Kolom yang dikenal:
          <code>sku</code>, <code>nama</code>, <code>kategori</code>, <code>satuan</code>,
          <code>harga</code>, <code>modal</code>, <code>markup</code>, <code>stok</code>,
          <code>min_stok</code>, <code>harga_dinamis</code>, <code>aktif</code>.
          Kategori &amp; satuan boleh ditulis nama biasa ("ATK", "Lembar").
        </p>
        <textarea id="imp-text" rows="6" class="input font-mono text-xs" placeholder="${esc(CONTOH_KOLOM)}" aria-label="Data produk CSV"></textarea>
        <div class="flex flex-wrap items-center gap-2">
          <label class="btn btn-ghost cursor-pointer">
            ${icon('upload')}<span>Pilih file</span>
            <input id="imp-file" type="file" accept=".csv,.txt,text/csv,text/plain" class="sr-only" />
          </label>
          <button type="button" id="imp-contoh" class="btn btn-ghost">Contoh format</button>
          <button type="button" id="imp-read" class="btn btn-primary ml-auto">Baca &amp; tinjau</button>
        </div>
        <p class="form-sec">2. Tinjau lalu tekan Impor</p>
        <div id="imp-prev" class="text-xs text-gray-500 dark:text-gray-400">Belum dibaca.</div>
      </div>`,
    onMount: (m) => {
      const ta = m.el.querySelector<HTMLTextAreaElement>('#imp-text')!;
      const prev = m.el.querySelector<HTMLElement>('#imp-prev')!;
      m.ok.disabled = true;

      const baca = () => {
        const tb = parseTable(ta.value);
        const skuAda = new Set([...state.products, ...state.inactive].map((p) => p.sku));
        hasil = mapRows(tb, {
          kategori: state.categories,
          satuan: state.units,
          adaSku: (sku) => skuAda.has(sku),
        });
        sudahBaca = true;
        pernahBaca = true;
        prev.innerHTML = previewImpor(hasil);
        const siap = hasil.filter((r) => r.data).length;
        m.ok.disabled = siap === 0;
        m.ok.textContent = siap ? `Impor ${siap} baris` : 'Impor';
      };

      m.el.querySelector('#imp-read')?.addEventListener('click', baca);
      m.el.querySelector('#imp-contoh')?.addEventListener('click', () => {
        ta.value = CONTOH_KOLOM;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      m.el.querySelector('#imp-file')?.addEventListener('change', async (e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (!f) return;
        try {
          ta.value = await f.text();
        } catch {
          toast('Gagal membaca file', 'error');
          return;
        }
        baca();
      });

      m.ok.addEventListener('click', async () => {
        if (!siapBisa()) return;
        const rows = hasil.filter((r) => r.data).map((r) => r.data!);
        m.ok.disabled = true;
        try {
          const res = await apiPost<{ data: { ok: number; baru: number; update: number; gagal: number } }>(
            '/api/products/import',
            { rows },
          );
          const d = res.data;
          toast(
            `Impor selesai: ${d.ok} baris (${d.baru} baru, ${d.update} diperbarui)${d.gagal ? `, ${d.gagal} gagal` : ''}`,
            d.gagal ? 'error' : 'success',
          );
          m.close();
          await reload(true);
        } catch (e) {
          toast(`Gagal impor: ${errMsg(e)}`, 'error');
          m.ok.disabled = false;
        }
      });

      /** Tombol Impor hanya hidup setelah pratinjau dibuat ulang dari isi saat ini.
       *  Tanpa ini, kasir bisa mengubah textarea lalu menekan Impor dengan data
       *  yang TIDAK pernah dilihatnya di pratinjau. */
      const siapBisa = () => sudahBaca && hasil.some((r) => r.data);
      ta.addEventListener('input', () => {
        // Isi yang berubah setelah pratinjau membuat pratinjau basi: tombol
        // Impor dimatikan sampai dibaca ulang, supaya yang dikirim server selalu
        // sama dengan yang dilihat kasir. Sebelum pernah dibaca tetap "Belum
        // dibaca", bukan "berubah" (belum ada yang bisa berubah).
        sudahBaca = false;
        m.ok.disabled = true;
        m.ok.textContent = 'Impor';
        prev.innerHTML = pernahBaca
          ? 'Isi sudah berubah — tekan <b>Baca &amp; tinjau</b> lagi.'
          : 'Belum dibaca.';
      });
    },
  });
}

function productForm(p: Product | 'new', cats: Category[]): void {
  const isNew = p === 'new';
  const d = isNew ? null : p;
  const trackDefault = d ? d.track_stock : (cats[0]?.track_stock ?? 0);

  openModal({
    title: isNew ? 'Tambah Produk' : `Ubah: ${d!.name}`,
    okLabel: isNew ? 'Tambah' : 'Simpan',
    wide: true,
    body: `
      <div class="space-y-2">
        <p class="form-sec">Detail produk</p>
        <div class="field-sm">
          <label class="label" for="f-name">Nama produk *</label>
          <input id="f-name" class="input input-sm" value="${esc(d?.name ?? '')}" placeholder="cth: Pulpen A5 Hitam" />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="field-sm">
            <label class="label" for="f-sku">SKU <span class="hint font-normal" id="f-sku-hint"></span></label>
            <input id="f-sku" class="input input-sm" value="${esc(d?.sku ?? '')}" placeholder="kosong = otomatis" ${
              d ? 'readonly title="SKU tidak bisa diubah (upsert by SKU)"' : ''
            } />
          </div>
          <div class="field-sm">
            <label class="label" for="f-barcode">Barcode <span class="hint font-normal">1 produk = 1 barcode</span></label>
            <input id="f-barcode" class="input input-sm" value="${esc(d?.barcode ?? '')}" inputmode="numeric" placeholder="opsional" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="field-sm">
            <label class="label" for="f-cat">Kategori *</label>
            <select id="f-cat" class="input input-sm">${cats
              .map(
                (c) =>
                  `<option value="${esc(c.slug)}" ${d?.category_slug === c.slug ? 'selected' : ''}>${esc(c.name)}</option>`,
              )
              .join('')}</select>
          </div>
          <div class="field-sm">
            <label class="label" for="f-unit">Satuan <span class="hint font-normal">daftar: halaman Satuan</span></label>
            <select id="f-unit" class="input input-sm">${unitOptions(d?.unit)}</select>
          </div>
        </div>
        <p class="hint" id="f-track-hint"></p>

        <p class="form-sec">Harga</p>
        <div class="grid grid-cols-3 gap-2">
          <div class="field-sm">
            <label class="label" for="f-cost">Harga beli (Rp)</label>
            <input id="f-cost" class="input input-sm" inputmode="numeric" value="${d?.cost ?? 0}" />
          </div>
          <div class="field-sm">
            <label class="label" for="f-markup">Markup (%)</label>
            <input id="f-markup" class="input input-sm" inputmode="decimal" value="${d?.markup ?? 0}" />
          </div>
          <div class="field-sm">
            <label class="label" for="f-price">Harga jual (Rp) *</label>
            <input id="f-price" class="input input-sm" inputmode="numeric" value="${d?.price ?? 0}" />
          </div>
        </div>
        ${d && d.track_stock ? `
        <p class="-mt-1 text-xs text-gray-500 dark:text-gray-400">
          Modal rata-rata: <b class="text-gray-700 dark:text-gray-200">${rp(d.avg_cost)}</b>
          — hasil penimbangan seluruh restock, dipakai sebagai HPP saat jual.
          <span class="text-gray-400 dark:text-gray-500">"Harga beli" di atas adalah angka manual Anda (patokan markup) dan TIDAK ikut berubah oleh restock.</span>
        </p>` : ''}
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 pt-0.5">
          ${switchHtml('f-dyn', d ? !!d.price_dynamic : false, 'Boleh ubah harga saat jual')}
          ${d ? switchHtml('f-active', !!d.is_active, 'Aktif') : ''}
        </div>

        <p class="form-sec">Satuan jual</p>
        <div class="space-y-1.5">
          <p class="hint">
            Satuan dasar <b id="f-unit-base">${esc(d?.unit ?? 'pcs')}</b> selalu ada; baris di bawah untuk
            pack/dus — <b>stok &amp; HPP pakai satuan dasar</b>.
          </p>
          <div class="grid grid-cols-[1fr_72px_1fr_auto] gap-2 text-[11px] text-gray-500 dark:text-gray-400">
            <span>Satuan</span><span class="text-center">1 = berapa</span><span>Harga</span><span></span>
          </div>
          <div id="f-unit-rows" class="space-y-1.5"></div>
          <button type="button" id="f-unit-add" class="btn btn-ghost">${icon('plus')}<span>Tambah satuan</span></button>
        </div>

        <div id="f-stock-wrap">
          <p class="form-sec">Stok</p>
          <div class="grid grid-cols-2 gap-2">
            <div class="field-sm">
              <label class="label" for="f-stock">Stok</label>
              <input id="f-stock" class="input input-sm" inputmode="numeric" value="${d?.stock ?? 0}" />
            </div>
            <div class="field-sm">
              <label class="label" for="f-min">Stok minimum</label>
              <input id="f-min" class="input input-sm" inputmode="numeric" value="${d?.min_stock ?? 0}" />
            </div>
          </div>
        </div>
      </div>`,
    onMount: ({ el, ok, close }) => {
      const val = (id: string) => (el.querySelector(`#${id}`) as HTMLInputElement).value.trim();
      const num = (id: string) => Number(val(id).replace(/\D/g, '') || 0);
      const dec = (id: string) => Number(val(id).replace(',', '.').replace(/[^\d.]/g, '') || 0);
      const setNum = (id: string, v: number) => {
        (el.querySelector(`#${id}`) as HTMLInputElement).value = String(v);
      };
      const catSel = el.querySelector('#f-cat') as HTMLSelectElement;
      const dyn = el.querySelector('#f-dyn') as HTMLInputElement;
      const price = el.querySelector('#f-price') as HTMLInputElement;
      const cost = el.querySelector('#f-cost') as HTMLInputElement;
      const markup = el.querySelector('#f-markup') as HTMLInputElement;
      const stock = el.querySelector('#f-stock') as HTMLInputElement;
      const min = el.querySelector('#f-min') as HTMLInputElement;
      const name = el.querySelector('#f-name') as HTMLInputElement;
      const sku = el.querySelector('#f-sku') as HTMLInputElement;
      const skuHint = el.querySelector('#f-sku-hint') as HTMLElement;
      const trackHint = el.querySelector('#f-track-hint') as HTMLElement;
      const stockWrap = el.querySelector('#f-stock-wrap') as HTMLElement;

      const track = () => cats.find((c) => c.slug === catSel.value)?.track_stock === 1;
      const syncTrack = () => {
        const t = track();
        // Blok Stok disembunyikan total (bukan cuma disabled) untuk kategori jasa —
        // field yang tak terlihat tapi masih terkirim bikin kasir bingung.
        stockWrap.hidden = !t;
        trackHint.textContent = t
          ? 'Kategori ini melacak stok, jadi blok Stok di bawah aktif.'
          : `Kategori "${cats.find((c) => c.slug === catSel.value)?.name ?? ''}" tidak melacak stok (jasa/cetak/topup) — stok diisi lewat penjualan, bukan master.`;
      };

      // --- harga: modal <-> markup <-> harga jual saling mengisi -------------
      // Guard `busy` mencegah event berantai: ubah harga -> tulis markup ->
      // event markup -> tulis harga -> ... Rp dibulatkan ke{ratusan} terdekat.
      let busy = false;
      const hargaDariMarkup = (c: number, m: number) =>
        c > 0 ? Math.round((c * (1 + m / 100)) / 100) * 100 : 0;
      const markupDariHarga = (c: number, p: number) =>
        c > 0 ? Math.round(((p - c) / c) * 10000) / 100 : 0;
      const syncMarkupDariHarga = () => {
        if (busy) return;
        busy = true;
        const c = num('f-cost');
        if (c > 0) markup.value = String(markupDariHarga(c, num('f-price')));
        markup.disabled = c <= 0;
        busy = false;
      };
      const syncHargaDariMarkup = () => {
        if (busy) return;
        busy = true;
        if (num('f-cost') > 0) price.value = String(hargaDariMarkup(num('f-cost'), dec('f-markup')));
        markup.disabled = num('f-cost') <= 0;
        busy = false;
      };
      const syncPrice = () => {
        price.disabled = dyn.checked;
        price.classList.toggle('opacity-50', dyn.checked);
      };

      // SKU kosong -> server menurunkan dari nama. Cuma pratinjau; server yang
      // menjamin unik (nama sama -> SKU dapat akhiran -2, -3, ...).
      const syncSkuHint = () => {
        if (d) {
          skuHint.textContent = 'SKU tidak bisa diubah';
          return;
        }
        const ketik = sku.value.trim();
        skuHint.textContent = ketik ? '' : `dibuat otomatis: ${skuOtomatis(name.value)}`;
      };

      catSel.addEventListener('change', syncTrack);
      dyn.addEventListener('change', syncPrice);
      cost.addEventListener('input', syncHargaDariMarkup);
      markup.addEventListener('input', syncHargaDariMarkup);
      price.addEventListener('input', syncMarkupDariHarga);
      name.addEventListener('input', syncSkuHint);
      sku.addEventListener('input', syncSkuHint);

      // --- satuan jual alternatif (fitur #3 Multi satuan) -------------------
      // Satuan DASAR tidak punya baris (implisit dari select Satuan di atas);
      // baris di sini hanya untuk pack/dus/dsb.
      const unitRowsEl = el.querySelector('#f-unit-rows') as HTMLElement;
      const unitBaseEl = el.querySelector('#f-unit-base') as HTMLElement;
      const unitSel = el.querySelector('#f-unit') as HTMLSelectElement;
      let unitList: { unit: string; factor: number; price: number | null }[] =
        (d?.units ?? []).map((u) => ({ ...u }));

      const opsiSatuan = (base: string, current?: string): string => {
        const list = state.units.filter((u) => u.slug !== base);
        const sel = current && current !== base && list.some((u) => u.slug === current)
          ? current
          : list[0]?.slug ?? '';
        return list
          .map((u) => `<option value="${esc(u.slug)}" ${u.slug === sel ? 'selected' : ''}>${esc(u.name)}</option>`)
          .join('');
      };

      const renderUnitRows = () => {
        const base = unitSel.value || 'pcs';
        unitBaseEl.textContent = base;
        // Baris yang satuan-nya jadi SATUAN DASAR gugur sendiri (kasir mengubah
        // select Satuan di atas) — server juga menolaknya.
        unitList = unitList.filter((u) => u.unit !== base);
        unitRowsEl.innerHTML = unitList
          .map(
            (u, i) => `<div class="grid grid-cols-[1fr_72px_1fr_auto] items-center gap-2" data-u-row="${i}">
              <select class="input input-sm" data-u-unit aria-label="Satuan jual">${opsiSatuan(base, u.unit)}</select>
              <input class="input input-sm text-center" data-u-factor inputmode="decimal" value="${u.factor}"
                title="1 satuan ini = berapa ${esc(base)}" aria-label="Faktor" />
              <input class="input input-sm" data-u-price inputmode="numeric" value="${u.price ?? ''}"
                placeholder="otomatis" title="Kosong = faktor &times; harga dasar" aria-label="Harga" />
              <button type="button" class="row-btn row-btn-danger" data-u-del aria-label="Hapus satuan" title="Hapus satuan">${icon('trash')}</button>
            </div>`,
          )
          .join('');
      };

      // Baca isi DOM -> state. Dipanggil SEBELUM tiap mutasi supaya input yang
      // baru diketik kasir tidak hilang saat baris dirender ulang.
      const bacaUnitRows = () => {
        unitList = [...unitRowsEl.querySelectorAll<HTMLElement>('[data-u-row]')]
          .map((r) => {
            const unit = (r.querySelector('[data-u-unit]') as HTMLSelectElement).value;
            const f = Number((r.querySelector('[data-u-factor]') as HTMLInputElement).value.replace(',', '.'));
            const pv = (r.querySelector('[data-u-price]') as HTMLInputElement).value.trim();
            return { unit, factor: f, price: pv === '' ? null : Number(pv.replace(/\D/g, '') || 0) };
          })
          .filter((x) => x.unit);
      };

      el.querySelector('#f-unit-add')?.addEventListener('click', () => {
        bacaUnitRows();
        const base = unitSel.value || 'pcs';
        const terpakai = new Set(unitList.map((x) => x.unit));
        const next = state.units.find((u) => u.slug !== base && !terpakai.has(u.slug));
        if (!next) {
          toast('Semua satuan di master sudah terpakai — tambah dulu di halaman Satuan', 'warning');
          return;
        }
        unitList.push({ unit: next.slug, factor: 1, price: null });
        renderUnitRows();
      });

      unitRowsEl.addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-u-row]');
        if (!row || !(e.target as HTMLElement).closest('[data-u-del]')) return;
        const i = Number(row.dataset.uRow);
        if (!Number.isInteger(i)) return;   // Number(undefined) = NaN -> splice(NaN) = hapus baris PERTAMA
        bacaUnitRows();
        unitList.splice(i, 1);
        renderUnitRows();
      });
      unitSel.addEventListener('change', () => { bacaUnitRows(); renderUnitRows(); });
      renderUnitRows();

      syncTrack();
      syncPrice();
      syncSkuHint();
      syncMarkupDariHarga();

      ok.addEventListener('click', async () => {
        const nama = val('f-name');
        if (!nama) { toast('Nama produk wajib diisi', 'warning'); return; }
        bacaUnitRows();
        const base = unitSel.value || 'pcs';
        const rusak = unitList.find((u) => !Number.isFinite(u.factor) || u.factor <= 0);
        if (rusak) { toast(`Faktor satuan ${rusak.unit} harus angka > 0`, 'warning'); return; }
        const ganda = new Set<string>();
        for (const u of unitList) {
          if (ganda.has(u.unit)) { toast(`Satuan jual duplikat: ${u.unit}`, 'warning'); return; }
          ganda.add(u.unit);
        }
        if (unitList.some((u) => u.unit === base)) {
          toast(`Satuan dasar (${base}) tidak perlu diulang`, 'warning'); return;
        }
        ok.disabled = true;
        try {
          const res = await apiPost<{ data: Product }>('/api/products', {
            name: nama,
            sku: val('f-sku'),
            barcode: val('f-barcode') || null,
            category_slug: catSel.value,
            unit: val('f-unit') || 'pcs',
            price: num('f-price'),
            cost: num('f-cost'),
            markup: dec('f-markup'),
            price_dynamic: dyn.checked ? 1 : 0,
            stock: num('f-stock'),
            min_stock: num('f-min'),
            is_active: d ? ((el.querySelector('#f-active') as HTMLInputElement).checked ? 1 : 0) : 1,
            // SELALU dikirim (termasuk []) — tidak dikirim = tidak diubah, jadi
            // form tanpa perubahan satuan harus tetap mengirim daftar lama agar
            // konsisten dengan tampilan. `[]` = hapus semua satuan alternatif.
            units: unitList.map((u) => ({ unit: u.unit, factor: u.factor, price: u.price })),
          });
          // SKU bisa dibuat server saat kolomnya dikosongkan -> tampilkan apa
          // yang benar-benar tersimpan, bukan tebakan client.
          toast(`${d ? 'Produk diperbarui' : 'Tersimpan'} · ${res?.data?.sku ?? ''}`, 'success');
          close();
          await reload(true);
        } catch (e) {
          toast(`Gagal simpan: ${errMsg(e)}`, 'error');
          ok.disabled = false;
        }
      });
    },
  });
}

/** Dialog stok: dua mode yang selalu dipakai bergantian — **Masuk barang**
 *  (restock, menambah) dan **Hitung fisik** (opname, MENGGANTI stok dengan angka
 *  yang diketik, termasuk 0).
 *
 *  Mode diganti lewat chip, dan angka diikut-setel ke default masuk akal per
 *  mode (`1` untuk masuk, stok tercatat untuk hitung fisik) — angka yang sama
 *  tidak boleh berpindah mode dengan arti berbeda, itu sumber salah hitung.
 *  Di mode opname hint-nya selalu menampilkan SELISIH secara live, supaya kasir
 *  tahu berapa stok yang akan berubah sebelum menekan Simpan. */
/* ---------- CETAK LABEL HARGA ---------- */

/** Produk yang TIDAK layak jadi label: harga nol (label tanpa harga = sampah)
 *  dan harga dinamis (harga aslinya baru diketahui per transaksi, jadi label
 *  yang dicetak hari ini akan MENYESATKAN besok). */
function layakLabel(p: Product): boolean {
  return p.price_dynamic !== 1 && p.price > 0;
}

/** Dialog cetak label: mencetak SESUAI FILTER SAAT INI (cari/kategori/status),
 *  karena pekerjaan wajar toko adalah "cetak label untuk rak Minuman" — bukan
 *  memilih 500 SKU satu per satu. Kolom cari jadi pemilih halusnya: ketik
 *  "Aqua" -> 1 label. Jumlah selalu ditampilkan sebelum dikirim. */
function labelForm(): void {
  const semua = filteredProducts();
  const layak = semua.filter(layakLabel);
  const lewat = semua.length - layak.length;
  if (!layak.length) {
    toast('Tidak ada produk berharga tetap di filter ini', 'warning');
    return;
  }
  const contoh = layak[0];
  const preview: ProdukLabel = {
    name: contoh.name, sku: contoh.sku, price: contoh.price,
    unit: contoh.unit, barcode: contoh.barcode,
  };

  openModal({
    title: 'Cetak label harga',
    okLabel: `Cetak ${layak.length} label`,
    wide: true,
    body: `
      <p class="text-xs text-gray-500 dark:text-gray-400">
        ${layak.length} label mengikuti <b>filter saat ini</b>${lewat ? ` · ${lewat} dilewati (harga dinamis/nol)` : ''}.
        Mau sedikit saja? Saring dulu lewat kolom cari.
      </p>
      <p class="text-xs text-gray-500 dark:text-gray-400" id="lbl-agent">cek print-agent…</p>
      <div class="table-scroll mt-2 max-h-36 overflow-y-auto rounded border border-gray-200 dark:border-gray-700">
        <ul class="divide-y divide-gray-100 dark:divide-gray-800">
          ${layak.slice(0, 100).map((p) => `<li class="px-2 py-1.5">${esc(p.name)} <span class="text-gray-400">· ${esc(p.sku)} · ${rp(p.price)}</span></li>`).join('')}
        </ul>
      </div>
      ${layak.length > 100 ? `<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">… ${layak.length - 100} lainnya ikut tercetak.</p>` : ''}
      <p class="form-sec">Pratinjau label (${COLS} kolom)</p>
      <pre class="overflow-x-auto rounded bg-gray-100 p-2 font-mono text-[11px] leading-tight dark:bg-gray-800">${esc(teksLabel(preview).join('\n'))}</pre>`,
    onMount: ({ el, ok, close }) => {
      // Cek agent dulu: kasir perlu tahu apakah ini masuk printer atau file,
      // dan tahu SEBELUM menekan Cetak kalau agent tidak jalan.
      fetch(`${urlAgent()}/health`)
        .then((r) => r.json())
        .then((j) => {
          const box = el.querySelector('#lbl-agent');
          if (box) box.textContent = j.printer ? `print-agent siap · printer ${j.printer}` : 'print-agent siap · printer belum ketemu (output jadi file)';
        })
        .catch(() => {
          const box = el.querySelector('#lbl-agent');
          if (box) {
            box.textContent = `print-agent TIDAK terjangkau di ${urlAgent()} — jalankan: npm run dev:agent`;
            box.classList.add('font-semibold', 'text-red-600', 'dark:text-red-400');
          }
          ok.disabled = true;
        });

      ok.addEventListener('click', async () => {
        ok.disabled = true;
        try {
          const via = await kirimPrint(gabungLabel(layak.map((p) => ({
            name: p.name, sku: p.sku, price: p.price, unit: p.unit, barcode: p.barcode,
          }))));
          toast(`${layak.length} label dikirim${via ? ` · ${via}` : ''}`, 'success');
          close();
        } catch (e) {
          toast(`Gagal cetak: ${errMsg(e)}`, 'error');
          ok.disabled = false;
        }
      });
    },
  });
}

function restockForm(p: Product): void {
  type Mode = 'masuk' | 'opname';
  let mode: Mode = 'masuk';

  openModal({
    title: `Stok: ${p.name}`,
    okLabel: 'Tambah stok',
    body: `
      <div class="mb-3 flex gap-2" role="group" aria-label="Mode stok">
        <button type="button" class="chip" data-mode="masuk" aria-pressed="true">Masuk barang</button>
        <button type="button" class="chip" data-mode="opname" aria-pressed="false">Hitung fisik</button>
      </div>
      <div class="field">
        <label class="label" for="r-qty" id="r-label">Jumlah masuk *</label>
        <input id="r-qty" class="input" inputmode="numeric" value="1" placeholder="cth: 24" />
        <span class="text-xs text-gray-500 dark:text-gray-400" id="r-hint"></span>
      </div>
      <div class="field" id="r-cost-field">
        <label class="label" for="r-cost">Harga beli / nota (Rp)</label>
        <input id="r-cost" class="input" inputmode="numeric" value="" placeholder="cth: 1500" />
        <span class="text-xs text-gray-500 dark:text-gray-400" id="r-cost-hint">
          Diisi = modal rata-rata ikut dihitung ulang (dasar HPP). Kosongkan bila
          tidak ada nota — rata-rata tidak diubah.
        </span>
      </div>`,
    onMount: ({ el, ok, close }) => {
      const input = el.querySelector('#r-qty') as HTMLInputElement;
      const label = el.querySelector('#r-label') as HTMLElement;
      const hint = el.querySelector('#r-hint') as HTMLElement;
      const costField = el.querySelector('#r-cost-field') as HTMLElement;
      const costInput = el.querySelector('#r-cost') as HTMLInputElement;
      const min = p.min_stock > 0 ? ` · minimum: ${p.min_stock}` : '';

      /** `null` = kosong / bukan angka. Dibedakan dari 0, karena 0 adalah angka
       *  yang SAH untuk opname (semua barang hilang) tapi bukan untuk restock. */
      const angka = (): number | null => {
        const t = input.value.trim().replace(/[^\d.-]/g, '');
        if (t === '') return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
      };

      /** `null` = belum/tidak diisi. Berbeda dari 0: 0 adalah harga sah
       *  (barang hadiah/bonus) dan memang menurunkan rata-rata. */
      const harga = (): number | null => {
        const t = costInput.value.trim().replace(/[^\d]/g, '');
        if (t === '') return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
      };

      const hintMasuk = () => {
        let t = `Stok saat ini: ${p.stock}${min}.`;
        const n = angka();
        const h = harga();
        if (h !== null && n !== null && n > 0) {
          // Rumus yang sama persis dengan server (index.ts /api/restock):
          // stok_lama dihitung SEBELUM penambahan.
          const baru = Math.round((p.stock * p.avg_cost + n * h) / (p.stock + n));
          t += ` Modal rata-rata <b>${rp(p.avg_cost)}</b> -> <b>${rp(baru)}</b>`;
        } else if (h !== null) {
          t += ` Modal rata-rata ${rp(p.avg_cost)} — isi jumlah untuk melihat hasilnya.`;
        } else {
          t += ` Modal rata-rata ${rp(p.avg_cost)} (tanpa nota = tidak diubah).`;
        }
        hint.innerHTML = t;
      };
      const hintOpname = () => {
        const n = angka();
        if (n === null) {
          hint.textContent = `Stok tercatat: ${p.stock}${min}. Isi hasil hitung fisik.`;
          return;
        }
        const s = n - p.stock;
        hint.innerHTML =
          `Stok tercatat: ${p.stock}${min} · <b>selisih ${s > 0 ? '+' : ''}${s}</b>` +
          (s === 0 ? ' (cocok)' : ` -> stok jadi ${n}`);
      };

      const paint = () => {
        el.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => {
          const on = b.dataset.mode === mode;
          // classList.toggle menerima SATU token per panggilan — meneruskan
          // "!border-primary !text-primary" (ada spasi) melempar TypeError dan
          // mematikan seluruh paint(), jadi hint kosong & listener OK hilang.
          b.classList.toggle('!border-primary', on);
          b.classList.toggle('!text-primary', on);
          b.setAttribute('aria-pressed', String(on));
        });
        // Harga beli hanya berlaku di mode masuk: opname tidak mengubah
        // rata-rata modal (lihat index.ts /api/stock-opname).
        costField.hidden = mode !== 'masuk';
        if (mode === 'masuk') {
          label.textContent = 'Jumlah masuk *';
          ok.textContent = 'Tambah stok';
          hintMasuk();
        } else {
          label.textContent = 'Jumlah fisik hasil hitung *';
          ok.textContent = 'Simpan opname';
          hintOpname();
        }
      };

      el.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) =>
        b.addEventListener('click', () => {
          mode = b.dataset.mode as Mode;
          // Default ikut mode: masuk = 1 keping, hitung fisik = stok tercatat.
          input.value = mode === 'masuk' ? '1' : String(p.stock);
          paint();
          input.focus();
          input.select();
        }),
      );
      input.addEventListener('input', () => { if (mode === 'opname') hintOpname(); else hintMasuk(); });
      costInput.addEventListener('input', () => { if (mode === 'masuk') hintMasuk(); });

      paint();
      input.focus();
      input.select();

      ok.addEventListener('click', async () => {
        const n = angka();
        if (mode === 'masuk') {
          if (n === null || !(n > 0)) { toast('Jumlah harus lebih dari 0', 'warning'); return; }
          ok.disabled = true;
          try {
            const h = harga();
            const res = await apiPost<{ data: { avg_cost: number } }>('/api/restock', {
              product_id: p.id, qty: n,
              ...(h !== null ? { harga_beli: h } : {}),
            });
            toast(
              `Stok ${p.name} +${n}` +
                (h !== null ? ` · modal rata-rata ${rp(res.data.avg_cost)}` : ''),
              'success',
            );
          } catch (e) {
            toast(`Restock gagal: ${errMsg(e)}`, 'error');
            ok.disabled = false;
            return;
          }
        } else {
          // n === 0 = barang habis semuanya -> SAH, jadi hanya negatif/kosong yang ditolak.
          if (n === null || n < 0) { toast('Jumlah fisik wajib diisi (angka, boleh 0)', 'warning'); return; }
          ok.disabled = true;
          try {
            const res = await apiPost<{ data: { sebelum: number; sesudah: number; selisih: number } }>(
              '/api/stock-opname',
              { product_id: p.id, qty_fisik: n },
            );
            const d = res.data;
            toast(
              d.selisih === 0
                ? `Opname ${p.name}: tidak ada selisih (stok ${d.sesudah})`
                : `Opname ${p.name}: ${d.sebelum} -> ${d.sesudah} (${d.selisih > 0 ? '+' : ''}${d.selisih})`,
              'success',
            );
          } catch (e) {
            toast(`Opname gagal: ${errMsg(e)}`, 'error');
            ok.disabled = false;
            return;
          }
        }
        close();
        await reload(true);
      });
    },
  });
}

function categoryForm(cat: EditCat, cats: Category[]): void {
  const slugLocked = !cat.isNew;
  openModal({
    title: cat.isNew ? 'Tambah Kategori' : `Ubah Kategori: ${cat.name}`,
    okLabel: cat.isNew ? 'Tambah' : 'Simpan',
    body: `
      <div class="field">
        <label class="label" for="c-name">Nama kategori *</label>
        <input id="c-name" class="input" value="${esc(cat.name)}" placeholder="cth: Minuman" />
      </div>
      <div class="field">
        <span class="label">Slug (otomatis dari nama)</span>
        <input id="c-slug" class="input bg-gray-50 text-gray-500 dark:bg-gray-900/50" value="${esc(cat.slug)}" readonly aria-describedby="c-slug-hint" />
        <span class="text-xs text-gray-500 dark:text-gray-400" id="c-slug-hint">${
          slugLocked
            ? 'Slug tidak bisa diubah setelah kategori dibuat.'
            : 'Otomatis: huruf kecil, angka, dan strip. Tidak bisa diubah nanti.'
        }</span>
      </div>
      <label class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
        <input id="c-track" type="checkbox" class="mt-0.5 size-4 accent-primary" ${cat.track_stock ? 'checked' : ''} />
        <span>Lacak stok untuk semua produk kategori ini
          <span class="block text-xs text-gray-500 dark:text-gray-400">Hanya untuk barang fisik (ATK, es krim, snack, rokok). Jasa/cetak/desain/topup tidak melacak stok.</span>
        </span>
      </label>`,
    onMount: ({ el, ok, close }) => {
      const name = el.querySelector('#c-name') as HTMLInputElement;
      const slug = el.querySelector('#c-slug') as HTMLInputElement;
      const track = el.querySelector('#c-track') as HTMLInputElement;
      // Slug SELALU diturunkan dari nama (kategori baru). Kolomnya readonly,
      // jadi tidak mungkin tidak sinkron dengan nama.
      if (cat.isNew) {
        name.addEventListener('input', () => { slug.value = slugify(name.value); });
      }
      name.focus();
      ok.addEventListener('click', async () => {
        const n = name.value.trim();
        const s = (slugLocked ? cat.slug : slugify(n)).trim().toLowerCase();
        if (!n || !s) { toast('Nama kategori wajib diisi', 'warning'); return; }
        if (!/^[a-z0-9-]+$/.test(s)) { toast('Slug hanya boleh huruf kecil, angka, dan strip', 'warning'); return; }
        const affects = state.products.filter((p) => p.category_slug === s).length;
        if (track.checked && affects > 0 && !cat.track_stock) {
          const yes = await confirmDialog({
            title: 'Aktifkan pelacakan stok?',
            message: `Kategori ini sudah punya ${affects} produk aktif. Menyalakan track_stock membuat semua produknya ikut melacak stok.`,
            okLabel: 'Ya, nyalakan',
          });
          if (!yes) { ok.disabled = false; return; }
        }
        ok.disabled = true;
        try {
          const prev = cats.find((c) => c.slug === s);
          await apiPost('/api/categories', {
            slug: s,
            name: n,
            track_stock: track.checked ? 1 : 0,
            sort: prev?.sort ?? 0,
          });
          toast(cat.isNew ? 'Kategori ditambahkan' : 'Kategori diperbarui', 'success');
          close();
          await reload(true);
        } catch (e) {
          toast(`Gagal simpan kategori: ${errMsg(e)}`, 'error');
          ok.disabled = false;
        }
      });
    },
  });
}

/* ---------- DATA ---------- */

async function loadCategories(): Promise<Category[]> {
  const res = await apiGet<{ data: Category[] }>('/api/categories');
  state.categories = res.data;
  return res.data;
}

/** Master satuan untuk dropdown form produk. Kalau gagal, form tetap jalan:
 *  satuan lalu jadi dropdown seadanya dari cache terakhir (lihat unitOptions). */
async function loadUnits(): Promise<void> {
  try {
    const res = await apiGet<{ data: Unit[] }>('/api/units');
    state.units = res.data;
  } catch (e) {
    toast(`Gagal memuat satuan: ${errMsg(e)}`, 'error');
  }
}

/** Ambil daftar produk nonaktif dari server (tidak masuk cache/IndexedDB). */
async function loadInactive(): Promise<void> {
  try {
    const res = await apiGet<{ data: Product[] }>('/api/products?since=0&status=nonaktif');
    state.inactive = res.data;
  } catch (e) {
    toast(`Gagal memuat produk nonaktif: ${errMsg(e)}`, 'error');
  }
}

async function doSync(): Promise<void> {
  // Delta sync: ?since=maxVersion dari IndexedDB, digabung per sku.
  const res = await syncMaster((since) => apiGet<{ data: Product[]; maxVersion: number }>(`/api/products?since=${since}`));
  state.products = (await getCachedProducts()).slice().sort((a, b) => a.name.localeCompare(b.name, 'id'));
  state.syncedAt = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  state.syncedNote = `${res.added} berubah dari server · ${res.total} total`;
}

async function reload(withServer = false): Promise<void> {
  try {
    if (withServer) await doSync();
    else state.products = (await getCachedProducts()).slice().sort((a, b) => a.name.localeCompare(b.name, 'id'));
    await loadCategories();
    await loadUnits();
  } catch (e) {
    toast(`Gagal memuat data: ${errMsg(e)}`, 'error');
  }
  paint();
}

let host: HTMLElement | null = null;

/** Render ulang HANYA tbody + footer. Dipakai infinite scroll dan pencarian:
 *  tidak menyentuh toolbar/sidebar, jadi scroll, fokus search, dan posisi
 *  scroll tabel tidak hilang. */
function renderRows(): void {
  if (!host) return;
  const rows = host.querySelector('#rows');
  if (rows) rows.innerHTML = productRows();
  bindRowActions();
  const count = host.querySelector('#count');
  if (count) count.textContent = countText();
}

/** Tambah satu batch baris (dipakai infinite scroll). */
function loadStep(): void {
  state.limit += STEP;
  renderRows();
}

/** Filter berubah -> daftar harus kembali ke atas, bukan menggantung di bawah.
 *  Tanpa ini `scrollTop` yang tersisa membuat area tabel masih "dekat bawah",
 *  jadi infinite scroll langsung memuat satu halaman tambahan dan reset ke PAGE
 *  tidak pernah terlihat oleh pengguna. */
function resetFilterScroll(): void {
  const wrap = host?.querySelector<HTMLElement>('.table-wrap');
  if (wrap) wrap.scrollTop = 0;
  const page = host?.closest<HTMLElement>('.page');
  if (page) page.scrollTop = 0;
}

function paint(): void {
  // Host bisa sudah lepas dari DOM: mountProductsPage async masih jalan (reload)
  // lalu kasir pindah halaman. Tanpa guard, tabel Products menimpa halaman lain.
  if (!host || !host.isConnected) return;
  const scroll = host.scrollTop;
  // Render ulang penuh = filter/data berubah -> mulai lagi dari PAGE pertama.
  state.limit = PAGE;
  host.innerHTML = renderProductsPage();
  host.scrollTop = scroll;
  bind();
}

/* ---------- EVENTS ---------- */

function bind(): void {
  if (!host) return;
  bindRowActions();
  const find = <T extends HTMLElement>(sel: string) => host!.querySelector<T>(sel);

  const q = find<HTMLInputElement>('#q');
  q?.addEventListener('input', () => {
    state.q = q.value;
    state.limit = PAGE; // filter baru -> mulai dari baris pertama
    resetFilterScroll();
    renderRows();
  });

  /* Infinite scroll: tambah STEP baris saat sudah dekat bawah area scroll.
     Tidak ada tombol "Muat lagi" — 50 baris awal selalu melebihi tinggi layar,
     jadi sisanya selalu bisa dijangkau dengan scroll.
     Dua container listened karena keduanya dipakai:
       - .table-wrap  -> desktop (>= lg), halaman tidak scroll
       - .page        -> mobile, halaman scroll normal
     Syarat `remaining() > 0` mencegah loop tak berujung saat data habis. */
  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    if (remaining() <= 0) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (!nearBottom) return;
    loadStep();
  };
  find('.table-wrap')?.addEventListener('scroll', onScroll, { passive: true });
  host.closest('.page')?.addEventListener('scroll', onScroll, { passive: true });

  find('#sync')?.addEventListener('click', () => void reload(true));
  find('#prod-new')?.addEventListener('click', () => productForm('new', state.categories));
  find('#prod-import')?.addEventListener('click', () => importForm());
  find('#prod-label')?.addEventListener('click', () => labelForm());
  // Toggle sidebar kategori: ubah atribut data-open saja (bukan render ulang),
  // supaya animasi CSS berjalan dan isian search tidak hilang/fokus hilang.
  find('#side-toggle')?.addEventListener('click', () => {
    state.side = !state.side;
    try { localStorage.setItem(SIDE_KEY, state.side ? 'shown' : 'hidden'); } catch { /* abaikan */ }
    const wrap = host!.querySelector('.prod-side-wrap');
    if (wrap) wrap.setAttribute('data-open', String(state.side));
    const btn = host!.querySelector('#side-toggle');
    btn?.setAttribute('aria-expanded', String(state.side));
    btn?.classList.toggle('is-on', state.side);
  });

  host.querySelectorAll<HTMLElement>('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      state.cat = b.dataset.cat ?? 'all';
      resetFilterScroll();
      paint();
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-status]').forEach((b) =>
    b.addEventListener('click', async () => {
      state.status = (b.dataset.status ?? 'aktif') as StatusFilter;
      if (state.status !== 'aktif' && state.inactive.length === 0) await loadInactive();
      resetFilterScroll();
      paint();
    }),
  );
  find('#cat-new')?.addEventListener('click', () =>
    categoryForm({ isNew: true, slug: '', name: '', track_stock: 0 }, state.categories),
  );
  host.querySelectorAll<HTMLElement>('[data-cat-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = state.categories.find((x) => x.slug === b.dataset.catEdit);
      if (c) categoryForm({ isNew: false, slug: c.slug, name: c.name, track_stock: c.track_stock }, state.categories);
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-cat-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const slug = b.dataset.catDel ?? '';
      const c = state.categories.find((x) => x.slug === slug);
      if (!c) return;
      const n = state.products.filter((p) => p.category_slug === slug).length;
      const yes = await confirmDialog({
        title: `Hapus kategori "${c.name}"?`,
        message:
          n > 0
            ? `Kategori ini dipakai ${n} produk aktif, jadi server akan menolak. Pindahkan atau nonaktifkan produknya dulu.`
            : 'Kategori kosong dan akan dihapus permanen.',
        okLabel: 'Hapus',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/categories/${encodeURIComponent(slug)}`);
        toast('Kategori dihapus', 'success');
        if (state.cat === slug) state.cat = 'all';
        await reload(false);
      } catch (e) {
        toast(`Gagal hapus: ${errMsg(e)}`, 'error');
      }
    }),
  );
}

/** Ubah status aktif tanpa menyentuh field lain. WAJIB lengkap: `POST /api/products`
 *  itu upsert, jadi field yang tidak dikirim di-reset ke default server
 *  (unit -> pcs, cost -> 0, markup -> 0). Satu helper untuk nonaktifkan &
 *  aktifkan supaya keduanya tidak bisa melenceng berbeda. */
function payloadToggleAktif(p: Product, isActive: 0 | 1) {
  return {
    sku: p.sku, name: p.name, category_slug: p.category_slug, barcode: p.barcode,
    unit: p.unit, price: p.price, cost: p.cost, markup: p.markup,
    price_dynamic: p.price_dynamic, stock: p.stock, min_stock: p.min_stock,
    is_active: isActive,
    // `units` sengaja TIDAK dimasukkan. Server memperlakukan ketidakhadirannya
    // sebagai "tidak ada perubahan" (lihat upsertProduct), sehingga toggle
    // status tidak pernah menghapus satuan jual — dan nilai di DB (bukan cache
    // client yang mungkin basi) tetap jadi yang dipertahankan.
  };
}

/** Tombol aksi di tiap baris tabel (edit / restock / nonaktifkan / aktifkan / hapus).
 *
 *  WAJIB dipanggil ulang setiap kali tbody dirender ulang. Sebelumnya listener
 *  ini hanya dipasang sekali di bind(), sedangkan renderRows() mengganti
 *  innerHTML tbody utuh -> semua tombol hasil pencarian/filter/infinite scroll
 *  jadi mati diam-diam (klik tidak buka form, tanpa error di console). */
function bindRowActions(): void {
  if (!host) return;
  host.querySelectorAll<HTMLElement>('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = state.products.find((x) => x.id === Number(b.dataset.edit));
      if (p) productForm(p, state.categories);
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-restock]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = state.products.find((x) => x.id === Number(b.dataset.restock));
      if (p) restockForm(p);
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-off]').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = state.products.find((x) => x.id === Number(b.dataset.off));
      if (!p) return;
      const yes = await confirmDialog({
        title: `Nonaktifkan "${p.name}"?`,
        message:
          'Produk akan hilang dari kasir (POS) sampai diaktifkan kembali. Riwayat penjualan lama tetap aman dan tidak berubah.',
        okLabel: 'Ya, nonaktifkan',
        cancelLabel: 'Batal, jangan diubah',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiPost('/api/products', payloadToggleAktif(p, 0));
        toast(`"${p.name}" dinonaktifkan`, 'success');
        // Buang juga dari cache: API tidak pernah mengirim produk nonaktif lagi.
        await removeProductBySku(p.sku);
        state.inactive = state.inactive.filter((x) => x.sku !== p.sku);
        await reload(false);
      } catch (e) {
        toast(`Gagal: ${errMsg(e)}`, 'error');
      }
    }),
  );

  host.querySelectorAll<HTMLElement>('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const p =
        state.products.find((x) => x.id === Number(b.dataset.del)) ??
        state.inactive.find((x) => x.id === Number(b.dataset.del));
      if (!p) return;
      const yes = await confirmDialog({
        title: `Hapus "${p.name}"?`,
        message:
          'Produk hilang permanen dari daftar maupun dari kasir (POS), berbeda dengan nonaktifkan. ' +
          'Kalau produk ini pernah terjual, server akan menolak (riwayat penjualan harus utuh) — pakai nonaktifkan saja. ' +
          'Batal kalau ragu.',
        okLabel: 'Hapus permanen',
        cancelLabel: 'Batal',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/products/${p.id}`);
        toast(`"${p.name}" dihapus`, 'success');
        // Buang dari cache + kedua daftar lokal; tombstone-nya juga dibawa
        // syncMaster() ke device kasir lain lewat ?since=.
        await removeProductBySku(p.sku);
        state.products = state.products.filter((x) => x.sku !== p.sku);
        state.inactive = state.inactive.filter((x) => x.sku !== p.sku);
        await reload(false);
      } catch (e) {
        toast(`Gagal hapus: ${errMsg(e)}`, 'error');
      }
    }),
  );

  // Aktifkan kembali: POST upsert yang sama, is_active=1. Payload LENGKAP wajib
  // dikirim — kalau hanya is_active, price/stock akan ter-reset ke 0 oleh server.
  host.querySelectorAll<HTMLElement>('[data-on]').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = state.inactive.find((x) => x.id === Number(b.dataset.on));
      if (!p) return;
      const yes = await confirmDialog({
        title: `Aktifkan kembali "${p.name}"?`,
        message: 'Produk akan muncul lagi di kasir (POS) dan bisa langsung dijual. Stok saat ini: ' + p.stock + '.',
        okLabel: 'Ya, aktifkan',
        cancelLabel: 'Batal, jangan diubah',
        icon: 'question',
      });
      if (!yes) return;
      try {
        await apiPost('/api/products', payloadToggleAktif(p, 1));
        toast(`"${p.name}" aktif kembali`, 'success');
        state.inactive = state.inactive.filter((x) => x.sku !== p.sku);
        await reload(true); // delta sync: versi baru > maxVersion cache, jadi ikut terambil
      } catch (e) {
        toast(`Gagal: ${errMsg(e)}`, 'error');
      }
    }),
  );
}

/* ---------- ENTRY ---------- */

export async function mountProductsPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderProductsPage();
  bind();
  // Cache dulu supaya tabel terisi instan, lalu tarik data server.
  state.products = (await getCachedProducts()).slice().sort((a, b) => a.name.localeCompare(b.name, 'id'));
  if (!el.isConnected) return; // pindah halaman saat baca cache
  paint();
  await reload(true);
}
