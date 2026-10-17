// Halaman Laporan (#/reports): katalog laporan pemilik toko ala Aronium.
//
// Menu (chip di toolbar): Harian | Kasir | Produk | Piutang | Stok. Harian =
// tampilan lama (satu tanggal, DOM dipertahankan untuk kompatibilitas test);
// menu lain memakai rentang tanggal from..to (bawaan 7 hari terakhir).
//
// SATU-SUMBER DATA: angka yang tampil adalah angka yang dikembalikan server
// (summary/cashiers/products + customer-debts untuk sisa berjalan). Turunan
// tampilan (Omzet bersih = omzet−retur, Laba produk = amount−hpp) dihitung
// klien dari dua angka server — preseden nonTunai di shift-tutup.ts; agregat
// (SUM/COUNT) tidak pernah dihitung ulang di klien.
// Cetak/PDF: tiap menu membangun DokLaporan -> cetakLaporan() (popup +
// window.print, simpan sebagai PDF dari dialog browser — pola cetakInvoice).
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
import { cetakLaporan, type DokLaporan } from '../invoice';
import { toast } from '../ui/toast';

/* ---------- tipe (ikuti kontrak GET /api/reports/*) ---------- */

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
  /** Retur hari itu (Tahap 2, 2026-10-11) — total = uang kembali. Opsional
   *  dengan alasan yang sama. Dipakai kartu Retur + Omzet bersih (hybrid). */
  retur?: { n: number; total: number };
  /** Pembelian yang DITERIMA hari itu (Tahap 3, 2026-10-11) — total = nilai
   *  nota diterima. Opsional, alasan sama. */
  purchase?: { n: number; total: number };
  /** Piutang (butir credit Z-report): TERBENTUK + TERBAYAR. Opsional. */
  piutang?: { baru: number; bayar: number };
};

type KasirRow = { cashier: string; n: number; omzet: number; diskon: number };
type KasirData = { from: string; to: string; rows: KasirRow[]; total: { n: number; omzet: number; diskon: number } };
type ProdukRow = { name: string; unit: string; qty: number; amount: number; hpp: number };
type ProdukData = { from: string; to: string; rows: ProdukRow[]; total: number };

type Menu = 'harian' | 'kasir' | 'produk' | 'piutang' | 'stok';

const MENU_LABEL: Record<Menu, string> = {
  harian: 'Harian',
  kasir: 'Kasir',
  produk: 'Produk',
  piutang: 'Piutang',
  stok: 'Stok',
};

/* ---------- state ---------- */

const state = {
  menu: 'harian' as Menu,
  date: hariIni(),
  from: geser(hariIni(), -6),
  to: hariIni(),
  q: '',
  data: null as Laporan | null,
  sumData: null as (Omit<Laporan, 'date'> & { from: string; to: string }) | null,
  kasir: null as KasirData | null,
  produk: null as ProdukData | null,
  sisaPiutang: 0,
  loading: true,
  error: '',
};

let host: HTMLElement | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

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

const periode = () => `${state.from} s/d ${state.to}`;

/* ---------- render: toolbar ---------- */

