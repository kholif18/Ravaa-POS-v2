// Halaman Riwayat transaksi (menu sidebar "Riwayat transaksi").
//
// Satu linimasa per hari: penjualan (POST /api/sales) digabung dengan
// topup/tarik (POST /api/topups), diurutkan waktu terbaru dulu, dan tiap baris
// bisa dibuka untuk melihat isinya — item nota + rincian pembayaran untuk
// penjualan, atau nominal/admin/nomor untuk topup.
//
// Aturan hari = aturan laporan harian: pemilih tanggal memakai hari UTC
// (new Date().toISOString().slice(0,10)) dan server memfilter
// `date(created_at) = date(?)` — filter yang sama dipakai /api/reports/daily,
// jadi ringkasan di atas tabel diambil dari laporan itu sendiri sehingga angka
// di sini TIDAK MUNGKIN berbeda dengan halaman Laporan.
//
// Tidak ada pembatalan/refund di sini: riwayat bersifat catatan. Koreksi nota
// lewat jalur yang sama seperti sebelumnya (stok opname + transaksi baru).

import { apiGet, HttpError } from '../api';
import { icon } from '../ui/icons';
import { jam, waktu } from '../ui/waktu';
import { rp } from '../escpos';

/* ---------- tipe ---------- */

type SaleRow = {
  id: string; shift_id: number | null; created_at: string; pay_method: string;
  subtotal: number; discount: number; total: number; cash_in: number; change: number;
  cashier: string; n_items: number;
};

type TopupRow = {
  id: string; shift_id: number | null; created_at: string; kind: 'topup' | 'tarik';
  provider: string; nomor: string; nominal: number; admin: number; total: number;
  pay_method: string; cashier: string;
};

type ItemRow = {
  id: number; sale_id: string; product_id: number | null; name: string;
  qty: number; price: number; amount: number; discount: number; unit: string;
};

type Ringkas = {
  date: string;
  sales: { n: number; omzet: number; diskon: number };
  topup: { kind: string; n: number; nominal: number; admin: number }[];
};

/** Baris linimasa hasil gabungan dua sumber (satu hari, maks 200 per sumber). */
type Baris = {
  key: string;                 // 'sale:<id>' | 'topup:<id>'
  created_at: string;
  jenis: 'penjualan' | 'topup' | 'tarik';
  s?: SaleRow;
  t?: TopupRow;
};

/* ---------- state ---------- */

const LIMIT = 200; // batas atas per sumber (limit API maks juga 200)

const state = {
  date: hariIni(),
  sales: [] as SaleRow[],
  topups: [] as TopupRow[],
  totalSales: 0,
  totalTopup: 0,
  ringkas: null as Ringkas | null,
  loading: true,
  error: '',
  buka: '',
  det: null as { key: string; items: ItemRow[] } | null,
  detMuat: false,
  detErr: '',
};

let host: HTMLElement | null = null;

