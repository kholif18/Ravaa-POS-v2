// Halaman Laporan (#/reports): laporan harian pemilik toko.
//
// SATU-SUMBER DATA: GET /api/reports/daily?date= — angka yang tampil di sini
// adalah angka yang dikembalikan server (sales {n,omzet,diskon}, hpp, laba,
// byMethod, topup, topItems, lowStock). Tidak ada perhitungan ulang di klien,
// supaya halaman Laporan dan ringkasan mana pun (Dashboard, Riwayat
// transaksi) tidak mungkin berbeda angka.
//
// Hari memakai UTC persis seperti server & halaman Riwayat transaksi
// (`date(created_at)=date(?)`) — lihat ui/waktu.ts dan pages/history.ts.
// Ekspor CSV dibangun dari data yang SEDANG tampil, jadi "yang saya lihat =
// yang saya unduh" (aturan yang sama dengan ekspor halaman Stok).
//
// CATATAN TABEL: kartu di halaman ini berukuran setengah layar, jadi tabelnya
// TIDAK memakai class `.table` (yang punya `min-w-[720px]` — kolom Total/Admin
// terpotong keluar kartu). Yang dipakai: `<table class="w-full text-left
// text-sm">` + `.th`/`.td`/`.td-num` biasa, sehingga lebar mengikuti kartu.

import { apiGet, HttpError } from '../api';
import { icon } from '../ui/icons';
import { hariIni, geser, tglPanjang } from '../ui/waktu';
import { unduhCSV } from '../importcsv';
import { rp } from '../escpos';

/* ---------- tipe (ikuti kontrak GET /api/reports/daily) ---------- */

type ByMethod = { pay_method: string; n: number; total: number };
type TopupBaris = { kind: string; n: number; nominal: number; admin: number };
type TopItem = { name: string; unit: string; qty: number; amount: number };
type LowStock = { sku: string; name: string; stock: number; min_stock: number };

type Laporan = {
  date: string;
  sales: { n: number; omzet: number; diskon: number };
  hpp: number;
  laba: number;
  byMethod: ByMethod[];
  topup: TopupBaris[];
  topItems: TopItem[];
  lowStock: LowStock[];
  /** Pengeluaran kas hari itu (Tahap 1, 2026-10-11) — opsional supaya halaman
   *  tetap jalan melawan server lama yang belum mengirimkannya. */
  expense?: { n: number; total: number };
};

/* ---------- state ---------- */