function toolbar(): string {
  const hariIniKah = state.date === hariIni();
  const chips = (Object.keys(MENU_LABEL) as Menu[])
    .map(
      (m) => `<button type="button" data-menu="${m}" class="chip-tab${state.menu === m ? ' is-active' : ''}">${MENU_LABEL[m]}</button>`,
    )
    .join('');
  const filterHarian = `
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-h="prev" class="row-btn" title="Hari sebelumnya" aria-label="Hari sebelumnya">${icon('chevL')}</button>
        <input id="rp-date" type="date" class="input input-sm !w-44" value="${esc(state.date)}" aria-label="Pilih tanggal laporan" />
        <button type="button" data-h="next" class="row-btn" title="Hari berikutnya" aria-label="Hari berikutnya">${icon('chevR')}</button>
        ${hariIniKah ? '' : `<button type="button" id="rp-today" class="chip">${icon('calendar')}<span>Hari ini</span></button>`}
        <span class="chip">${icon('calendar')}<span>${esc(tglPanjang(state.date))}</span></span>
      </div>`;
  const filterRentang = `
      <div class="flex flex-wrap items-center gap-2">
        <input id="rp-from" type="date" class="input input-sm !w-40" value="${esc(state.from)}" aria-label="Dari tanggal" />
        <span class="text-xs text-gray-500 dark:text-gray-400">s/d</span>
        <input id="rp-to" type="date" class="input input-sm !w-40" value="${esc(state.to)}" aria-label="Sampai tanggal" />
        ${state.menu === 'produk' ? `
        <div class="relative">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
          <input id="rp-q" class="input input-sm pl-9 !w-52" type="search" placeholder="Cari produk…" autocomplete="off" value="${esc(state.q)}" />
        </div>` : ''}
      </div>`;
  return `
  <div class="card">
    <div class="chip-tabs mb-2" role="tablist" aria-label="Menu laporan">${chips}</div>
    <div class="flex flex-wrap items-center justify-between gap-2">
      ${state.menu === 'harian' ? filterHarian : filterRentang}
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" id="rp-print" class="btn btn-ghost !min-h-[38px] !px-3 !py-2" ${adaData() ? '' : 'disabled'}>
          ${icon('print')}<span>Cetak / PDF</span>
        </button>
        <button type="button" id="rp-csv" class="btn btn-ghost !min-h-[38px] !px-3 !py-2" ${adaData() ? '' : 'disabled'}>
          ${icon('download')}<span>Ekspor CSV</span>
        </button>
      </div>
    </div>
  </div>`;
}

function adaData(): boolean {
  if (state.menu === 'harian') return !!state.data;
  if (state.menu === 'kasir') return !!state.kasir;
  if (state.menu === 'produk') return !!state.produk;
  return !!state.sumData;
}

/* ---------- render: HARIAN (tampilan lama, dipertahankan) ---------- */

