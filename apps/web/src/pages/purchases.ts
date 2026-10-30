// Halaman Pembelian (#/purchases, Tahap 3 2026-10-11): nota kulakan ke
// supplier — order dulu, barang datang baru receive (stok masuk), bayar tunai
// (bawaan lunas; boleh sisa hutang — keputusan pemilik (b): praktik selalu
// tunai, kolom hutang hanya bila suatu saat terjadi).
//
// **Sub-halaman, BUKAN modal (2026-10-17)** — permintaan pemilik: "PO
// purchasing buat halaman saja jangan modal, rawan terklik di luar modal dan
// hilang". Rute: `#/purchases` daftar · `#/purchases/baru` form PO ·
// `#/purchases/<id>` rincian + aksi inline (Terima/Bayar). Batalkan tetap
// `confirmDialog` (konfirmasi destruktif — tidak ada input yang bisa hilang).
// `parseRoute` mencocokkan segmen pertama, jadi nav "Pembelian" tetap aktif.
//
// Server: GET /api/purchases?status=&limit=&offset= (+`sisa` computed,
// `n_items`), GET /api/purchases/:id, POST /api/purchases (order, tanpa stok),
// POST /:id/receive (stok masuk rumus restock + terbayar + shift),
// POST /:id/pay (cicil sisa, maks total), POST /:id/cancel (order saja).
// Kas keluar = `terbayar` di shift PO (agregat purchase_total → kasSeharusnya).
//
// **Cetak A4 nota PO (butir ROADMAP 1.6.3, ACC pemilik 19 Okt 2026)**: tombol
// "Cetak A4" di rincian (`#/purchases/<id>`) membangun dokumen cetak browser
// (kop `store_*`, supplier, item, Total/Terbayar/Sisa) — pola `cetakHutangA4`
// debts.ts (popup + window.print, TANPA print-agent); gagal = toast.
//
// **Revisi layout 2026-10-17 kedua** (permintaan pemilik: "refactor desain
// layout purchasing, PO, dan /#/purchases/190 agar lebih mudah dibaca" +
// chip filter "seperti tidak terlihat, begitu juga di laporan" + "pencarian
// produk buat dropdown saja" + "kebingungan mencari purchasing yang belum
// lunas"): filter status = segmented `.chip-tabs`/`.chip-tab` (kini termasuk
// **"Belum lunas"** — server `?status=hutang` = received bersisa, computed);
// chip `#po-lewat` KLIK = saring ke "Belum lunas"; daftar dapat kolom Sisa +
// tanggal di bawah nomor; form PO = hasil cari berupa DROPDOWN (disaring
// barang fisik `track_stock` saja — jasa ditolak server; klik → baris masuk
// qty 1 + harga beli master, lalu diedit di TABEL baris editable) dan
// rincian PO = TABEL barang (qty/harga beli/sub total) + tfoot
// Total/Terbayar/Sisa.

import { apiGet, apiPost } from '../api';
import { icon } from '../ui/icons';
import { punyaIzin } from '../ui/auth';
import { confirmDialog } from '../ui/confirm';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { pasangAksiBaru } from '../ui/aksi-baru';
import { toast } from '../ui/toast';
import { getCashier } from '../ui/user';
import { tglPendek } from '../ui/waktu';
import { rp } from '../escpos';
import { esc } from '../ui/html';
import { errMsg } from '../ui/http';
// Slot logo bersama semua dokumen A4 (permintaan pemilik 19 Okt 2026) —
// helper tinggal di invoice.ts, dipakai juga oleh debts.ts & rekap/laporan.
import { CSS_LOGO_A4, bukaTabCetak, footerDokumenA4, logoA4Html, rpIdr, tglSingkat, tglLengkap, cityToko } from '../invoice';

type Po = {
  id: number; created_at: string;
  supplier_id: number | null; supplier_name: string;
  status: 'order' | 'received' | 'cancel';
  /** Status TAMPIL dari server (butir 3.7, 2026-10-25): `sebagian` = sudah ada
   *  kedatangan tapi qty belum lengkap — status tersimpan tetap `order` (CHECK
   *  lama tidak diubah). Klien tidak menurunkan sendiri dari angka. */
  status_tampil: 'order' | 'sebagian' | 'received' | 'cancel';
  total: number; terbayar: number;
  /** Nilai barang yang SUDAH diterima (Σ kedatangan; nota lama = total). */
  diterima: number;
  /** Sisa hutang supplier atas barang yang SUDAH diterima (0 = lunas). */
  sisa: number;
  /** Nilai barang yang BELUM datang — bukan hutang, hanya progress. */
  sisa_terima: number;
  n_terima: number;
  /** Retur ke supplier (butir ROADMAP 1.9, 2026-10-26): Σ nilai retur +
   *  jumlah event — mengurangi hutang via `sisa` (computed server). */
  retur_total: number;
  n_retur: number;
  cashier: string; shift_id: number | null; received_at: string | null;
  note: string; n_items: number;
  /** Usia hutang supplier (hari sejak DITERIMA, dihitung server 2026-10-16).
   *  null = bukan hutang (order/batal/lunas) — badge umur hanya muncul saat
   *  masih ada sisa. */
  umur_hari: number | null;
};

type PoItem = {
  id: number; purchase_id: number; product_id: number; name: string;
  qty: number; harga_beli: number; amount: number;
  /** Qty yang sudah diterima (Σ kedatangan; nota lama = qty penuh). */
  diterima: number;
  /** Qty yang masih ditunggu (qty − diterima). */
  sisa_terima: number;
};

type PoReceiveItem = {
  id: number; receive_id: number; purchase_item_id: number;
  qty: number; harga_beli: number; amount: number;
  name: string; qty_po: number;
};

type PoReceive = {
  id: number; purchase_id: number; created_at: string;
  shift_id: number | null; cashier: string;
  total: number; dibayar: number; note: string;
  n_items: number; items: PoReceiveItem[];
}

/** Retur ke supplier (butir ROADMAP 1.9) — bentuk mirror PoReceive. */
type PoReturItem = {
  id: number; retur_id: number; purchase_item_id: number;
  qty: number; harga_beli: number; amount: number;
  name: string; qty_po: number;
};

type PoRetur = {
  id: number; purchase_id: number; created_at: string;
  shift_id: number | null; cashier: string;
  total: number; note: string;
  n_items: number; items: PoReturItem[];
};

type SupplierOpt = { id: number; code: string; name: string };
type ProdukCari = { id: number; sku: string; name: string; price: number; cost: number; stock: number; track_stock: number };

const state = {
  status: 'semua',
  items: [] as Po[],
  total: 0,
  // Pengingat hutang supplier (2026-10-16): jumlah PO received bersisa >30 hari
  // (dihitung server dari seluruh nota, bukan cuma halaman ini).
  lewat30: 0,
  // Paginasi (2026-10-11): RESET ke 0 setiap status berubah.
  offset: 0,
  limit: PAGE_SIZE,
  loading: true,
  error: '',
  shiftId: null as number | null,
  suppliers: [] as SupplierOpt[],
};

let host: HTMLElement | null = null;
let cariTimer: ReturnType<typeof setTimeout> | undefined;

const STATUS: { key: string; label: string }[] = [
  { key: 'semua', label: 'Semua' },
  { key: 'order', label: 'Order' },
  // Computed di server (butir 3.7, 2026-10-25): sudah ada kedatangan tapi qty
  // belum lengkap. Status tersimpan tetap `order` sampai barang terakhir masuk.
  { key: 'sebagian', label: 'Sebagian' },
  { key: 'received', label: 'Diterima' },
  // Computed di server: nota received yang masih bersisa (bukan status
  // tersimpan) — jawaban "kebingungan mencari purchasing yang belum lunas".
  { key: 'hutang', label: 'Belum lunas' },
  { key: 'cancel', label: 'Batal' },
];

