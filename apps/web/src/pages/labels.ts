// Halaman Label harga (#/labels) — cetak label harga 32 kolom.
//
// Kenapa halaman sendiri (keputusan user 2026-09-29): dulu tombol "Label" ada di
// toolbar Produk dan membuka dialog sempit — kasir yang mencetak label rak
// Minuman harus menebak isi cetakannya dari daftar nama saja. Di sini layar
// dibagi: ALAT kiri 20% (cari, kategori, pilih, status print-agent, tombol
// cetak), PRATINJAU kanan 80% (kartu label per produk persis seperti yang akan
// keluar printer). Tombol "Label" lama di halaman Produk sudah dipindah ke sini.
//
// TIDAK ada endpoint baru: produk & kategori dibaca lewat endpoint yang sama
// dengan halaman Stok (`GET /api/products`, `GET /api/categories`), pencetakan
// lewat print-agent (`kirimPrint` -> POST :9100/print, lihat escpos.ts).

import { apiGet, HttpError } from '../api';
import { getCachedProducts, type Category, type Product } from '../store';
import { COLS, gabungLabel, kirimPrint, teksLabel, urlAgent, type ProdukLabel } from '../escpos';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';

const rp = (n: number) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;

/** Produk yang bisa dicetak labelnya. Sama aturan dengan tombol Label lama:
 *  harga dinamis tidak punya angka pasti, dan harga 0 berarti belum diisi. */
const layak = (p: Product) => p.price_dynamic !== 1 && p.price > 0;

const keLabel = (p: Product): ProdukLabel => ({
  name: p.name, sku: p.sku, price: p.price, unit: p.unit, barcode: p.barcode,
});

const state = {
  products: [] as Product[],
  categories: [] as Category[],
  loading: true,
  error: '',
  q: '',
  /** 'all' = tanpa saring kategori. */
  cat: 'all',
  /** id produk yang DICENTANG. Semua produk layak ikut tercentang saat mount —
   *  sama perilaku dengan tombol Label lama: buka halaman -> langsung bisa cetak
   *  semua. Kasir memperkecil lewat kolom cari lalu "Pilih yang tampil". */
  pilih: new Set<number>(),
  /** Teks status print-agent + apakah boleh cetak. */
  agentTeks: 'cek print-agent…',
  agentOk: false,
  cetak: false,
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

/** Semua yang dicentang — TIDAK dibatasi filter sekarang, supaya sisa pilihan
 *  dari pencarian sebelumnya tidak hilang diam-diam begitu kolom cari dikosongkan. */
function dipilih(): Product[] {
  return state.products.filter(layak).filter((p) => state.pilih.has(p.id));
}

/* ---------- Render ---------- */

function alatHtml(): string {
  const semuaLayak = state.products.filter(layak);
  const dilewati = state.products.length - semuaLayak.length;
  const tampilLayak = tampil();
  const n = dipilih().length;
  // Pilihan yang tidak sedang terlihat = hasil pencarian/kategori sebelumnya.
  // Harus dilaporkan: kalau tidak, kasir menekan "Cetak 40 label" padahal yang
  // terlihat cuma 3 baris.
  const diLuar = n - tampilLayak.filter((p) => state.pilih.has(p.id)).length;

  return `
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Alat cetak</h2>
      <span class="chip">${COLS} kolom</span>
    </div>

    <div class="search-wrap">
      ${icon('search')}
      <input id="lb-q" class="input input-sm" type="search" placeholder="Cari produk…"
        aria-label="Cari nama, SKU, atau barcode" value="${esc(state.q)}" />
    </div>

    <div>
      <label class="label" for="lb-cat">Kategori</label>
      <select id="lb-cat" class="input input-sm">
        <option value="all"${state.cat === 'all' ? ' selected' : ''}>Semua kategori</option>
        ${state.categories
          .map((c) => `<option value="${esc(c.slug)}"${state.cat === c.slug ? ' selected' : ''}>${esc(c.name)}</option>`)
          .join('')}
      </select>
    </div>

    <div class="flex flex-wrap gap-2">
      <button type="button" id="lb-pilih" class="btn btn-ghost">Pilih yang tampil (${tampilLayak.length})</button>
      <button type="button" id="lb-kosong" class="btn btn-ghost">Kosongkan</button>
    </div>

    <div class="rounded-lg bg-gray-50 p-2.5 text-xs dark:bg-gray-800/60">
      <p class="text-gray-500 dark:text-gray-400">Label terpilih</p>
      <p class="text-lg font-semibold tabular-nums text-gray-900 dark:text-white">${n}</p>
      ${diLuar > 0 ? `<p class="mt-0.5 text-amber-600 dark:text-amber-400">${diLuar} di luar filter sekarang (ikut tercetak)</p>` : ''}
    </div>

    <p id="lb-agent" class="text-xs ${state.agentOk ? 'text-gray-500 dark:text-gray-400' : 'font-semibold text-red-600 dark:text-red-400'}">${esc(state.agentTeks)}</p>

    <button type="button" id="lb-print" class="btn btn-primary w-full" ${state.agentOk && n && !state.cetak ? '' : 'disabled'}>
      ${icon('print')}<span>${state.cetak ? 'Mengirim…' : `Cetak ${n} label`}</span>
    </button>

    <p class="text-xs text-gray-500 dark:text-gray-400">
      Label memakai nama, SKU, harga, satuan, dan barcode produk. Produk harga
      dinamis atau belum berharga tidak dicetak${dilewati ? ` — <b>${dilewati}</b> dilewati` : ''}.
    </p>`;
}

function gridHtml(): string {
  const list = tampil();
  if (state.loading) {
    return `<div class="space-y-3 p-4"><div class="skel"></div><div class="skel w-5/6"></div><div class="skel w-2/3"></div></div>`;
  }
  if (state.error && !state.products.length) {
    return `<div class="empty">${icon('alert')}<span>Gagal memuat produk: ${esc(state.error)}</span></div>`;
  }
  if (!list.length) {
    return `<div class="empty">${icon('info')}<span>${
      state.q || state.cat !== 'all'
        ? 'Tidak ada produk yang cocok dengan filter.'
        : 'Belum ada produk berharga tetap untuk dicetak labelnya.'
    }</span></div>`;
  }
  return `<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
    ${list
      .map((p) => {
        const on = state.pilih.has(p.id);
        return `<label class="flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition ${
          on ? 'border-primary bg-primary-soft/40 dark:bg-primary/10' : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
        }" data-kartu="${p.id}">
          <input type="checkbox" data-pick="${p.id}" ${on ? 'checked' : ''}
            class="mt-1 size-4 shrink-0 accent-current" aria-label="Cetak label ${esc(p.name)}" />
          <span class="min-w-0 flex-1">
            <span class="cell-strong block truncate" title="${esc(p.name)}">${esc(p.name)}</span>
            <span class="cell-sub block">${esc(p.sku)} · ${rp(p.price)} / ${esc(p.unit)}</span>
            <pre class="mt-1.5 overflow-x-auto rounded bg-gray-100 p-1.5 font-mono text-[10px] leading-tight dark:bg-gray-800">${esc(teksLabel(keLabel(p)).join('\n'))}</pre>
          </span>
        </label>`;
      })
      .join('')}
  </div>`;
}

