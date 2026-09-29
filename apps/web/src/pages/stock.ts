// Halaman Stok (#/stock): pantau stok menipis + masuk barang / hitung fisik.
//
// Sengaja TIDAK memuat form edit produk: form itu butuh master satuan & kategori
// milik halaman Produk (state modul `pages/products.ts`), dan membukanya dari
// sini bisa membuka dropdown satuan yang belum termuat. Ubah harga/nama =
// ke halaman Produk; halaman ini urusannya angka stok.
//
// Endpoint yang dipakai (lihat AGENTS.md §3 — tidak ada endpoint baru):
//   GET  /api/products        -> daftar + stock/min_stock/avg_cost/track_stock
//   POST /api/restock         -> tambah stok + rata-rata modal (melalui restockForm)
//   POST /api/stock-opname    -> ganti stok dengan hitung fisik (restockForm)
//   GET  /api/stock-moves     -> riwayat mutasi SATU produk (riwayatForm)
// Impor CSV di halaman ini HANYA memakai /api/stock-opname — lihat komentar
// importStokForm() di bawah kenapa restock tidak masuk lewat impor massal.
// Riwayat stok (masuk/keluar/opname per produk) dibuka lewat tombol jam di
// tiap baris: `GET /api/stock-moves?product_id=` sudah ada sejak Fase 1, jadi
// halaman ini menjanjikan riwayat tanpa endpoint tambahan.

import { apiGet, apiPost, HttpError } from '../api';
import { getCachedProducts, type Category, type Product } from '../store';
import { icon } from '../ui/icons';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { HEADER_STOK, bacaStok, csvStok, unduhCSV, type BarisStok } from '../importcsv';
import { restockForm } from './products';

const rp = (n: number) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;

/** Kunci persistensi sidebar kategori — SAMA dengan halaman Produk, jadi
 *  preferensi tampil/sembunyi berlaku untuk keduanya. */
const SIDE_KEY = 'ravaa.prodside';

/** Default: tampil di desktop, sembunyi di HP (sidebar 256px di layar 390px). */
function readSide(): boolean {
  try {
    const v = localStorage.getItem(SIDE_KEY);
    if (v) return v !== 'hidden';
    return window.matchMedia('(min-width: 1024px)').matches;
  } catch {
    return true;
  }
}

type Filter = 'semua' | 'kritis' | 'habis' | 'minus';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'semua', label: 'Semua' },
  { key: 'kritis', label: 'Stok menipis' },
  { key: 'habis', label: 'Stok habis' },
  // Stok minus = hasil pengaturan "stok boleh minus" (#/settings): angka di bawah
  // nol karena penjualan dibiarkan menembus stok. Sengaja filter sendiri supaya
  // tidak tercampur "habis" (== 0) maupun "menipis" (butuh min_stock > 0) —
  // minus adalah kondisi yang paling mendesak dibereskan.
  { key: 'minus', label: 'Stok minus' },
];

const state = {
  products: [] as Product[],
  categories: [] as Category[],
  loading: true,
  error: '',
  filter: 'semua' as Filter,
  /** Slug kategori terpilih di sidebar; 'all' = tanpa saring. */
  cat: 'all',
  side: readSide(),
  q: '',
};

let host: HTMLElement | null = null;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/* ---------- Klasifikasi ---------- */

/** Produk yang benar-benar memakai stok (kategori `track_stock=1`).
 *  Jasa/cetak/desain/topup TIDAK ikut dihitung maupun ditampilkan di sini. */
const dilacak = (p: Product) => p.track_stock === 1;

/** Habis total: angka 0. Tidak peduli min_stock — 0 barang = 0 barang. */
const habis = (p: Product) => p.stock === 0;

/** Menipis tapi belum habis. `min_stock === 0` berarti TIDAK ada ambang batas,
 *  jadi tidak boleh dihitung menipis (sama aturan dengan halaman Produk). */
const kritis = (p: Product) => p.stock > 0 && p.min_stock > 0 && p.stock <= p.min_stock;

/** Stok menembus nol (pengaturan "stok boleh minus" aktif). */
const minus = (p: Product) => p.stock < 0;

function urutan(p: Product): number {
  if (minus(p)) return -1; // paling mendesak: barang sudah terjual melebihi isi rak
  if (habis(p)) return 0;
  if (kritis(p)) return 1;
  return 2;
}

/** Dasar penghitung: sudah tersaring KATEGORI + PENCARIAN, belum tersaring status.
 *  Dipakai bersama oleh isi tabel DAN angka pada tombol filter, supaya keduanya
 *  tidak pernah beda — sama polanya dengan filteredProducts() halaman Produk. */
