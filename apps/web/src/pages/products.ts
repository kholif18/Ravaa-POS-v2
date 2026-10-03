// Halaman Produk: sidebar kategori + status, toolbar cari, tabel produk.
// Data: cache IndexedDB (instant) lalu delta sync dari server (?since=maxVersion).
//
// Catatan `type` produk (barang|jasa|cetak|desain|topup) SUDAH DIHAPUS 2026-09-26:
// nature produk sudah tercermin dari kategori (categories.track_stock).

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { fullReset, getCachedProducts, removeProductBySku, syncMaster, type Category, type Product, type Unit } from '../store';
import { icon } from '../ui/icons';
import { toggleNavDrawer } from '../ui/shell';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { switchHtml } from '../ui/switch';
import { toast } from '../ui/toast';
import { statusExpiry, tglExpiry } from '../ui/expiry';
import { CONTOH_KOLOM, csvProduk, mapRows, parseTable, templateProduk, unduhCSV, type BarisImpor } from '../importcsv';

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

type EditCat = { isNew: boolean; slug: string; name: string; track_stock: number; use_expiry: number };

/** Kolom yang bisa diurutkan dengan klik header. Default `nama` asc = urutan yang
 *  selama ini dipakai (load & sync mengurutkan nama), jadi tidak ada perubahan
 *  perilaku untuk kasir yang tidak pernah menyentuh header. */
type SortKey = 'nama' | 'kategori' | 'harga' | 'stok';
type SortState = { key: SortKey; dir: 'asc' | 'desc' };
const SORT_LABEL: Record<SortKey, string> = {
  nama: 'Produk',
  kategori: 'Kategori',
  harga: 'Harga',
  stok: 'Stok',
};

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
  sort: { key: 'nama', dir: 'asc' } as SortState,
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
  const list = visibleProducts().filter((p) => {
    if (state.cat !== 'all' && p.category_slug !== state.cat) return false;
    if (!terms.length) return true;
    const n = p.name.toLowerCase();
    const s = p.sku.toLowerCase();
    const c = (p.barcode ?? '').toLowerCase();
    return terms.every((x) => n.includes(x) || s.includes(x) || c.includes(x));
  });
  return urutkan(list);
}

/** Pengurutan tabel (klik header). Selalu di-pegang dengan nama sebagai tie-break
 *  supaya dua produk berharga sama tidak berpindah-pindah tiap render. */
function urutkan(list: Product[]): Product[] {
  const { key, dir } = state.sort;
  const n = dir === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    let x = 0;
    if (key === 'kategori') x = a.category_name.localeCompare(b.category_name, 'id');
    else if (key === 'harga') x = a.price - b.price;
    else if (key === 'stok') x = a.stock - b.stock;
    else x = a.name.localeCompare(b.name, 'id');
    return n * (x !== 0 ? x : a.name.localeCompare(b.name, 'id'));
  });
}

/* ---------- DISKON & KADALUARSA (tampilan baris) ---------- */

/** Nilai potongan rupiah yang benar-benar memotong harga: diskon Rp yang
 *  melebihi harga jual tidak menghasilkan harga coret masuk akal (justru minus),
 *  jadi dibatasi setara harga (gratis) supaya tampilan tidak bohong. */
function diskonRp(p: Product): number {
  if (p.discount_type !== 'rp' || p.discount <= 0) return 0;
  if (p.price_dynamic || p.price <= 0) return 0;
  return Math.min(p.discount, p.price);
}

/** Label badge diskon untuk baris tabel: `-10%` atau `-Rp500`. */
function labelDiskon(p: Product): string {
  if (p.discount_type === 'pct') return p.discount > 0 ? `-${p.discount}%` : '';
  const rpDisc = diskonRp(p);
  return rpDisc > 0 ? `-${rp(rpDisc)}` : '';
}

/** Harga setelah diskon permanen (dipakai kolom Harga & pratinjau form). */
function hargaDiskon(p: Product): number | null {
  if (p.price_dynamic) return null;
  if (p.discount_type === 'pct') {
    if (p.discount <= 0) return null;
    return Math.round((p.price * (1 - p.discount / 100)) / 100) * 100;
  }
  const d = diskonRp(p);
  return d > 0 ? p.price - d : null;
}

/** Status kadaluarsa & format tanggalnya dipakai bersama dengan layar POS —
 *  lihat `ui/expiry.ts` (statusExpiry, tglExpiry). */

/** Field "Tanggal kadaluarsa" di form produk tampil bila kategorinya MENYALAKAN
 *  pengaturan `use_expiry` (checkbox "Gunakan tanggal kadaluarsa" di form
 *  Kategori — lihat kolom `categories.use_expiry`). Pengganti daftar hardcode
 *  snack/eskrim: kategori baru (mis. Frozen food) tinggal dicentang pemilik,
 *  tanpa menyentuh kode.
 *
 *  Produk yang SUDAH punya tanggal tetap menampilkan fieldnya walau
 *  kategorinya dipindah atau pengaturannya dimatikan — data jangan pernah
 *  disembunyikan begitu saja (nilainya masih terkirim saat Simpan). */