function ringkasan(l: Laporan): string {
  const exp = l.expense ?? { n: 0, total: 0 };
  const ret = l.retur ?? { n: 0, total: 0 };
  const po = l.purchase ?? { n: 0, total: 0 };
  // Hybrid keputusan (c): Omzet KOTOR + Retur terpisah + Omzet bersih.
  // Bersih = omzet − retur, dihitung di klien dari dua angka server (preseden:
  // `nonTunai = omzet − tunai` di shift-tutup.ts) — agregatnya tetap server.
  const kartu = [
    { label: 'Omzet', nilai: rp(l.sales.omzet), sub: `${l.sales.n} transaksi (setelah diskon)` },
    { label: 'Retur', nilai: rp(ret.total), sub: `${ret.n} retur · uang kembali`, link: '#/returns' },
    { label: 'Omzet bersih', nilai: rp(l.sales.omzet - ret.total), sub: 'omzet − retur' },
    { label: 'Laba', nilai: rp(l.laba), sub: 'omzet − HPP', tone: l.laba < 0 ? 'danger' : '' },
    { label: 'HPP', nilai: rp(l.hpp), sub: 'modal rata-rata tertimbang' },
    { label: 'Diskon', nilai: rp(l.sales.diskon), sub: 'transaksi + per baris' },
    // Pengeluaran kas (Tahap 1) — dilaporkan TERPISAH, tidak menggerus laba
    // (laba = laba kotor dagang). Link ke halaman catatnya.
    { label: 'Pengeluaran', nilai: rp(exp.total), sub: `${exp.n} catatan · kas keluar`, link: '#/expenses' },
    // Pembelian diterima (Tahap 3) — nilai kulakan masuk hari itu.
    { label: 'Pembelian', nilai: rp(po.total), sub: `${po.n} nota diterima`, link: '#/purchases' },
  ];
  return `<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
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

/* ---------- render: KASIR ---------- */

function kasirView(): string {
  const d = state.kasir;
  if (!d) return '';
  const rows = d.rows
    .map(
      (r) => `<tr>
        <td class="td"><div class="cell-strong">${esc(r.cashier)}</div></td>
        <td class="td td-num">${r.n}</td>
        <td class="td td-num font-semibold">${rp(r.omzet)}</td>
        <td class="td td-num">${rp(r.diskon)}</td>
      </tr>`,
    )
    .join('');
  return `
  <div class="card">
    <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Penjualan per kasir — ${esc(periode())}</h2>
    ${
      d.rows.length
        ? `<table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Kasir</th><th class="th text-right">Transaksi</th><th class="th text-right">Omzet</th><th class="th text-right">Diskon</th></tr></thead>
        <tbody>${rows}
          <tr>
            <td class="td font-semibold">Jumlah</td>
            <td class="td td-num font-semibold">${d.total.n}</td>
            <td class="td td-num font-semibold">${rp(d.total.omzet)}</td>
            <td class="td td-num font-semibold">${rp(d.total.diskon)}</td>
          </tr>
        </tbody>
      </table>`
        : `<div class="empty">Belum ada penjualan pada rentang ini.</div>`
    }
  </div>`;
}

/* ---------- render: PRODUK ---------- */

function produkView(): string {
  const d = state.produk;
  if (!d) return '';
  const rows = d.rows
    .map(
      (t) => `<tr>
        <td class="td">
          <div class="cell-strong">${esc(t.name)}</div>
          <div class="cell-sub">satuan ${esc(t.unit)}</div>
        </td>
        <td class="td td-num">${t.qty} ${esc(t.unit)}</td>
        <td class="td td-num">${rp(t.amount)}</td>
        <td class="td td-num">${rp(t.hpp)}</td>
        <td class="td td-num font-semibold">${rp(t.amount - t.hpp)}</td>
      </tr>`,
    )
    .join('');
  const totOmzet = d.rows.reduce((a, t) => a + t.amount, 0);
  const totHpp = d.rows.reduce((a, t) => a + t.hpp, 0);
  return `
  <div class="card">
    <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Produk — ${esc(periode())}${state.q ? ` · cari “${esc(state.q)}”` : ''}</h2>
    ${
      d.rows.length
        ? `<table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Produk</th><th class="th text-right">Qty</th><th class="th text-right">Omzet</th><th class="th text-right">HPP</th><th class="th text-right">Laba</th></tr></thead>
        <tbody>${rows}
          <tr>
            <td class="td font-semibold">Jumlah (${d.total} produk)</td>
            <td class="td td-num"></td>
            <td class="td td-num font-semibold">${rp(totOmzet)}</td>
            <td class="td td-num font-semibold">${rp(totHpp)}</td>
            <td class="td td-num font-semibold">${rp(totOmzet - totHpp)}</td>
          </tr>
        </tbody>
      </table>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Dikelompokkan per (nama, satuan). Laba = omzet − HPP (snapshot saat jual).
      </p>`
        : `<div class="empty">Belum ada penjualan produk pada rentang ini.</div>`
    }
  </div>`;
}

/* ---------- render: PIUTANG ---------- */

function piutangView(): string {
  const l = state.sumData;
  if (!l) return '';
  const baru = l.piutang?.baru ?? 0;
  const bayar = l.piutang?.bayar ?? 0;
  const kartu = [
    { label: 'Hutang terbentuk', nilai: rp(baru), sub: 'tunai kurang — laci tak menerimanya' },
    { label: 'Piutang terbayar', nilai: rp(bayar), sub: 'masuk laci periode ini' },
    { label: 'Sisa berjalan kini', nilai: rp(state.sisaPiutang), sub: 'saldo live seluruh pelanggan', link: '#/debts' },
  ];
  return `
  <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
    ${kartu
      .map((k) => {
        const isi = `
          <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${k.label}</p>
          <p class="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-white">${esc(k.nilai)}</p>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${esc(k.sub)}</p>`;
        return 'link' in k && k.link
          ? `<a href="${k.link}" class="card transition hover:border-primary">${isi}</a>`
          : `<div class="card">${isi}</div>`;
      })
      .join('')}
  </div>
  <div class="card">
    <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Arus piutang — ${esc(periode())}</h2>
    <p class="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
      Terbentuk ${rp(baru)} dari penjualan tunai-kurang, terbayar ${rp(bayar)}.
      Rincian per pelanggan + pelunasan ada di halaman Hutang.
    </p>
  </div>`;
}

/* ---------- render: STOK (reorder) ---------- */

function stokView(): string {
  const l = state.sumData;
  if (!l) return '';
  const rows = l.lowStock
    .map(
      (p) => `<tr>
        <td class="td">
          <div class="cell-strong">${esc(p.name)}</div>
          <div class="cell-sub">${esc(p.sku)}</div>
        </td>
        <td class="td td-num font-semibold ${p.stock <= 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}">${p.stock}</td>
        <td class="td td-num">${p.min_stock}</td>
        <td class="td td-num font-semibold">${Math.max(0, p.min_stock - p.stock)}</td>
      </tr>`,
    )
    .join('');
  return `
  <div class="card">
    <div class="flex items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Perlu dikulak</h2>
      <a href="#/purchases" class="chip">${icon('truck')}<span>Buat PO</span></a>
    </div>
    ${
      l.lowStock.length
        ? `<table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Produk</th><th class="th text-right">Stok</th><th class="th text-right">Min</th><th class="th text-right">Saran order</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Saran order = stok minimum − stok kini (kembali ke batas aman). Buat PO-nya di halaman Pembelian.
      </p>`
        : `<div class="empty">Semua stok aman — tidak ada yang perlu dikulak.</div>`
    }
  </div>`;
}

/* ---------- isi ---------- */

function isiHarian(): string {
  if (state.loading) {
    return `<div class="space-y-3">
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>
        <div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>
        <div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>
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

function isi(): string {
  if (state.loading) return isiHarian();
  if (state.error) {
    return `<div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat laporan: ${esc(state.error)}</span></div></div>`;
  }
  if (state.menu === 'harian') {
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
  if (state.menu === 'kasir') return kasirView();
  if (state.menu === 'produk') return produkView();
  if (state.menu === 'piutang') return piutangView();
  return stokView();
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
  root.querySelectorAll<HTMLElement>('[data-menu]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = b.dataset.menu as Menu;
      if (!m || m === state.menu) return;
      state.menu = m;
      void load();
    }),
  );
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
  root.querySelector('#rp-from')?.addEventListener('change', (e) => {
    state.from = (e.target as HTMLInputElement).value || state.from;
    void load();
  });
  root.querySelector('#rp-to')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (v) {
      state.to = v;
      void load();
    }
  });
  const cari = root.querySelector<HTMLInputElement>('#rp-q');
  cari?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = (cari.value ?? '').trim();
      void load();
    }, 350);
  });
  cari?.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      clearTimeout(searchTimer);
      state.q = (cari.value ?? '').trim();
      void load();
    }
  });
  root.querySelector('#rp-csv')?.addEventListener('click', () => eksporCSV());
  root.querySelector('#rp-print')?.addEventListener('click', () => void cetak());
}