function dasar(): Product[] {
  const q = state.q.trim().toLowerCase();
  const kata = q ? q.split(/\s+/) : [];
  return state.products
    .filter(dilacak)
    .filter((p) => state.cat === 'all' || p.category_slug === state.cat)
    .filter((p) => {
      if (!kata.length) return true;
      // SEMUA kata harus cocok — konsisten dengan pencarian Produk & POS.
      const hay = `${p.name} ${p.sku} ${p.barcode ?? ''} ${p.category_name}`.toLowerCase();
      return kata.every((k) => hay.includes(k));
    });
}

function terlihat(): Product[] {
  return dasar()
    .filter((p) => {
      if (state.filter === 'semua') return true;
      if (state.filter === 'minus') return minus(p);
      if (state.filter === 'habis') return habis(p);
      return kritis(p) || habis(p); // "Stok menipis" tetap menyertakan yang habis
    })
    .sort((a, b) => urutan(a) - urutan(b) || a.name.localeCompare(b.name, 'id'));
}

/** Teks footer di bawah tabel — selalu sebanding dengan isi tabel karena
 *  keduanya memakai terlihat(). Halaman Stok merender semua baris (tanpa
 *  infinite scroll seperti Produk), jadi cukup hitungan tunggal. */
function countText(): string {
  return `${terlihat().length} produk dilacak stok`;
}

/** Sidebar kategori: tampilan disamakan dengan halaman Produk
 *  (.side-list / .side-item / .side-count) supaya satu kebiasaan UI.
 *  Sengaja TANPA tombol tambah/ubah/hapus kategori — pengelolaan kategori
 *  berada di halaman Produk (lihat komentar header file ini), dan
 *  categoryForm() memang tidak diekspor dari sana.
 *  Hanya kategori yang benar-benar punya produk dilacak stok yang dicantumkan:
 *  jasa/cetak/desain/topup selalu 0 di sini dan hanya memenuhi ruang. */
function categorySidebar(): string {
  const list = state.products.filter(dilacak);
  const counts = new Map<string, number>();
  for (const p of list) counts.set(p.category_slug, (counts.get(p.category_slug) ?? 0) + 1);
  const kategori = state.categories.filter((c) => (counts.get(c.slug) ?? 0) > 0);

  return `
  <div class="flex h-full flex-col">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Kategori</h2>
    </div>
    <div class="side-list">
      <button type="button" data-cat="all" class="side-item${state.cat === 'all' ? ' is-active' : ''}">
        <span class="min-w-0 flex-1 truncate">Semua</span><span class="side-count">${list.length}</span>
      </button>
      ${kategori
        .map(
          (c) => `
        <button type="button" data-cat="${esc(c.slug)}" class="side-item${state.cat === c.slug ? ' is-active' : ''}">
          <span class="min-w-0 flex-1 truncate" title="${esc(c.name)}">${esc(c.name)}</span>
          <span class="side-count">${counts.get(c.slug) ?? 0}</span>
        </button>`,
        )
        .join('')}
    </div>

    <div class="mt-auto flex items-center justify-end pt-3">
      <span class="text-xs text-gray-400">${kategori.length} kategori</span>
    </div>
  </div>`;
}

/* ---------- Render ---------- */

function ringkasan(): string {
  const list = state.products.filter(dilacak);
  const nHabis = list.filter(habis).length;
  const nKritis = list.filter(kritis).length;
  const nilai = list.reduce((t, p) => t + p.stock * p.avg_cost, 0);

  const kartu = [
    { label: 'Produk dilacak stok', nilai: String(list.length), sub: 'dari seluruh produk' },
    { label: 'Stok habis', nilai: String(nHabis), sub: 'perlu restock', tone: nHabis ? 'danger' : '' },
    { label: 'Stok menipis', nilai: String(nKritis), sub: 'di bawah minimum', tone: nKritis ? 'warn' : '' },
    { label: 'Nilai persediaan', nilai: rp(nilai), sub: 'stok × modal rata-rata', monospace: true },
  ];

  return `<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
    ${kartu
      .map((k) => {
        const warna =
          k.tone === 'danger'
            ? 'text-red-600 dark:text-red-400'
            : k.tone === 'warn'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-gray-900 dark:text-white';
        return `<div class="card">
          <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${k.label}</p>
          <p class="mt-1 text-2xl font-semibold tabular-nums ${warna}${k.monospace ? ' text-lg sm:text-2xl' : ''}">${esc(k.nilai)}</p>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${esc(k.sub)}</p>
        </div>`;
      })
      .join('')}
  </div>`;
}