function paint(): void {
  if (!host) return;
  const cari = host.querySelector<HTMLInputElement>('#lb-q');
  const posisi = cari?.selectionStart ?? null;
  const fokus = document.activeElement === cari;

  const n = dipilih().length;
  host.innerHTML = `
    <div class="flex flex-col gap-4 lg:h-full lg:min-h-0 lg:flex-row lg:items-stretch">
      <aside class="card w-full shrink-0 space-y-3 !p-3 lg:w-[20%] lg:min-w-[228px] lg:max-w-[320px] lg:self-start lg:overflow-y-auto">
        ${alatHtml()}
      </aside>
      <div class="card-flush flex min-h-0 flex-1 flex-col">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <span class="text-sm font-semibold text-gray-900 dark:text-white">
            Pratinjau label <span class="text-gray-400">(${COLS} kolom)</span>
          </span>
          <span class="text-xs text-gray-500 dark:text-gray-400" id="lb-jml">
            ${tampil().length} produk ditampilkan · ${n} terpilih
          </span>
        </div>
        <div class="table-scroll min-h-0 flex-1 p-3">${gridHtml()}</div>
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-gray-200 px-4 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <span>Centang label yang mau dicetak, lalu tekan Cetak di kiri.</span>
          <span>Ukuran label mengikuti <b>${COLS} kolom</b> printer 58 mm.</span>
        </div>
      </div>
    </div>`;

  bind();
  const baru = host.querySelector<HTMLInputElement>('#lb-q');
  if (baru && fokus) {
    baru.focus();
    if (posisi !== null) baru.setSelectionRange(posisi, posisi);
  }
}

/** Perbarui hitungan + tombol cetak TANPA merender ulang grid: centang/membatalkan
 *  puluhan label sambil repaint seluruh kolom kanan membuat guliran melompat. */
function sync(): void {
  if (!host) return;
  const n = dipilih().length;
  const jml = host.querySelector('#lb-jml');
  if (jml) jml.textContent = `${tampil().length} produk ditampilkan · ${n} terpilih`;
  const btn = host.querySelector<HTMLButtonElement>('#lb-print');
  if (btn) {
    btn.disabled = !state.agentOk || n === 0 || state.cetak;
    const span = btn.querySelector('span');
    if (span) span.textContent = state.cetak ? 'Mengirim…' : `Cetak ${n} label`;
  }
  // Baris "N di luar filter sekarang" ikut berubah — ada di dalam alatHtml(),
  // jadi cukup gambar ulang kolom alat saja (bukan seluruh halaman).
  // JANGAN lakukan bila kasir sedang mengetik di kolom cari: node input-nya
  // ikut terganti dan huruf berikutnya terbuang diam-diam.
  const alat = host.querySelector('aside');
  if (alat && !alat.contains(document.activeElement)) {
    alat.innerHTML = alatHtml();
    bindAlat();
  }
}