/* ---------- ekspor CSV ---------- */

function namaFileCsv(): string {
  return state.menu === 'harian'
    ? `laporan-${state.date}.csv`
    : `laporan-${state.menu}-${state.from}_sd_${state.to}.csv`;
}

function eksporCSV(): void {
  if (state.menu !== 'harian') return eksporCSVMenu();
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
    ['Retur', (l.retur ?? { n: 0, total: 0 }).total],
    ['Omzet bersih', l.sales.omzet - (l.retur ?? { n: 0, total: 0 }).total],
    ['Pengeluaran', (l.expense ?? { n: 0, total: 0 }).total],
    ['Pembelian diterima', (l.purchase ?? { n: 0, total: 0 }).total],
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
  unduhCSV(b.map((r) => r.map(sel).join(',')).join('\r\n'), namaFileCsv());
}

function eksporCSVMenu(): void {
  let b: (string | number)[][] = [];
  if (state.menu === 'kasir' && state.kasir) {
    const d = state.kasir;
    b = [
      ['Laporan kasir', 'Ravaa POS'],
      ['Periode', `${d.from} s/d ${d.to}`],
      [],
      ['Kasir', 'Transaksi', 'Omzet', 'Diskon'],
      ...d.rows.map((r) => [r.cashier, r.n, r.omzet, r.diskon]),
      ['Jumlah', d.total.n, d.total.omzet, d.total.diskon],
    ];
  } else if (state.menu === 'produk' && state.produk) {
    const d = state.produk;
    b = [
      ['Laporan produk', 'Ravaa POS'],
      ['Periode', `${d.from} s/d ${d.to}`],
      [],
      ['Nama', 'Satuan', 'Qty', 'Omzet', 'HPP', 'Laba'],
      ...d.rows.map((t) => [t.name, t.unit, t.qty, t.amount, t.hpp, t.amount - t.hpp]),
    ];
  } else if (state.menu === 'piutang' && state.sumData) {
    const l = state.sumData;
    b = [
      ['Laporan piutang', 'Ravaa POS'],
      ['Periode', `${l.from} s/d ${l.to}`],
      [],
      ['Hutang terbentuk', l.piutang?.baru ?? 0],
      ['Piutang terbayar', l.piutang?.bayar ?? 0],
      ['Sisa berjalan kini', state.sisaPiutang],
    ];
  } else if (state.menu === 'stok' && state.sumData) {
    const l = state.sumData;
    b = [
      ['Stok perlu dikulak', 'Ravaa POS'],
      [],
      ['SKU', 'Nama', 'Stok', 'Minimum', 'Kurang', 'Saran order'],
      ...l.lowStock.map((p) => [p.sku, p.name, p.stock, p.min_stock, p.min_stock - p.stock, Math.max(0, p.min_stock - p.stock)]),
    ];
  } else {
    return;
  }
  unduhCSV(b.map((r) => r.map(sel).join(',')).join('\r\n'), namaFileCsv());
}