function toolbar(): string {
  // Hitungan memakai dasar() (ikut kategori + pencarian), bukan seluruh daftar —
  // angka pada tombol harus mencerminkan yang sedang dibuka kasir.
  const list = dasar();
  const jml = (f: Filter) =>
    f === 'habis'
      ? list.filter(habis).length
      : f === 'minus'
        ? list.filter(minus).length
        : f === 'kritis'
          ? list.filter(kritis).length
          : list.length;
  return `
    <div class="card !p-3">
      <div class="toolbar">
        <button type="button" id="side-toggle" class="side-collapse-btn" title="Tampilkan/sembunyikan kategori" aria-label="Tampilkan atau sembunyikan sidebar kategori" aria-expanded="${state.side}">${icon('menu')}</button>
        <div class="search-wrap">
          ${icon('search')}
          <input id="st-q" class="input" type="search" placeholder="Cari nama, SKU, barcode..."
            aria-label="Cari produk" value="${esc(state.q)}" />
        </div>
        ${FILTERS.map(
          (f) =>
            // Sengaja .btn (bukan .chip): ukurannya harus sama dengan kolom
            // pencarian dan tombol Ekspor/Impor di baris yang sama.
            `<button type="button" data-filter="${f.key}" class="btn btn-ghost${state.filter === f.key ? ' is-on' : ''}">${f.label} <span class="tabular-nums ${state.filter === f.key ? 'text-primary' : 'text-gray-400'}">${jml(f.key)}</span></button>`,
        ).join('')}
        <button type="button" id="st-export" class="btn btn-ghost ml-auto" title="Unduh daftar stok yang sedang tampil (ikut filter &amp; pencarian)">${icon('download')}<span class="hidden sm:inline">Ekspor</span></button>
        <button type="button" id="st-import" class="btn btn-ghost" title="Terapkan stok dari CSV — tambah atau ganti">${icon('upload')}<span class="hidden sm:inline">Impor</span></button>
      </div>
    </div>`;
}

