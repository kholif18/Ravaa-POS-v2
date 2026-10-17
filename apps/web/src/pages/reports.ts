// Halaman Laporan (#/reports): katalog laporan pemilik toko ala Aronium.
//
// Struktur (refactor 2026-10-17 — permintaan pemilik "perlu refactor juga
// halaman report untuk menampung seluruh menu laporan"): daftar menu pindah ke
// kolom kiri (grup Penjualan/Keuangan/Stok) dan SETIAP menu = satu objek
// MenuDef di registry MENUS — menambah laporan baru cukup menambah satu objek
// (label/grup/filter/muat/isi/csv/cetak), bukan menambah cabang if di lima
// tempat. Menu saat ini: Harian | Laba | Kasir | Produk | Piutang | Stok.
//   - Harian = tampilan lama + grafik per jam (2026-10-17; jam UTC) + kolom
//     HPP/Laba di "Produk terlaris" (`topItems[].hpp/laba` dihitung SERVER).
//   - Laba = laba per hari + per transaksi (GET /api/reports/profit; 200 nota
//     terbaru) — menampung permintaan "laba transaksi perhari".
//   - Rentang tanggal dipilih lewat DROPDOWN (2026-10-17; permintaan pemilik
//     "date filter seperti downloadan" lalu direvisi "jadikan dropdown saja
//     jangan seperti modal"): panel melayang menempel di bawah tombol rentang,
//     preset kiri + dua kalender kanan ala Blueprint/Aronium — presets
//     Hari ini..Tahun lalu + Kustom, batas 366 hari server divalidasi LANGSUNG
//     di panel (Terapkan mati saat rentang tak sah), nilai baru masuk state
//     hanya saat Terapkan; tutup via klik luar / Esc / Batal / Terapkan.
//
// SATU-SUMBER DATA: angka yang tampil adalah angka yang dikembalikan server
// (daily/summary/profit/cashiers/products + customer-debts untuk sisa
// berjalan). Turunan tampilan (Omzet bersih = omzet−retur, margin %, dsb.)
// dihitung klien dari angka server — preseden nonTunai di shift-tutup.ts;
// agregat (SUM/COUNT) tidak pernah dihitung ulang di klien. Rumus laba
// (per produk, per hari, per transaksi) milik SERVER — jangan dihitung ulang
// di sini (dulu Laba produk = amount−hpp di klien; dipindah 2026-10-17).
// Cetak/PDF: tiap menu membangun DokLaporan -> cetakLaporan() (popup +
// window.print, simpan sebagai PDF dari dialog browser — pola cetakInvoice).
// Ekspor CSV dibangun dari data yang SEDANG tampil, jadi "yang saya lihat =
// yang saya unduh" (aturan yang sama dengan ekspor halaman Stok).
//
// CATATAN TABEL: kartu di halaman ini berukuran setengah layar, jadi tabelnya
// TIDAK memakai class `.table` (yang punya `min-w-[720px]` — kolom Total/Admin
// terpotong keluar kartu). Yang dipakai: `<table class="w-full text-left
// text-sm">` + `.th`/`.td`/`.td-num` biasa, sehingga lebar mengikuti kartu.
// Urutan tabel kartu Harian = kontrak test laporan-test: metode bayar DULU,
// baru topup, baru produk terlaris — grafik per jam sengaja DIV (bukan tabel)
// supaya urutan itu tidak bergeser saat menambah fitur.

import { apiGet, HttpError } from '../api';
import { icon } from '../ui/icons';
import { hariIni, geser, tglPanjang, tglPendek, jam, awalMinggu, awalBulan, akhirBulan } from '../ui/waktu';
import { unduhCSV } from '../importcsv';
import { rp } from '../escpos';
import { cetakLaporan, type DokLaporan } from '../invoice';
import { toast } from '../ui/toast';

/* ---------- tipe (ikuti kontrak GET /api/reports/*) ---------- */

type ByMethod = { pay_method: string; n: number; total: number };
type TopupBaris = { kind: string; n: number; nominal: number; admin: number };
/** `hpp`/`laba` per baris DIHITUNG SERVER (2026-10-17) — rumus laba produk
 *  hanya hidup di laporanRentang (index.ts), klien menampilkan apa adanya. */
type TopItem = { name: string; unit: string; qty: number; amount: number; hpp: number; laba: number };
type LowStock = { sku: string; name: string; stock: number; min_stock: number };
type JamBaris = { jam: number; n: number; omzet: number };

