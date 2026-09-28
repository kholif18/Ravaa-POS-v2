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
// Riwayat restock butuh baca `stock_moves` — BELUM ada endpoint-nya, jadi
// halaman ini sengaja tidak menjanjikan riwayat.

import { apiGet, HttpError } from '../api';
import { getCachedProducts, type Product } from '../store';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { restockForm } from './products';

const rp = (n: number) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;

type Filter = 'semua' | 'kritis' | 'habis';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'semua', label: 'Semua' },
  { key: 'kritis', label: 'Stok menipis' },
  { key: 'habis', label: 'Stok habis' },
];

const state = {
  products: [] as Product[],
  loading: true,
  error: '',
  filter: 'semua' as Filter,
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

function urutan(p: Product): number {
  if (habis(p)) return 0;
  if (kritis(p)) return 1;
  return 2;
}

function terlihat(): Product[] {
  const q = state.q.trim().toLowerCase();
  const kata = q ? q.split(/\s+/) : [];
  return state.products
    .filter(dilacak)
    .filter((p) =>
      state.filter === 'habis' ? habis(p) : state.filter === 'kritis' ? kritis(p) || habis(p) : true,
    )
    .filter((p) => {
      if (!kata.length) return true;
      // SEMUA kata harus cocok — konsisten dengan pencarian Produk & POS.
      const hay = `${p.name} ${p.sku} ${p.barcode ?? ''} ${p.category_name}`.toLowerCase();
      return kata.every((k) => hay.includes(k));
    })
    .sort((a, b) => urutan(a) - urutan(b) || a.name.localeCompare(b.name, 'id'));
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
  const list = state.products.filter(dilacak);
  const jml = (f: Filter) =>
    f === 'habis' ? list.filter(habis).length : f === 'kritis' ? list.filter(kritis).length : list.length;
  return `
    <div class="card flex flex-wrap items-center gap-2">
      <div class="relative min-w-[180px] flex-1">
        <input id="st-q" class="input pl-9" type="search" placeholder="Cari nama, SKU, barcode..."
          aria-label="Cari produk" value="${esc(state.q)}" />
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
      </div>
      ${FILTERS.map(
        (f) =>
          `<button type="button" data-filter="${f.key}" class="chip ${
            state.filter === f.key ? '!border-primary !text-primary' : ''
          }">${f.label} <span class="tabular-nums text-gray-400">${jml(f.key)}</span></button>`,
      ).join('')}
    </div>`;
}

function tabel(): string {
  const list = terlihat();

  if (state.loading) {
    return `<div class="card"><div class="space-y-2"><div class="skel"></div><div class="skel w-5/6"></div><div class="skel w-2/3"></div></div></div>`;
  }

  if (!list.length) {
    const pesan = state.error
      ? `Gagal memuat: ${state.error}`
      : state.q || state.filter !== 'semua'
        ? 'Tidak ada produk yang cocok dengan filter.'
        : 'Belum ada produk yang melacak stok. Stok hanya dihitung untuk kategori dengan pelacakan stok (ATK, Es krim, Snack, Rokok).';
    return `<div class="card"><div class="empty">${icon('stock')}<span>${esc(pesan)}</span></div></div>`;
  }

  return `<div class="card-flush overflow-x-auto">
    <table class="table">
      <thead>
        <tr>
          <th class="th">Produk</th>
          <th class="th">Kategori</th>
          <th class="th text-right">Stok</th>
          <th class="th text-right">Minimum</th>
          <th class="th text-right">Nilai</th>
          <th class="th text-right">Aksi</th>
        </tr>
      </thead>
      <tbody>
        ${list
          .map((p) => {
            const h = habis(p);
            const k = kritis(p);
            const badge = h
              ? `<span class="badge-low">${icon('alert')}<span>habis</span></span>`
              : k
                ? `<span class="badge-low">${icon('alert')}<span>${p.stock} / min ${p.min_stock}</span></span>`
                : `<span class="badge-ok">${icon('check')}<span>${p.stock}</span></span>`;
            const off = p.is_active === 0;
            return `<tr class="tr${off ? ' opacity-60' : ''}">
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

function paint(): void {
  if (!host) return;
  const cari = host.querySelector<HTMLInputElement>('#st-q');
  const posisi = cari?.selectionStart ?? null;
  const fokus = document.activeElement === cari;

  host.innerHTML = `
    <div class="space-y-4">
      ${ringkasan()}
      ${toolbar()}
      ${tabel()}
      <p class="text-xs text-gray-500 dark:text-gray-400">
        Angka stok di sini sama dengan yang dipakai kasir. Ubah nama, harga, atau satuan
        dilakukan di halaman <a class="text-primary underline underline-offset-2" href="#/products">Produk</a>.
      </p>
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

  host.querySelectorAll<HTMLElement>('[data-stock]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = state.products.find((x) => x.id === Number(b.dataset.stock));
      if (!p) return;
      // restockForm memanggil callback ini setelah menyimpan, supaya angka di
      // halaman ini ikut terbaru tanpa reload penuh.
      restockForm(p, () => load());
    }),
  );
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
  state.loading = false;
  paint();
}

export async function mountStockPage(el: HTMLElement): Promise<void> {
  host = el;
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