function perluExpiry(slug: string, adaNilai: boolean): boolean {
  if (adaNilai) return true;
  return state.categories.find((c) => c.slug === slug)?.use_expiry === 1;
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

/** Isi tbody tabel Produk.
 *
 *  Sel aksi: hanya **Ubah** dan **Hapus** yang selalu tampil langsung (paling
 *  sering dipakai); sisanya — Duplikat, Nonaktifkan / Aktifkan kembali — masuk
 *  ke menu ⋮ supaya baris tidak penuh tombol. Stok & opname sengaja TIDAK ada
 *  di menu ini: perubahan stok hanya lewat halaman Stok. Menu dibuka dan
 *  diletakkan oleh bukaMenu(). */
function productRows(): string {
  const list = filteredProducts();

  if (list.length === 0) {
    const msg =
      state.status === 'nonaktif'
        ? 'Tidak ada produk nonaktif. Bagus — semua produk masih aktif.'
        : 'Tidak ada produk yang cocok dengan filter.';
    return `<tr><td colspan="6"><div class="empty">${icon('products')}<span>${msg}</span></div></td></tr>`;
  }

  // Infinite scroll: potong dulu, baru render. Baris baru hanya ditambahkan di
  // BAWAH, jadi scrollTop pengguna tidak bergeser saat halaman berikutnya dimuat.
  return list
    .slice(0, state.limit)
    .map((p, i) => {
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
        : (() => {
            const akhir = hargaDiskon(p);
            const lbl = labelDiskon(p);
            // Diskon permanen: harga coret di atas + harga akhir, badge potongannya.
            // Tanpa diskon tetap tampil persis seperti sebelumnya (satu baris).
            if (akhir === null || !lbl) {
              return `<span class="td-num block font-semibold text-gray-900 tabular-nums dark:text-white">${rp(p.price)}</span>`;
            }
            return `<span class="block text-xs text-gray-400 line-through tabular-nums">${rp(p.price)}</span>
              <span class="td-num block font-semibold text-red-600 tabular-nums dark:text-red-400">${rp(akhir)}</span>
              <span class="badge-low mt-1 !px-1.5 !py-0.5">${lbl}</span>`;
          })();
      const exp = statusExpiry(p.expiry_date);
      const expTeks = p.expiry_date
        ? exp === 'lewat'
          ? `<span class="font-semibold text-red-600 dark:text-red-400">lewat kadaluarsa ${tglExpiry(p.expiry_date)}</span>`
          : exp === 'dekat'
            ? `<span class="font-semibold text-amber-600 dark:text-amber-400">kadaluarsa ${tglExpiry(p.expiry_date)}</span>`
            : `<span>kadaluarsa ${tglExpiry(p.expiry_date)}</span>`
        : '';
      // Foto: thumbnail kecil saja (file aslinya di disk server, jadi tidak
      // membebani cache IndexedDB). onerror menyembunyikan gambar rusak tanpa
      // meninggalkan ikon pecah di tengah nama produk.
      const thumb = p.image
        ? `<img src="/api/products/${p.id}/image?${p.version}" alt="" aria-hidden="true"
             class="size-8 shrink-0 rounded-md border border-gray-200 object-cover dark:border-gray-700"
             loading="lazy" onerror="this.remove()" />`
        : '';
      return `
      <tr class="tr${off ? ' opacity-60' : ''}" data-row="${p.id}">
        <td class="td w-12 text-center tabular-nums text-gray-400">${i + 1}</td>
        <td class="td">
          <div class="flex items-start gap-2">
            ${thumb}
            <div class="min-w-0">
              <div class="cell-strong">${esc(p.name)}${off ? ` <span class="badge-off ml-1">nonaktif</span>` : ''}</div>
              <div class="cell-sub">${esc(p.sku)}${p.unit && p.unit !== '-' ? ` · ${esc(p.unit)}` : ''}${p.barcode ? ` · ${esc(p.barcode)}` : ''}${expTeks ? ` · ${expTeks}` : ''}</div>
            </div>
          </div>
        </td>
        <td class="td">${esc(p.category_name)}</td>
        <td class="td">${priceBadge}</td>
        <td class="td">${stockBadge}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            <button type="button" data-edit="${p.id}" class="row-btn" title="Ubah" aria-label="Ubah ${esc(p.name)}">${icon('pencil')}</button>
            <button type="button" data-del="${p.id}" class="row-btn row-btn-danger" title="Hapus produk" aria-label="Hapus ${esc(p.name)}">${icon('trash')}</button>
            <div class="row-more">
              <button type="button" data-more="${p.id}" class="row-btn" aria-haspopup="menu" aria-expanded="false" title="Aksi lain" aria-label="Aksi lain untuk ${esc(p.name)}">${icon('more')}</button>
              <div class="row-dd" role="menu" hidden>
                ${off
                  ? `<button type="button" data-on="${p.id}" class="dd-item" role="menuitem">${icon('check')}<span>Aktifkan kembali</span></button>`
                  : ''}
                <button type="button" data-copy="${p.id}" class="dd-item" role="menuitem">${icon('copy')}<span>Duplikat (varian baru)</span></button>
                ${off
                  ? ''
                  : `<button type="button" data-off="${p.id}" class="dd-item dd-item-danger" role="menuitem">${icon('close')}<span>Nonaktifkan</span></button>`}
              </div>
            </div>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

/** Header kolom yang bisa diurutkan. Panah `↕` pada kolom non-aktif menandakan
 *  "bisa diklik" tanpa mengklaim urutan apa pun; `aria-sort` memberi tahu
 *  pembaca layar urutan yang sedang berlaku. */
function thUrut(key: SortKey, extra = ''): string {
  const on = state.sort.key === key;
  const arah = on ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const panah = on ? (state.sort.dir === 'asc' ? '▲' : '▼') : '↕';
  return `<th class="th th-sticky ${extra}" aria-sort="${arah}">
            <button type="button" data-sort="${key}" class="th-sort${on ? ' is-on' : ''}"
              title="Urutkan menurut ${SORT_LABEL[key]}">${SORT_LABEL[key]}<span class="th-arrow" aria-hidden="true">${panah}</span></button>
          </th>`;
}

function tableCard(): string {
  // `lg:flex-1` WAJIB: tanpa grow-nya kartu berhenti seukuran isi, jadi footer
  // tidak pernah turun ke dasar area tabel saat barisnya sedikit (wrap 696px vs
  // kartu 172px pada filter 1 baris) — selama ini tertutupi banyaknya baris.
  return `
  <div class="card-flush lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
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
      <table class="table table-compact">
        <thead>
          <tr>
            <th class="th th-sticky w-12 text-center">No.</th>
            ${thUrut('nama')}
            ${thUrut('kategori')}
            ${thUrut('harga', 'text-right')}
            ${thUrut('stok')}
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
  // Rute ini TIDAK punya header sama sekali (lihat TANPA_HEADER di ui/shell):
  // judul + breadcrumb + tombol tema/user sengaja dibuang supaya area kerja
  // tabel mendapat tinggi penuh. Navigasi antar-halaman lewat sidebar (selalu
  // terlihat di >= lg) atau tombol kotak di toolbar (drawer di < lg).
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
            <button type="button" id="nav-toggle" class="side-collapse-btn lg:hidden" title="Buka navigasi" aria-label="Buka navigasi">${icon('dashboard')}</button>
            <button type="button" id="side-toggle" class="side-collapse-btn" title="Tampilkan/sembunyikan kategori" aria-label="Tampilkan atau sembunyikan sidebar kategori" aria-expanded="${state.side}">
              ${icon('menu')}
            </button>
            <div class="search-wrap">
              ${icon('search')}
              <input id="q" class="input input-sm" type="search" placeholder="Cari nama, SKU, atau barcode..." value="${esc(state.q)}" />
            </div>
            <button type="button" id="sync" class="btn btn-ghost" title="Sinkronkan master produk — Shift+klik untuk reset cache penuh">${icon('sync')}<span class="hidden sm:inline">Sinkron</span></button>
            <button type="button" id="prod-import" class="btn btn-ghost" title="Impor produk dari CSV atau tempelan Excel">${icon('upload')}<span class="hidden sm:inline">Impor</span></button>
            <button type="button" id="prod-export" class="btn btn-ghost" title="Unduh produk yang sedang tampil (ikut filter &amp; pencarian) sebagai CSV">${icon('download')}<span class="hidden sm:inline">Ekspor</span></button>
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

/** Semua SKU yang sudah dipakai (aktif + nonaktif). Dasar cek tabrakan SKU
 *  di form — pola yang SAMA dengan dialog impor (lihat `adaSku` di baca()). */
function skuTerpakai(): Set<string> {
  return new Set([...state.products, ...state.inactive].map((x) => x.sku));
}

/** Client TIDAK lagi menurunkan SKU dari nama (sejak SKU default jadi `PRD#####`
 *  yang dihitung server dari MAX). Form membiarkan kolom kosong untuk mode baru
 *  & salinan, lalu server mengisi saat menyimpan — pratinjau angka dari client
 *  tidak akan pernah tepat karena bisa saja ada perubahan lain di server.
 *  Kolom hanya divalidasi ketika DIKETIK: SKU adalah kunci upsert, jadi SKU yang
 *  sudah dipakai tidak boleh lolos (pola daftarnya sama dengan dialog impor). */

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
          Baris pertama = judul kolom. <b>Unduh template</b> untuk mendapat
          judul + 2 baris contoh — namanya persis seperti label di form, dan
          kategori/satunya sudah terisi dari master Anda.
          Bisa juga tempel tabel dari Excel atau tulis judul sendiri;
          file ekspor <b>Aronium</b> tetap bisa langsung masuk tanpa diubah.
          Kategori &amp; satuan boleh ditulis nama biasa ("ATK", "Lembar").
        </p>
        <textarea id="imp-text" rows="6" class="input font-mono text-xs" placeholder="${esc(CONTOH_KOLOM)}" aria-label="Data produk CSV"></textarea>
        <div class="flex flex-wrap items-center gap-2">
          <label class="btn btn-ghost cursor-pointer">
            ${icon('upload')}<span>Pilih file</span>
            <input id="imp-file" type="file" accept=".csv,.txt,text/csv,text/plain" class="sr-only" />
          </label>
          <button type="button" id="imp-unduh" class="btn btn-ghost">${icon('download')}<span>Unduh template</span></button>
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
      // Unduh template CSV: header = label form (HEADER_TEMPLATE) + 2 baris
      // contoh dari master kategori/satuan hidup. Menggantikan tombol
      // "Contoh format" lama — satu tombol, satu file, langsung siap isi.
      // BOM di depan supaya Excel Windows membaca UTF-8 benar — parser membuang
      // BOM-nya sendiri, jadi file hasil unduh tetap bisa langsung diimpor.
      m.el.querySelector('#imp-unduh')?.addEventListener('click', () => {
        unduhCSV(templateProduk(state.categories, state.units), 'template-produk-ravaa.csv');
        // Sengaja TIDAK memakai toast: browser sudah menampilkan unduhannya,
        // dan toast tambahan menumpuk di #toast-root sehingga menggeser
        // `.first()` pada test toast impor (e2e-import) yang mengasumsikan
        // toast teratas = hasil impor.
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

/** Foto terpilih di form Tambah/Duplikat yang BELUM punya id produk:
 *  thumbnail dataURL disimpan di sini, diunggah otomatis SETELAH
 *  `POST /api/products` sukses (endpoint fotonya butuh id produk).
 *  Dibuang (tanpa jejak server) saat form dibatalkan — ini keunggulan mode
 *  Tambah dibanding mode Ubah yang mengunggah seketika.
 *  Di-reset di awal `productForm()`, jadi pilihan lama tidak pernah bocor ke
 *  form berikutnya. */
let fotoPending: string | null = null;

/** Kolom KIRI form produk: kotak foto persegi (modal 2 kolom ala RPOS — kiri
 *  gambar, kanan form).
 *
 *  Mode Ubah (`d != null`) kotaknya hidup: seluruh kotak diklik = pilih berkas,
 *  tombol hapus melayang di pojok kanan atas, unggah SEKETIKA ke
 *  `POST /api/products/:id/image` (lihat catatan di bawah).
 *
 *  Mode Tambah/Duplikat (`d == null`) kotaknya juga HIDUP sejak 2026-10-01
 *  (E: foto saat Tambah): pilihan ditahan di `fotoPending` dan diunggah
 *  otomatis setelah produk disimpan. Endpoint fotonya memang butuh id produk,
 *  jadi TIDAK mungkin unggah saat ini juga — yang ditampilkan pratinjau dari
 *  dataURL di memori. Batal = foto dibuang tanpa menyentuh server.
 *
 *  Kenapa mode Ubah mengunggah LANGSUNG (bukan menunggu tombol Simpan): kalau
 *  ditunda, dua operasi jadi satu tombol — simpan produk gagal = foto ikut
 *  hilang; simpan sukses tapi foto gagal = kasir tidak tahu mana yang benar.
 *  Dengan simpan seketika, hasilnya terlihat di tempat dan bisa diulang
 *  sendiri. Keterbatasannya DITULIS apa adanya di hint: tombol Batal tidak
 *  mengembalikan foto yang sudah terlanjur terunggah. */
function fotoKolom(d: Product | null, mode: ModeForm): string {
  if (!d) {
    // Tambah/Duplikat: kotak hidup, tanpa tombol hapus server (belum ada foto
    // tersimpan) — tombolnya dipakai untuk MEMBUANG pilihan (lihat handler).
    return `
        <p class="form-sec">Foto</p>
        <div class="relative">
          <label class="foto-kotak" title="Klik untuk memilih foto">
            <input id="f-photo-file" type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" />
            <img id="f-photo" alt="Pratinjau foto produk" class="foto-kotak-img" hidden />
            <span id="f-photo-empty" class="foto-kotak-empty">${icon('upload')}<span>Klik untuk pilih foto</span></span>
          </label>
          <button type="button" id="f-photo-del" class="foto-kotak-x hidden"
            title="Buang foto terpilih" aria-label="Buang foto terpilih">${icon('trash')}</button>
        </div>
        <p class="hint mt-1.5">
          Pilih foto sekarang juga boleh — ia disimpan dulu di memori lalu
          <b>diunggah otomatis setelah produk disimpan</b> (endpoint fotonya butuh
          id produk). <b>Batal</b> membuang pilihan tanpa mengirim apa pun ke
          server. Foto dikecilkan jadi thumbnail &le;512px JPEG supaya ringan
          dibuka HP kasir${
            mode === 'copy' ? '; foto produk sumber <b>tidak ikut disalin</b>.' : '.'
          }
        </p>`;
  }
  const src = d.image ? `/api/products/${d.id}/image?v=${d.version}` : '';
  return `
        <p class="form-sec">Foto</p>
        <div class="relative">
          <label class="foto-kotak" title="Klik untuk memilih foto">
            <input id="f-photo-file" type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" />
            <img id="f-photo" src="${src}" alt="Foto ${esc(d.name)}" class="foto-kotak-img"
              ${src ? '' : 'hidden'} />
            <span id="f-photo-empty" class="foto-kotak-empty" ${src ? 'hidden' : ''}>${icon('upload')}<span>Klik untuk pilih foto</span></span>
          </label>
          <button type="button" id="f-photo-del" class="foto-kotak-x ${src ? '' : 'hidden'}"
            title="Hapus foto" aria-label="Hapus foto">${icon('trash')}</button>
        </div>
        <p class="hint mt-1.5">
          Foto <b>langsung tersimpan</b> begitu dipilih (tidak menunggu Simpan) dan otomatis
          dikecilkan jadi thumbnail supaya ringan dibuka HP kasir — file aslinya disimpan di
          server, bukan di cache browser. Karena simpannya seketika, tombol <b>Batal</b> tidak
          mengembalikan foto yang sudah terlanjur diunggah.
        </p>`;
}

/** Baca berkas gambar -> thumbnail JPEG maksimal 512px sebagai dataURL.
 *
 *  Q1 (keputusan user): yang disimpan hanya THUMBNAIL — foto asli berukuran
 *  besar memenuhi cache IndexedDB dan memperlambat sync di HP kasir, padahal
 *  tampilan butuh 64-128px. JPEG dipilih karena jauh lebih kecil dari PNG pada
 *  foto hasil kamera; latar transparan PNG jadi putih (dapat ditoleransi untuk
 *  thumbnail produk). */
async function kecilkanFoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('gambar tidak bisa dibaca'));
      i.src = url;
    });
    const MAX = 512;
    const skala = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * skala));
    const h = Math.max(1, Math.round(img.naturalHeight * skala));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('canvas tidak tersedia');
    ctx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ModeForm = 'new' | 'edit' | 'copy';

/** `mode`:
 *  - `new`  = tambah; SKU boleh kosong (server menurunkan), pasti aktif.
 *  - `edit` = ubah; SKU terkunci karena SKU adalah kunci upsert.
 *  - `copy` = duplikat buat VARIAN (cth. "Bolpoin Snowman" -> Merah/Biru):
 *     disalin: kategori, satuan, harga, markup, satuan jual, stok minimum,
 *     harga-dinamis. TIDAK disalin: SKU (wajib baru), barcode (1 barcode = 1
 *     produk), stok (varian baru belum tentu ada barang fisiknya — menyalin
 *     angkanya berarti menciptakan persediaan yang tidak ada). */
function productForm(
  p: Product | 'new',
  cats: Category[],
  mode: ModeForm = p === 'new' ? 'new' : 'edit',
): void {
  const d = p === 'new' ? null : p;
  // Form baru = pilihan foto baru juga. Tanpa reset ini, foto yang dibatalkan
  // di form sebelumnya ikut terunggah ke produk berikutnya yang disimpan.
  fotoPending = null;
  const salin = mode === 'copy';
  const bisaEditSku = mode !== 'edit';
  const trackDefault = d ? d.track_stock : (cats[0]?.track_stock ?? 0);
  // Mode salinan sengaja mengosongkan SKU: nomor PRD##### hanya bisa dihitung
  // oleh server, dan mengosongkan juga memaksa kasir meninjau SKU sebelum simpan.
  const skuAwal = salin ? '' : (d?.sku ?? '');
  const barcodeAwal = salin ? '' : (d?.barcode ?? '');
  const stokAwal = salin ? 0 : (d?.stock ?? 0);
  // Mode Ubah TIDAK merender input Stok sama sekali (bukan readonly, bukan
  // disembunyikan CSS) — stok hanya diisi saat produk dibuat, sesudahnya hanya
  // lewat restock/opname di halaman Stok. `Stok minimum` tetap ada: itu ambang
  // peringatan produk, bukan mutasi stok.
  const inputStok =
    mode === 'edit'
      ? ''
      : `<div class="field-sm">
              <label class="label" for="f-stock">Stok</label>
              <input id="f-stock" class="input input-sm" inputmode="numeric" value="${stokAwal}" />
            </div>`;

  openModal({
    title: mode === 'new' ? 'Tambah Produk' : salin ? `Duplikat: ${d!.name}` : `Ubah: ${d!.name}`,
    okLabel: mode === 'new' ? 'Tambah' : salin ? 'Buat produk' : 'Simpan',
    wider: true,
    body: `
      ${salin ? `<p class="hint">Salinan baru — SKU dikosongkan dan akan diisi server dengan nomor urut <b>PRD#####</b> saat disimpan; barcode &amp; stok sengaja dikosongkan. Ubah nama &amp; barcode sesuai varian.</p>` : ''}
      <div class="grid grid-cols-1 gap-x-4 gap-y-3 lg:grid-cols-[240px_1fr]">
        <div class="mx-auto w-44 sm:w-56 lg:mx-0 lg:w-full">
          ${fotoKolom(mode === 'edit' && d ? d : null, mode)}
        </div>
        <div class="space-y-2 min-w-0">
        <p class="form-sec">Detail produk</p>
        <div class="field-sm">
          <label class="label" for="f-name">Nama produk *</label>
          <input id="f-name" class="input input-sm" value="${esc(d?.name ?? '')}" placeholder="cth: Pulpen A5 Hitam" />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="field-sm">
            <label class="label" for="f-sku">SKU <span class="hint font-normal" id="f-sku-hint"></span></label>
            <input id="f-sku" class="input input-sm" value="${esc(skuAwal)}" placeholder="kosong = PRD#####" ${
              bisaEditSku ? '' : 'readonly title="SKU tidak bisa diubah (upsert by SKU)"'
            } />
          </div>
          <div class="field-sm">
            <label class="label" for="f-barcode">Barcode <span class="hint font-normal">1 produk = 1 barcode</span></label>
            <input id="f-barcode" class="input input-sm" value="${esc(barcodeAwal)}" inputmode="numeric" placeholder="opsional" />
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
        ${mode === 'edit' && d && d.track_stock ? `
        <p class="-mt-1 text-xs text-gray-500 dark:text-gray-400">
          Modal rata-rata: <b class="text-gray-700 dark:text-gray-200">${rp(d.avg_cost)}</b>
          — hasil penimbangan seluruh restock, dipakai sebagai HPP saat jual.
          <span class="text-gray-400 dark:text-gray-500">"Harga beli" di atas adalah angka manual Anda (patokan markup) dan TIDAK ikut berubah oleh restock.</span>
        </p>` : ''}
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 pt-0.5">
          ${switchHtml('f-dyn', d ? !!d.price_dynamic : false, 'Boleh ubah harga saat jual')}
          ${switchHtml('f-note', d ? !!d.use_note : false, 'Catatan di POS')}
          ${mode === 'edit' && d ? switchHtml('f-active', !!d.is_active, 'Aktif') : ''}
        </div>
        <p class="hint">Aktifkan bila produk ini butuh catatan per transaksi di keranjang POS
          (mis. Cetak Banner — ukuran, bahan) — teksnya ikut tercetak di struk.</p>

        <p class="form-sec">Diskon</p>
        <div class="grid grid-cols-2 gap-2">
          <div class="field-sm">
            <label class="label" for="f-disc-type">Tipe diskon</label>
            <select id="f-disc-type" class="input input-sm">
              <option value="rp" ${(d?.discount_type ?? 'rp') === 'rp' ? 'selected' : ''}>Potongan Rupiah (Rp)</option>
              <option value="pct" ${d?.discount_type === 'pct' ? 'selected' : ''}>Persen dari harga (%)</option>
            </select>
          </div>
          <div class="field-sm">
            <label class="label" for="f-disc">Nilai diskon</label>
            <input id="f-disc" class="input input-sm" inputmode="decimal" value="${d?.discount ?? 0}" />
          </div>
        </div>
        <p class="hint" id="f-disc-hint"></p>

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
          <div class="grid gap-2 ${mode === 'edit' ? 'grid-cols-1' : 'grid-cols-2'}">
            ${inputStok}
            <div class="field-sm">
              <label class="label" for="f-min">Stok minimum</label>
              <input id="f-min" class="input input-sm" inputmode="numeric" value="${d?.min_stock ?? 0}" />
            </div>
          </div>
        </div>

        <div id="f-exp-wrap" ${perluExpiry(d?.category_slug ?? '', !!d?.expiry_date) ? '' : 'hidden'}>
          <p class="form-sec">Kadaluarsa</p>
          <div class="field-sm">
            <label class="label" for="f-exp">Tanggal kadaluarsa</label>
            <input id="f-exp" type="date" class="input input-sm" value="${esc(d?.expiry_date ?? '')}" />
            <span class="hint" id="f-exp-hint"></span>
          </div>
        </div>
        </div><!-- /kolom kanan (form) -->
      </div><!-- /grid 2 kolom -->`,
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
      const min = el.querySelector('#f-min') as HTMLInputElement;
      const name = el.querySelector('#f-name') as HTMLInputElement;
      const sku = el.querySelector('#f-sku') as HTMLInputElement;
      const skuHint = el.querySelector('#f-sku-hint') as HTMLElement;
      const trackHint = el.querySelector('#f-track-hint') as HTMLElement;
      const stockWrap = el.querySelector('#f-stock-wrap') as HTMLElement;
      const expWrap = el.querySelector('#f-exp-wrap') as HTMLElement;
      const expInput = el.querySelector('#f-exp') as HTMLInputElement;
      const expHint = el.querySelector('#f-exp-hint') as HTMLElement;
      const discType = el.querySelector('#f-disc-type') as HTMLSelectElement;
      const discInput = el.querySelector('#f-disc') as HTMLInputElement;
      const discHint = el.querySelector('#f-disc-hint') as HTMLElement;

      const track = () => cats.find((c) => c.slug === catSel.value)?.track_stock === 1;
      const syncTrack = () => {
        const t = track();
        // Blok Stok disembunyikan total (bukan cuma disabled) untuk kategori jasa —
        // field yang tak terlihat tapi masih terkirim bikin kasir bingung.
        stockWrap.hidden = !t;
        trackHint.textContent = t
          ? 'Kategori ini melacak stok, jadi blok Stok di bawah aktif.'
          : `Kategori "${cats.find((c) => c.slug === catSel.value)?.name ?? ''}" tidak melacak stok (jasa/cetak/topup) — stok diisi lewat penjualan, bukan master.`;
        // Kadaluarsa: tampil bila KATEGORI menyalakan `use_expiry` (checkbox di
        // form Kategori). TAPI produk yang sudah punya tanggal tetap
        // menampilkan fieldnya — data tidak boleh disembunyikan begitu
        // kategorinya dipindah (perluExpiry menilai keduanya).
        const adaNilai = expInput.value.trim() !== '';
        const nyalakan = cats.find((c) => c.slug === catSel.value)?.use_expiry === 1;
        expWrap.hidden = !perluExpiry(catSel.value, adaNilai);
        expHint.textContent = nyalakan
          ? 'Diisi untuk barang cepat basi — tampil di tabel Produk dan dipakai peringatan stok.'
          : adaNilai
            ? 'Kategori ini tidak menyalakan tanggal kadaluarsa, tapi produk ini sudah punya tanggal — kolomnya tetap ditampilkan supaya datanya tidak tersembunyi.'
            : 'Kategori ini belum menyalakan tanggal kadaluarsa — centang di form Kategori bila produknya butuh.';
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
      const merah = ['text-red-600', 'dark:text-red-400'];
      // Kolom SKU hanya divalidasi ketika diketik — client tidak pernah
      // mengisinya sendiri, termasuk di mode salinan. Saat kosong, server yang
      // menomori `PRD#####`; pratinjau angka dari client tidak akan pernah tepat
      // karena nomor berikutnya bisa saja sudah dipakai perubahan lain di server.
      const syncSkuHint = () => {
        skuHint.classList.remove(...merah);
        if (!bisaEditSku) {
          skuHint.textContent = 'SKU tidak bisa diubah';
          return;
        }
        const ketik = sku.value.trim();
        if (!ketik) {
          skuHint.textContent = 'dikosongkan = diisi server (PRD#####)';
          return;
        }
        // Cek tabrakan LIVE. Server meng-upsert berdasarkan SKU, jadi SKU yang
        // sudah dipakai TIDAK boleh lolos — kalau lolos, produk lain ikut
        // tertimpa diam-diam. Pola daftar-nya sama dengan dialog impor.
        if (skuTerpakai().has(ketik)) {
          skuHint.textContent = 'sudah dipakai!';
          skuHint.classList.add(...merah);
        } else {
          skuHint.textContent = 'unik';
        }
      };

      // --- diskon permanen: pratinjau harga akhir ---------------------------
      // Nilai disimpan apa adanya (rp bulat / persen boleh desimal); yang
      // diverifikasi di sini hanya batas yang memang mustahil (persen > 100,
      // rupiah melewati harga jual) supaya kesalahannya ketahuan SEBELUM simpan,
      // bukan sebagai toast gagal setelah kasir menekan Simpan.
      const warnaMerah = ['text-red-600', 'dark:text-red-400'];
      const bacaDisc = () => (discType.value === 'pct' ? dec('f-disc') : num('f-disc'));
      const syncDisc = () => {
        const pct = discType.value === 'pct';
        const nilai = bacaDisc();
        const harga = num('f-price');
        discHint.classList.remove(...warnaMerah);
        if (nilai <= 0) {
          discHint.innerHTML = 'Tanpa diskon — dijual sesuai harga jual di atas.';
          return;
        }
        if (pct && nilai > 100) {
          discHint.textContent = 'Diskon persen maksimal 100%.';
          discHint.classList.add(...warnaMerah);
          return;
        }
        if (!pct && !dyn.checked && harga > 0 && nilai > harga) {
          discHint.textContent = `Diskon ${rp(nilai)} melebihi harga jual ${rp(harga)} — kurangi dulu.`;
          discHint.classList.add(...warnaMerah);
          return;
        }
        // Harga dinamis / belum diisi: tidak ada angka yang bisa dipratinjau,
        // dan memang harga per transaksilah yang akan dipotong.
        if (dyn.checked || harga <= 0) {
          discHint.textContent = pct
            ? `Potong ${nilai}% dari harga yang diketik kasir saat transaksi.`
            : `Potong ${rp(nilai)} dari harga yang diketik kasir saat transaksi.`;
          return;
        }
        const akhir = pct ? Math.round((harga * (1 - nilai / 100)) / 100) * 100 : harga - nilai;
        discHint.innerHTML =
          `Harga jual ${rp(harga)} &rarr; <b class="text-gray-700 dark:text-gray-200">${rp(Math.max(0, akhir))}</b>` +
          ` (${pct ? `${nilai}%` : `potong ${rp(nilai)}`}) — jadi diskon awal baris di kasir.`;
      };

      // --- foto: unggah seketika (lihat catatan pada fotoKolom) --------------
      const fotoEl = el.querySelector<HTMLImageElement>('#f-photo');
      const fotoEmpty = el.querySelector<HTMLElement>('#f-photo-empty');
      const fotoDel = el.querySelector<HTMLButtonElement>('#f-photo-del');
      const tampilFoto = (src: string | null) => {
        if (!fotoEl) return;
        if (src) {
          fotoEl.src = src;
          fotoEl.hidden = false;
          if (fotoEmpty) fotoEmpty.hidden = true;
          fotoDel?.classList.remove('hidden');
        } else {
          fotoEl.hidden = true;
          fotoEl.removeAttribute('src');
          if (fotoEmpty) fotoEmpty.hidden = false;
          fotoDel?.classList.add('hidden');
        }
      };
      el.querySelector('#f-photo-file')?.addEventListener('change', async (e) => {
        const inp = e.target as HTMLInputElement;
        const f = inp.files?.[0];
        // Di-reset dulu: kalau tidak, memilih berkas yang sama dua kali tidak
        // memicu event change (nilai DOM identik) dan terlihat seperti tombol mati.
        inp.value = '';
        if (!f) return;
        if (!f.type.startsWith('image/')) {
          toast('Berkas harus gambar (PNG, JPG, atau WebP)', 'warning');
          return;
        }
        const btn = el.querySelector<HTMLLabelElement>('#f-photo-file')?.closest('label');
        if (btn) btn.classList.add('pointer-events-none', 'opacity-60');
        try {
          const dataUrl = await kecilkanFoto(f);
          if (mode === 'edit' && d) {
            // Ubah: unggah seketika (produk sudah punya id) — lihat catatan fotoKolom.
            const res = await apiPost<{ data: { image: string } }>(
              `/api/products/${d.id}/image`,
              { image: dataUrl },
            );
            d.image = res.data.image;
            tampilFoto(`/api/products/${d.id}/image?v=${Date.now()}`);
            toast('Foto tersimpan', 'success');
          } else {
            // Tambah/Duplikat: tahan di memori, unggah SETELAH produk disimpan
            // (blok Simpan di bawah). Mode copy sengaja TIDAK mengunggah ke
            // `d` — `d` di sini adalah produk SUMBER, bukan hasil salinan.
            fotoPending = dataUrl;
            tampilFoto(dataUrl);
            toast('Foto dipilih — akan diunggah otomatis setelah produk disimpan', 'info');
          }
        } catch (err) {
          toast(`Gagal memproses foto: ${errMsg(err)}`, 'error');
        } finally {
          if (btn) btn.classList.remove('pointer-events-none', 'opacity-60');
        }
      });
      fotoDel?.addEventListener('click', async () => {
        if (mode === 'edit' && d) {
          const yes = await confirmDialog({
            title: 'Hapus foto produk?',
            message: 'Foto dihapus dari produk ini dan tidak bisa dikembalikan — masih bisa diunggah ulang kapan saja.',
            okLabel: 'Hapus foto',
            danger: true,
          });
          if (!yes) return;
          try {
            await apiPost(`/api/products/${d.id}/image`, { image: '' });
            d.image = null;
            tampilFoto(null);
            toast('Foto dihapus', 'success');
          } catch (e) {
            toast(`Gagal hapus foto: ${errMsg(e)}`, 'error');
          }
          return;
        }
        // Tambah/Duplikat: belum ada apa-apa di server — buang pilihan saja.
        fotoPending = null;
        tampilFoto(null);
        toast('Foto dibuang', 'info');
      });

      catSel.addEventListener('change', syncTrack);
      dyn.addEventListener('change', syncPrice);
      dyn.addEventListener('change', syncDisc);
      cost.addEventListener('input', syncHargaDariMarkup);
      cost.addEventListener('input', syncDisc);
      markup.addEventListener('input', syncHargaDariMarkup);
      markup.addEventListener('input', syncDisc);
      price.addEventListener('input', syncMarkupDariHarga);
      price.addEventListener('input', syncDisc);
      sku.addEventListener('input', syncSkuHint);
      name.addEventListener('input', syncSkuHint);
      discType.addEventListener('change', syncDisc);
      discInput.addEventListener('input', syncDisc);
      expInput.addEventListener('change', syncTrack);

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
      syncDisc();

      ok.addEventListener('click', async () => {
        const nama = val('f-name');
        if (!nama) { toast('Nama produk wajib diisi', 'warning'); return; }
        const skuKetik = val('f-sku');
        if (bisaEditSku && skuKetik && skuTerpakai().has(skuKetik)) {
          toast(`SKU "${skuKetik}" sudah dipakai produk lain — SKU harus unik. Kosongkan agar diisi server (PRD#####).`, 'warning');
          sku.focus();
          sku.select();
          return;
        }
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
        // --- diskon & kadaluarsa: tolak sebelum mengirim ---------------------
        const tipeDisc = discType.value === 'pct' ? 'pct' : 'rp';
        const nilaiDisc = tipeDisc === 'pct' ? dec('f-disc') : num('f-disc');
        if (!Number.isFinite(nilaiDisc) || nilaiDisc < 0) {
          toast('Nilai diskon harus angka >= 0', 'warning'); discInput.focus(); return;
        }
        if (tipeDisc === 'pct' && nilaiDisc > 100) {
          toast('Diskon persen maksimal 100%', 'warning'); discInput.focus(); return;
        }
        const hargaJual = num('f-price');
        if (tipeDisc === 'rp' && !dyn.checked && hargaJual > 0 && nilaiDisc > hargaJual) {
          toast(`Diskon ${rp(nilaiDisc)} melebihi harga jual ${rp(hargaJual)}`, 'warning');
          discInput.focus();
          return;
        }
        const expVal = val('f-exp');
        if (expVal && !/^\d{4}-\d{2}-\d{2}$/.test(expVal)) {
          toast('Tanggal kadaluarsa tidak valid', 'warning'); expInput.focus(); return;
        }
        ok.disabled = true;
        try {
          const res = await apiPost<{ data: Product }>('/api/products', {
            name: nama,
            sku: skuKetik,
            barcode: val('f-barcode') || null,
            category_slug: catSel.value,
            unit: val('f-unit') || 'pcs',
            price: num('f-price'),
            cost: num('f-cost'),
            markup: dec('f-markup'),
            price_dynamic: dyn.checked ? 1 : 0,
            // Mode Ubah tidak punya elemen `#f-stock`. `num('f-stock')` tanpa
            // elemennya jatuh ke 0 -> server men-reset stok jadi nol diam-diam
            // (lihat AGENTS §3: field yang tidak dikirim ikut ke-reset). Kirim
            // nilai lama apa adanya.
            stock: mode === 'edit' ? (d?.stock ?? 0) : num('f-stock'),
            min_stock: num('f-min'),
            is_active:
              mode === 'edit'
                ? ((el.querySelector('#f-active') as HTMLInputElement).checked ? 1 : 0)
                : 1,
            // SELALU dikirim (termasuk []) — tidak dikirim = tidak diubah, jadi
            // form tanpa perubahan satuan harus tetap mengirim daftar lama agar
            // konsisten dengan tampilan. `[]` = hapus semua satuan alternatif.
            units: unitList.map((u) => ({ unit: u.unit, factor: u.factor, price: u.price })),
            // Diskon & kadaluarsa SELALU ikut: field yang tidak dikirim di-reset
            // server ke default (lihat AGENTS §3), jadi form yang tidak menyentuhnya
            // tetap harus mengirim nilai yang sedang tampil.
            discount_type: tipeDisc,
            discount: nilaiDisc,
            expiry_date: expVal || null,
            // Catatan di POS: SELALU dikirim (field biasa — absen = reset ke 0
            // di server), sama alasannya dengan diskon/kadaluarsa di atas.
            use_note: (el.querySelector('#f-note') as HTMLInputElement).checked ? 1 : 0,
            // `image` sengaja TIDAK ada di payload: server memperlakukan
            // ketidakhadirannya sebagai "tidak diubah", sehingga menyimpan form
            // tidak pernah menghapus foto yang sudah diunggah lewat blok Foto
            // (persis perlakuan `units` terhadap satuan jual).
          });
          // SKU bisa dibuat server saat kolomnya dikosongkan -> tampilkan apa
          // yang benar-benar tersimpan, bukan tebakan client.
          // Foto mode Tambah/Duplikat: unggah SEKETIKA setelah produk punya id
          // (kotak foto penuh di mode ini memang menjanjikan ini — lihat fotoKolom).
          let fotoGagal = '';
          if (mode !== 'edit' && fotoPending) {
            try {
              await apiPost(`/api/products/${res.data.id}/image`, { image: fotoPending });
              fotoPending = null;
            } catch (fe) {
              // Produk SUDAH tersimpan — jangan dibatalkan hanya karena foto.
              // Kasir diberi tahu terpisah dan bisa mengunggah ulang lewat mode Ubah.
              fotoGagal = ` · foto gagal diunggah: ${errMsg(fe)}`;
            }
          }
          toast(
            `${mode === 'edit' ? 'Produk diperbarui' : salin ? 'Produk diduplikat' : 'Tersimpan'} · ${res?.data?.sku ?? ''}${fotoGagal}`,
            fotoGagal ? 'warning' : 'success',
          );
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
/** Dialog stok (restock + opname). HANYA dipanggil dari halaman Stok — sejak
 *  2026-09-28 form produk menyimpan stok AWAL saja, jadi tiap perubahan stok
 *  wajib melewati jalur ini dan tercatat sebagai mutasi. `sesudah` disuntikkan,
 *  bukan memakai `reload()` halaman Produk (halaman Stok punya state sendiri). */
export function restockForm(p: Product, sesudah?: () => void | Promise<void>): void {
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
        await (sesudah ? sesudah() : reload(true));
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
      </label>
      <label class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
        <input id="c-exp" type="checkbox" class="mt-0.5 size-4 accent-primary" ${cat.use_expiry ? 'checked' : ''} />
        <span>Gunakan tanggal kadaluarsa (expired)
          <span class="block text-xs text-gray-500 dark:text-gray-400">Menampilkan kolom <b>Tanggal kadaluarsa</b> di form produk kategori ini — untuk barang cepat basi (snack, es krim, frozen food).</span>
        </span>
      </label>`,
    onMount: ({ el, ok, close }) => {
      const name = el.querySelector('#c-name') as HTMLInputElement;
      const slug = el.querySelector('#c-slug') as HTMLInputElement;
      const track = el.querySelector('#c-track') as HTMLInputElement;
      const pakaiExp = el.querySelector('#c-exp') as HTMLInputElement;
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
            use_expiry: pakaiExp.checked ? 1 : 0,
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

  // Shift+klik Sinkron = reset cache lalu tarik ulang dari nol (`fullReset()`
  // sudah ada sejak awal tapi tidak pernah dipanggil). Perlu setelah migrasi SKU:
  // syncMaster merge per SKU dan tidak pernah menghapus key lama, jadi baris
  // lama akan menetap sebagai hantu di IndexedDB bila hanya delta sync biasa.
  find('#sync')?.addEventListener('click', async (e) => {
    if (e.shiftKey) {
      await fullReset();
      toast('Cache master dibersihkan — menarik ulang semua data dari nol.', 'success');
    }
    await reload(true);
  });
  find('#prod-new')?.addEventListener('click', () => productForm('new', state.categories));
  find('#prod-import')?.addEventListener('click', () => importForm());
  // Ekspor mengikuti filter & pencarian yang sedang aktif, jadi
  // "yang saya lihat = yang saya dapat".
  // Sengaja TIDAK memakai toast: browser sudah menampilkan unduhannya.
  find('#prod-export')?.addEventListener('click', () => {
    const rows = filteredProducts();
    unduhCSV(csvProduk(rows), 'produk-ravaa.csv');
  });
  // Toggle sidebar kategori: ubah atribut data-open saja (bukan render ulang),
  // supaya animasi CSS berjalan dan isian search tidak hilang/fokus hilang.
  // #nav-toggle membuka DRAWER NAVIGASI (bukan sidebar kategori): rute ini
  // tidak punya header, jadi di layar kecil (< lg) inilah satu-satunya jalan
  // pindah halaman (lihat toggleNavDrawer di ui/shell.ts).
  find('#nav-toggle')?.addEventListener('click', () => toggleNavDrawer());
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
  // Klik header = urutkan. Klik lagi di kolom yang sama MEMBALIK arah (asc <-> desc),
  // klik kolom lain mulai dari asc. Paint penuh karena panahnya ada di thead;
  // limit ikut reset ke PAGE karena daftarnya berubah total.
  host.querySelectorAll<HTMLElement>('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.sort as SortKey;
      if (!(key in SORT_LABEL)) return;
      state.sort =
        state.sort.key === key
          ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: 'asc' };
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
    categoryForm({ isNew: true, slug: '', name: '', track_stock: 0, use_expiry: 0 }, state.categories),
  );
  host.querySelectorAll<HTMLElement>('[data-cat-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = state.categories.find((x) => x.slug === b.dataset.catEdit);
      if (c) categoryForm({ isNew: false, slug: c.slug, name: c.name, track_stock: c.track_stock, use_expiry: c.use_expiry }, state.categories);
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
    // Diskon & kadaluarsa ikut dikirim karena server me-reset field yang absen
    // ke default (`rp`, 0, null) — tanpa ini, menonaktifkan produk lalu
    // mengaktifkannya kembali MEMBUANG diskon permanen & tanggal kadaluarsanya
    // diam-diam. Sama alasannya dengan price/cost/min_stock di atas.
    discount_type: p.discount_type ?? 'rp',
    discount: p.discount ?? 0,
    expiry_date: p.expiry_date ?? null,
    use_note: p.use_note ?? 0,
    // `image` & `units` sengaja TIDAK dimasukkan. Server memperlakukan
    // ketidakhadirannya sebagai "tidak ada perubahan" (lihat upsertProduct),
    // sehingga toggle status tidak pernah menghapus foto maupun satuan jual —
    // dan nilai di DB (bukan cache client yang mungkin basi) tetap jadi yang
    // dipertahankan.
  };
}

/* ---------- menu ⋮ aksi baris ---------- */

/** Tutup satu menu ⋮ (wrap = pembungkus .row-more). */
function tutupMenu(wrap: HTMLElement): void {
  wrap.classList.remove('is-open');
  wrap.querySelector('[data-more]')?.setAttribute('aria-expanded', 'false');
  wrap.querySelector<HTMLElement>('.row-dd')?.setAttribute('hidden', '');
}

function tutupSemuaMenu(): void {
  document.querySelectorAll<HTMLElement>('.row-more.is-open').forEach(tutupMenu);
}

/** Buka menu ⋮ — buka dulu baru ukur: elemen `hidden` tidak punya
 *  offsetWidth/offsetHeight, jadi posisinya belum bisa dihitung.
 *
 *  Posisi pakai `position: fixed` (di-set inline + di CSS .row-dd) supaya lolos
 *  dari .table-wrap yang overflow-x-auto — menurut spesifikasi itu memaksa
 *  overflow-y ikut dihitung `auto`, sehingga anak ber-absolute di dalamnya ikut
 *  terpotong atau memicu scrollbar tabel. */
function bukaMenu(wrap: HTMLElement, btn: HTMLElement): void {
  const dd = wrap.querySelector<HTMLElement>('.row-dd');
  if (!dd) return;
  tutupSemuaMenu(); // hanya satu menu yang boleh terbuka pada satu waktu
  dd.removeAttribute('hidden');
  dd.style.left = '0';
  dd.style.top = '0';
  const r = btn.getBoundingClientRect();
  const w = dd.offsetWidth;
  const h = dd.offsetHeight;
  // Siku kanan menu = siku kanan tombol, lalu dijepit ke viewport: kolom Aksi
  // menempel di tepi kanan tabel, tanpa jepit menu bisa keluar layar.
  const kiri = Math.min(Math.max(8, r.right - w), Math.max(8, window.innerWidth - w - 8));
  // Baris paling bawah -> buka ke atas, jangan keluar tepi bawah layar.
  const atas = r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
  dd.style.left = `${kiri}px`;
  dd.style.top = `${atas}px`;
  wrap.classList.add('is-open');
  btn.setAttribute('aria-expanded', 'true');
}

/** Klik di luar & Escape. Dipasang SEKALI — kalau dipasang di dalam
 *  bindRowActions(), listener menumpuk satu tiap renderRows() dipanggil
 *  (pencarian, filter, dan infinite scroll sama-sama merender ulang tbody). */
let menuGlobalTerpasang = false;
function pasangMenuGlobal(): void {
  if (menuGlobalTerpasang) return;
  menuGlobalTerpasang = true;
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    document.querySelectorAll<HTMLElement>('.row-more.is-open').forEach((w) => {
      // Tombol ⋮ dan seluruh isi menu ada di dalam .row-more, jadi klik di
      // dalamnya sengaja tidak ditutup oleh listener ini (dibiarkan oleh
      // pemanggilannya sendiri).
      if (!w.contains(t)) tutupMenu(w);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') tutupSemuaMenu();
  });
}

/** Tombol aksi di tiap baris tabel (edit / hapus + menu ⋮: duplikat,
 *  nonaktifkan / aktifkan).
 *
 *  WAJIB dipanggil ulang setiap kali tbody dirender ulang. Sebelumnya listener
 *  ini hanya dipasang sekali di bind(), sedangkan renderRows() mengganti
 *  innerHTML tbody utuh -> semua tombol hasil pencarian/filter/infinite scroll
 *  jadi mati diam-diam (klik tidak buka form, tanpa error di console). */
function bindRowActions(): void {
  if (!host) return;
  host.querySelectorAll<HTMLElement>('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.copy);
      const p = state.products.find((x) => x.id === id) ?? state.inactive.find((x) => x.id === id);
      if (p) productForm(p, state.categories, 'copy');
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      // Cari juga di state.inactive: Ubah kini satu-satunya tombol yang selalu
      // tampil di baris, jadi ia harus tetap hidup saat status = nonaktif.
      // Form edit menampilkan switch #f-active (mati) dan menyimpannya apa
      // adanya, jadi membuka produk nonaktif tidak mengaktifkannya diam-diam.
      const id = Number(b.dataset.edit);
      const p =
        state.products.find((x) => x.id === id) ?? state.inactive.find((x) => x.id === id);
      if (p) productForm(p, state.categories);
    }),
  );
  // "Stok & opname" TIDAK ada lagi di sini: perubahan stok hanya lewat halaman
  // Stok (#/stock), supaya form produk benar-benar menyimpan stok AWAL saja dan
  // tiap mutasi punya jejak. Lihat restockForm() yang kini hanya dipanggil stock.ts.
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

  // Menu ⋮: buka/tutup. Sengaja TANPA stopPropagation — tombol ⋮ ada di dalam
  // .row-more, jadi listener "klik di luar" di document menganggapnya klik
  // di dalam dan tidak ikut menutup. Keuntungannya handler global lain (menu
  // pengguna, dropdown POS) tetap jalan saat ⋮ diklik.
  host.querySelectorAll<HTMLElement>('[data-more]').forEach((b) =>
    b.addEventListener('click', () => {
      const wrap = b.closest('.row-more');
      if (!(wrap instanceof HTMLElement)) return;
      if (wrap.classList.contains('is-open')) tutupMenu(wrap);
      else bukaMenu(wrap, b);
    }),
  );

  // Item menu diklik -> tutup menunya. Aksi masing-masing sudah diikat di atas
  // (selector [data-on]/[data-copy]/… menemukannya juga di dalam menu);
  // penutup ini supaya tidak ada panel tipis yang menutupi modal hasilnya.
  host.querySelectorAll<HTMLElement>('.row-dd').forEach((d) =>
    d.addEventListener('click', () => {
      const wrap = d.closest('.row-more');
      if (wrap instanceof HTMLElement) tutupMenu(wrap);
    }),
  );
  pasangMenuGlobal();
}

/* ---------- ENTRY ---------- */

export async function mountProductsPage(el: HTMLElement): Promise<void> {
  host = el;
  // Baca ulang preferensi sidebar tiap mount — kuncinya (SIDE_KEY) berbagi
  // dengan halaman Stok, sementara state.side hanya dibaca sekali saat boot
  // modul. Harus SEBELUM renderProductsPage(), karena render itulah yang
  // menuliskan data-open ke DOM.
  state.side = readSide();
  el.innerHTML = renderProductsPage();
  bind();
  // Cache dulu supaya tabel terisi instan, lalu tarik data server.
  state.products = (await getCachedProducts()).slice().sort((a, b) => a.name.localeCompare(b.name, 'id'));
  if (!el.isConnected) return; // pindah halaman saat baca cache
  paint();
  await reload(true);
}