/* ---------- cetak / PDF ---------- */

async function cetak(): Promise<void> {
  try {
    if (state.menu === 'harian' && state.data) {
      const l = state.data;
      const ret = l.retur ?? { n: 0, total: 0 };
      const baris: string[][] = [
        ['Omzet', rp(l.sales.omzet)],
        ['Retur', rp(ret.total)],
        ['Omzet bersih', rp(l.sales.omzet - ret.total)],
        ['Laba', rp(l.laba)],
        ['HPP', rp(l.hpp)],
        ['Diskon', rp(l.sales.diskon)],
        ['Pengeluaran', rp((l.expense ?? { n: 0, total: 0 }).total)],
        ['Pembelian diterima', rp((l.purchase ?? { n: 0, total: 0 }).total)],
        ...l.byMethod.map((m) => [`${metode(m.pay_method)} (${m.n}x)`, rp(m.total)]),
      ];
      await cetakLaporan({
        judul: 'LAPORAN HARIAN', periode: tglPanjang(l.date),
        meta: [['Transaksi', String(l.sales.n)]],
        kolom: [{ label: 'Uraian' }, { label: 'Nilai', kanan: true }],
        baris, ringkas: [['Omzet bersih', rp(l.sales.omzet - ret.total)]],
        catatan: 'Topup/tarik tidak masuk omzet.',
      });
    } else if (state.menu === 'kasir' && state.kasir) {
      const d = state.kasir;
      await cetakLaporan({
        judul: 'LAPORAN KASIR', periode: `${d.from} s/d ${d.to}`,
        meta: [['Transaksi', String(d.total.n)]],
        kolom: [{ label: 'Kasir' }, { label: 'Trx', kanan: true }, { label: 'Omzet', kanan: true }, { label: 'Diskon', kanan: true }],
        baris: d.rows.map((r) => [r.cashier, String(r.n), rp(r.omzet), rp(r.diskon)]),
        ringkas: [['Total omzet', rp(d.total.omzet)]],
      });
    } else if (state.menu === 'produk' && state.produk) {
      const d = state.produk;
      const totOmzet = d.rows.reduce((a, t) => a + t.amount, 0);
      const totHpp = d.rows.reduce((a, t) => a + t.hpp, 0);
      await cetakLaporan({
        judul: 'LAPORAN PRODUK', periode: `${d.from} s/d ${d.to}`,
        meta: state.q ? [['Cari', state.q]] : [],
        kolom: [{ label: 'Produk' }, { label: 'Qty', kanan: true }, { label: 'Omzet', kanan: true }, { label: 'HPP', kanan: true }, { label: 'Laba', kanan: true }],
        baris: d.rows.map((t) => [`${t.name} (${t.unit})`, String(t.qty), rp(t.amount), rp(t.hpp), rp(t.amount - t.hpp)]),
        ringkas: [['Total laba', rp(totOmzet - totHpp)]],
      });
    } else if (state.menu === 'piutang' && state.sumData) {
      const l = state.sumData;
      await cetakLaporan({
        judul: 'LAPORAN PIUTANG', periode: `${l.from} s/d ${l.to}`,
        meta: [],
        kolom: [{ label: 'Uraian' }, { label: 'Nilai', kanan: true }],
        baris: [
          ['Hutang terbentuk', rp(l.piutang?.baru ?? 0)],
          ['Piutang terbayar', rp(l.piutang?.bayar ?? 0)],
        ],
        ringkas: [['Sisa berjalan kini', rp(state.sisaPiutang)]],
        catatan: 'Rincian per pelanggan ada di halaman Hutang.',
      });
    } else if (state.menu === 'stok' && state.sumData) {
      const l = state.sumData;
      await cetakLaporan({
        judul: 'STOK PERLU DIKULAK', periode: `${l.from} s/d ${l.to}`,
        meta: [['Item', String(l.lowStock.length)]],
        kolom: [{ label: 'Produk' }, { label: 'Stok', kanan: true }, { label: 'Min', kanan: true }, { label: 'Saran order', kanan: true }],
        baris: l.lowStock.map((p) => [`${p.name} (${p.sku})`, String(p.stock), String(p.min_stock), String(Math.max(0, p.min_stock - p.stock))]),
        ringkas: [],
      });
    }
  } catch (e) {
    // Popup diblokir / API gagal = toast saja (pola cetakInvoice).
    toast(`Cetak laporan gagal: ${e instanceof Error ? e.message : 'gagal memuat'}`, 'warning', 9000);
  }
}

/* ---------- muat ---------- */

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    if (state.menu === 'harian') {
      const j = await apiGet<{ data: Laporan }>(`/api/reports/daily?date=${encodeURIComponent(state.date)}`);
      state.data = j.data;
    } else if (state.menu === 'kasir') {
      const j = await apiGet<{ data: KasirData }>(
        `/api/reports/cashiers?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`,
      );
      state.kasir = j.data;
    } else if (state.menu === 'produk') {
      const p = new URLSearchParams({ from: state.from, to: state.to, limit: '50' });
      if (state.q) p.set('q', state.q);
      const j = await apiGet<{ data: ProdukData }>(`/api/reports/products?${p}`);
      state.produk = j.data;
    } else {
      const j = await apiGet<{ data: Omit<Laporan, 'date'> & { from: string; to: string } }>(
        `/api/reports/summary?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`,
      );
      state.sumData = j.data;
      if (state.menu === 'piutang') {
        // Sisa berjalan live (saldo seluruh pelanggan, bukan per periode).
        const s = await apiGet<{ data: unknown; total: number }>('/api/customer-debts?status=open');
        state.sisaPiutang = s.total;
      }
    }
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