/* ---------- Aksi ---------- */

function bindAlat(): void {
  if (!host) return;

  host.querySelector<HTMLInputElement>('#lb-q')?.addEventListener('input', (e) => {
    state.q = (e.target as HTMLInputElement).value;
    paint();
  });

  host.querySelector<HTMLSelectElement>('#lb-cat')?.addEventListener('change', (e) => {
    state.cat = (e.target as HTMLSelectElement).value;
    paint();
  });

  host.querySelector('#lb-pilih')?.addEventListener('click', () => {
    for (const p of tampil()) state.pilih.add(p.id);
    paint();
  });

  host.querySelector('#lb-kosong')?.addEventListener('click', () => {
    state.pilih.clear();
    paint();
  });

  host.querySelector('#lb-print')?.addEventListener('click', () => void cetak());
}

function bind(): void {
  if (!host) return;
  bindAlat();

  // Centang per kartu: cukup ubah state + hitungan — jangan paint() ulang,
  // karena paint() mengganti seluruh grid dan guliran kanan lompat ke atas.
  host.querySelectorAll<HTMLInputElement>('[data-pick]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.pick);
      if (cb.checked) state.pilih.add(id);
      else state.pilih.delete(id);
      const kartu = cb.closest<HTMLElement>('[data-kartu]');
      if (kartu) {
        kartu.classList.toggle('border-primary', cb.checked);
        kartu.classList.toggle('bg-primary-soft/40', cb.checked);
        kartu.classList.toggle('dark:bg-primary/10', cb.checked);
        kartu.classList.toggle('border-gray-200', !cb.checked);
        kartu.classList.toggle('dark:border-gray-700', !cb.checked);
      }
      sync();
    });
  });
}

/** Kirim label terpilih ke print-agent. Gagal cetak TIDAK menghapus pilihan —
 *  kasir tinggal memperbaiki agent lalu menekan Cetak lagi. */
async function cetak(): Promise<void> {
  const layakDipilih = dipilih();
  if (!layakDipilih.length || state.cetak) return;
  state.cetak = true;
  sync();
  try {
    const via = await kirimPrint(gabungLabel(layakDipilih.map(keLabel)));
    toast(`${layakDipilih.length} label dikirim${via ? ` · ${via}` : ''}`, 'success');
  } catch (e) {
    toast(`Gagal cetak: ${errMsg(e)}`, 'error');
  } finally {
    state.cetak = false;
    sync();
  }
}

/** Status print-agent: kasir harus tahu SEBELUM menekan Cetak apakah outputnya
 *  masuk printer atau justru agent tidak jalan (pola sama dengan dialog lama). */
async function cekAgent(): Promise<void> {
  try {
    const r = await fetch(`${urlAgent()}/health`);
    const j = (await r.json()) as { printer?: string };
    state.agentTeks = j.printer
      ? `print-agent siap · printer ${j.printer}`
      : 'print-agent siap · printer belum ketemu (output jadi file)';
    state.agentOk = true;
  } catch {
    state.agentTeks = `print-agent TIDAK terjangkau di ${urlAgent()} — jalankan: npm run dev:agent`;
    state.agentOk = false;
  }
  sync();
}

/* ---------- Muat data ---------- */

async function load(): Promise<void> {
  try {
    const res = await apiGet<{ data: Product[] }>('/api/products');
    state.products = res.data;
    state.error = '';
    // Pilihan awal = semua produk layak (lihat komentar state.pilih).
    if (!state.pilih.size) for (const p of state.products) if (layak(p)) state.pilih.add(p.id);
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

  try {
    const c = await apiGet<{ data: Category[] }>('/api/categories');
    state.categories = c.data;
  } catch {
    /* kategori hanya untuk dropdown — daftar label tetap jalan tanpanya */
  }

  state.loading = false;
  paint();
}

export async function mountLabelsPage(el: HTMLElement): Promise<void> {
  host = el;
  state.loading = true;
  state.error = '';
  paint();

  // Cache dulu (instan, jalan juga saat offline), lalu tarik server.
  try {
    const cached = await getCachedProducts();
    if (cached.length) {
      state.products = cached;
      if (!state.pilih.size) for (const p of state.products) if (layak(p)) state.pilih.add(p.id);
      paint();
    }
  } catch {
    /* IndexedDB tidak siap -> tunggu server */
  }
  await Promise.all([load(), cekAgent()]);
}

export function unmountLabelsPage(): void {
  host = null;
}