function badge(p: Po): string {
  const tampil = p.status_tampil ?? p.status;
  // `data-po-badge` = penanda status (bukan teks bebas) — nama supplier bisa
  // memuat kata "Sebagian"/"Lunas" dan membuat pembaca baris salah sangka.
  if (tampil === 'cancel') {
    return `<span data-po-badge class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:bg-gray-500/15 dark:text-gray-400">Batal</span>`;
  }
  if (tampil === 'order') {
    return `<span data-po-badge class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">Order</span>`;
  }
  // "Sebagian" = progress kedatangan, BUKAN status bayar — badge biru supaya
  // tidak tertukar dengan chip merah "Hutang" (uang).
  if (tampil === 'sebagian') {
    return `<span data-po-badge class="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary dark:bg-primary/15 dark:text-[#6aa5ff]">Sebagian</span>`;
  }
  if ((p.sisa ?? 0) > 0) {
    return `<span data-po-badge class="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700 dark:bg-red-500/15 dark:text-red-400">Hutang ${rp(p.sisa)}</span>`;
  }
  return `<span data-po-badge class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">Lunas</span>`;
}

/** Sub-baris status: untuk PO "Sebagian" yang uangnya masih kurang, badge
 *  biru saja menyembunyikan hutang — filter "Belum lunas" menampungnya, jadi
 *  angkanya wajib terlihat di baris daftar. */
function subHutang(p: Po): string {
  return (p.status_tampil ?? p.status) === 'sebagian' && (p.sisa ?? 0) > 0
    ? `<div class="cell-sub font-semibold !text-red-600 dark:!text-red-400">Hutang ${rp(p.sisa)}</div>`
    : '';
}

function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="chip-tabs" role="tablist" aria-label="Filter status pembelian">
          ${STATUS.map((s) => `<button type="button" data-pstatus="${s.key}" class="chip-tab${state.status === s.key ? ' is-active' : ''}">${s.label}</button>`).join('')}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="chip cursor-pointer !border-amber-500/40 !text-amber-700 dark:!text-amber-400" id="po-lewat" hidden
                title="Ada nota diterima dengan sisa hutang lebih dari 30 hari — klik untuk lihat semua yang belum lunas">
            ${icon('alert')}<span id="po-lewat-n">0</span><span>lewat 30 hari</span>
          </button>
          <button type="button" id="po-new" class="btn btn-primary" title="Buat PO baru (Alt+N)">${icon('plus')}<span>Buat PO</span><kbd class="kbd">Alt+N</kbd></button>
        </div>
      </div>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Order dulu, barang datang baru Terima — boleh bertahap: tiap kedatangan menambah stok & mencatat kas keluar sendiri. Barang yang belum datang bukan hutang; sisa uang disaring lewat filter <b>Belum lunas</b>.</p>
    </div>
    <div id="po-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat pembelian: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.items.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('truck')}
        <span>${
          state.status === 'hutang'
            ? 'Belum ada nota pembelian yang belum lunas — semua PO diterima sudah lunas.'
            : `Belum ada nota pembelian${state.status === 'semua' ? '.' : ' status ini.'}`
        }</span>
      </div>
    </div>`;
  }
  const rows = state.items
    .map((o) => {
      // Umur hutang supplier (2026-10-16): hari sejak barang diterima; server
      // hanya mengirim angka untuk nota yang masih bersisa.
      const umur = o.umur_hari ?? null;
      const sisa = (o.status_tampil ?? o.status) !== 'cancel' && o.sisa > 0
        ? `<span class="font-semibold text-red-600 dark:text-red-400">${rp(o.sisa)}</span>`
        : '<span class="text-gray-400">—</span>';
      const progress = (o.diterima ?? 0) > 0 && (o.diterima ?? 0) < o.total
        ? `<div class="cell-sub tabular-nums">diterima ${rp(o.diterima)}</div>`
        : '';
      return `
      <tr data-row="${o.id}" class="cursor-pointer" data-po-buka="${o.id}" title="Buka rincian">
        <td class="td">
          <div class="cell-strong tabular-nums">PO-${o.id}</div>
          <div class="cell-sub tabular-nums">${esc(tglPendek(o.created_at.slice(0, 10)))}</div>
        </td>
        <td class="td">
          <div class="cell-strong">${esc(o.supplier_name || 'Tanpa supplier')}</div>
          <div class="cell-sub">${o.n_items} baris${o.shift_id ? ` · Shift #${o.shift_id}` : ''} · ${esc(o.cashier)}</div>
        </td>
        <td class="td">${badge(o)}${subHutang(o)}${
          umur === null
            ? ''
            : `<div class="cell-sub tabular-nums${umur >= 30 ? ' font-semibold !text-red-600 dark:!text-red-400' : ''}"
                    title="Usia hutang sejak barang diterima">${umur <= 0 ? 'baru' : `${umur} hari`}</div>`
        }</td>
        <td class="td td-num">${rp(o.total)}${progress}</td>
        <td class="td td-num">${(o.diterima ?? 0) > 0 || o.status === 'received' ? rp(o.terbayar) : '<span class="text-gray-400">—</span>'}</td>
        <td class="td td-num">${sisa}</td>
      </tr>`;
    })
    .join('');
  return `
  <div class="card-flush">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="th">Nota</th>
            <th class="th">Supplier</th>
            <th class="th">Status</th>
            <th class="th text-right">Total</th>
            <th class="th text-right">Terbayar</th>
            <th class="th text-right">Sisa</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagerHtml(state.offset, state.limit, state.total)}
  </div>`;
}

function paint(): void {
  const body = host?.querySelector('#po-body');
  if (body) body.innerHTML = renderTable();
  host?.querySelectorAll<HTMLElement>('[data-pstatus]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.pstatus === state.status);
  });
  // Pengingat hutang supplier: chip hanya tampil bila memang ada yang lewat 30 hari.
  const lewatEl = host?.querySelector<HTMLElement>('#po-lewat');
  if (lewatEl) {
    lewatEl.hidden = state.lewat30 <= 0;
    const n = lewatEl.querySelector('#po-lewat-n');
    if (n) n.textContent = String(state.lewat30);
  }
  bindPager(host!, (o) => {
    state.offset = o;
    void load();
  });
  bindPagerLimit(host!, (v) => {
    state.limit = v;
    state.offset = 0;
    void load();
  });
  bindRows();
}

/* ---------- SUB-RUTE HALAMAN (2026-10-17) ---------- */

/** Hash `#/purchases/baru` = form PO, `#/purchases/<id>` = rincian —
 *  dua-duanya HALAMAN penuh, bukan modal (backdrop modal di luar area mudah
 *  terklik dan semua input hilang). `parseRoute` cocokkan segmen pertama,
 *  jadi nav "Pembelian" tetap aktif di sub-halaman. */
type SubRute = { view: 'list' } | { view: 'baru' } | { view: 'detail'; id: number };