function tableCard(): string {
  const list = terlihat();

  let isi: string;
  if (state.loading) {
    isi = `<div class="space-y-2 p-5"><div class="skel"></div><div class="skel w-5/6"></div><div class="skel w-2/3"></div></div>`;
  } else if (!list.length) {
    const pesan = state.error
      ? `Gagal memuat: ${state.error}`
      : state.q || state.filter !== 'semua' || state.cat !== 'all'
        ? 'Tidak ada produk yang cocok dengan filter.'
        : 'Belum ada produk yang melacak stok. Stok hanya dihitung untuk kategori dengan pelacakan stok (ATK, Es krim, Snack, Rokok).';
    isi = `<div class="p-5"><div class="empty">${icon('stock')}<span>${esc(pesan)}</span></div></div>`;
  } else {
    isi = `
      <div class="table-wrap table-scroll">
        <table class="table table-compact">
          <thead>
            <tr>
              <th class="th th-sticky w-12 text-center">No.</th>
              <th class="th th-sticky">Produk</th>
              <th class="th th-sticky">Kategori</th>
              <th class="th th-sticky text-right">Stok</th>
              <th class="th th-sticky text-right">Minimum</th>
              <th class="th th-sticky text-right">Nilai</th>
              <th class="th th-sticky text-right">Aksi</th>
            </tr>
          </thead>
          <tbody id="st-rows">
            ${list
              .map((p, i) => {
                const h = habis(p);
                const k = kritis(p);
                const m = minus(p);
                const badge = m
                  ? `<span class="badge-low">${icon('alert')}<span>${p.stock} minus</span></span>`
                  : h
                    ? `<span class="badge-low">${icon('alert')}<span>habis</span></span>`
                    : k
                      ? `<span class="badge-low">${icon('alert')}<span>${p.stock} / min ${p.min_stock}</span></span>`
                      : `<span class="badge-ok">${icon('check')}<span>${p.stock}</span></span>`;
                const off = p.is_active === 0;
                return `<tr class="tr${off ? ' opacity-60' : ''}">
                  <td class="td w-12 text-center tabular-nums text-gray-400">${i + 1}</td>
                  <td class="td">
                    <div class="cell-strong">${esc(p.name)}${off ? ' <span class="badge-off ml-1">nonaktif</span>' : ''}</div>
                    <div class="cell-sub">${esc(p.sku)} · ${esc(p.unit)}</div>
                  </td>
                  <td class="td">${esc(p.category_name)}</td>
                  <td class="td text-right">${badge}</td>
                  <td class="td text-right tabular-nums">${p.min_stock > 0 ? p.min_stock : '—'}</td>
                  <td class="td text-right tabular-nums">${rp(p.stock * p.avg_cost)}</td>
                  <td class="td">
                    <div class="flex items-center justify-end gap-1">
                      <button type="button" data-hist="${p.id}" class="row-btn"
                        title="Riwayat mutasi" aria-label="Riwayat stok ${esc(p.name)}">${icon('clock')}</button>
                      <button type="button" data-stock="${p.id}" class="row-btn"
                        title="Stok &amp; opname" aria-label="Stok dan opname ${esc(p.name)}">${icon('truck')}</button>
                    </div>
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  // Footer menempel di bawah area scroll (sama seperti halaman Produk), jadi
  // angka jumlah produk tidak pernah ikut ter-scroll keluar layar.
  // `lg:flex-1` WAJIB: card-flush adalah anak dari wrapper column-flex, dan tanpa
  // grow-nya kartu berhenti seukuran isi — footer tidak pernah turun ke dasar
  // area tabel (terbukti: wrap 544px, kartu cuma 419px saat barisnya cuma 7).
  return `<div class="card-flush lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
    ${isi}
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-gray-200 px-4 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
      <span id="st-count" aria-live="polite">${state.loading ? 'memuat data…' : countText()}</span>
      <span class="sm:text-right">Angka stok di sini sama dengan yang dipakai kasir. Ubah nama, harga, atau satuan
        dilakukan di halaman <a class="text-primary underline underline-offset-2" href="#/products">Produk</a>.</span>
    </div>
  </div>`;
}

function paint(): void {
  if (!host) return;
  const cari = host.querySelector<HTMLInputElement>('#st-q');
  const posisi = cari?.selectionStart ?? null;
  const fokus = document.activeElement === cari;

  // Rantai `lg:h-full` + `lg:min-h-0` mengikuti halaman Produk: di desktop (>= lg)
  // halaman TIDAK scroll — hanya tbody tabel yang scroll, jadi ringkasan, toolbar,
  // dan footer jumlah produk tidak pernah keluar layar. Di mobile halaman scroll
  // normal seperti sebelumnya.
  host.innerHTML = `
    <div class="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div class="shrink-0 space-y-4">
        ${ringkasan()}
        ${toolbar()}
      </div>
      <div class="mt-4 flex flex-col items-stretch gap-4 lg:min-h-0 lg:flex-1 lg:flex-row lg:items-stretch">
        <div class="prod-side-wrap shrink-0" data-open="${state.side}">
          <aside class="card w-64 max-w-full !p-3 lg:overflow-y-auto">${categorySidebar()}</aside>
        </div>
        <div class="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">${tableCard()}</div>
      </div>
    </div>`;

  bind();
  // Search harus tetap hidup setiap paint: kehilangan fokus di tengah mengetik
  // membuat karakter berikutnya terbuang diam-diam.
  const baru = host.querySelector<HTMLInputElement>('#st-q');
  if (baru && fokus) {
    baru.focus();
    if (posisi !== null) baru.setSelectionRange(posisi, posisi);
  }
}

function bind(): void {
  if (!host) return;

  const q = host.querySelector<HTMLInputElement>('#st-q');
  q?.addEventListener('input', () => {
    state.q = q.value;
    paint();
  });

  host.querySelectorAll<HTMLElement>('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter as Filter;
      paint();
    }),
  );

  // Preferensi sidebar disimpan di kunci yang sama dengan halaman Produk,
  // jadi sekali disembunyikan di satu halaman, halaman lain ikut.
  host.querySelector('#side-toggle')?.addEventListener('click', () => {
    state.side = !state.side;
    try {
      localStorage.setItem(SIDE_KEY, state.side ? 'shown' : 'hidden');
    } catch {
      /* abaikan */
    }
    // Visibilitas sidebar dikendalikan CSS lewat [data-open] pada .prod-side-wrap
    // (lihat styles.css), BUKAN lewat kehadiran elemennya. Kalau atribut ini tidak
    // diikuti, tombolnya berubah (aria-expanded / is-on) tapi sidebar diam saja —
    // terbukti 2026-09-29: data-open tetap "true" & lebar 256px dua kali klik.
    // Sengaja ubah atribut saja, bukan paint() ulang: supaya animasi CSS jalan
    // dan isian search tidak hilang/fokus tidak pindah (pola sama dgn Produk).
    const wrap = host!.querySelector('.prod-side-wrap');
    if (wrap) wrap.setAttribute('data-open', String(state.side));
    const btn = host!.querySelector('#side-toggle');
    btn?.setAttribute('aria-expanded', String(state.side));
    btn?.classList.toggle('is-on', state.side);
  });

  host.querySelectorAll<HTMLElement>('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      state.cat = b.dataset.cat ?? 'all';
      paint();
    }),
  );

  // Ekspor mengikuti filter + pencarian, sama lingkupnya dengan tabel —
  // "yang saya lihat = yang saya dapat". Sengaja tanpa toast: browser sudah
  // menampilkan unduhannya.
  host.querySelector('#st-export')?.addEventListener('click', () => {
    unduhCSV(csvStok(terlihat()), 'stok-ravaa.csv');
  });
  host.querySelector('#st-import')?.addEventListener('click', () => importStokForm());

  host.querySelectorAll<HTMLElement>('[data-stock]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = state.products.find((x) => x.id === Number(b.dataset.stock));
      if (!p) return;
      // restockForm memanggil callback ini setelah menyimpan, supaya angka di
      // halaman ini ikut terbaru tanpa reload penuh.
      restockForm(p, () => load());
    }),
  );

  host.querySelectorAll<HTMLElement>('[data-hist]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = state.products.find((x) => x.id === Number(b.dataset.hist));
      if (p) riwayatForm(p);
    }),
  );
}