/* ---------- util ---------- */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/** Hari UTC hari ini — sama persis dengan default `date` di server. */
function hariIni(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Geser satu hari (prev/next) memakai aritmetika UTC supaya tidak kena
 *  pergantian zona waktu yang memajukan/mundurkan tanggal. */
function geser(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return hariIni();
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function tglPanjang(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const METODE: Record<string, string> = { tunai: 'Tunai', qris: 'QRIS', transfer: 'Transfer' };
const metode = (m: string) => METODE[m] ?? m;

const LAYANAN: Record<string, string> = {
  'E-WALLET': 'Isi e-wallet', 'PULSA': 'Pulsa', 'PLN-TOKEN': 'PLN token', 'PLN-BILL': 'PLN tagihan',
  'TARIK-EWALLET': 'Tarik e-wallet', 'TARIK-BANK': 'Tarik bank',
};
const layanan = (p: string) => LAYANAN[p] ?? p;

/* ---------- render ---------- */

function kepala(): string {
  const r = state.ringkas;
  const nTopup = r ? r.topup.reduce((a, k) => a + k.n, 0) : 0;
  const nominal = r ? r.topup.reduce((a, k) => a + k.nominal, 0) : 0;
  const admin = r ? r.topup.reduce((a, k) => a + k.admin, 0) : 0;
  const hariIniKah = state.date === hariIni();
  return `
  <div class="card">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-h="prev" class="row-btn" title="Hari sebelumnya" aria-label="Hari sebelumnya">${icon('chevL')}</button>
        <input id="h-date" type="date" class="input input-sm !w-44" value="${esc(state.date)}" aria-label="Pilih tanggal riwayat" />
        <button type="button" data-h="next" class="row-btn" title="Hari berikutnya" aria-label="Hari berikutnya">${icon('chevR')}</button>
        ${hariIniKah ? '' : `<button type="button" id="h-today" class="chip">${icon('calendar')}<span>Hari ini</span></button>`}
        <span class="chip ml-1">${icon('calendar')}<span>${esc(tglPanjang(state.date))}</span></span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="chip" title="Sesuai angka halaman Laporan untuk tanggal yang sama">
          ${icon('receipt')}<span>${r ? r.sales.n : 0} penjualan · ${rp(r ? r.sales.omzet : 0)} omzet</span>
        </span>
        <span class="chip" title="Nominal topup/tarik (admin di luar omzet, lihat Laporan)">
          ${icon('wallet')}<span>${nTopup} topup/tarik · ${rp(nominal)}${admin ? ` + ${rp(admin)} admin` : ''}</span>
        </span>
      </div>
    </div>
  </div>`;
}

function badge(jenis: Baris['jenis']): string {
  if (jenis === 'penjualan') return `<span class="chip !border-primary/40 !text-primary dark:!text-primary">${icon('pos')}<span>Penjualan</span></span>`;
  if (jenis === 'topup') return `<span class="chip !border-emerald-500/40 !text-emerald-700 dark:!text-emerald-400">${icon('wallet')}<span>Topup</span></span>`;
  return `<span class="chip !border-amber-500/40 !text-amber-700 dark:!text-amber-400">${icon('download')}<span>Tarik</span></span>`;
}

function baris(): Baris[] {
  const s: Baris[] = state.sales.map((x) => ({ key: `sale:${x.id}`, created_at: x.created_at, jenis: 'penjualan' as const, s: x }));
  const t: Baris[] = state.topups.map((x) => ({
    key: `topup:${x.id}`, created_at: x.created_at, jenis: x.kind === 'tarik' ? 'tarik' as const : 'topup' as const, t: x,
  }));
  // Kriteria sama dengan kedua endpoint: waktu terbaru dulu; saat detiknya sama
  // (banyak nota tercipta dalam satu detik) penjualan didahulukan supaya urutan
  // selalu stabil antar-render.
  return [...s, ...t].sort((a, b) =>
    a.created_at === b.created_at
      ? (a.s ? -1 : 1) - (b.s ? -1 : 1)
      : a.created_at < b.created_at ? 1 : -1,
  );
}

function detailJual(s: SaleRow): string {
  if (state.detMuat) return `<div class="card"><div class="skel h-6 w-64"></div></div>`;
  if (state.detErr) return `<div class="card"><div class="empty">${icon('alert')}<span>${esc(state.detErr)}</span></div></div>`;
  const items = state.det?.key === `sale:${s.id}` ? state.det.items : [];
  const discBaris = Math.max(0, s.subtotal - s.discount - s.total); // terturun dari kolom (lihat insertSale)
  const rows = items
    .map((it) => {
      const bersih = it.amount - it.discount;
      return `
      <div class="flex items-start justify-between gap-3 border-b border-gray-100 py-2 last:border-0 dark:border-gray-800">
        <div class="min-w-0">
          <div class="text-sm font-medium text-gray-900 dark:text-white">${esc(it.name)}</div>
          <div class="cell-sub">${it.qty}${it.unit ? ` ${esc(it.unit)}` : ''} × ${rp(it.price)}${
            it.discount > 0 ? ` · <span class="text-amber-600 dark:text-amber-400">diskon ${rp(it.discount)}</span>` : ''
          }${it.product_id === null ? ' · item manual' : ''}</div>
        </div>
        <div class="shrink-0 text-right tabular-nums">
          ${it.discount > 0 ? `<div class="text-xs text-gray-400 line-through">${rp(it.amount)}</div>` : ''}
          <div class="text-sm font-semibold text-gray-900 dark:text-white">${rp(bersih)}</div>
        </div>
      </div>`;
    })
    .join('');
  const ket = (l: string, v: string, kuat = false) => `
    <div class="flex items-baseline justify-between gap-3 py-1">
      <span class="text-xs text-gray-500 dark:text-gray-400">${l}</span>
      <span class="text-sm tabular-nums ${kuat ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}">${v}</span>
    </div>`;
  return `
  <div class="grid gap-3 lg:grid-cols-[1fr_280px]">
    <div class="card">
      <h3 class="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Item nota</h3>
      ${items.length ? rows : `<div class="empty">Tidak ada baris item pada nota ini.</div>`}
    </div>
    <div class="card">
      <h3 class="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Pembayaran</h3>
      ${ket('Subtotal', rp(s.subtotal))}
      ${discBaris > 0 ? ket('Diskon baris', `− ${rp(discBaris)}`) : ''}
      ${s.discount > 0 ? ket('Diskon transaksi', `− ${rp(s.discount)}`) : ''}
      <div class="my-1 border-t border-gray-200 dark:border-gray-700"></div>
      ${ket('Total', rp(s.total), true)}
      ${ket('Metode', metode(s.pay_method))}
      ${s.pay_method === 'tunai' ? ket('Uang diterima', rp(s.cash_in)) + ket('Kembali', rp(s.change)) : ''}
      ${ket('Kasir', esc(s.cashier))}
      ${ket('Shift', s.shift_id ? `#${s.shift_id}` : '—')}
      <div class="mt-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
        Nota ${esc(s.id)}<br />${esc(waktu(s.created_at))}
      </div>
    </div>
  </div>`;
}

function detailTopup(t: TopupRow): string {
  const ket = (l: string, v: string, kuat = false) => `
    <div class="flex items-baseline justify-between gap-3 py-1">
      <span class="text-xs text-gray-500 dark:text-gray-400">${l}</span>
      <span class="text-sm tabular-nums ${kuat ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}">${v}</span>
    </div>`;
  return `
  <div class="card">
    <div class="grid gap-x-8 sm:grid-cols-2">
      <div>
        <h3 class="mb-1 text-sm font-semibold text-gray-900 dark:text-white">${t.kind === 'tarik' ? 'Penarikan' : 'Pengisian'}</h3>
        ${ket('Jenis layanan', esc(layanan(t.provider)))}
        ${ket(t.kind === 'tarik' ? 'Ke rekening' : 'Nomor tujuan', esc(t.nomor))}
        ${ket('Metode', metode(t.pay_method))}
      </div>
      <div>
        <h3 class="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Nilai</h3>
        ${ket('Nominal', rp(t.nominal))}
        ${ket('Admin', rp(t.admin))}
        ${ket('Total dibayar', rp(t.total), true)}
        ${ket('Kasir', esc(t.cashier)) + ket('Shift', t.shift_id ? `#${t.shift_id}` : '—')}
      </div>
    </div>
    <div class="mt-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
      Transaksi ${esc(t.id)}<br />${esc(waktu(t.created_at))} · nominal = mutasi modal, admin = pendapatan jasa
    </div>
  </div>`;
}

function renderTabel(): string {
  if (state.loading) {
    return `<div class="space-y-2">
      <div class="card"><div class="skel h-6 w-72"></div></div>
      <div class="card"><div class="skel h-6 w-96"></div></div>
      <div class="card"><div class="skel h-6 w-64"></div></div>
    </div>`;
  }
  if (state.error) {
    return `<div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat riwayat: ${esc(state.error)}</span></div></div>`;
  }

  const rows = baris();
  if (!rows.length) {
    return `<div class="card">
      <div class="empty">${icon('receipt')}
        <span>Belum ada transaksi pada ${esc(tglPanjang(state.date))}. Pilih hari lain, atau mulai jualan di layar Kasir.</span>
      </div>
    </div>`;
  }

  const html = rows
    .map((b) => {
      const terbuka = state.buka === b.key;
      const waktuCell = b.s ? jam(b.s.created_at) : jam(b.t!.created_at);
      const keterangan = b.s
        ? `<div class="cell-strong">${b.s.n_items} item · Nota ${esc(b.s.id.slice(0, 8))}</div>
           <div class="cell-sub">Kasir ${esc(b.s.cashier)}${b.s.discount ? ` · diskon ${rp(b.s.discount)}` : ''}</div>`
        : `<div class="cell-strong">${esc(layanan(b.t!.provider))} · ${esc(b.t!.nomor)}</div>
           <div class="cell-sub">Kasir ${esc(b.t!.cashier)}${
             b.t!.kind === 'topup' && b.t!.admin ? ` · admin ${rp(b.t!.admin)}` : ''
           }</div>`;
      const total = b.s ? b.s.total : b.t!.total;
      const metodeCell = b.s ? metode(b.s.pay_method) : metode(b.t!.pay_method);
      const isi = terbuka
        ? `<tr class="det-row"><td colspan="6" class="td !py-3">${
            b.s ? detailJual(b.s) : detailTopup(b.t!)
          }</td></tr>`
        : '';
      return `
      <tr data-trx="${esc(b.key)}" class="cursor-pointer${terbuka ? ' bg-gray-50 dark:bg-gray-800/50' : ''}" aria-expanded="${terbuka}">
        <td class="td whitespace-nowrap tabular-nums">${esc(waktuCell)}</td>
        <td class="td">${badge(b.jenis)}</td>
        <td class="td">${keterangan}</td>
        <td class="td whitespace-nowrap">${esc(metodeCell)}</td>
        <td class="td td-num font-semibold">${rp(total)}</td>
        <td class="td td-num"><span class="inline-flex ${terbuka ? 'rotate-180' : ''}">${icon('chevD')}</span></td>
      </tr>
      ${isi}`;
    })
    .join('');

  const kelebihan =
    state.totalSales > state.sales.length || state.totalTopup > state.topups.length
      ? `<p class="mt-2 text-xs text-amber-700 dark:text-amber-400">
           Hari ini melebihi ${LIMIT} transaksi per jenis — menampilkan ${LIMIT} terbaru.
           Persempit lewat laporan bila butuh semua.
         </p>`
      : '';

  return `
  <div class="card-flush">
    <table class="table">
      <thead>
        <tr>
          <th class="th">Waktu</th>
          <th class="th">Jenis</th>
          <th class="th">Keterangan</th>
          <th class="th">Metode</th>
          <th class="th text-right">Total</th>
          <th class="th text-right"><span class="sr-only">Rincian</span></th>
        </tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
  </div>
  ${kelebihan}
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    ${rows.length} baris ditampilkan${state.totalSales + state.totalTopup > rows.length
      ? ` dari ${state.totalSales + state.totalTopup} transaksi hari itu`
      : ''}. Klik baris untuk membuka rincian. Topup/tarik tidak masuk omzet — lihat halaman Laporan.
  </p>`;
}

function paint(): void {
  const body = host?.querySelector('#h-body');
  if (!body) return;
  body.innerHTML = kepala() + renderTabel();
  bind();
}

function bind(): void {
  const root = host!.querySelector('#h-body');
  if (!root) return;
  root.querySelector('#h-date')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    state.date = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : hariIni();
    state.buka = '';
    state.det = null;
    void load();
  });
  root.querySelectorAll<HTMLElement>('[data-h]').forEach((b) =>
    b.addEventListener('click', () => {
      state.date = geser(state.date, b.dataset.h === 'prev' ? -1 : 1);
      state.buka = '';
      state.det = null;
      void load();
    }),
  );
  root.querySelector('#h-today')?.addEventListener('click', () => {
    state.date = hariIni();
    state.buka = '';
    state.det = null;
    void load();
  });
  root.querySelectorAll<HTMLElement>('[data-trx]').forEach((tr) =>
    tr.addEventListener('click', () => {
      const key = tr.dataset.trx ?? '';
      state.buka = state.buka === key ? '' : key;
      state.detErr = '';
      const s = key.startsWith('sale:') ? state.sales.find((x) => `sale:${x.id}` === key) : undefined;
      if (state.buka && s && state.det?.key !== state.buka) void bukaDetail(s.id);
      else paint();
    }),
  );
}

/** Ambil isi nota sekali per baris yang dibuka (GET /api/sales/:id sudah ada
 *  sejak awal — riwayat tidak butuh endpoint baru untuk isi itemnya). */
async function bukaDetail(id: string): Promise<void> {
  state.detMuat = true;
  paint();
  try {
    const j = await apiGet<{ data: { sale: unknown; items: ItemRow[] } }>(`/api/sales/${encodeURIComponent(id)}`);
    state.det = { key: `sale:${id}`, items: j.data.items };
    state.detErr = '';
  } catch (e) {
    state.detErr = errMsg(e);
  }
  state.detMuat = false;
  if (host?.isConnected) paint();
}

/* ---------- muat ---------- */

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const q = `date=${encodeURIComponent(state.date)}&limit=${LIMIT}`;
    const [s, t, r] = await Promise.all([
      apiGet<{ data: SaleRow[]; total: number }>(`/api/sales?${q}`),
      apiGet<{ data: TopupRow[]; total: number }>(`/api/topups?${q}`),
      apiGet<{ data: Ringkas }>(`/api/reports/daily?date=${encodeURIComponent(state.date)}`),
    ]);
    state.sales = s.data;
    state.totalSales = s.total;
    state.topups = t.data;
    state.totalTopup = t.total;
    state.ringkas = r.data;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

/* ---------- entry ---------- */

export async function mountHistoryPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = `
    <div class="mx-auto max-w-5xl space-y-4">
      <div id="h-body"></div>
    </div>`;
  paint();
  await load();
}
