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

import { apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { pasangAksiBaru } from '../ui/aksi-baru';
import { toast } from '../ui/toast';
import { getCashier } from '../ui/user';
import { tglPendek } from '../ui/waktu';
import { rp } from '../escpos';
// Slot logo bersama semua dokumen A4 (permintaan pemilik 19 Okt 2026) —
// helper tinggal di invoice.ts, dipakai juga oleh debts.ts & rekap/laporan.
import { CSS_LOGO_A4, footerDokumenA4, logoA4Html, rpIdr, tglSingkat, tglLengkap, cityToko } from '../invoice';

type Po = {
  id: number; created_at: string;
  supplier_id: number | null; supplier_name: string;
  status: 'order' | 'received' | 'cancel';
  total: number; terbayar: number; sisa: number;
  cashier: string; shift_id: number | null; received_at: string | null;
  note: string; n_items: number;
  /** Usia hutang supplier (hari sejak DITERIMA, dihitung server 2026-10-16).
   *  null = bukan hutang received (order/batal/lunas) — badge umur hanya muncul
   *  saat masih ada sisa. */
  umur_hari: number | null;
};

type PoItem = {
  id: number; purchase_id: number; product_id: number; name: string;
  qty: number; harga_beli: number; amount: number;
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

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

const STATUS: { key: string; label: string }[] = [
  { key: 'semua', label: 'Semua' },
  { key: 'order', label: 'Order' },
  { key: 'received', label: 'Diterima' },
  // Computed di server: nota received yang masih bersisa (bukan status
  // tersimpan) — jawaban "kebingungan mencari purchasing yang belum lunas".
  { key: 'hutang', label: 'Belum lunas' },
  { key: 'cancel', label: 'Batal' },
];

function badge(p: Po): string {
  if (p.status === 'cancel') {
    return `<span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:bg-gray-500/15 dark:text-gray-400">Batal</span>`;
  }
  if (p.status === 'order') {
    return `<span class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">Order</span>`;
  }
  if (p.sisa > 0) {
    return `<span class="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700 dark:bg-red-500/15 dark:text-red-400">Hutang ${rp(p.sisa)}</span>`;
  }
  return `<span class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">Lunas</span>`;
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
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Order dulu, barang datang baru Terima (stok masuk + kas keluar). Bawaan tunai penuh — kurangi bila hutang; sisa tiap nota disaring lewat filter <b>Belum lunas</b>.</p>
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
      // hanya mengirim angka untuk PO received yang masih bersisa.
      const umur = o.umur_hari ?? null;
      const sisa = o.status === 'received' && o.sisa > 0
        ? `<span class="font-semibold text-red-600 dark:text-red-400">${rp(o.sisa)}</span>`
        : '<span class="text-gray-400">—</span>';
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
        <td class="td">${badge(o)}${
          umur === null
            ? ''
            : `<div class="cell-sub tabular-nums${umur >= 30 ? ' font-semibold !text-red-600 dark:!text-red-400' : ''}"
                    title="Usia hutang sejak barang diterima">${umur <= 0 ? 'baru' : `${umur} hari`}</div>`
        }</td>
        <td class="td td-num">${rp(o.total)}</td>
        <td class="td td-num">${o.status === 'received' ? rp(o.terbayar) : '<span class="text-gray-400">—</span>'}</td>
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
  const baris = items
    .map((it, i) => `<tr>
        <td class="text-center">${i + 1}</td>
        <td><strong>${esc(it.name)}</strong></td>
        <td class="text-right nowrap">${it.qty}</td>
        <td class="text-right nowrap">${rpIdr(it.harga_beli)}</td>
        <td class="text-right nowrap">${rpIdr(it.amount)}</td>
      </tr>`)
    .join('');

  const sisa = Math.max(0, po.sisa);
  const labelSisa = po.status === 'cancel'
    ? 'Dibatalkan'
    : po.status === 'order'
      ? 'Sisa (belum diterima)'
      : sisa > 0 ? 'Sisa hutang' : 'Sisa (lunas)';
  const labelStatus = po.status === 'cancel' ? 'DIBATALKAN' : po.status === 'received' ? 'DITERIMA' : 'ORDER';

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
  .baris-kop { display: flex; margin-top: 2px; font-size: 11px; color: #374151; }
  .baris-kop .lbl { width: 72px; font-weight: 700; }
  .title { font-size: 26px; font-weight: 900; color: #111827; margin: 0; letter-spacing: -.5px; }
  .title-no { font-size: 20px; font-weight: 700; color: #111827; margin-top: 2px; letter-spacing: -.5px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 15px; table-layout: fixed; }
  th { text-align: left; padding: 5px; border-bottom: 1.5px solid #333; text-transform: uppercase; font-size: 10px; }
  td { padding: 5px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tbody tr:nth-child(even) { background-color: #fafafa; }
  .text-right { text-align: right; }
  .text-center { text-align: center; }
  .nowrap { white-space: nowrap; }
  .font-mono { font-family: 'Courier New', Courier, monospace; }
  .total-section { margin-left: auto; width: 250px; }
  .total-row { display: flex; justify-content: space-between; padding: 5px 0; font-weight: bold; }
  .grand-total { font-size: 14px; border-top: 2px solid #333; padding-top: 10px; margin-top: 5px; }
  .foot { margin-top: 30px; text-align: center; color: #aaa; font-size: 10px; border-top: 1px dashed #ddd; padding-top: 10px; }
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
          <th class="text-center" width="40">#</th>
          <th>Barang</th>
          <th class="text-right" width="64">Qty</th>
          <th class="text-right" width="120">Harga beli</th>
          <th class="text-right" width="120">Sub total</th>
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
        <div class="total-row grand-total"><span>${labelSisa}</span><span>${rpIdr(sisa)}</span></div>
      </div>
    </div>

    ${po.note ? `<div style="margin-top: 14px; font-style: italic;">Catatan: ${esc(po.note)}</div>` : ''}

    <div class="foot">
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
  const [det, set] = await Promise.all([
    apiGet<{ data: { purchase: Po; items: PoItem[] } }>(`/api/purchases/${id}`),
    apiGet<{ data: Toko }>('/api/settings'),
  ]);
  const tglCetak = new Date().toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const html = htmlPoA4(det.data.purchase, det.data.items, set.data, tglCetak);
  const w = window.open('', '_blank');
  if (!w) throw new Error('popup diblokir browser — izinkan popup untuk mencetak A4');
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* ---------- RINCIAN (halaman #/purchases/<id>) ---------- */

function detailHtml(po: Po, items: PoItem[]): string {
  const aksiTerima = po.status === 'order'
    ? `
    <div class="card">
      <h3 class="mb-2 text-sm font-bold">Terima barang</h3>
      <div class="field">
        <label class="label" for="pt-bayar">Dibayar tunai (Rp)</label>
        <input id="pt-bayar" class="input text-right font-bold tabular-nums" type="number" inputmode="numeric" min="0" max="${po.total}" step="500" value="${po.total}" />
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Isi penuh = lunas. Kurangi bila hutang — sisanya tercatat sebagai hutang supplier.</p>
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">${
        state.shiftId
          ? `Masuk hitungan Shift #${state.shiftId} (stok masuk, kas keluar ${rp(po.total)}).`
          : 'Di luar shift — tercatat + masuk laporan.'
      }</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" id="pt-ok" class="btn btn-primary">${icon('check')}<span>Terima + bayar</span></button>
        <button type="button" data-po-batal class="btn btn-ghost !text-red-600 dark:!text-red-400">Batalkan PO</button>
      </div>
    </div>`
    : '';
  const aksiBayar = po.status === 'received' && po.sisa > 0
    ? `
    <div class="card">
      <h3 class="mb-2 text-sm font-bold">Bayar sisa hutang</h3>
      <div class="field">
        <label class="label" for="pb-amount">Jumlah bayar (Rp)</label>
        <input id="pb-amount" class="input text-right font-bold tabular-nums" type="number" inputmode="numeric" min="1" max="${po.sisa}" step="500" value="${po.sisa}" />
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Maks sisa hutang. Kas keluar diatribusikan ke Shift #${po.shift_id ?? '—'} PO ini.</p>
      </div>
      <div class="mt-3">
        <button type="button" id="pb-ok" class="btn btn-primary">${icon('wallet')}<span>Bayar</span></button>
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
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">dibuat ${esc(po.created_at)}${po.received_at ? ` · diterima ${esc(po.received_at)}` : ''}${po.shift_id ? ` · Shift #${po.shift_id}` : ''}</p>
      ${po.note ? `<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Catatan: ${esc(po.note)}</p>` : ''}
    </div>
    <div class="card-flush">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="th">Barang</th>
              <th class="th text-right">Qty</th>
              <th class="th text-right">Harga beli</th>
              <th class="th text-right">Sub total</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((it) => `
            <tr>
              <td class="td"><span class="cell-strong">${esc(it.name)}</span></td>
              <td class="td td-num">${it.qty}</td>
              <td class="td td-num">${rp(it.harga_beli)}</td>
              <td class="td td-num font-semibold">${rp(it.amount)}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td class="td font-semibold" colspan="3">Total</td>
              <td class="td td-num font-bold">${rp(po.total)}</td>
            </tr>
            <tr>
              <td class="td" colspan="3">Terbayar</td>
              <td class="td td-num">${rp(po.terbayar)}</td>
            </tr>
            ${po.status === 'received' && po.sisa > 0 ? `
            <tr>
              <td class="td font-semibold text-red-600 dark:text-red-400" colspan="3">Sisa hutang</td>
              <td class="td td-num font-semibold text-red-600 dark:text-red-400">${rp(po.sisa)}</td>
            </tr>` : ''}
          </tfoot>
        </table>
      </div>
    </div>
    ${aksiTerima}
    ${aksiBayar}
  </div>`;
}

async function mountDetail(el: HTMLElement, id: number): Promise<void> {
  el.innerHTML = `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  let data: { purchase: Po; items: PoItem[] } | null = null;
  try {
    const r = await apiGet<{ data: { purchase: Po; items: PoItem[] } }>(`/api/purchases/${id}`);
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
  const { purchase: po, items } = data;
  el.innerHTML = detailHtml(po, items);
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

  el.querySelector<HTMLElement>('#pt-ok')?.addEventListener('click', async () => {
    const dibayar = Number((el.querySelector('#pt-bayar') as HTMLInputElement).value || 0);
    if (!Number.isInteger(dibayar) || dibayar < 0 || dibayar > po.total) {
      toast(`Dibayar harus bulat 0..${po.total}`, 'warning');
      return;
    }
    try {
      await apiPost(`/api/purchases/${po.id}/receive`, {
        dibayar,
        cashier: getCashier(),
        ...(state.shiftId !== null ? { shift_id: state.shiftId } : {}),
      });
      toast(dibayar === po.total ? `PO-${po.id} diterima lunas` : `PO-${po.id} diterima · hutang ${rp(po.total - dibayar)}`, 'success');
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
          <select id="po-sup" class="input">${supOptsHtml()}</select>
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
 *  dibuka (refresh/bookmark) tanpa melewati daftar yang biasa mengisinya. */
async function isiSupplier(el: HTMLElement): Promise<void> {
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
  try {
    const [r, s] = await Promise.all([
      apiGet<{ data: Po[]; total: number; lewat30: number }>(`/api/purchases?status=${encodeURIComponent(state.status)}&limit=${state.limit}&offset=${state.offset}`),
      apiGet<{ data: SupplierOpt[]; total: number }>('/api/suppliers'),
    ]);
    state.items = r.data;
    state.total = r.total;
    state.lewat30 = r.lewat30 ?? 0;
    state.suppliers = s.data;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
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