/* ---------- Riwayat stok ---------- */

/** Satu baris `stock_moves` (lihat GET /api/stock-moves). */
type StockMove = {
  id: number;
  created_at: string;
  product_id: number;
  sku: string;
  name: string;
  qty: number; // TANDA: masuk +, keluar - (sale sengaja disimpan negatif)
  reason: 'sale' | 'restock' | 'opname' | 'rusak';
  ref_id: string | null;
  unit_cost: number | null;
  cashier: string | null;
};

const ALASAN: Record<StockMove['reason'], string> = {
  sale: 'Penjualan',
  restock: 'Masuk barang',
  opname: 'Opname',
  rusak: 'Rusak / hilang',
};

/** Waktu dari SQLite `datetime('now')` (UTC) ditampilkan APA ADANYA, tanpa
 *  dikonversi ke zona lokal. Konversi malah menipu: laporan harian juga memakai
 *  `date(created_at)` di sisi server, jadi angka tanggal di riwayat dan di
 *  laporan harus membaca jam yang sama. */
function waktu(s: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s ?? ''));
  if (!m) return String(s ?? '—');
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${Number(m[3])} ${bulan[Number(m[2]) - 1]} ${m[1]} · ${m[4]}:${m[5]}`;
}

/** Keterangan kolom — alasan angka bergerak, plus rujukan bila ada. */
function ket(m: StockMove): string {
  if (m.reason === 'sale') return m.ref_id ? `Nota ${String(m.ref_id).slice(0, 8)}` : 'Penjualan';
  if (m.reason === 'restock') return 'Pembelian masuk';
  if (m.reason === 'opname') return 'Selisih hitung fisik';
  return 'Kerusakan / kehilangan';
}

/** Riwayat mutasi satu produk: masuk/keluar/opname lengkap dengan kasir &
 *  harga beli. Tombol hanya baca — semua tulis stok tetap lewat tombol truk. */
function riwayatForm(p: Product): void {
  openModal({
    title: `Riwayat stok — ${p.name}`,
    wide: true,
    cancelLabel: 'Tutup',
    body: `
      <div class="space-y-3">
        <p class="text-xs text-gray-500 dark:text-gray-400">
          <b>${esc(p.sku)}</b> · ${esc(p.unit)} · stok saat ini
          <b class="tabular-nums">${p.stock}</b>${p.min_stock > 0 ? ` (minimum ${p.min_stock})` : ''}
        </p>
        <div id="rv-body" class="text-xs text-gray-500 dark:text-gray-400">Memuat riwayat…</div>
      </div>`,
    onMount: (api) => {
      api.ok.remove(); // dialog ini hanya baca — cukup satu tombol "Tutup"
      void (async () => {
        const box = api.el.querySelector<HTMLElement>('#rv-body');
        if (!box) return;
        try {
          const res = await apiGet<{ data: StockMove[]; total: number }>(
            `/api/stock-moves?product_id=${p.id}&limit=100`,
          );
          const list = res.data;
          if (!list.length) {
            box.innerHTML = `<div class="empty">${icon('info')}<span>Belum ada mutasi tercatat untuk produk ini.</span></div>`;
            return;
          }
          const rows = list
            .map((s) => {
              const modal = s.unit_cost && s.unit_cost > 0 ? rp(s.unit_cost) : '—';
              // Warna hanya untuk angka BENERAN bergerak: opname tanpa selisih
              // (0) bukan kejadian merah — tidak ada barang yang hilang/masuk.
              const warna =
                s.qty > 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : s.qty < 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-400 dark:text-gray-500';
              return `<tr class="border-t border-gray-200 dark:border-gray-700">
                <td class="whitespace-nowrap py-1.5 pr-3 tabular-nums text-gray-500 dark:text-gray-400">${waktu(s.created_at)}</td>
                <td class="py-1.5 pr-3">${esc(ALASAN[s.reason] ?? s.reason)}</td>
                <td class="py-1.5 pr-3 text-right font-semibold tabular-nums ${warna}">${s.qty > 0 ? '+' : ''}${s.qty}</td>
                <td class="py-1.5 pr-3 text-gray-500 dark:text-gray-400">${esc(ket(s))}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">${modal}</td>
                <td class="py-1.5 text-right text-gray-500 dark:text-gray-400">${esc(s.cashier ?? '—')}</td>
              </tr>`;
            })
            .join('');
          box.innerHTML = `
            <div class="table-wrap table-scroll max-h-[55vh]">
              <table class="table table-compact w-full">
                <thead><tr>
                  <th class="th">Waktu</th><th class="th">Jenis</th>
                  <th class="th text-right">Qty</th><th class="th">Keterangan</th>
                  <th class="th text-right">Harga modal</th><th class="th text-right">Kasir</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            <p class="mt-2 text-gray-500 dark:text-gray-400">
              ${list.length}${res.total > list.length ? ` dari ${res.total}` : ''} mutasi terakhir ·
              qty memakai satuan dasar <b>${esc(p.unit)}</b> · harga modal = harga beli batch
              saat masuk barang, atau rata-rata modal yang berlaku pada mutasi lain.
            </p>`;
        } catch (e) {
          box.innerHTML = `<div class="empty">${icon('alert')}<span>Gagal memuat riwayat: ${esc(errMsg(e))}</span></div>`;
        }
      })();
    },
  });
}

/* ---------- Impor stok ---------- */

/** Dialog impor stok — dua langkah seperti Impor Produk: "Baca & tinjau" dulu,
 *  baru kirim. TIDAK ada endpoint baru: tiap baris ditembak ke
 *  `POST /api/stock-opname`, jadi `version` naik per baris persis seperti saat
 *  dilakukan manual lewat tombol truk — delta sync kasir offline tetap
 *  menarik perubahannya.
 *
 *  Impor HANYA untuk HITUNG FISIK (opname): angka pada kolom Stok MENJADI
 *  stok baru apa adanya, termasuk 0. Masuk barang TIDAK lewat sini, karena
 *  dua alasan yang keduanya bukan selera tapi bukti:
 *    1. Format ekspor (`csvStok`) berisi hitungan ABSOLUT, bukan selisih —
 *       menjumlahkannya kembali (restock) akan MENGANDAKAN stok tiap kali
 *       file hasil unduh diimpor ulang.
 *    2. Berkasnya tidak punya kolom harga beli, dan `stock.ts` tidak pernah
 *       mengirim `harga_beli` — restock begitu tidak akan pernah memperbarui
 *       `avg_cost`, padahal `avg_cost` adalah satu-satunya sumber HPP.
 *  Masuk barang dilakukan per item lewat tombol truk yang sudah punya isian
 *  harga beli. Pratinjau menampilkan "Saat ini" dan "Sesudah" supaya tidak ada
 *  satu pun angka berubah sebelum kasir melihat dampaknya. */
function importStokForm(): void {
  let hasil: BarisStok[] = [];
  /** Pratinjau yang tampil sekarang masih mencerminkan isi textarea. */
  let sudahBaca = false;
  /** Sama seperti di importForm produk: dilekatkan, tidak pernah direset ketikan. */
  let pernahBaca = false;

  type Siap = {
    baris: number; sku: string; p?: Product;
    qty: number | null; sesudah?: number; error: string | null;
  };

  /** Pencarian SKU tidak peka huruf besar/kecil: file bisa dari mesin lain. */
  const cari = (sku: string) =>
    state.products.find((x) => x.sku.toUpperCase() === sku.toUpperCase());

  /** Padukan hasil baca + produk jadi baris siap-tampil. */
  const nilai = (): Siap[] =>
    hasil.map((r) => {
      if (r.error) return { baris: r.baris, sku: r.sku, qty: null, error: r.error };
      const p = cari(r.sku);
      if (!p) return { baris: r.baris, sku: r.sku, qty: r.qty, error: 'SKU tidak ditemukan' };
      if (p.track_stock !== 1)
        return { baris: r.baris, sku: r.sku, p, qty: r.qty, error: 'produk ini tidak melacak stok' };
      const q = r.qty as number;
      // Hitung fisik: 0 sah (semua hilang), negatif tidak pernah.
      if (q < 0) return { baris: r.baris, sku: r.sku, p, qty: q, error: 'jumlah tidak boleh negatif' };
      return { baris: r.baris, sku: r.sku, p, qty: q, sesudah: q, error: null };
    });

  const preview = (): string => {
    const rows = nilai();
    if (!rows.length) return 'Belum dibaca.';
    const siap = rows.filter((r) => !r.error);
    const bad = rows.length - siap.length;
    const baris = rows
      .map(
        (r) => `<tr class="border-t border-gray-200 dark:border-gray-700">
          <td class="py-1 pr-2 tabular-nums">${r.baris}</td>
          <td class="py-1 pr-2 font-mono">${esc(r.sku)}</td>
          <td class="py-1 pr-2">${r.p ? esc(r.p.name) : '—'}</td>
          <td class="py-1 pr-2 tabular-nums">${r.p ? r.p.stock : '—'}</td>
          <td class="py-1 pr-2 tabular-nums">${r.qty ?? '—'}</td>
          <td class="py-1 pr-2 tabular-nums">${r.sesudah ?? '—'}</td>
          <td class="py-1 ${r.error ? 'text-red-500' : 'text-green-600'}">${r.error ? esc(r.error) : 'siap'}</td>
        </tr>`,
      )
      .join('');
    return `<div class="overflow-x-auto"><table class="w-full text-left">
        <thead><tr class="text-gray-400">
          <th class="py-1 pr-2">#</th><th class="py-1 pr-2">SKU</th><th class="py-1 pr-2">Produk</th>
          <th class="py-1 pr-2">Saat ini</th><th class="py-1 pr-2">Angka</th>
          <th class="py-1 pr-2">Sesudah</th><th class="py-1">Status</th>
        </tr></thead>
        <tbody>${baris}</tbody>
      </table></div>
      <p class="mt-2">${siap.length} baris siap dikirim${bad ? `, ${bad} tidak bisa dipakai` : ''}.</p>`;
  };

  openModal({
    title: 'Impor stok',
    okLabel: 'Impor',
    wide: true,
    body: `
      <div class="space-y-3">
        <p class="form-sec">1. Isi data</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          <b>Hitung fisik.</b> Angka pada kolom <b>Stok</b> menjadi stok baru
          apa adanya, termasuk 0; selisihnya tercatat sebagai mutasi.
          Masuk barang tidak lewat sini — kerjakan per item lewat tombol truk
          supaya harganya ikut tercatat.
        </p>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          Baris pertama = judul kolom. Wajib ada <b>SKU</b> dan <b>Stok</b>;
          kolom lain (<b>Nama</b>, atau sisa kolom ekspor Produk) boleh ada dan
          dilewati — jadi hasil unduh halaman Stok maupun halaman Produk bisa
          langsung dipakai. Bisa juga tempel tabel langsung dari Excel.
          <b>Stok minimum</b> sengaja tidak ada di sini: kolom itu tidak pernah
          dibaca proses ini, dan mengubahnya hanya lewat halaman Produk.
        </p>
        <textarea id="st-text" rows="6" class="input font-mono text-xs" placeholder="${HEADER_STOK}" aria-label="Data stok CSV"></textarea>
        <div class="flex flex-wrap items-center gap-2">
          <label class="btn btn-ghost cursor-pointer">
            ${icon('upload')}<span>Pilih file</span>
            <input id="st-file" type="file" accept=".csv,.txt,text/csv,text/plain" class="sr-only" />
          </label>
          <button type="button" id="st-unduh" class="btn btn-ghost">${icon('download')}<span>Unduh template</span></button>
          <button type="button" id="st-read" class="btn btn-primary ml-auto">Baca &amp; tinjau</button>
        </div>

        <p class="form-sec">2. Tinjau lalu tekan Impor</p>
        <div id="st-prev" class="text-xs text-gray-500 dark:text-gray-400">Belum dibaca.</div>
      </div>`,
    onMount: (m) => {
      const ta = m.el.querySelector<HTMLTextAreaElement>('#st-text')!;
      const prev = m.el.querySelector<HTMLElement>('#st-prev')!;
      m.ok.disabled = true;

      const gambar = () => {
        prev.innerHTML = preview();
        const siap = nilai().filter((r) => !r.error).length;
        m.ok.disabled = siap === 0;
        m.ok.textContent = siap ? `Impor ${siap} baris` : 'Impor';
      };

      const baca = () => {
        // Diparse SEKALI: hasilnya disimpan, supaya pratinjau yang tampil
        // selalu berasal dari teks yang sama dengan yang dibaca tombol Impor.
        const res = bacaStok(ta.value);
        hasil = res.baris;
        sudahBaca = true;
        pernahBaca = true;
        const gagalBaca = (pesan: string) => {
          prev.innerHTML = pesan;
          m.ok.disabled = true;
          m.ok.textContent = 'Impor';
        };
        if (!res.ada) {
          gagalBaca('Judul kolom <b>SKU</b> / <b>Stok</b> tidak ditemukan — periksa baris pertama.');
          return;
        }
        if (!res.baris.length) {
          gagalBaca('File terbaca, tapi tidak ada baris data.');
          return;
        }
        gambar();
      };

      m.el.querySelector('#st-read')?.addEventListener('click', baca);

      m.el.querySelector('#st-file')?.addEventListener('change', async (e) => {
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

      // Template = dua baris pertama dari data HIDUP (SKU asli + angka asli),
      // jadi file hasil unduh langsung valid untuk dicoba.
      m.el.querySelector('#st-unduh')?.addEventListener('click', () => {
        unduhCSV(csvStok(state.products.filter(dilacak).slice(0, 2)), 'template-stok-ravaa.csv');
      });

      /** Isi berubah setelah pratinjau = pratinjau basi. Tombol Impor mati
       *  sampai dibaca ulang, supaya yang dikirim selalu sama dengan yang
       *  dilihat kasir (sama guard-nya dengan importForm produk). */
      ta.addEventListener('input', () => {
        sudahBaca = false;
        m.ok.disabled = true;
        m.ok.textContent = 'Impor';
        prev.innerHTML = pernahBaca
          ? 'Isi sudah berubah — tekan <b>Baca &amp; tinjau</b> lagi.'
          : 'Belum dibaca.';
      });

      m.ok.addEventListener('click', async () => {
        if (!sudahBaca) return;
        const rows = nilai().filter((r) => !r.error);
        if (!rows.length) return;
        m.ok.disabled = true;
        let ok = 0;
        let gagal = 0;
        // Berurutan sengaja: 1-2 kasir, dan jalur yang sama dengan tombol truk.
        for (const r of rows) {
          try {
            await apiPost('/api/stock-opname', { product_id: r.p!.id, qty_fisik: r.qty });
            ok++;
          } catch {
            gagal++;
          }
        }
        toast(
          `Impor stok selesai: ${ok} baris${gagal ? `, ${gagal} gagal` : ''}`,
          gagal ? 'error' : 'success',
        );
        m.close();
        await load();
      });
    },
  });
}

/* ---------- Muat data ---------- */

async function load(): Promise<void> {
  try {
    const res = await apiGet<{ data: Product[] }>('/api/products');
    state.products = res.data;
    state.error = '';
  } catch (e) {
    // Offline / server mati: cache IndexedDB supaya halaman tetap berguna.
    if (!state.products.length) {
      try {
        state.products = await getCachedProducts();
      } catch {
        /* cache juga gagal -> biarkan pesan error tampil */
      }
    }
    state.error = errMsg(e);
    if (state.error) toast(`Stok: ${state.error}`, 'warning');
  }

  // Master kategori untuk sidebar. SELALU ditarik ulang tiap kali halaman di-mount
  // — sebelumnya dijaga `if (!state.categories.length)`, dan itu membuat kategori
  // yang baru dibuat/diedit di halaman Produk TIDAK pernah muncul selama sesi SPA
  // masih hidup (produknya sendiri ikut kehitung karena selalu di-fetch, jadi
  // angka "Semua" naik tapi nama kategorinya hilang; baru benar setelah reload
  // penuh). Halaman Produk sudah memakai pola selalu-fetch (loadCategories), jadi
  // ini juga soal konsistensi antar-halaman.
  //
  // Gagal pun halaman tetap jalan: bila DAFTAR LAMA MASIH ADA, biarkan (lebih
  // lengkap daripada fallback); fallback turunan dari produk hanya dipakai saat
  // belum pernah berhasil sekali pun (mis. buka Stok langsung saat offline).
  try {
    const c = await apiGet<{ data: Category[] }>('/api/categories');
    state.categories = c.data;
  } catch {
    if (!state.categories.length) {
      const seen = new Map<string, Category>();
      for (const p of state.products) {
        if (!seen.has(p.category_slug))
          seen.set(p.category_slug, {
            id: p.category_id,
            slug: p.category_slug,
            name: p.category_name,
            track_stock: p.track_stock,
            sort: 0,
          });
      }
      state.categories = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'id'));
    }
  }

  state.loading = false;
  paint();
}

export async function mountStockPage(el: HTMLElement): Promise<void> {
  host = el;
  // Baca ulang preferensi sidebar tiap mount. state.side diinisialisasi hanya
  // SEKALI saat boot modul, sedangkan kuncinya (SIDE_KEY) berbagi dengan
  // halaman Produk — tanpa baris ini, menyembunyikan sidebar di satu halaman
  // baru terasa di halaman lain setelah reload penuh, padahal komentar di bind()
  // menjanjikan "halaman lain ikut".
  state.side = readSide();
  state.loading = true;
  state.error = '';
  paint();

  // Gambar cache dulu (instan, jalan juga saat offline), lalu tarik server.
  try {
    const cached = await getCachedProducts();
    if (cached.length) {
      state.products = cached;
      paint();
    }
  } catch {
    /* IndexedDB tidak siap -> tunggu server */
  }
  await load();
}

export function unmountStockPage(): void {
  host = null;
}