function subRute(): SubRute {
  const seg = (location.hash.replace(/^#\/?/, '').split('?')[0] ?? '').split('/');
  if (seg[0] !== 'purchases') return { view: 'list' };
  if (seg[1] === 'baru') return { view: 'baru' };
  const id = Number(seg[1]);
  if (Number.isInteger(id) && id > 0) return { view: 'detail', id };
  return { view: 'list' };
}

function keDaftar(): void {
  location.hash = '#/purchases';
}

function kembaliBtnHtml(): string {
  return `<button type="button" data-po-kembali class="btn btn-ghost">${icon('chevL')}<span>Kembali</span></button>`;
}

function bindKembali(el: HTMLElement): void {
  el.querySelectorAll<HTMLElement>('[data-po-kembali]').forEach((b) =>
    b.addEventListener('click', () => keDaftar()),
  );
}

/* ---------- DOKUMEN A4 (cetak/ekspor nota PO — butir ROADMAP 1.6.3) ---------- */

type Toko = {
  store_name: string; store_address: string; store_phone: string; store_email: string;
  invoice_footer?: string;
};

/** Tanggal/jam gaya Indonesia, zona waktu KASIR (bukan UTC) — pola
 *  debts.ts/invoice.ts: created_at disimpan UTC (Z), diparse lalu tampil lokal. */
function tglLokal(iso: string): string {
  const t = /[Zz]$|[+-]\d{2}:\d{2}$/.test(iso) || iso.includes('T')
    ? iso
    : `${iso.replace(' ', 'T')}Z`;
  return new Date(t).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Seluruh dokumen nota PO jadi satu string HTML (A4, print-only) — pola
 *  `htmlHutangA4` debts.ts: kop store_* + supplier + tabel barang +
 *  ringkas Total/Terbayar/Sisa (striping, print-color-adjust: exact). */
function htmlPoA4(po: Po, items: PoItem[], toko: Toko, tglCetak: string): string {
  const tampil = po.status_tampil ?? po.status;
  const baris = items
    .map((it, i) => `<tr>
        <td class="text-center">${i + 1}</td>
        <td><strong>${esc(it.name)}</strong></td>
        <td class="text-right nowrap">${it.qty}</td>
        <td class="text-right nowrap">${it.diterima ?? it.qty}</td>
        <td class="text-right nowrap">${rpIdr(it.harga_beli)}</td>
        <td class="text-right nowrap">${rpIdr(it.amount)}</td>
      </tr>`)
    .join('');

  // Baris ringkas KETIGA (tepat 3 `.total-row`, kontrak purchase-test F):
  // urutan prioritas batal -> sisa hutang (uang kurang atas barang yang sudah
  // datang) -> sisa barang yang belum datang -> lunas.
  const sisa = Math.max(0, po.sisa);
  const belum = Math.max(0, po.sisa_terima ?? (po.total - (po.diterima ?? 0)));
  const labelSisa = tampil === 'cancel'
    ? 'Dibatalkan'
    : sisa > 0
      ? 'Sisa hutang'
      : belum > 0
        ? 'Belum diterima'
        : 'Sisa (lunas)';
  const nilaiSisa = tampil === 'cancel' ? 0 : sisa > 0 ? sisa : belum;
  const labelStatus = tampil === 'cancel'
    ? 'DIBATALKAN'
    : tampil === 'sebagian'
      ? 'SEBAGIAN'
      : tampil === 'received' ? 'DITERIMA' : 'ORDER';

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Nota pembelian PO-${po.id} — ${esc(po.supplier_name || 'Tanpa supplier')}</title>
<style>
  @page { size: A4; margin: 1cm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; padding: 0; line-height: 1.4; }
  .container { width: 100%; margin: 0; padding: 0; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
  .nama-toko { font-size: 16px; font-weight: 800; margin-top: 4px; letter-spacing: .2px; }
  .alamat-toko { font-size: 11px; color: #374151; margin-top: 2px; }
  .baris-kop { margin-top: 2px; font-size: 11px; color: #374151; }
  .baris-kop .lbl { font-weight: 700; }
  .title { font-size: 18px; font-weight: 800; color: #111827; margin: 0; letter-spacing: -.3px; }
  .title-no { font-size: 14px; font-weight: 700; color: #111827; margin-top: 2px; letter-spacing: -.3px; }
  .meta { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
  .info-box { width: 48%; }
  .info-title { font-weight: 700; text-transform: uppercase; border-bottom: 1px solid #333; margin-bottom: 6px; padding-bottom: 3px; font-size: 11px; letter-spacing: .3px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 15px; table-layout: fixed; }
  th { text-align: left; padding: 6px 5px; border-bottom: 1.5px solid #333; text-transform: uppercase; font-size: 10px; letter-spacing: .3px; }
  td { padding: 6px 5px; border-bottom: 1px solid #d1d5db; vertical-align: middle; }
  tbody tr:nth-child(even) { background-color: #f9fafb; }
  .text-right { text-align: right; }
  .text-center { text-align: center; }
  .nowrap { white-space: nowrap; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .total-section { margin-left: auto; width: 250px; }
  .total-row { display: flex; justify-content: space-between; padding: 5px 0; font-weight: 700; }
  .grand-total { font-size: 14px; border-top: 2px solid #333; padding-top: 10px; margin-top: 5px; }
  .foot { margin-top: 30px; text-align: center; color: #4b5563; font-size: 10px; border-top: 1px dashed #d1d5db; padding-top: 10px; }
  .foot-line { margin: 4px 0; }
  ${CSS_LOGO_A4}
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="display: flex; gap: 15px; align-items: flex-start;">
        ${logoA4Html()}
        <div>
          <div class="nama-toko">${esc(toko.store_name || 'Ravaa POS')}</div>
          ${toko.store_address ? `<div class="alamat-toko">${esc(toko.store_address)}</div>` : ''}
          ${toko.store_phone || toko.store_email
            ? `<div class="baris-kop"><span class="lbl">Telp:</span> ${esc(toko.store_phone ?? '')}${(toko.store_phone && toko.store_email) ? ' | ' : ''}${esc(toko.store_email ?? '')}</div>`
            : ''}
        </div>
      </div>
      <div style="text-align: right;">
        <h1 class="title">NOTA PEMBELIAN</h1>
        <div class="title-no">PO-${po.id}</div>
      </div>
    </div>

    <div class="meta">
      <div class="info-box" style="width: 48%;">
        <div class="info-title">SUPPLIER</div>
        <div style="font-size: 14px; font-weight: bold;">${esc(po.supplier_name || 'Tanpa supplier')}</div>
      </div>
      <div class="info-box" style="width: 48%; text-align: right;">
        <div class="info-title">DETAIL</div>
        <div>Nomor: <strong>PO-${po.id}</strong></div>
        <div>Tanggal: <strong>${esc(tglLokal(po.created_at))}</strong></div>
        ${po.received_at ? `<div>Diterima: <strong>${esc(tglLokal(po.received_at))}</strong></div>` : ''}
        <div>Kasir: <strong>${esc(po.cashier || '—')}</strong></div>
        ${po.shift_id ? `<div>Shift: <strong>#${po.shift_id}</strong></div>` : ''}
        <div>Status: <strong>${labelStatus}</strong></div>
      </div>
    </div>

    ${
      items.length === 0
        ? `<div class="info-box" style="width: 50%; font-style: italic; color: #777;">Tidak ada barang pada nota ini.</div>`
        : `<table class="items">
      <thead>
        <tr>
          <th class="text-center" width="36">#</th>
          <th>Barang</th>
          <th class="text-right" width="52">Qty</th>
          <th class="text-right" width="58">Diterima</th>
          <th class="text-right" width="110">Harga beli</th>
          <th class="text-right" width="110">Sub total</th>
        </tr>
      </thead>
      <tbody>${baris}</tbody>
    </table>`
    }

    <div style="display: flex; justify-content: space-between;">
      <div style="width: 50%;"></div>
      <div class="total-section">
        <div class="total-row"><span>Total</span><span>${rpIdr(po.total)}</span></div>
        <div class="total-row"><span>Terbayar</span><span>${rpIdr(po.terbayar)}</span></div>
        <div class="total-row grand-total"><span>${labelSisa}</span><span>${rpIdr(nilaiSisa)}</span></div>
      </div>
    </div>

    ${po.note ? `<div style="margin-top: 14px; font-style: italic;">Catatan: ${esc(po.note)}</div>` : ''}

    <div class="foot">
      <div class="foot-line">Dicetak melalui Ravaa POS pada: ${esc(tglCetak)}</div>
      ${footerDokumenA4(toko) ? `<div class="foot-line">${esc(footerDokumenA4(toko))}</div>` : ''}
    </div>
  </div>
  <script>
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`;
}

async function cetakPoA4(id: number): Promise<void> {
  // Tab dibuka SINKRON sebelum fetch — lihat `bukaTabCetak()` di invoice.ts
  // (popup setelah await bisa diblokir karena aktivasi pengguna kedaluwarsa).
  const w = bukaTabCetak(
    'popup diblokir browser — izinkan popup untuk mencetak A4',
    'Menyiapkan nota pembelian…',
  );
  let det: { data: { purchase: Po; items: PoItem[] } };
  let set: { data: Toko };
  try {
    [det, set] = await Promise.all([
      apiGet<{ data: { purchase: Po; items: PoItem[] } }>(`/api/purchases/${id}`),
      apiGet<{ data: Toko }>('/api/settings'),
    ]);
  } catch (e) {
    try { w.close(); } catch { /* sudah tertutup */ }
    throw e;
  }
  if (w.closed) return;
  const tglCetak = tglLengkap(new Date().toISOString());
  const html = htmlPoA4(det.data.purchase, det.data.items, set.data, tglCetak);
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* ---------- RINCIAN (halaman #/purchases/<id>) ---------- */

function detailHtml(po: Po, items: PoItem[], receives: PoReceive[], returs: PoRetur[]): string {
  const tampil = po.status_tampil ?? po.status;
  const diterimaNilai = po.diterima ?? 0;
  const belumNilai = Math.max(0, po.sisa_terima ?? (po.total - diterimaNilai));
  const barisSisa = items
    .map((it) => ({
      it,
      sisa: Math.max(0, it.sisa_terima ?? (it.qty - (it.diterima ?? 0))),
      sudah: it.diterima ?? 0,
    }))
    .filter((x) => x.sisa > 0);
  // Default qty = SEMUA sisa (perilaku lama "terima semua" sekali klik) —
  // kasir menurunkan baris yang belum datang. Ringkasan uang dihitung live.
  const totalSisa = barisSisa.reduce((s, x) => s + Math.round(x.sisa * x.it.harga_beli), 0);
  const maksBayar = Math.max(0, diterimaNilai + totalSisa - po.terbayar);

  const aksiTerima = tampil !== 'cancel' && barisSisa.length
    ? `
    <div class="card">
      <h3 class="mb-2 text-sm font-bold">Terima barang${tampil === 'sebagian' ? ' (kedatangan berikutnya)' : ''}</h3>
      <div class="table-wrap">
        <table class="table table-compact !min-w-[520px]">
          <thead>
            <tr>
              <th class="th">Barang</th>
              <th class="th !w-28 text-right">Qty datang</th>
              <th class="th !w-28 text-right">Harga beli</th>
              <th class="th !w-32 text-right">Nilai</th>
            </tr>
          </thead>
          <tbody>
            ${barisSisa.map(({ it, sisa, sudah }) => `
            <tr>
              <td class="td">
                <span class="cell-strong">${esc(it.name)}</span>
                <div class="cell-sub tabular-nums">PO ${it.qty} · sudah diterima ${sudah}</div>
              </td>
              <td class="td td-num"><input data-pt-qty="${it.id}" data-harga="${it.harga_beli}" data-sisa="${sisa}"
                    class="input input-sm !w-24 text-right tabular-nums" type="number" min="0" max="${sisa}" step="any"
                    value="${sisa}" aria-label="Qty datang ${esc(it.name)}" /></td>
              <td class="td td-num">${rp(it.harga_beli)}</td>
              <td class="td td-num" data-pt-sub="${it.id}">${rp(Math.round(sisa * it.harga_beli))}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td class="td font-semibold" colspan="3">Nilai kedatangan ini</td>
              <td class="td td-num font-bold" id="pt-total">${rp(totalSisa)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="field mt-3">
        <label class="label" for="pt-bayar">Dibayar tunai (Rp)</label>
        <input id="pt-bayar" class="input text-right font-bold tabular-nums" type="number" inputmode="numeric" min="0" max="${maksBayar}" step="500" value="${totalSisa}" />
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Bawaan = nilai kedatangan ini (lunas). Boleh kurang (jadi hutang supplier) atau lebih untuk melunasi kekurangan kedatangan sebelumnya — maksimal ${rp(maksBayar)}.</p>
      </div>
      <div class="field mt-2">
        <label class="label" for="pt-note">Catatan kedatangan (opsional)</label>
        <input id="pt-note" class="input" maxlength="200" placeholder="cth: datang 1 dari 2 dus" />
      </div>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">${
        state.shiftId
          ? `Masuk hitungan Shift #${state.shiftId} (stok masuk, kas keluar sebesar dibayar di atas).`
          : 'Di luar shift — stok tetap masuk, kas tercatat di laporan tanpa menggerakkan laci shift mana pun.'
      }</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" id="pt-ok" class="btn btn-primary">${icon('check')}<span>Terima barang</span></button>
        ${po.n_terima === 0
          ? `<button type="button" data-po-batal class="btn btn-ghost !text-red-600 dark:!text-red-400">Batalkan PO</button>`
          : ''}
      </div>
      ${po.n_terima > 0
        ? `<p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Sudah ada penerimaan — PO ini tidak bisa dibatalkan. Koreksi stok lewat Opname, koreksi kas lewat Pengeluaran.</p>`
        : ''}
    </div>`
    : tampil !== 'cancel'
      ? `<div class="card">
          <h3 class="mb-1 text-sm font-bold">Semua barang sudah diterima</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400">Tidak ada qty yang masih ditunggu. Koreksi stok lewat Opname bila ada selisih fisik.</p>
          ${po.n_terima === 0 && tampil === 'order' ? `<div class="mt-3"><button type="button" data-po-batal class="btn btn-ghost !text-red-600 dark:!text-red-400">Batalkan PO</button></div>` : ''}
        </div>`
      : '';

  const aksiBayar = po.sisa > 0 && diterimaNilai > 0
    ? `
    <div class="card">
      <h3 class="mb-2 text-sm font-bold">Bayar sisa hutang</h3>
      <div class="field">
        <label class="label" for="pb-amount">Jumlah bayar (Rp)</label>
        <input id="pb-amount" class="input text-right font-bold tabular-nums" type="number" inputmode="numeric" min="1" max="${po.sisa}" step="500" value="${po.sisa}" />
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Maks sisa hutang. Kas keluar diatribusikan ke Shift #${po.shift_id ?? '—'} (shift kedatangan pertama).</p>
      </div>
      <div class="mt-3">
        <button type="button" id="pb-ok" class="btn btn-primary">${icon('wallet')}<span>Bayar</span></button>
      </div>
    </div>`
    : '';

  // Retur ke supplier (butir ROADMAP 1.9, 2026-10-26): per baris = diterima −
  // sudah_diretur (Σ dari events retur). Bawaan input qty = 0 (retur aksi
  // sengaja, bukan "kirim semua" seperti terima). Nilai retur TIDAK menggerakkan
  // laci — uang kembali dari supplier dicatat manual di Kas masuk (desain §1.9).
  const sudahReturPer = new Map<number, number>();
  for (const r of returs) for (const ri of r.items ?? []) {
    sudahReturPer.set(ri.purchase_item_id, (sudahReturPer.get(ri.purchase_item_id) ?? 0) + ri.qty);
  }
  const barisRetur = items
    .map((it) => ({ it, bisa: Math.max(0, (it.diterima ?? 0) - (sudahReturPer.get(it.id) ?? 0)) }))
    .filter((x) => x.bisa > 1e-9);
  const aksiRetur = tampil !== 'cancel' && po.n_terima > 0 && barisRetur.length
    ? `
    <div class="card">
      <h3 class="mb-2 text-sm font-bold">Retur ke supplier</h3>
      <div class="table-wrap">
        <table class="table table-compact !min-w-[520px]">
          <thead>
            <tr>
              <th class="th">Barang</th>
              <th class="th !w-28 text-right">Qty retur</th>
              <th class="th !w-28 text-right">Harga beli</th>
              <th class="th !w-32 text-right">Nilai</th>
            </tr>
          </thead>
          <tbody>
            ${barisRetur.map(({ it, bisa }) => `
            <tr>
              <td class="td">
                <span class="cell-strong">${esc(it.name)}</span>
                <div class="cell-sub tabular-nums">diterima ${it.diterima ?? 0} · bisa diretur ${bisa}</div>
              </td>
              <td class="td td-num"><input data-pr-qty="${it.id}" data-harga="${it.harga_beli}" data-bisa="${bisa}"
                    class="input input-sm !w-24 text-right tabular-nums" type="number" min="0" max="${bisa}" step="any"
                    value="0" aria-label="Qty retur ${esc(it.name)}" /></td>
              <td class="td td-num">${rp(it.harga_beli)}</td>
              <td class="td td-num" data-pr-sub="${it.id}">Rp0</td>
            </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td class="td font-semibold" colspan="3">Nilai retur ini</td>
              <td class="td td-num font-bold" id="pr-total">Rp0</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="field mt-3">
        <label class="label" for="pr-note">Alasan retur (opsional)</label>
        <input id="pr-note" class="input" maxlength="200" placeholder="cth: kemasan rusak, 2 pcs bocor" />
      </div>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Stok keluar otomatis; sisa hutang ${rp(po.sisa)} berkurang senilai retur. <strong>Uang kembali dari supplier dicatat manual di halaman Kas masuk</strong> — retur ini tidak menggerakkan laci.</p>
      <div class="mt-3">
        <button type="button" id="pr-ok" class="btn btn-ghost !text-red-600 dark:!text-red-400">${icon('sync')}<span>Kirim retur</span></button>
      </div>
    </div>`
    : '';

  // Riwayat kedatangan (butir 3.7): satu baris per event — sumber angka
  // laporan/laci harian. Waktu lokal (created_at UTC dari server).
  const riwayat = receives.length
    ? `
    <div class="card-flush">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200/70 px-3 py-2 dark:border-gray-700/70">
        <h3 class="text-sm font-bold">Riwayat kedatangan <span class="font-normal text-gray-500 dark:text-gray-400">(${receives.length})</span></h3>
        <span class="text-xs text-gray-500 dark:text-gray-400">Stok & kas dihitung per baris ini, bukan per tanggal PO.</span>
      </div>
      <div class="table-wrap">
        <table class="table table-compact !min-w-[720px]">
          <thead>
            <tr>
              <th class="th">Waktu</th>
              <th class="th">Barang</th>
              <th class="th">Shift / kasir</th>
              <th class="th text-right">Nilai</th>
              <th class="th text-right">Dibayar</th>
            </tr>
          </thead>
          <tbody>
            ${receives.map((r) => `
            <tr>
              <td class="td tabular-nums">${esc(tglLokal(r.created_at))}</td>
              <td class="td">
                <div class="cell-strong">${r.n_items} baris</div>
                <div class="cell-sub">${esc((r.items ?? []).map((x) => `${x.qty}× ${x.name}`).join(', ') || '—')}</div>
                ${r.note ? `<div class="cell-sub italic">${esc(r.note)}</div>` : ''}
              </td>
              <td class="td"><div>${r.shift_id ? `Shift #${r.shift_id}` : 'di luar shift'}</div><div class="cell-sub">${esc(r.cashier || '—')}</div></td>
              <td class="td td-num">${rp(r.total)}</td>
              <td class="td td-num font-semibold">${rp(r.dibayar)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`
    : '';

  // Riwayat retur ke supplier (butir 1.9) — bentuk mirror riwayat kedatangan.
  const riwayatRetur = returs.length
    ? `
    <div class="card-flush">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200/70 px-3 py-2 dark:border-gray-700/70">
        <h3 class="text-sm font-bold">Riwayat retur ke supplier <span class="font-normal text-gray-500 dark:text-gray-400">(${returs.length})</span></h3>
        <span class="text-xs text-gray-500 dark:text-gray-400">Stok keluar & hutang berkurang per baris ini.</span>
      </div>
      <div class="table-wrap">
        <table class="table table-compact !min-w-[640px]">
          <thead>
            <tr>
              <th class="th">Waktu</th>
              <th class="th">Barang</th>
              <th class="th">Shift / kasir</th>
              <th class="th text-right">Nilai retur</th>
            </tr>
          </thead>
          <tbody>
            ${returs.map((r) => `
            <tr>
              <td class="td tabular-nums">${esc(tglLokal(r.created_at))}</td>
              <td class="td">
                <div class="cell-strong">${r.n_items} baris</div>
                <div class="cell-sub">${esc((r.items ?? []).map((x) => `${x.qty}× ${x.name}`).join(', ') || '—')}</div>
                ${r.note ? `<div class="cell-sub italic">${esc(r.note)}</div>` : ''}
              </td>
              <td class="td"><div>${r.shift_id ? `Shift #${r.shift_id}` : 'di luar shift'}</div><div class="cell-sub">${esc(r.cashier || '—')}</div></td>
              <td class="td td-num font-semibold">${rp(r.total)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`
    : '';

  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center gap-2">
        ${kembaliBtnHtml()}
        <h2 class="text-base font-bold">PO-${po.id} — ${esc(po.supplier_name || 'Tanpa supplier')}</h2>
        ${badge(po)}
        <button type="button" data-po-cetak class="btn btn-ghost ml-auto">${icon('print')}<span>Cetak A4</span></button>
      </div>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">dibuat ${esc(tglLokal(po.created_at))}${po.received_at ? ` · kedatangan pertama ${esc(tglLokal(po.received_at))}` : ''}${po.shift_id ? ` · Shift #${po.shift_id}` : ''} · ${esc(po.cashier || '—')}</p>
      ${po.note ? `<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Catatan: ${esc(po.note)}</p>` : ''}
    </div>
    <div class="card-flush">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="th">Barang</th>
              <th class="th text-right">Qty PO</th>
              <th class="th text-right">Diterima</th>
              <th class="th text-right">Sisa</th>
              <th class="th text-right">Harga beli</th>
              <th class="th text-right">Sub total</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((it) => {
              const sudah = it.diterima ?? 0;
              const sisa = Math.max(0, it.sisa_terima ?? (it.qty - sudah));
              return `
            <tr>
              <td class="td"><span class="cell-strong">${esc(it.name)}</span></td>
              <td class="td td-num">${it.qty}</td>
              <td class="td td-num${sudah > 0 ? ' font-semibold text-emerald-700 dark:text-emerald-400' : ''}">${sudah}</td>
              <td class="td td-num${sisa > 0 ? ' text-amber-700 dark:text-amber-400' : ''}">${sisa > 0 ? sisa : '—'}</td>
              <td class="td td-num">${rp(it.harga_beli)}</td>
              <td class="td td-num font-semibold">${rp(it.amount)}</td>
            </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td class="td font-semibold" colspan="5">Total PO</td>
              <td class="td td-num font-bold">${rp(po.total)}</td>
            </tr>
            <tr>
              <td class="td" colspan="5">Nilai barang diterima</td>
              <td class="td td-num">${rp(diterimaNilai)}</td>
            </tr>
            <tr>
              <td class="td" colspan="5">Terbayar</td>
              <td class="td td-num">${rp(po.terbayar)}</td>
            </tr>
            ${po.sisa > 0 ? `
            <tr>
              <td class="td font-semibold text-red-600 dark:text-red-400" colspan="5">Sisa hutang</td>
              <td class="td td-num font-semibold text-red-600 dark:text-red-400">${rp(po.sisa)}</td>
            </tr>` : ''}
            ${belumNilai > 0 ? `
            <tr>
              <td class="td text-amber-700 dark:text-amber-400" colspan="5">Belum datang (bukan hutang)</td>
              <td class="td td-num text-amber-700 dark:text-amber-400">${rp(belumNilai)}</td>
            </tr>` : ''}
          </tfoot>
        </table>
      </div>
    </div>
    ${aksiTerima}
    ${aksiBayar}
    ${aksiRetur}
    ${riwayat}
    ${riwayatRetur}
  </div>`;
}

async function mountDetail(el: HTMLElement, id: number): Promise<void> {
  el.innerHTML = `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  let data: { purchase: Po; items: PoItem[]; receives: PoReceive[]; returns?: PoRetur[] } | null = null;
  try {
    const r = await apiGet<{ data: { purchase: Po; items: PoItem[]; receives: PoReceive[]; returns?: PoRetur[] } }>(`/api/purchases/${id}`);
    data = r.data;
  } catch (e) {
    el.innerHTML = `
    <div class="space-y-3">
      <div class="card">${kembaliBtnHtml()}</div>
      <div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat PO-${esc(id)}: ${esc(errMsg(e))}</span></div></div>
    </div>`;
    bindKembali(el);
    return;
  }
  const { purchase: po, items, receives } = data;
  // returns = retur ke supplier (butir 1.9); server lama tanpa field itu
  // dinormalisasi [] supaya detail tetap tergambar tanpa form retur.
  const returs = data.returns ?? [];
  el.innerHTML = detailHtml(po, items, receives ?? [], returs);
  bindKembali(el);

  el.querySelector<HTMLElement>('[data-po-cetak]')?.addEventListener('click', () => {
    cetakPoA4(po.id).catch((e) => toast(`Gagal mencetak: ${errMsg(e)}`, 'error'));
  });

  el.querySelector<HTMLElement>('[data-po-batal]')?.addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: `Batalkan PO-${po.id}?`,
      message: 'PO order dibuang permanen (belum ada stok/kas bergerak).',
      okLabel: 'Ya, batalkan',
      cancelLabel: 'Jangan',
      danger: true,
    });
    if (!yes) return;
    try {
      await apiPost(`/api/purchases/${po.id}/cancel`, {});
      toast(`PO-${po.id} dibatalkan`, 'success');
      keDaftar();
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });

  // Form Terima BERTAHAP: qty per baris (bawaan = semua sisa), nilai & batas
  // bayar dihitung live — angka yang dikirim harus sama dengan yang dilihat.
  const inputBayar = el.querySelector<HTMLInputElement>('#pt-bayar');
  const rowInputs = [...el.querySelectorAll<HTMLInputElement>('[data-pt-qty]')];
  // SATU id per form (bukan per klik): klik ganda / retry setelah jawaban
  // hilang memakai kunci yang sama sehingga server mengenali event yang sama.
  // Setelah sukses mountDetail() menggambar ulang form = id baru untuk
  // kedatangan berikutnya.
  const clientIdTerima = crypto.randomUUID();
  let bayarDisentuh = false;
  const qtyTerima = (inp: HTMLInputElement) => {
    const maks = Number(inp.dataset.sisa ?? 0);
    const v = Number(inp.value || 0);
    return Number.isFinite(v) ? Math.min(Math.max(0, v), maks) : 0;
  };
  const hitungEvent = () => rowInputs.reduce((s, inp) =>
    s + Math.round(qtyTerima(inp) * Number(inp.dataset.harga ?? 0)), 0);
  const paintEvent = () => {
    const total = hitungEvent();
    let adaQty = false;
    for (const inp of rowInputs) {
      const q = qtyTerima(inp);
      if (q > 0) adaQty = true;
      const sub = el.querySelector<HTMLElement>(`[data-pt-sub="${inp.dataset.ptQty}"]`);
      if (sub) sub.textContent = rp(Math.round(q * Number(inp.dataset.harga ?? 0)));
    }
    const t = el.querySelector<HTMLElement>('#pt-total');
    if (t) t.textContent = rp(total);
    if (inputBayar) {
      const maks = Math.max(0, (po.diterima ?? 0) + total - po.terbayar);
      inputBayar.max = String(maks);
      if (!bayarDisentuh) inputBayar.value = String(adaQty ? total : 0);
      else if (Number(inputBayar.value || 0) > maks) inputBayar.value = String(maks);
    }
    el.querySelector<HTMLButtonElement>('#pt-ok')?.toggleAttribute('disabled', !adaQty);
  };
  rowInputs.forEach((inp) => {
    inp.addEventListener('input', paintEvent);
    inp.addEventListener('change', paintEvent);
  });
  inputBayar?.addEventListener('input', () => { bayarDisentuh = true; });

  el.querySelector<HTMLElement>('#pt-ok')?.addEventListener('click', async () => {
    const dipilih = rowInputs
      .map((inp) => ({ purchase_item_id: Number(inp.dataset.ptQty), qty: qtyTerima(inp) }))
      .filter((x) => x.qty > 0);
    if (!dipilih.length) { toast('Isi qty kedatangan minimal satu baris', 'warning'); return; }
    const eventTotal = hitungEvent();
    const maks = Math.max(0, (po.diterima ?? 0) + eventTotal - po.terbayar);
    const dibayar = Number(inputBayar?.value || 0);
    if (!Number.isInteger(dibayar) || dibayar < 0 || dibayar > maks) {
      toast(`Dibayar harus bulat 0..${maks}`, 'warning');
      inputBayar?.focus();
      return;
    }
    const note = (el.querySelector('#pt-note') as HTMLInputElement | null)?.value.trim() ?? '';
    try {
      // client_id stabil per form: klik ganda / retry setelah jawaban hilang
      // tidak menggandakan stok & kas (server mengenali event yang sama).
      const r = await apiPost<{ data: Po }>(`/api/purchases/${po.id}/receive`, {
        items: dipilih,
        dibayar,
        note,
        cashier: getCashier(),
        client_id: clientIdTerima,
        ...(state.shiftId !== null ? { shift_id: state.shiftId } : {}),
      });
      const sisaDatang = Math.max(0, r.data.sisa_terima ?? 0);
      const pesan = sisaDatang > 0
        ? `PO-${po.id} kedatangan dicatat · sisa barang ${rp(sisaDatang)}`
        : `PO-${po.id} diterima lengkap`;
      toast(r.data.sisa > 0 ? `${pesan} · hutang ${rp(r.data.sisa)}` : pesan, 'success');
      await mountDetail(el, id);
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });

  el.querySelector<HTMLElement>('#pb-ok')?.addEventListener('click', async () => {
    const amount = Number((el.querySelector('#pb-amount') as HTMLInputElement).value || 0);
    if (!Number.isInteger(amount) || amount <= 0) { toast('Jumlah harus rupiah bulat > 0', 'warning'); return; }
    try {
      const r = await apiPost<{ data: Po }>(`/api/purchases/${po.id}/pay`, { amount });
      toast(r.data.sisa === 0 ? `PO-${po.id} lunas` : `Terbayar · sisa ${rp(r.data.sisa)}`, 'success');
      await mountDetail(el, id);
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });

  // Form retur ke supplier (butir 1.9): qty per baris (bawaan 0), nilai live.
  // client_id SATU per form (pola terima) — klik ganda/retry tidak menggandakan
  // pengurangan stok/hutang; mountDetail() ulang = id baru untuk retur berikut.
  const returInputs = [...el.querySelectorAll<HTMLInputElement>('[data-pr-qty]')];
  if (returInputs.length) {
    const clientIdRetur = crypto.randomUUID();
    const qtyRetur = (inp: HTMLInputElement) => {
      const maks = Number(inp.dataset.bisa ?? 0);
      const v = Number(inp.value || 0);
      return Number.isFinite(v) ? Math.min(Math.max(0, v), maks) : 0;
    };
    const paintRetur = () => {
      let total = 0;
      for (const inp of returInputs) {
        const q = qtyRetur(inp);
        total += Math.round(q * Number(inp.dataset.harga ?? 0));
        const sub = el.querySelector<HTMLElement>(`[data-pr-sub="${inp.dataset.prQty}"]`);
        if (sub) sub.textContent = rp(Math.round(q * Number(inp.dataset.harga ?? 0)));
      }
      const t = el.querySelector<HTMLElement>('#pr-total');
      if (t) t.textContent = rp(total);
      el.querySelector<HTMLButtonElement>('#pr-ok')?.toggleAttribute('disabled', total <= 0);
    };
    returInputs.forEach((inp) => {
      inp.addEventListener('input', paintRetur);
      inp.addEventListener('change', paintRetur);
    });
    paintRetur();
    el.querySelector<HTMLElement>('#pr-ok')?.addEventListener('click', async () => {
      const dipilih = returInputs
        .map((inp) => ({ purchase_item_id: Number(inp.dataset.prQty), qty: qtyRetur(inp) }))
        .filter((x) => x.qty > 0);
      if (!dipilih.length) { toast('Isi qty retur minimal satu baris', 'warning'); return; }
      const total = dipilih.reduce((s, x) => {
        const inp = returInputs.find((i) => Number(i.dataset.prQty) === x.purchase_item_id)!;
        return s + Math.round(x.qty * Number(inp.dataset.harga ?? 0));
      }, 0);
      const note = (el.querySelector('#pr-note') as HTMLInputElement | null)?.value.trim() ?? '';
      try {
        const r = await apiPost<{ data: Po & { retur?: { total: number } } }>(`/api/purchases/${po.id}/returns`, {
          items: dipilih,
          note,
          cashier: getCashier(),
          client_id: clientIdRetur,
          ...(state.shiftId !== null ? { shift_id: state.shiftId } : {}),
        });
        toast(`Retur ${rp(total)} dicatat · sisa hutang ${rp(r.data.sisa)}${r.data.retur?.total ? ` · stok keluar` : ''}`, 'success');
        await mountDetail(el, id);
      } catch (e) {
        toast(`Gagal: ${errMsg(e)}`, 'error');
      }
    });
  }
}

/* ---------- BUAT PO (halaman #/purchases/baru) ---------- */

type BarisPo = { product_id: number; name: string; qty: number; harga_beli: number };

function supOptsHtml(): string {
  return state.suppliers.length
    ? `<option value="">— Tanpa supplier (eceran) —</option>` +
      state.suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}${s.code ? ` · ${esc(s.code)}` : ''}</option>`).join('')
    : `<option value="">— Tanpa supplier (eceran) —</option>`;
}

function halamanBaruHtml(): string {
  // Supplier master dijaga `supplier.kelola` di server; PO tanpa supplier
  // tetap sah. Tanpa izin itu dropdown-nya dikunci + diberi alasan, bukan
  // dibiarkan kosong seolah master supplier memang belum ada.
  const bolehSupplier = punyaIzin('supplier.kelola');
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center gap-2">
        ${kembaliBtnHtml()}
        <h2 class="text-base font-bold">Buat PO (order)</h2>
      </div>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Ketik nama/SKU lalu klik hasilnya untuk menambah baris. Simpan = order dulu (stok belum bergerak) — barang datang baru Terima di rincian PO (stok masuk + kas keluar di situ).</p>
    </div>
    <div class="card">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="po-sup">Supplier</label>
          <select id="po-sup" class="input"${bolehSupplier ? '' : ' disabled'}>${supOptsHtml()}</select>
          ${bolehSupplier
            ? ''
            : `<span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">Butuh izin Supplier untuk memilih pemasok — PO tanpa supplier tetap bisa disimpan.</span>`}
        </div>
        <div class="field">
          <label class="label" for="po-note">Catatan</label>
          <input id="po-note" class="input" maxlength="200" placeholder="cth: pesan Senin, datang Selasa" />
        </div>
      </div>
      <div class="field mt-3">
        <label class="label" for="po-q">Cari produk (nama / SKU / barcode)</label>
        <div class="relative">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
          <input id="po-q" class="input pl-9" type="search" placeholder="Ketik minimal 2 huruf…" autocomplete="off" />
          <div id="po-hasil" class="absolute left-0 right-0 top-full z-20 mt-1 hidden max-h-72 overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-pop dark:border-gray-700 dark:bg-gray-800" role="listbox" aria-label="Hasil pencarian produk"></div>
        </div>
      </div>
    </div>
    <div class="card-flush">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200/70 px-3 py-2 dark:border-gray-700/70">
        <h3 class="text-sm font-bold">Baris PO<span id="po-nrows" class="font-normal text-gray-500 dark:text-gray-400"></span></h3>
        <span class="text-sm font-bold">Total: <span id="po-total" class="tabular-nums">Rp0</span></span>
      </div>
      <div id="po-baris"></div>
    </div>
    <div class="card flex flex-wrap items-center justify-end gap-2">
      <button type="button" id="po-batal" class="btn btn-ghost">Batal</button>
      <button type="button" id="po-simpan" class="btn btn-primary">${icon('check')}<span>Simpan PO</span></button>
    </div>
  </div>`;
}

/** Supplier dimuat ulang di sini: halaman `#/purchases/baru` bisa langsung
 *  dibuka (refresh/bookmark) tanpa melewati daftar yang biasa mengisinya.
 *  GET /api/suppliers dijaga `supplier.kelola` — tanpa izin itu jangan
 *  memanggil sama sekali (dropdown sudah disabled + diberi alasan di
 *  `halamanBaruHtml`; PO tanpa supplier tetap sah). */
async function isiSupplier(el: HTMLElement): Promise<void> {
  if (!punyaIzin('supplier.kelola')) return;
  try {
    const s = await apiGet<{ data: SupplierOpt[] }>('/api/suppliers');
    state.suppliers = s.data;
    const sel = el.querySelector<HTMLSelectElement>('#po-sup');
    if (sel) sel.innerHTML = supOptsHtml();
  } catch {
    /* biarkan dropdown "Tanpa supplier" */
  }
}

function mountBaru(el: HTMLElement): void {
  el.innerHTML = halamanBaruHtml();
  const baris: BarisPo[] = [];
  const box = el.querySelector('#po-baris') as HTMLElement;
  const hasil = el.querySelector('#po-hasil') as HTMLElement;
  const q = el.querySelector('#po-q') as HTMLInputElement;

  const totalBaris = () => baris.reduce((s, b) => s + Math.round((b.qty || 0) * (b.harga_beli || 0)), 0);

  const gambarBaris = () => {
    box.innerHTML = baris.length
      ? `<div class="table-wrap">
          <table class="table table-compact !min-w-[560px]">
            <thead>
              <tr>
                <th class="th">Barang</th>
                <th class="th !w-24 text-right">Qty</th>
                <th class="th !w-32 text-right">Harga beli</th>
                <th class="th !w-32 text-right">Sub total</th>
                <th class="th !w-10"></th>
              </tr>
            </thead>
            <tbody>
              ${baris.map((b, i) => `
              <tr>
                <td class="td"><span class="cell-strong">${esc(b.name)}</span></td>
                <td class="td td-num"><input data-po-qty="${i}" class="input input-sm !w-20 text-right tabular-nums" type="number" min="0" step="any" value="${b.qty}" aria-label="Qty ${esc(b.name)}" /></td>
                <td class="td td-num"><input data-po-hb="${i}" class="input input-sm !w-24 text-right tabular-nums" type="number" min="0" step="1" value="${b.harga_beli}" aria-label="Harga beli ${esc(b.name)}" /></td>
                <td class="td td-num font-semibold" data-po-sub="${i}">${rp(Math.round((b.qty || 0) * (b.harga_beli || 0)))}</td>
                <td class="td"><button type="button" data-po-del="${i}" class="row-btn row-btn-danger" aria-label="Hapus baris">${icon('trash')}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`
      : `<div class="p-3"><div class="empty">Belum ada baris — cari produk di atas lalu klik hasilnya.</div></div>`;
    const nrows = el.querySelector('#po-nrows');
    if (nrows) nrows.textContent = baris.length ? ` (${baris.length} baris)` : '';
    const totEl = el.querySelector('#po-total');
    if (totEl) totEl.textContent = rp(totalBaris());

    // Edit qty/harga = update model + sub total + total TANPA menggambar ulang
    // tabel (kalau digambar ulang tiap ketikan, fokus pindah keluar input).
    const segarkan = (i: number) => {
      const b = baris[i];
      const sub = box.querySelector(`[data-po-sub="${i}"]`);
      if (b && sub) sub.textContent = rp(Math.round((b.qty || 0) * (b.harga_beli || 0)));
      if (totEl) totEl.textContent = rp(totalBaris());
    };
    box.querySelectorAll<HTMLInputElement>('input[data-po-qty]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const i = Number(inp.dataset.poQty);
        if (!baris[i]) return;
        baris[i].qty = Number(inp.value) || 0;
        segarkan(i);
      });
    });
    box.querySelectorAll<HTMLInputElement>('input[data-po-hb]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const i = Number(inp.dataset.poHb);
        if (!baris[i]) return;
        baris[i].harga_beli = Number(inp.value) || 0;
        segarkan(i);
      });
    });
    box.querySelectorAll<HTMLElement>('[data-po-del]').forEach((btn) =>
      btn.addEventListener('click', () => {
        baris.splice(Number(btn.dataset.poDel), 1);
        gambarBaris();
      }),
    );
  };
  gambarBaris();
  q.focus();

  bindKembali(el);
  el.querySelector('#po-batal')?.addEventListener('click', () => keDaftar());

  const tutupHasil = () => hasil.classList.add('hidden');

  /** Klik hasil cari = baris masuk (qty 1 + harga beli master) — qty/harga
   *  diedit langsung di tabel baris; produk+harga sama digabung qty-nya. */
  const tambah = (pd: ProdukCari) => {
    const hb = Math.round(pd.cost || 0);
    const ada = baris.find((b) => b.product_id === pd.id && b.harga_beli === hb);
    if (ada) ada.qty += 1;
    else baris.push({ product_id: pd.id, name: pd.name, qty: 1, harga_beli: hb });
    gambarBaris();
    q.value = '';
    tutupHasil();
    q.focus();
  };

  q.addEventListener('input', () => {
    clearTimeout(cariTimer);
    cariTimer = setTimeout(async () => {
      const v = q.value.trim();
      if (v.length < 2) { hasil.innerHTML = ''; tutupHasil(); return; }
      try {
        const r = await apiGet<{ data: ProdukCari[] }>(`/api/products?q=${encodeURIComponent(v)}&status=aktif`);
        // Hanya barang fisik (track_stock=1): jasa/cetak/desain DITOLAK
        // POST /api/purchases, jadi jangan tawarkan di dropdown (dulu bisa
        // diklik lalu gagal 400 saat simpan).
        const hits = r.data.filter((pd) => pd.track_stock).slice(0, 8);
        hasil.innerHTML = hits.map((pd) => `
          <button type="button" data-po-pilih="${pd.id}" class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-primary-soft dark:hover:bg-primary/15" role="option">
            <span class="min-w-0">
              <span class="block truncate font-semibold">${esc(pd.name)}</span>
              <span class="cell-sub">${esc(pd.sku)} · stok ${pd.stock} · beli ${rp(pd.cost || 0)}</span>
            </span>
            <span class="shrink-0 text-gray-400 [&>svg]:size-4">${icon('plus')}</span>
          </button>`).join('') || `<div class="empty">Tidak ketemu.</div>`;
        hasil.classList.remove('hidden');
        hasil.querySelectorAll<HTMLElement>('[data-po-pilih]').forEach((btn) =>
          btn.addEventListener('click', () => {
            const pd = hits.find((x) => x.id === Number(btn.dataset.poPilih));
            if (pd) tambah(pd);
          }),
        );
      } catch (e) {
        hasil.innerHTML = `<div class="empty">Gagal cari: ${esc(errMsg(e))}</div>`;
        hasil.classList.remove('hidden');
      }
    }, 250);
  });

  // Enter di kolom cari = ambil hasil pertama (jalur cepat tanpa mouse).
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      hasil.querySelector<HTMLElement>('[data-po-pilih]')?.click();
    }
  });

  // Sembunyikan dropdown saat fokus pindah; jeda 150ms supaya klik hasil
  // (mousedown → blur → click) tetap sampai sebelum disembunyikan.
  q.addEventListener('blur', () => setTimeout(tutupHasil, 150));
  // Klik hasil: mousedown + preventDefault supaya input TIDAK blur — tanpa ini
  // timer blur 150ms menyembunyikan dropdown saat tombol masih ditahan dan
  // click-nya tidak pernah sampai (klik lambat > 150ms; pola sama dengan
  // #pos-results di pos.ts:4511).
  hasil.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest?.('[data-po-pilih]')) e.preventDefault();
  });

  el.querySelector('#po-simpan')?.addEventListener('click', async () => {
    if (!baris.length) { toast('Belum ada baris PO', 'warning'); q.focus(); return; }
    for (const [i, b] of baris.entries()) {
      if (!(b.qty > 0)) { toast(`Baris ${i + 1} (${b.name}): qty harus > 0`, 'warning'); return; }
      if (!(b.harga_beli >= 0)) { toast(`Baris ${i + 1} (${b.name}): harga beli harus ≥ 0`, 'warning'); return; }
    }
    const supVal = (el.querySelector('#po-sup') as HTMLSelectElement).value;
    try {
      const r = await apiPost<{ data: { purchase: Po } }>('/api/purchases', {
        ...(supVal ? { supplier_id: Number(supVal) } : {}),
        items: baris.map((b) => ({ product_id: b.product_id, qty: b.qty, harga_beli: b.harga_beli })),
        note: (el.querySelector('#po-note') as HTMLInputElement).value.trim(),
        cashier: getCashier(),
      });
      toast(`PO-${r.data.purchase.id} tersimpan · ${rp(r.data.purchase.total)}`, 'success');
      keDaftar();
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });

  void isiSupplier(el);
}

/* ---------- AKSI ---------- */

function bindRows(): void {
  host!.querySelectorAll<HTMLElement>('[data-po-buka]').forEach((tr) =>
    tr.addEventListener('click', () => {
      location.hash = `#/purchases/${tr.dataset.poBuka}`;
    }),
  );
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  // Supplier dimuat TERPISAH: GET /api/suppliers dijaga `supplier.kelola`
  // sedangkan daftar PO cukup `pembelian.kelola`. Digabung di Promise.all,
  // satu 403 supplier memerahkan seluruh daftar PO (akses yang sebenarnya sah).
  void muatSupplier();
  try {
    const r = await apiGet<{ data: Po[]; total: number; lewat30: number }>(
      `/api/purchases?status=${encodeURIComponent(state.status)}&limit=${state.limit}&offset=${state.offset}`,
    );
    state.items = r.data;
    state.total = r.total;
    state.lewat30 = r.lewat30 ?? 0;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

/** Isi cache supplier untuk dropdown form PO baru (tanpa mengganggu daftar).
 *  Gagal/403 = `state.suppliers` dibiarkan apa adanya. */
async function muatSupplier(): Promise<void> {
  if (!punyaIzin('supplier.kelola')) return;
  try {
    const s = await apiGet<{ data: SupplierOpt[]; total: number }>('/api/suppliers');
    state.suppliers = s.data;
  } catch {
    /* daftar PO tetap tampil; dropdown form memakai cache lama/kosong */
  }
}

async function loadShift(): Promise<void> {
  try {
    const r = await apiGet<{ data: { id: number } | null }>(
      `/api/shifts/open?cashier=${encodeURIComponent(getCashier())}`,
    );
    state.shiftId = r.data?.id ?? null;
  } catch {
    state.shiftId = null;
  }
}

/* ---------- ENTRY ---------- */

export async function mountPurchasesPage(el: HTMLElement): Promise<void> {
  host = el;
  const sub = subRute();
  if (sub.view === 'baru') {
    mountBaru(el);
    return;
  }
  if (sub.view === 'detail') {
    await mountDetail(el, sub.id);
    return;
  }
  el.innerHTML = renderPage();
  paint();
  // Alt+N = pintasan tombol yang sama (ui/aksi-baru.ts) — masuk HALAMAN form
  // PO baru (#/purchases/baru, bukan modal sejak 2026-10-17).
  const bukaBaru = () => {
    location.hash = '#/purchases/baru';
  };
  el.querySelector('#po-new')?.addEventListener('click', bukaBaru);
  pasangAksiBaru(bukaBaru);
  // Chip "lewat 30 hari" = pintu cepat ke daftar belum lunas (aging).
  el.querySelector('#po-lewat')?.addEventListener('click', () => {
    state.status = 'hutang';
    state.offset = 0;
    void load();
  });
  host.querySelectorAll<HTMLElement>('[data-pstatus]').forEach((b) =>
    b.addEventListener('click', () => {
      state.status = b.dataset.pstatus ?? 'semua';
      state.offset = 0;
      void load();
    }),
  );
  await loadShift();
  await load();
}