type Laporan = {
  date: string;
  sales: { n: number; omzet: number; diskon: number };
  hpp: number;
  laba: number;
  byMethod: ByMethod[];
  topup: TopupBaris[];
  topItems: TopItem[];
  lowStock: LowStock[];
  /** Penjualan per jam — 24 ember 0..23, zero-fill server, jam UTC. Opsional
   *  supaya halaman tetap jalan melawan server lama yang belum mengirimnya. */
  byHour?: JamBaris[];
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
type ProdukRow = { name: string; unit: string; qty: number; amount: number; hpp: number; laba: number };
type ProdukData = { from: string; to: string; rows: ProdukRow[]; total: number };

/** GET /api/reports/profit (menu Laba, 2026-10-17): HPP per NOTA (subquery
 *  per s.id — join langsung menggandakan s.total), trx dibatasi 200 terbaru. */
type ProfitHari = { date: string; n: number; omzet: number; hpp: number; laba: number };
type ProfitTrx = {
  id: string;
  created_at: string;
  invoice_no: string | null;
  cashier: string;
  total: number;
  hpp: number;
  laba: number;
};
type ProfitData = {
  from: string;
  to: string;
  total: { n: number; omzet: number; hpp: number; laba: number };
  days: ProfitHari[];
  trx: ProfitTrx[];
};

/* ---------- state ---------- */

type MenuId = 'harian' | 'laba' | 'kasir' | 'produk' | 'piutang' | 'stok';
type GrupMenu = 'Penjualan' | 'Keuangan' | 'Stok';

/** Satu menu laporan = satu objek ini. `ada()` menggerakkan disabled tombol
 *  Cetak/CSV; `filter` menentukan baris kontrol tanggal yang dirender. */
type MenuDef = {
  id: MenuId;
  label: string;
  grup: GrupMenu;
  filter: 'hari' | 'rentang';
  /** Kotak cari hanya dirender bila true (menu Produk). */
  cari?: boolean;
  ada: () => boolean;
  muat: () => Promise<void>;
  isi: () => string;
  csv: () => (string | number)[][];
  cetak: () => Promise<void>;
};

const state = {
  menu: 'harian' as MenuId,
  date: hariIni(),
  from: geser(hariIni(), -6),
  to: hariIni(),
  q: '',
  data: null as Laporan | null,
  sumData: null as (Omit<Laporan, 'date'> & { from: string; to: string }) | null,
  kasir: null as KasirData | null,
  produk: null as ProdukData | null,
  laba: null as ProfitData | null,
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

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Pengaman CSV (polanya sama dengan `sel` di importcsv.ts, yang tidak diekspor). */
function sel(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const periode = () => `${state.from} s/d ${state.to}`;

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

/** Grafik penjualan per jam — pola yang sama dengan grafik dashboard.ts
 *  (batang + tooltip hover + garis bantu). Sengaja DIV, bukan tabel: urutan
 *  tabel kartu Harian sudah dikunci laporan-test. Jam = UTC apa adanya. */
function jamCard(l: Laporan): string {
  const bh = l.byHour ?? [];
  if (bh.length !== 24) return '';
  const ada = bh.some((b) => b.n > 0);
  const max = Math.max(1, ...bh.map((b) => b.omzet));
  const tinggiPx = 120;
  const teramai = bh.reduce((a, b) => (b.omzet > a.omzet ? b : a), bh[0]);
  const batang = bh
    .map((b) => {
      const tinggi = b.omzet <= 0 ? 2 : Math.max(4, Math.round((b.omzet / max) * 100));
      const nilai = b.omzet > 0 ? rp(b.omzet) : 'Rp0';
      return `
      <div class="group relative h-full min-w-0 flex-1" data-jam="${b.jam}"
           title="Jam ${pad2(b.jam)}:00 — ${esc(nilai)} · ${b.n} transaksi">
        <span class="pointer-events-none absolute left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[10px] font-semibold text-white shadow-md group-hover:block" style="bottom:calc(${tinggi}% + 6px)">${esc(nilai)}</span>
        <div class="absolute inset-x-0 bottom-0 rounded-t-[4px] ${
          b.omzet <= 0 ? 'bg-gray-200 dark:bg-gray-700' : 'bg-primary/40 group-hover:bg-primary/70'
        }" style="height:${tinggi}%"></div>
      </div>`;
    })
    .join('');
  const label = bh
    .map(
      (b) =>
        `<div class="min-w-0 flex-1 text-center text-[9px] tabular-nums text-gray-400 dark:text-gray-500">${
          b.jam % 3 === 0 ? pad2(b.jam) : '&nbsp;'
        }</div>`,
    )
    .join('');
  return `
  <div class="card">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Penjualan per jam (UTC)</h2>
      ${
        ada
          ? `<span class="chip">${icon('clock')}<span>Jam teramai ${pad2(teramai.jam)}:00 · ${esc(rp(teramai.omzet))} · ${teramai.n} trx</span></span>`
          : ''
      }
    </div>
    <div class="relative mt-3" style="height:${tinggiPx}px">
      <div class="pointer-events-none absolute inset-0 flex flex-col justify-between">
        <span class="border-t border-dashed border-gray-200 dark:border-gray-700"></span>
        <span class="border-t border-dashed border-gray-100 dark:border-gray-700/60"></span>
        <span class="border-t border-gray-200 dark:border-gray-700"></span>
      </div>
      <div class="absolute inset-0 flex items-end gap-[3px]" role="img"
           aria-label="Grafik penjualan per jam, ${bh.reduce((a, b) => a + b.n, 0)} transaksi">
        ${batang}
      </div>
    </div>
    <div class="mt-1 flex gap-[3px]">${label}</div>
    <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
      ${
        ada
          ? `Puncak belanja jam ${pad2(teramai.jam)}:00 (${esc(rp(teramai.omzet))} · ${teramai.n} transaksi).`
          : 'Belum ada penjualan pada tanggal ini.'
      }
      Jam memakai UTC — sama dengan Riwayat transaksi dan shift.
    </p>
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
        <thead><tr><th class="th">Produk</th><th class="th text-right">Omzet</th><th class="th text-right">HPP</th><th class="th text-right">Laba</th></tr></thead>
        <tbody>
          ${l.topItems
            .map(
              (t, i) => `<tr>
                <td class="td">
                  <div class="cell-strong">${i + 1}. ${esc(t.name)}</div>
                  <div class="cell-sub">${t.qty} ${esc(t.unit)}</div>
                </td>
                <td class="td td-num">${rp(t.amount)}</td>
                <td class="td td-num">${rp(t.hpp)}</td>
                <td class="td td-num font-semibold ${t.laba < 0 ? 'text-red-600 dark:text-red-400' : ''}">${rp(t.laba)}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        10 teratas per (nama, satuan) — "2 pack" dan "3 btl" tidak dicampur.
        Laba dihitung server = omzet − diskon baris − HPP baris (diskon transaksi tidak dialokasikan).
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

function harianIsi(): string {
  const l = state.data;
  if (!l) return '';
  return `
    ${ringkasan(l)}
    ${jamCard(l)}
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

/* ---------- render: LABA (baru 2026-10-17) ---------- */

function labaView(): string {
  const d = state.laba;
  if (!d) return '';
  const margin = d.total.omzet > 0 ? Math.round((d.total.laba / d.total.omzet) * 100) : 0;
  const kartu = [
    { label: 'Transaksi', nilai: String(d.total.n), sub: `${d.days.length} hari berisi penjualan` },
    { label: 'Omzet', nilai: rp(d.total.omzet), sub: 'setelah semua diskon' },
    { label: 'HPP', nilai: rp(d.total.hpp), sub: 'modal rata-rata tertimbang' },
    { label: 'Laba kotor', nilai: rp(d.total.laba), sub: `margin ${margin}%`, tone: d.total.laba < 0 ? 'danger' : '' },
  ];
  const hari = d.days
    .map(
      (h) => `<tr>
        <td class="td font-medium tabular-nums">${esc(h.date)}</td>
        <td class="td td-num">${h.n}</td>
        <td class="td td-num">${rp(h.omzet)}</td>
        <td class="td td-num">${rp(h.hpp)}</td>
        <td class="td td-num font-semibold ${h.laba < 0 ? 'text-red-600 dark:text-red-400' : ''}">${rp(h.laba)}</td>
      </tr>`,
    )
    .join('');
  const trx = d.trx
    .map(
      (t) => `<tr>
        <td class="td">
          <div class="cell-strong tabular-nums">${esc(jam(t.created_at))}</div>
          <div class="cell-sub">${esc(tglPendek(String(t.created_at).slice(0, 10)))}</div>
        </td>
        <td class="td font-medium">${esc(t.invoice_no || '—')}</td>
        <td class="td">${esc(t.cashier)}</td>
        <td class="td td-num">${rp(t.total)}</td>
        <td class="td td-num">${rp(t.hpp)}</td>
        <td class="td td-num font-semibold ${t.laba < 0 ? 'text-red-600 dark:text-red-400' : ''}">${rp(t.laba)}</td>
      </tr>`,
    )
    .join('');
  return `
  <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
    ${kartu
      .map((k) => {
        const warna = 'tone' in k && k.tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white';
        return `
      <div class="card">
        <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${k.label}</p>
        <p class="mt-1 text-sm font-semibold tabular-nums ${warna}">${esc(k.nilai)}</p>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${esc(k.sub)}</p>
      </div>`;
      })
      .join('')}
  </div>
  ${
    d.days.length
      ? `<div class="card">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Laba per hari</h2>
      <table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Tanggal</th><th class="th text-right">Trx</th><th class="th text-right">Omzet</th><th class="th text-right">HPP</th><th class="th text-right">Laba</th></tr></thead>
        <tbody>${hari}
          <tr>
            <td class="td font-semibold">Jumlah</td>
            <td class="td td-num font-semibold">${d.total.n}</td>
            <td class="td td-num font-semibold">${rp(d.total.omzet)}</td>
            <td class="td td-num font-semibold">${rp(d.total.hpp)}</td>
            <td class="td td-num font-semibold">${rp(d.total.laba)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Laba per transaksi</h2>
        <span class="chip">${icon('receipt')}<span>${d.trx.length} dari ${d.total.n} nota</span></span>
      </div>
      <table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Waktu</th><th class="th">Nota</th><th class="th">Kasir</th><th class="th text-right">Omzet</th><th class="th text-right">HPP</th><th class="th text-right">Laba</th></tr></thead>
        <tbody>${trx}</tbody>
      </table>
      ${
        d.total.n > d.trx.length
          ? `<p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Menampilkan ${d.trx.length} nota terbaru dari ${d.total.n} — persempit rentang atau buka
        <a href="#/history" class="underline">Riwayat transaksi</a> untuk sisanya.
      </p>`
          : `<p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        HPP per nota = Σ qty × modal tertimbang saat jual (snapshot). Arsip lengkap ada di
        <a href="#/history" class="underline">Riwayat transaksi</a>.
      </p>`
      }
    </div>`
      : `<div class="card"><div class="empty">Belum ada penjualan pada rentang ini.</div></div>`
  }`;
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
          <div class="cell-sub">${t.qty} ${esc(t.unit)}</div>
        </td>
        <td class="td td-num">${rp(t.amount)}</td>
        <td class="td td-num">${rp(t.hpp)}</td>
        <td class="td td-num font-semibold ${t.laba < 0 ? 'text-red-600 dark:text-red-400' : ''}">${rp(t.laba)}</td>
      </tr>`,
    )
    .join('');
  const totOmzet = d.rows.reduce((a, t) => a + t.amount, 0);
  const totHpp = d.rows.reduce((a, t) => a + t.hpp, 0);
  const totLaba = d.rows.reduce((a, t) => a + t.laba, 0);
  return `
  <div class="card">
    <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Produk — ${esc(periode())}${state.q ? ` · cari “${esc(state.q)}”` : ''}</h2>
    ${
      d.rows.length
        ? `<table class="mt-2 w-full text-left text-sm">
        <thead><tr><th class="th">Produk</th><th class="th text-right">Omzet</th><th class="th text-right">HPP</th><th class="th text-right">Laba</th></tr></thead>
        <tbody>${rows}
          <tr>
            <td class="td font-semibold">Jumlah (${d.total} produk)</td>
            <td class="td td-num font-semibold">${rp(totOmzet)}</td>
            <td class="td td-num font-semibold">${rp(totHpp)}</td>
            <td class="td td-num font-semibold">${rp(totLaba)}</td>
          </tr>
        </tbody>
      </table>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Dikelompokkan per (nama, satuan). Laba dihitung server = omzet − diskon baris − HPP
        (snapshot saat jual; diskon transaksi tidak dialokasikan per baris).
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

/* ---------- CSV per menu ---------- */

function csvHarian(): (string | number)[][] {
  const l = state.data!;
  const ret = l.retur ?? { n: 0, total: 0 };
  return [
    ['Laporan harian', 'Ravaa POS'],
    ['Tanggal', l.date],
    [],
    ['Ringkasan'],
    ['Transaksi', l.sales.n],
    ['Omzet', l.sales.omzet],
    ['Diskon', l.sales.diskon],
    ['HPP', l.hpp],
    ['Laba', l.laba],
    ['Retur', ret.total],
    ['Omzet bersih', l.sales.omzet - ret.total],
    ['Pengeluaran', (l.expense ?? { n: 0, total: 0 }).total],
    ['Pembelian diterima', (l.purchase ?? { n: 0, total: 0 }).total],
    [],
    ['Penjualan per jam (UTC)'],
    ['Jam', 'Transaksi', 'Omzet'],
    ...(l.byHour ?? []).map((b) => [`${pad2(b.jam)}:00`, b.n, b.omzet] as [string, number, number]),
    [],
    ['Metode bayar'],
    ['Metode', 'Transaksi', 'Total'],
    ...l.byMethod.map((m) => [metode(m.pay_method), m.n, m.total] as [string, number, number]),
    [],
    ['Topup/tarik'],
    ['Jenis', 'Transaksi', 'Nominal', 'Admin'],
    ...l.topup.map((t) => [jenis(t.kind), t.n, t.nominal, t.admin] as [string, number, number, number]),
    [],
    ['Produk terlaris'],
    ['Nama', 'Satuan', 'Qty', 'Omzet', 'HPP', 'Laba'],
    ...l.topItems.map((t) => [t.name, t.unit, t.qty, t.amount, t.hpp, t.laba] as [string, string, number, number, number, number]),
    [],
    ['Stok menipis'],
    ['SKU', 'Nama', 'Stok', 'Minimum'],
    ...l.lowStock.map((p) => [p.sku, p.name, p.stock, p.min_stock] as [string, string, number, number]),
  ];
}

function csvLaba(): (string | number)[][] {
  const d = state.laba!;
  const margin = d.total.omzet > 0 ? Math.round((d.total.laba / d.total.omzet) * 100) : 0;
  return [
    ['Laporan laba', 'Ravaa POS'],
    ['Periode', `${d.from} s/d ${d.to}`],
    [],
    ['Ringkasan'],
    ['Transaksi', d.total.n],
    ['Omzet', d.total.omzet],
    ['HPP', d.total.hpp],
    ['Laba kotor', d.total.laba],
    ['Margin (%)', margin],
    [],
    ['Laba per hari'],
    ['Tanggal', 'Transaksi', 'Omzet', 'HPP', 'Laba'],
    ...d.days.map((h) => [h.date, h.n, h.omzet, h.hpp, h.laba] as [string, number, number, number, number]),
    [],
    ['Laba per transaksi (200 terbaru)'],
    ['Waktu', 'Nota', 'Kasir', 'Omzet', 'HPP', 'Laba'],
    ...d.trx.map((t) => [String(t.created_at), t.invoice_no ?? '', t.cashier, t.total, t.hpp, t.laba] as [string, string, string, number, number, number]),
  ];
}

function csvKasir(): (string | number)[][] {
  const d = state.kasir!;
  return [
    ['Laporan kasir', 'Ravaa POS'],
    ['Periode', `${d.from} s/d ${d.to}`],
    [],
    ['Kasir', 'Transaksi', 'Omzet', 'Diskon'],
    ...d.rows.map((r) => [r.cashier, r.n, r.omzet, r.diskon] as [string, number, number, number]),
    ['Jumlah', d.total.n, d.total.omzet, d.total.diskon],
  ];
}

function csvProduk(): (string | number)[][] {
  const d = state.produk!;
  return [
    ['Laporan produk', 'Ravaa POS'],
    ['Periode', `${d.from} s/d ${d.to}`],
    [],
    ['Nama', 'Satuan', 'Qty', 'Omzet', 'HPP', 'Laba'],
    ...d.rows.map((t) => [t.name, t.unit, t.qty, t.amount, t.hpp, t.laba] as [string, string, number, number, number, number]),
  ];
}

function csvPiutang(): (string | number)[][] {
  const l = state.sumData!;
  return [
    ['Laporan piutang', 'Ravaa POS'],
    ['Periode', `${l.from} s/d ${l.to}`],
    [],
    ['Hutang terbentuk', l.piutang?.baru ?? 0],
    ['Piutang terbayar', l.piutang?.bayar ?? 0],
    ['Sisa berjalan kini', state.sisaPiutang],
  ];
}

function csvStok(): (string | number)[][] {
  const l = state.sumData!;
  return [
    ['Stok perlu dikulak', 'Ravaa POS'],
    [],
    ['SKU', 'Nama', 'Stok', 'Minimum', 'Kurang', 'Saran order'],
    ...l.lowStock.map(
      (p) =>
        [p.sku, p.name, p.stock, p.min_stock, p.min_stock - p.stock, Math.max(0, p.min_stock - p.stock)] as [
          string,
          string,
          number,
          number,
          number,
          number,
        ],
    ),
  ];
}

/* ---------- cetak / PDF per menu ---------- */

async function cetakHarian(): Promise<void> {
  const l = state.data;
  if (!l) return;
  const ret = l.retur ?? { n: 0, total: 0 };
  const bh = l.byHour ?? [];
  const teramai = bh.length ? bh.reduce((a, b) => (b.omzet > a.omzet ? b : a), bh[0]) : null;
  const baris: string[][] = [
    ['Omzet', rp(l.sales.omzet)],
    ['Retur', rp(ret.total)],
    ['Omzet bersih', rp(l.sales.omzet - ret.total)],
    ['Laba', rp(l.laba)],
    ['HPP', rp(l.hpp)],
    ['Diskon', rp(l.sales.diskon)],
    ['Pengeluaran', rp((l.expense ?? { n: 0, total: 0 }).total)],
    ['Pembelian diterima', rp((l.purchase ?? { n: 0, total: 0 }).total)],
    ...(teramai && teramai.n > 0
      ? [[`Jam teramai ${pad2(teramai.jam)}:00`, `${rp(teramai.omzet)} · ${teramai.n} trx`]]
      : []),
    ...l.byMethod.map((m) => [`${metode(m.pay_method)} (${m.n}x)`, rp(m.total)]),
  ];
  await cetakLaporan({
    judul: 'LAPORAN HARIAN',
    periode: tglPanjang(l.date),
    meta: [['Transaksi', String(l.sales.n)]],
    kolom: [{ label: 'Uraian' }, { label: 'Nilai', kanan: true }],
    baris,
    ringkas: [['Omzet bersih', rp(l.sales.omzet - ret.total)]],
    catatan: 'Topup/tarik tidak masuk omzet. Jam teramai memakai UTC.',
  });
}

async function cetakLaba(): Promise<void> {
  const d = state.laba;
  if (!d) return;
  const margin = d.total.omzet > 0 ? Math.round((d.total.laba / d.total.omzet) * 100) : 0;
  await cetakLaporan({
    judul: 'LAPORAN LABA',
    periode: `${d.from} s/d ${d.to}`,
    meta: [['Transaksi', String(d.total.n)]],
    kolom: [
      { label: 'Tanggal' },
      { label: 'Trx', kanan: true },
      { label: 'Omzet', kanan: true },
      { label: 'HPP', kanan: true },
      { label: 'Laba', kanan: true },
    ],
    baris: d.days.map((h) => [h.date, String(h.n), rp(h.omzet), rp(h.hpp), rp(h.laba)]),
    ringkas: [
      ['Total laba', rp(d.total.laba)],
      ['Margin', `${margin}%`],
    ],
    catatan: 'Laba = omzet − HPP (modal tertimbang tersnapshot saat jual).',
  });
}

async function cetakKasir(): Promise<void> {
  const d = state.kasir;
  if (!d) return;
  await cetakLaporan({
    judul: 'LAPORAN KASIR',
    periode: `${d.from} s/d ${d.to}`,
    meta: [['Transaksi', String(d.total.n)]],
    kolom: [{ label: 'Kasir' }, { label: 'Trx', kanan: true }, { label: 'Omzet', kanan: true }, { label: 'Diskon', kanan: true }],
    baris: d.rows.map((r) => [r.cashier, String(r.n), rp(r.omzet), rp(r.diskon)]),
    ringkas: [['Total omzet', rp(d.total.omzet)]],
  });
}

async function cetakProduk(): Promise<void> {
  const d = state.produk;
  if (!d) return;
  const totLaba = d.rows.reduce((a, t) => a + t.laba, 0);
  await cetakLaporan({
    judul: 'LAPORAN PRODUK',
    periode: `${d.from} s/d ${d.to}`,
    meta: state.q ? [['Cari', state.q]] : [],
    kolom: [{ label: 'Produk' }, { label: 'Qty', kanan: true }, { label: 'Omzet', kanan: true }, { label: 'HPP', kanan: true }, { label: 'Laba', kanan: true }],
    baris: d.rows.map((t) => [`${t.name} (${t.unit})`, String(t.qty), rp(t.amount), rp(t.hpp), rp(t.laba)]),
    ringkas: [['Total laba', rp(totLaba)]],
  });
}

async function cetakPiutang(): Promise<void> {
  const l = state.sumData;
  if (!l) return;
  await cetakLaporan({
    judul: 'LAPORAN PIUTANG',
    periode: `${l.from} s/d ${l.to}`,
    meta: [],
    kolom: [{ label: 'Uraian' }, { label: 'Nilai', kanan: true }],
    baris: [
      ['Hutang terbentuk', rp(l.piutang?.baru ?? 0)],
      ['Piutang terbayar', rp(l.piutang?.bayar ?? 0)],
    ],
    ringkas: [['Sisa berjalan kini', rp(state.sisaPiutang)]],
    catatan: 'Rincian per pelanggan ada di halaman Hutang.',
  });
}

async function cetakStok(): Promise<void> {
  const l = state.sumData;
  if (!l) return;
  await cetakLaporan({
    judul: 'STOK PERLU DIKULAK',
    periode: `${l.from} s/d ${l.to}`,
    meta: [['Item', String(l.lowStock.length)]],
    kolom: [{ label: 'Produk' }, { label: 'Stok', kanan: true }, { label: 'Min', kanan: true }, { label: 'Saran order', kanan: true }],
    baris: l.lowStock.map((p) => [`${p.name} (${p.sku})`, String(p.stock), String(p.min_stock), String(Math.max(0, p.min_stock - p.stock))]),
    ringkas: [],
  });
}

/* ---------- registry menu (SATU tempat untuk seluruh katalog) ---------- */

const defHarian: MenuDef = {
  id: 'harian',
  label: 'Harian',
  grup: 'Penjualan',
  filter: 'hari',
  ada: () => !!state.data,
  muat: async () => {
    const j = await apiGet<{ data: Laporan }>(`/api/reports/daily?date=${encodeURIComponent(state.date)}`);
    state.data = j.data;
  },
  isi: harianIsi,
  csv: csvHarian,
  cetak: cetakHarian,
};

const defLaba: MenuDef = {
  id: 'laba',
  label: 'Laba',
  grup: 'Penjualan',
  filter: 'rentang',
  ada: () => !!state.laba,
  muat: async () => {
    const p = new URLSearchParams({ from: state.from, to: state.to });
    const j = await apiGet<{ data: ProfitData }>(`/api/reports/profit?${p}`);
    state.laba = j.data;
  },
  isi: labaView,
  csv: csvLaba,
  cetak: cetakLaba,
};

const defKasir: MenuDef = {
  id: 'kasir',
  label: 'Kasir',
  grup: 'Penjualan',
  filter: 'rentang',
  ada: () => !!state.kasir,
  muat: async () => {
    const j = await apiGet<{ data: KasirData }>(
      `/api/reports/cashiers?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`,
    );
    state.kasir = j.data;
  },
  isi: kasirView,
  csv: csvKasir,
  cetak: cetakKasir,
};

const defProduk: MenuDef = {
  id: 'produk',
  label: 'Produk',
  grup: 'Penjualan',
  filter: 'rentang',
  cari: true,
  ada: () => !!state.produk,
  muat: async () => {
    const p = new URLSearchParams({ from: state.from, to: state.to, limit: '50' });
    if (state.q) p.set('q', state.q);
    const j = await apiGet<{ data: ProdukData }>(`/api/reports/products?${p}`);
    state.produk = j.data;
  },
  isi: produkView,
  csv: csvProduk,
  cetak: cetakProduk,
};

const defPiutang: MenuDef = {
  id: 'piutang',
  label: 'Piutang',
  grup: 'Keuangan',
  filter: 'rentang',
  ada: () => !!state.sumData,
  muat: async () => {
    const j = await apiGet<{ data: Omit<Laporan, 'date'> & { from: string; to: string } }>(
      `/api/reports/summary?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`,
    );
    state.sumData = j.data;
    // Sisa berjalan live (saldo seluruh pelanggan, bukan per periode).
    const s = await apiGet<{ data: unknown; total: number }>('/api/customer-debts?status=open');
    state.sisaPiutang = s.total;
  },
  isi: piutangView,
  csv: csvPiutang,
  cetak: cetakPiutang,
};

const defStok: MenuDef = {
  id: 'stok',
  label: 'Stok',
  grup: 'Stok',
  filter: 'rentang',
  ada: () => !!state.sumData,
  muat: async () => {
    const j = await apiGet<{ data: Omit<Laporan, 'date'> & { from: string; to: string } }>(
      `/api/reports/summary?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`,
    );
    state.sumData = j.data;
  },
  isi: stokView,
  csv: csvStok,
  cetak: cetakStok,
};

const MENUS: MenuDef[] = [defHarian, defLaba, defKasir, defProduk, defPiutang, defStok];
const defAktif = (): MenuDef => MENUS.find((m) => m.id === state.menu) ?? defHarian;

/* ---------- preset & kalender dialog rentang ----------
 * Dialog rentang tanggal (permintaan pemilik 2026-10-17, referensi
 * date-picker Blueprint: preset di KIRI, dua kalender di KANAN). Daftar
 * preset = baku Aronium/Loyverse + konvensi Indonesia ("Minggu ini" =
 * Senin–hari ini; "Minggu lalu" sengaja tidak ada — pemilik menutup daftar
 * di "Tahun lalu" + Kustom). Aritmetika lewat ui/waktu.ts (satu aturan hari
 * UTC, §2 AGENTS) — jangan hitung tanggal sendiri di sini. */
const PRESETS: { id: string; label: string; rentang: () => [string, string] }[] = [
  { id: 'hari-ini', label: 'Hari ini', rentang: () => [hariIni(), hariIni()] },
  { id: 'kemarin', label: 'Kemarin', rentang: () => [geser(hariIni(), -1), geser(hariIni(), -1)] },
  { id: '7-hari', label: '7 hari terakhir', rentang: () => [geser(hariIni(), -6), hariIni()] },
  { id: '30-hari', label: '30 hari terakhir', rentang: () => [geser(hariIni(), -29), hariIni()] },
  { id: 'minggu-ini', label: 'Minggu ini', rentang: () => [awalMinggu(hariIni()), hariIni()] },
  { id: 'bulan-ini', label: 'Bulan ini', rentang: () => [awalBulan(hariIni()), hariIni()] },
  {
    id: 'bulan-lalu',
    label: 'Bulan lalu',
    rentang: () => {
      const akhir = akhirBulan(geser(awalBulan(hariIni()), -1)); // -1 hari dari tgl 1 = akhir bulan lalu
      return [awalBulan(akhir), akhir];
    },
  },
  {
    id: 'tahun-lalu',
    label: 'Tahun lalu',
    rentang: () => {
      const th = Number(hariIni().slice(0, 4)) - 1;
      return [`${th}-01-01`, `${th}-12-31`];
    },
  },
];

/** Id preset yang PERSIS sama dengan rentang `a`..`z` (null = Kustom). */
const presetCocok = (a: string, z: string): string | null =>
  PRESETS.find((pr) => {
    const [x, y] = pr.rentang();
    return x === a && y === z;
  })?.id ?? null;

const NAMA_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
/** Kepala kolom kalender ala kalender Indonesia (Senin..Minggu). */
const HARI_SINGKAT = ['S', 'S', 'R', 'K', 'J', 'S', 'M'];

/** Bulan sebagai indeks absolut `tahun*12 + bulan(0..11)` — navigasi bulan
 *  jadi sekadar +1/-1 tanpa if rollover Desember/Januari. */
const ymAbs = (iso: string): number => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/** Kelas satu sel hari — dipakai render awal DAN penyorotan hover (satu
 *  rumus, jadi highlight tidak bisa beda antara dua jalur). */
function kelasHari(iso: string, luarBulan: boolean, a: string, z: string): string {
  return [
    'drp-day',
    luarBulan ? 'is-out' : '',
    iso === hariIni() ? 'is-today' : '',
    iso === a || iso === z ? 'is-edge' : iso > a && iso < z ? 'is-in' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Satu grid bulan (6 baris tetap supaya tinggi dialog tidak melompat saat
 *  pindah bulan). Hari bulan sebelah tetap bisa diklik — perilaku baku
 *  date-picker. */
function bulanHtml(ym: number, a: string, z: string): string {
  const th = Math.floor(ym / 12);
  const bl = ym % 12;
  const mulai = (new Date(Date.UTC(th, bl, 1)).getUTCDay() + 6) % 7; // 0 = Senin
  const jml = new Date(Date.UTC(th, bl + 1, 0)).getUTCDate();
  let sel = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(th, bl, i - mulai + 1)); // overflow hari otomatis geser bulan
    const iso = d.toISOString().slice(0, 10);
    const luar = d.getUTCMonth() !== bl;
    sel += `<button type="button" class="${kelasHari(iso, luar, a, z)}" data-iso="${iso}"${luar ? ' data-out="1"' : ''}>${d.getUTCDate()}</button>`;
  }
  return `<div class="drp-grid">${HARI_SINGKAT.map((h) => `<span class="drp-dow" aria-hidden="true">${h}</span>`).join('')}${sel}</div>`;
}

/* ---------- render: kerangka (menu kiri + toolbar + isi) ---------- */

function menuKiri(): string {
  const grupUrut: GrupMenu[] = ['Penjualan', 'Keuangan', 'Stok'];
  const seksi = grupUrut
    .map((g) => {
      const tombol = MENUS.filter((m) => m.grup === g)
        .map((m) => {
          const aktif = state.menu === m.id;
          return `<button type="button" data-menu="${m.id}" class="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
            aktif
              ? 'bg-primary-soft font-semibold text-primary dark:bg-primary/15 dark:text-primary'
              : 'font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800'
          }"${aktif ? ' aria-current="page"' : ''}>${esc(m.label)}</button>`;
        })
        .join('');
      return `
      <p class="hidden px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-widest text-primary lg:block">${g}</p>
      ${tombol}`;
    })
    .join('');
  // Empat putaran revisi pemilik soal kolom ini (2026-10-17): (1) "tingginya
  // tidak sama dengan yang kanan" -> sempat di-stretch penuh; (2) "aside jadi
  // tidak sticky lagi" -> sticky dipasang di blok isi saja; (3) "cardnya
  // mengikuti tinggi kolom kanan — yang full hanya Harian/Laba ... hanya
  // textnya yang sticky" -> KARTU TIDAK LAGI mengikuti tinggi baris grid:
  // `<aside>` kini pembungkus TANPA visual yang tetap stretch sebagai
  // CONTAINING BLOCK sticky, sehingga SELURUH kartu (border+judul+menu)
  // setinggi kontennya sendiri dan ikut menempel saat digulir. Label grup
  // (`text-primary` + jarak atas `pt-4`) dibedakan tegas dari tombol menu.
  // (4) "jadikan template untuk semua laporan, agar perilaku dan layout sama
  // persis" -> inset sticky `top-0` (BUKAN top-4): inset positif membuat
  // kartu tergeser turun 16px HANYA di menu yang kolom kanannya memberi ruang
  // geser (terukur: Harian/Laba/Produk y=72 vs Kasir/Piutang/Stok y=56);
  // dengan top-0 posisi kartu identik di KEENAM menu (y=56, sejajar kolom
  // kanan) dan tetap menempel di posisi itu saat digulir (56 -> 56).
  return `
  <aside aria-label="Menu laporan">
    <div class="card lg:sticky lg:top-0">
      <p class="form-sec hidden lg:block">Menu laporan</p>
      <div class="grid grid-cols-2 gap-1 lg:mt-2 lg:block lg:gap-0">${seksi}</div>
    </div>
  </aside>`;
}

function toolbar(): string {
  const def = defAktif();
  const hariIniKah = state.date === hariIni();
  const aksi = `
        <button type="button" id="rp-print" class="btn btn-ghost !min-h-[38px] !px-3 !py-2" ${def.ada() ? '' : 'disabled'}>
          ${icon('print')}<span>Cetak / PDF</span>
        </button>
        <button type="button" id="rp-csv" class="btn btn-ghost !min-h-[38px] !px-3 !py-2" ${def.ada() ? '' : 'disabled'}>
          ${icon('download')}<span>Ekspor CSV</span>
        </button>`;
  const filterHarian = `
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-h="prev" class="row-btn" title="Hari sebelumnya" aria-label="Hari sebelumnya">${icon('chevL')}</button>
        <input id="rp-date" type="date" class="input input-sm !w-44" value="${esc(state.date)}" aria-label="Pilih tanggal laporan" />
        <button type="button" data-h="next" class="row-btn" title="Hari berikutnya" aria-label="Hari berikutnya">${icon('chevR')}</button>
        ${hariIniKah ? '' : `<button type="button" id="rp-today" class="chip">${icon('calendar')}<span>Hari ini</span></button>`}
        <span class="chip">${icon('calendar')}<span>${esc(tglPanjang(state.date))}</span></span>
      </div>`;
  // Menu rentang: SATU tombol rentang yang membuka DROPDOWN preset+kalender
  // (referensi date-picker pemilik; direvisi jadi dropdown 2026-10-17
  // "jadikan dropdown saja jangan seperti modal" — panel melayang di bawah
  // tombol, bukan overlay). Input `#rp-from`/`#rp-to`
  // tetap ada sebagai hidden — kontrak test membaca rentang yang berlaku
  // dari situ, dan nilainya selalu ikut repaint toolbar.
  const filterRentang = `
      <div class="flex flex-wrap items-center gap-2">
        <input id="rp-from" type="hidden" value="${esc(state.from)}" />
        <input id="rp-to" type="hidden" value="${esc(state.to)}" />
        <div class="relative">
          <button type="button" id="rp-range" class="btn btn-ghost !min-h-[38px] !px-3 !py-2" aria-haspopup="dialog" aria-expanded="false" aria-label="Rentang: ${esc(tglPanjang(state.from))} s/d ${esc(tglPanjang(state.to))}" title="Pilih rentang tanggal">
            ${icon('calendar')}<span>${esc(tglPendek(state.from))} – ${esc(tglPendek(state.to))}</span>${icon('chevD')}
          </button>
          <div id="rp-pop" class="drp-pop hidden" role="dialog" aria-label="Rentang tanggal laporan"></div>
        </div>
        ${def.cari ? `
        <div class="relative">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
          <input id="rp-q" class="input input-sm pl-9 !w-52" type="search" placeholder="Cari produk…" autocomplete="off" value="${esc(state.q)}" />
        </div>` : ''}
      </div>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        ${aksi}
      </div>`;
  return `
  <div class="card">
    <div class="flex flex-wrap items-center justify-between gap-2">
      ${def.filter === 'hari' ? `${filterHarian}<div class="flex flex-wrap items-center gap-2">${aksi}</div>` : filterRentang}
    </div>
  </div>`;
}

function skeleton(): string {
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

function isi(): string {
  if (state.loading) return skeleton();
  if (state.error) {
    return `<div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat laporan: ${esc(state.error)}</span></div></div>`;
  }
  return defAktif().isi();
}

function paint(): void {
  const body = host?.querySelector('#rp-body');
  if (!body) return;
  // Dropdown rentang (kalau terbuka) ikut terbuang bersama DOM lama — lepas
  // listener document-nya dulu supaya tidak menumpuk antar repaint.
  tutupPopRentang();
  body.innerHTML = `
    <div class="grid gap-3 lg:grid-cols-[220px_1fr]">
      ${menuKiri()}
      <div class="min-w-0 space-y-3">
        ${toolbar()}
        <div class="space-y-3">${isi()}</div>
      </div>
    </div>`;
  bind();
}

function bind(): void {
  const root = host!.querySelector('#rp-body');
  if (!root) return;
  root.querySelectorAll<HTMLElement>('[data-menu]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = b.dataset.menu as MenuId;
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
  root.querySelector('#rp-range')?.addEventListener('click', () => bukaDropdownRentang());
  root.querySelector('#rp-today')?.addEventListener('click', () => {
    state.date = hariIni();
    void load();
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

/* ---------- dropdown rentang tanggal (preset kiri + dua kalender kanan) ---------- */

/** Cleanup dropdown rentang yang sedang terbuka (lepas listener document +
 *  sembunyikan panel). Dipanggil paint() juga — DOM lama terbuang tiap
 *  repaint, jadi listener tidak boleh ikut tertinggal. */
let popRentang: (() => void) | null = null;

function tutupPopRentang(fokusKembali = false): void {
  popRentang?.();
  popRentang = null;
  if (fokusKembali) host?.querySelector<HTMLElement>('#rp-range')?.focus();
}

function bukaDropdownRentang(): void {
  const pop = host?.querySelector<HTMLElement>('#rp-pop');
  const tombol = host?.querySelector<HTMLElement>('#rp-range');
  if (!pop || !tombol) return;
  const sudahTerbuka = !pop.classList.contains('hidden');
  tutupPopRentang(); // bersihkan sisa sesi lama (stale) sebelum keadaan baru
  if (sudahTerbuka) return; // klik kedua pada tombol = tutup

  // Nilai hidup di variabel lokal panel; `state` baru berubah saat Terapkan.
  let dari = state.from;
  let sampai = state.to;
  let fase: 'pilih' | 'lengkap' = 'lengkap'; // 'pilih' = menunggu klik tanggal kedua
  let hover: string | null = null;
  let ym = ymAbs(dari); // bulan grid kiri; grid kanan selalu +1
  const thSekarang = Number(hariIni().slice(0, 4));

  /** Rentang yang DISOROT — saat memilih, ikut tanggal hover. */
  const tersorot = (): [string, string] => {
    if (fase === 'lengkap') return [dari, sampai];
    const h = hover ?? dari;
    return h < dari ? [h, dari] : [dari, h];
  };
  const nHari = (): number => Math.round((Date.parse(sampai) - Date.parse(dari)) / 86400000) + 1;

  const render = (): void => {
    const [a, z] = tersorot();
    const aktif = fase === 'lengkap' ? presetCocok(dari, sampai) : null;
    const thTampil = Math.floor(ym / 12);
    const blTampil = ym % 12;
    const opsiTh = new Set<number>();
    for (let y = thSekarang - 5; y <= thSekarang + 1; y++) opsiTh.add(y);
    opsiTh.add(thTampil);
    const hari = nHari();
    const sah = fase === 'lengkap' && hari >= 1 && hari <= 366;
    pop.innerHTML = `
      <div class="flex flex-col gap-4 sm:flex-row">
        <div class="flex flex-wrap gap-1 sm:w-44 sm:flex-col sm:flex-nowrap">
          ${PRESETS.map(
            (pr) =>
              `<button type="button" data-drp-preset="${pr.id}" class="w-full rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                aktif === pr.id
                  ? 'bg-primary-soft font-semibold text-primary dark:bg-primary/15 dark:text-primary'
                  : 'font-medium text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800'
              }">${pr.label}</button>`,
          ).join('')}
          <p class="w-full rounded-lg px-3 py-1.5 text-left text-sm ${
            aktif === null
              ? 'bg-primary-soft font-semibold text-primary dark:bg-primary/15 dark:text-primary'
              : 'text-gray-400 dark:text-gray-500'
          }">Kustom</p>
        </div>
        <div class="min-w-0 flex-1">
          <div class="mb-2 flex flex-wrap items-center gap-1">
            <button type="button" data-drp-nav="-1" class="row-btn" aria-label="Bulan sebelumnya">${icon('chevL')}</button>
            <select data-drp-bulan class="input input-sm !w-28" aria-label="Bulan">${NAMA_BULAN.map((n, i) => `<option value="${i}"${i === blTampil ? ' selected' : ''}>${n}</option>`).join('')}</select>
            <select data-drp-tahun class="input input-sm !w-20" aria-label="Tahun">${[...opsiTh].sort((x, y) => x - y).map((y) => `<option value="${y}"${y === thTampil ? ' selected' : ''}>${y}</option>`).join('')}</select>
            <span class="ml-auto hidden text-sm font-semibold text-gray-400 dark:text-gray-500 sm:block">${NAMA_BULAN[(blTampil + 1) % 12]} ${Math.floor((ym + 1) / 12)}</span>
            <button type="button" data-drp-nav="1" class="row-btn" aria-label="Bulan berikutnya">${icon('chevR')}</button>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>${bulanHtml(ym, a, z)}</div>
            <div class="hidden sm:block">${bulanHtml(ym + 1, a, z)}</div>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-700">
            <span class="chip">${esc(tglPanjang(dari))}</span>
            <span class="text-xs text-gray-400">s/d</span>
            <span class="chip">${fase === 'lengkap' ? esc(tglPanjang(sampai)) : 'pilih tanggal akhir…'}</span>
            ${fase === 'lengkap' ? `<span class="ml-auto text-xs text-gray-500 dark:text-gray-400">${hari} hari</span>` : ''}
          </div>
          ${fase === 'lengkap' && hari > 366 ? '<p class="mt-2 text-xs font-semibold text-red-600 dark:text-red-400">Rentang melebihi 366 hari — perpendek rentangnya, server menolak laporan sepanjang ini.</p>' : ''}
        </div>
      </div>
      <div class="mt-3 flex items-center justify-end gap-2 border-t border-gray-100 pt-3 dark:border-gray-700">
        <button type="button" data-drp-batal class="btn btn-ghost !min-h-[38px] !px-4">Batal</button>
        <button type="button" data-drp-ok class="btn btn-primary !min-h-[38px] !px-4">Terapkan</button>
      </div>`;
    const ok = pop.querySelector<HTMLButtonElement>('[data-drp-ok]');
    if (ok) ok.disabled = !sah;
  };

  /** Sorot ulang sel hari saja (hover) — tanpa render ulang seluruh panel. */
  const segarkan = (): void => {
    const [a, z] = tersorot();
    pop.querySelectorAll<HTMLElement>('[data-iso]').forEach((b) => {
      b.className = kelasHari(b.dataset.iso as string, b.dataset.out === '1', a, z);
    });
  };

  pop.classList.remove('hidden');
  tombol.setAttribute('aria-expanded', 'true');
  render();
  pop.querySelector<HTMLButtonElement>('[data-drp-preset]')?.focus();

  // Listener document (klik luar + Esc) hidup hanya selama panel terbuka;
  // AbortController melepas semuanya sekali tutup (pola dropdown shell.ts).
  const ac = new AbortController();
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest('#rp-pop, #rp-range')) return;
      tutupPopRentang();
    },
    { capture: true, signal: ac.signal },
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      tutupPopRentang(true);
    },
    { signal: ac.signal },
  );
  popRentang = () => {
    ac.abort();
    pop.classList.add('hidden');
    tombol.setAttribute('aria-expanded', 'false');
  };

  pop.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const nav = t.closest<HTMLElement>('[data-drp-nav]');
    if (nav) {
      ym += Number(nav.dataset.drpNav);
      render();
      return;
    }
    const pr = t.closest<HTMLElement>('[data-drp-preset]');
    if (pr) {
      const p = PRESETS.find((x) => x.id === pr.dataset.drpPreset);
      if (p) {
        [dari, sampai] = p.rentang();
        fase = 'lengkap';
        hover = null;
        ym = ymAbs(dari);
        render();
      }
      return;
    }
    const sel = t.closest<HTMLElement>('[data-iso]');
    if (sel) {
      const iso = sel.dataset.iso as string;
      if (fase === 'lengkap') {
        dari = iso;
        sampai = iso;
        fase = 'pilih'; // klik berikutnya menutup rentang
        hover = null;
      } else if (iso < dari) {
        sampai = dari;
        dari = iso;
        fase = 'lengkap';
      } else {
        sampai = iso;
        fase = 'lengkap';
      }
      render();
      return;
    }
    if (t.closest('[data-drp-batal]')) {
      tutupPopRentang(true);
      return;
    }
    if (t.closest('[data-drp-ok]')) {
      state.from = dari;
      state.to = sampai;
      tutupPopRentang();
      void load();
    }
  });
  pop.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.matches('[data-drp-bulan]')) ym = Math.floor(ym / 12) * 12 + Number(t.value);
    else if (t.matches('[data-drp-tahun]')) ym = Number(t.value) * 12 + (ym % 12);
    else return;
    render();
  });
  pop.addEventListener('mouseover', (e) => {
    if (fase !== 'pilih') return;
    const c = (e.target as HTMLElement).closest<HTMLElement>('[data-iso]');
    const iso = c?.dataset.iso ?? null;
    if (iso === hover) return;
    hover = iso;
    segarkan();
  });
}

/* ---------- ekspor CSV / cetak (pembalut registry) ---------- */

function namaFileCsv(): string {
  return state.menu === 'harian'
    ? `laporan-${state.date}.csv`
    : `laporan-${state.menu}-${state.from}_sd_${state.to}.csv`;
}

function eksporCSV(): void {
  const b = defAktif().csv();
  if (!b) return;
  unduhCSV(b.map((r) => r.map(sel).join(',')).join('\r\n'), namaFileCsv());
}

async function cetak(): Promise<void> {
  try {
    await defAktif().cetak();
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
    await defAktif().muat();
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