const state = {
  date: hariIni(),
  data: null as Laporan | null,
  loading: true,
  error: '',
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

// hariIni()/geser()/tglPanjang() pindah ke ui/waktu.ts 2026-09-30 — satu
// implementasi UTC untuk Riwayat, Laporan, dan Dashboard.

const METODE: Record<string, string> = { tunai: 'Tunai', qris: 'QRIS', transfer: 'Transfer' };
const metode = (m: string) => METODE[m] ?? m;

const JENIS: Record<string, string> = { topup: 'Topup', tarik: 'Tarik' };
const jenis = (k: string) => JENIS[k] ?? k;

/** Pengaman CSV (polanya sama dengan `sel` di importcsv.ts, yang tidak diekspor). */
function sel(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ---------- render ---------- */

function toolbar(): string {
  const hariIniKah = state.date === hariIni();
  return `
  <div class="card">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-h="prev" class="row-btn" title="Hari sebelumnya" aria-label="Hari sebelumnya">${icon('chevL')}</button>
        <input id="rp-date" type="date" class="input input-sm !w-44" value="${esc(state.date)}" aria-label="Pilih tanggal laporan" />
        <button type="button" data-h="next" class="row-btn" title="Hari berikutnya" aria-label="Hari berikutnya">${icon('chevR')}</button>
        ${hariIniKah ? '' : `<button type="button" id="rp-today" class="chip">${icon('calendar')}<span>Hari ini</span></button>`}
        <span class="chip">${icon('calendar')}<span>${esc(tglPanjang(state.date))}</span></span>
      </div>
      <button type="button" id="rp-csv" class="btn btn-ghost !min-h-[38px] !px-3 !py-2" ${state.data ? '' : 'disabled'}>
        ${icon('download')}<span>Ekspor CSV</span>
      </button>
    </div>
  </div>`;
}

function ringkasan(l: Laporan): string {
  const exp = l.expense ?? { n: 0, total: 0 };
  const kartu = [
    { label: 'Omzet', nilai: rp(l.sales.omzet), sub: `${l.sales.n} transaksi (setelah diskon)` },
    { label: 'Laba', nilai: rp(l.laba), sub: 'omzet − HPP', tone: l.laba < 0 ? 'danger' : '' },
    { label: 'HPP', nilai: rp(l.hpp), sub: 'modal rata-rata tertimbang' },
    { label: 'Diskon', nilai: rp(l.sales.diskon), sub: 'transaksi + per baris' },
    // Pengeluaran kas (Tahap 1) — dilaporkan TERPISAH, tidak menggerus laba
    // (laba = laba kotor dagang). Link ke halaman catatnya.
    { label: 'Pengeluaran', nilai: rp(exp.total), sub: `${exp.n} catatan · kas keluar`, link: '#/expenses' },
  ];
  return `<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
    ${kartu
      .map((k) => {
        const warna = k.tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white';
        const isi = `
          <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${k.label}</p>
          <p class="mt-1 text-sm font-semibold tabular-nums ${warna}">${esc(k.nilai)}</p>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${esc(k.sub)}</p>`;
        return 'link' in k && k.link
          ? `<a href="${k.link}" class="card transition hover:border-primary">${isi}</a>`
          : `<div class="card">${isi}</div>`;
      })
      .join('')}
  </div>`;
}

function metodeBayar(l: Laporan): string {
  const total = l.byMethod.reduce((a, m) => a + m.total, 0);
  const n = l.byMethod.reduce((a, m) => a + m.n, 0);
  return `
  <div class="card">
    <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Rekap per metode bayar</h2>
    ${
      l.byMethod.length
        ? `<table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Metode</th><th class="th text-right">Transaksi</th><th class="th text-right">Total</th></tr></thead>
        <tbody>
          ${l.byMethod
            .map(
              (m) => `<tr>
                <td class="td">${esc(metode(m.pay_method))}</td>
                <td class="td td-num">${m.n}</td>
                <td class="td td-num font-semibold">${rp(m.total)}</td>
              </tr>`,
            )
            .join('')}
          <tr>
            <td class="td font-semibold">Jumlah</td>
            <td class="td td-num font-semibold">${n}</td>
            <td class="td td-num font-semibold">${rp(total)}</td>
          </tr>
        </tbody>
      </table>`
        : `<div class="empty">Belum ada penjualan pada tanggal ini.</div>`
    }
  </div>`;
}

function topupCard(l: Laporan): string {
  const n = l.topup.reduce((a, t) => a + t.n, 0);
  const nominal = l.topup.reduce((a, t) => a + t.nominal, 0);
  const admin = l.topup.reduce((a, t) => a + t.admin, 0);
  return `
  <div class="card">
    <div class="flex items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Topup & tarik tunai</h2>
      <span class="chip">${icon('wallet')}<span>${n} transaksi</span></span>
    </div>
    ${
      l.topup.length
        ? `<table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Jenis</th><th class="th text-right">Transaksi</th><th class="th text-right">Nominal</th><th class="th text-right">Admin</th></tr></thead>
        <tbody>
          ${l.topup
            .map(
              (t) => `<tr>
                <td class="td">${esc(jenis(t.kind))}</td>
                <td class="td td-num">${t.n}</td>
                <td class="td td-num">${rp(t.nominal)}</td>
                <td class="td td-num">${rp(t.admin)}</td>
              </tr>`,
            )
            .join('')}
          <tr>
            <td class="td font-semibold">Jumlah</td>
            <td class="td td-num font-semibold">${n}</td>
            <td class="td td-num font-semibold">${rp(nominal)}</td>
            <td class="td td-num font-semibold">${rp(admin)}</td>
          </tr>
        </tbody>
      </table>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Nominal = mutasi modal, admin = pendapatan jasa. Keduanya TIDAK masuk omzet.
      </p>`
        : `<div class="empty">Belum ada topup/tarik pada tanggal ini.</div>`
    }
  </div>`;
}

function produkTerlaris(l: Laporan): string {
  return `
  <div class="card">
    <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Produk terlaris</h2>
    ${
      l.topItems.length
        ? `<table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Produk</th><th class="th text-right">Qty</th><th class="th text-right">Omzet</th></tr></thead>
        <tbody>
          ${l.topItems
            .map(
              (t, i) => `<tr>
                <td class="td">
                  <div class="cell-strong">${i + 1}. ${esc(t.name)}</div>
                  <div class="cell-sub">satuan ${esc(t.unit)}</div>
                </td>
                <td class="td td-num">${t.qty} ${esc(t.unit)}</td>
                <td class="td td-num font-semibold">${rp(t.amount)}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        10 teratas, dikelompokkan per (nama, satuan) — "2 pack" dan "3 btl" tidak dicampur.
      </p>`
        : `<div class="empty">Belum ada penjualan produk pada tanggal ini.</div>`
    }
  </div>`;
}

function stokMenipis(l: Laporan): string {
  return `
  <div class="card">
    <div class="flex items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Stok menipis</h2>
      <a href="#/stock" class="chip">${icon('stock')}<span>Buka Stok</span></a>
    </div>
    ${
      l.lowStock.length
        ? `<ul class="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
          ${l.lowStock
            .map(
              (p) => `<li class="flex items-center justify-between gap-2 py-2">
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium text-gray-900 dark:text-white">${esc(p.name)}</span>
                  <span class="cell-sub">${esc(p.sku)}</span>
                </span>
                <span class="shrink-0 text-sm font-semibold tabular-nums ${
                  p.stock <= 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                }">${p.stock} / min ${p.min_stock}</span>
              </li>`,
            )
            .join('')}
        </ul>`
        : `<div class="empty">Semua stok aman.</div>`
    }
  </div>`;
}

function isi(): string {
  if (state.loading) {
    return `<div class="space-y-3">
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>
        <div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>
        <div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>
        <div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>
        <div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>
      </div>
      <div class="card"><div class="skel h-6 w-56"></div></div>
    </div>`;
  }
  if (state.error) {
    return `<div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat laporan: ${esc(state.error)}</span></div></div>`;
  }
  const l = state.data;
  if (!l) return '';
  return `
    ${ringkasan(l)}
    <div class="grid gap-2 lg:grid-cols-2">
      ${metodeBayar(l)}
      ${topupCard(l)}
      ${produkTerlaris(l)}
      ${stokMenipis(l)}
    </div>
    <p class="text-xs text-gray-500 dark:text-gray-400">
      Angka diambil apa adanya dari <code>GET /api/reports/daily?date=${esc(l.date)}</code>.
      Topup/tarik tidak masuk omzet (lihat domain §topup). Hari memakai UTC — sama
      dengan halaman Riwayat transaksi dan shift.
    </p>`;
}

function paint(): void {
  const body = host?.querySelector('#rp-body');
  if (!body) return;
  body.innerHTML = toolbar() + `<div class="mt-3 space-y-3">${isi()}</div>`;
  bind();
}

function bind(): void {
  const root = host!.querySelector('#rp-body');
  if (!root) return;
  root.querySelector('#rp-date')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    state.date = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : hariIni();
    void load();
  });
  root.querySelectorAll<HTMLElement>('[data-h]').forEach((b) =>
    b.addEventListener('click', () => {
      state.date = geser(state.date, b.dataset.h === 'prev' ? -1 : 1);
      void load();
    }),
  );
  root.querySelector('#rp-today')?.addEventListener('click', () => {
    state.date = hariIni();
    void load();
  });
  root.querySelector('#rp-csv')?.addEventListener('click', () => eksporCSV());
}

/* ---------- ekspor CSV ---------- */

function eksporCSV(): void {
  const l = state.data;
  if (!l) return;
  const b: (string | number)[][] = [
    ['Laporan harian', 'Ravaa POS'],
    ['Tanggal', l.date],
    [],
    ['Ringkasan'],
    ['Transaksi', l.sales.n],
    ['Omzet', l.sales.omzet],
    ['Diskon', l.sales.diskon],
    ['HPP', l.hpp],
    ['Laba', l.laba],
    ['Pengeluaran', (l.expense ?? { n: 0, total: 0 }).total],
    [],
    ['Metode bayar'],
    ['Metode', 'Transaksi', 'Total'],
    ...l.byMethod.map((m) => [metode(m.pay_method), m.n, m.total]),
    [],
    ['Topup/tarik'],
    ['Jenis', 'Transaksi', 'Nominal', 'Admin'],
    ...l.topup.map((t) => [jenis(t.kind), t.n, t.nominal, t.admin]),
    [],
    ['Produk terlaris'],
    ['Nama', 'Satuan', 'Qty', 'Omzet'],
    ...l.topItems.map((t) => [t.name, t.unit, t.qty, t.amount]),
    [],
    ['Stok menipis'],
    ['SKU', 'Nama', 'Stok', 'Minimum'],
    ...l.lowStock.map((p) => [p.sku, p.name, p.stock, p.min_stock]),
  ];
  unduhCSV(b.map((r) => r.map(sel).join(',')).join('\r\n'), `laporan-${l.date}.csv`);
}

/* ---------- muat ---------- */

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const j = await apiGet<{ data: Laporan }>(`/api/reports/daily?date=${encodeURIComponent(state.date)}`);
    state.data = j.data;
  } catch (e) {
    state.error = errMsg(e);
    state.data = null;
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

/* ---------- entry ---------- */

export async function mountReportsPage(el: HTMLElement): Promise<void> {
  host = el;
  // Lebar penuh ke seluruh body (tanpa max-w/mx-auto) — konsisten dengan
  // halaman Stok & Produk; tabel rekap makin lega di layar lebar.
  el.innerHTML = `<div class="space-y-3"><div id="rp-body"></div></div>`;
  paint();
  await load();
}
