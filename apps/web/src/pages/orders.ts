// Halaman PESANAN JASA (#/orders, butir ROADMAP 1.6.6, ACC pemilik 19 Okt
// 2026) — alur cetak/desain/service: pesanan dicatat dulu, dikerjakan, lalu
// diserahkan. Lima keputusan pemilik (dikonfirmasi 2026-10-19) yang membentuk
// halaman ini:
//   1. Omzet DIKAKUI SAAT DIAMBIL — tombol "Serahkan" membuat nota penjualan
//      penuh di server (satu transaction: nota + pelunasan + hutang sisa).
//   2. Item pesanan = teks bebas; stok TIDAK pernah dipotong di jalur ini.
//   3. Sisa yang belum dibayar saat diserahkan OTOMATIS tercatat ke halaman
//      Hutang pelanggan (server yang mengerjakan + penanda orders.hutang_sisa).
//   4. Pembayaran satu metode: Tunai / QRIS / Transfer.
//   5. Nota pesanan dicetak thermal 58mm lewat print-agent; struk penjualan
//      saat serah memakai jalur "Cetak ulang" Riwayat (history.cetakUlang) —
//      satu susunan struk dengan nota POS asli, jangan ditulis ulang di sini.
//
// Halaman penuh + dua SUB-HALAMAN (pola Pembelian 2026-10-17, bukan modal —
// backdrop modal rawan terklik dan input hilang): `#/orders` daftar,
// `#/orders/baru` form, `#/orders/<id>` rincian. parseRoute mencocokkan
// segmen pertama, jadi nav "Pesanan" tetap aktif di sub-halaman.
//
// Server: GET /api/orders?status=&q=&limit=&offset= (+`ringkas`), GET
// /api/orders/:id, POST /api/orders, POST /:id/payments (DP),
// POST /:id/status (dikerjakan<->selesai), POST /:id/take (serah = nota +
// pelunasan + hutang), POST /:id/cancel (refund baris bila sudah ada uang).

import { apiGet, apiPost } from '../api';
import { icon } from '../ui/icons';
import { choiceDialog } from '../ui/confirm';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import {
  syncDariServerSettings, teksJumlahItem, footerStruk,
} from '../ui/identitas-struk';
import { getCashier, getToko } from '../ui/user';
import { punyaIzin } from '../ui/auth';
import { tglPendek } from '../ui/waktu';
import { kirimPrint, rp, strukUntukTercetak, type Struk } from '../escpos';
import { getPrintPause } from '../ui/print-pref';
import { pasangAksiBaru } from '../ui/aksi-baru';
import { esc } from '../ui/html';
import { errMsg } from '../ui/http';
import { cetakUlang, type SaleRow } from './history';

/* ---------- tipe (kontrak GET /api/orders & :id) ---------- */

type StatusOrder = 'dikerjakan' | 'selesai' | 'diambil' | 'batal';

type OrderRow = {
  id: number;
  order_no: string;
  created_at: string;
  updated_at: string;
  customer_id: number;
  customer_name: string;
  status: StatusOrder;
  total: number;
  note: string;
  cashier: string;
  taken_at: string | null;
  sale_id: string | null;
  hutang_sisa: number;
  batal_at: string | null;
  batal_note: string;
  /** Computed server: NET uang diterima (dp + pelunasan − refund). */
  dibayar: number;
  refund_total: number;
  /** total − dibayar (0 untuk batal) — angka yang ditagih saat serah. */
  sisa: number;
  n_items: number;
};

type OrderItem = {
  id: number; order_id: number; name: string; qty: number; price: number; amount: number; note: string;
};

type OrderPayment = {
  id: number; order_id: number; created_at: string;
  kind: 'dp' | 'pelunasan' | 'refund'; method: string; amount: number;
  shift_id: number | null; cashier: string; note: string;
};

type Ringkas = { dikerjakan: number; selesai: number; diambil: number; batal: number; piutang: number };

type Metode = 'tunai' | 'qris' | 'transfer';

/* ---------- state ---------- */

const state = {
  // Daftar
  status: 'semua' as 'semua' | StatusOrder,
  q: '',
  offset: 0,
  limit: PAGE_SIZE,
  items: [] as OrderRow[],
  total: 0,
  ringkas: { dikerjakan: 0, selesai: 0, diambil: 0, batal: 0, piutang: 0 } as Ringkas,
  loading: true,
  error: '',
  // Form pesanan baru
  customers: [] as { id: number; code: string; name: string }[],
  custId: null as number | null,
  formNote: '',
  baris: [{ name: '', qty: '1', price: '' }] as { name: string; qty: string; price: string }[],
  // Rincian
  detail: null as { order: OrderRow; items: OrderItem[]; payments: OrderPayment[] } | null,
  detLoading: false,
  detError: '',
  /** Shift terbuka kasir ini (null = di luar shift) — pembayaran/DP yang
   *  dikirim ikut shift ini supaya menggerakkan laci yang benar (pola
   *  kas-masuk/expenses; server memvalidasi bila dikirim). */
  shiftId: null as number | null,
};

let host: HTMLElement | null = null;
let searchTimer = 0;

/* ---------- util ---------- */

/** Tanggal/jam gaya Indonesia zona KASIR (pola purchases/invoice.ts):
 *  created_at disimpan UTC, diparse lalu tampil lokal. */
function tglLokal(iso: string | null): string {
  if (!iso) return '—';
  const t = /[Zz]$|[+-]\d{2}:\d{2}$/.test(iso) || iso.includes('T')
    ? iso
    : `${iso.replace(' ', 'T')}Z`;
  return new Date(t).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const metodeLabel = (m: string): string =>
  m === 'tunai' ? 'Tunai' : m === 'qris' ? 'QRIS' : m === 'transfer' ? 'Transfer' : m;

const kindLabel = (k: string): string =>
  k === 'dp' ? 'DP' : k === 'pelunasan' ? 'Pelunasan' : k === 'refund' ? 'Refund' : k;

function badgeStatus(s: StatusOrder): string {
  const map: Record<StatusOrder, { cls: string; label: string }> = {
    dikerjakan: {
      cls: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
      label: 'Dikerjakan',
    },
    selesai: {
      cls: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400',
      label: 'Selesai',
    },
    diambil: {
      cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
      label: 'Diambil',
    },
    batal: {
      cls: 'bg-gray-100 text-gray-500 dark:bg-gray-500/15 dark:text-gray-400',
      label: 'Batal',
    },
  };
  const b = map[s];
  return `<span class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${b.cls}">${b.label}</span>`;
}

/* ---------- sub-rute ---------- */

type SubRute = { view: 'list' } | { view: 'baru' } | { view: 'detail'; id: number };

function subRute(): SubRute {
  const seg = (location.hash.replace(/^#\/?/, '').split('?')[0] ?? '').split('/');
  if (seg[0] !== 'orders') return { view: 'list' };
  if (seg[1] === 'baru') return { view: 'baru' };
  const id = Number(seg[1]);
  if (Number.isInteger(id) && id > 0) return { view: 'detail', id };
  return { view: 'list' };
}

const keDaftar = (): void => { location.hash = '#/orders'; };

/* ---------- DAFTAR ---------- */

/** Jumlah order per chip filter — 'semua' = total seluruh status. */
function jumlahStatus(k: 'semua' | StatusOrder): number {
  if (k === 'semua') {
    return state.ringkas.dikerjakan + state.ringkas.selesai + state.ringkas.diambil + state.ringkas.batal;
  }
  return state.ringkas[k];
}

function renderList(): string {
  const STATUS: { key: 'semua' | StatusOrder; label: string }[] = [
    { key: 'semua', label: 'Semua' },
    { key: 'dikerjakan', label: 'Dikerjakan' },
    { key: 'selesai', label: 'Selesai' },
    { key: 'diambil', label: 'Diambil' },
    { key: 'batal', label: 'Batal' },
  ];
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="chip-tabs" role="tablist" aria-label="Filter status pesanan">
          ${STATUS.map((s) => `<button type="button" data-ostatus="${s.key}" data-olabel="${s.label}" class="chip-tab${state.status === s.key ? ' is-active' : ''}">${s.label} (${jumlahStatus(s.key)})</button>`).join('')}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="search-wrap !w-56 !flex-none">
            ${icon('search')}
            <input id="ord-q" class="input input-sm" type="search" placeholder="Cari no. / pelanggan / item" value="${esc(state.q)}" autocomplete="off" aria-label="Cari pesanan" />
          </div>
          ${punyaIzin('pesanan.buat') ? `<button type="button" id="ord-new" class="btn btn-primary" title="Pesanan baru (Alt+N)">${icon('plus')}<span>Pesanan baru</span><kbd class="kbd">Alt+N</kbd></button>` : ''}
        </div>
      </div>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Pesanan jasa (cetak/desain/service) dikerjakan dulu, omzet tercatat saat <b>Serahkan</b>. DP boleh kapan saja; sisa saat serah otomatis masuk halaman Hutang pelanggan.</p>
    </div>
    <div class="card">
      <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Piutang pesanan (belum diserahkan)</p>
      <p class="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-white" id="ord-piutang">${rp(state.ringkas.piutang)}</p>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Total − dibayar untuk pesanan berstatus dikerjakan &amp; selesai.</p>
    </div>
    <div id="ord-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat pesanan: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.items.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('clipboard')}
        <span>${state.q.trim() ? `Tidak ada pesanan cocok "${esc(state.q.trim())}".` : state.status === 'semua' ? 'Belum ada pesanan.' : 'Belum ada pesanan berstatus ini.'}</span>
      </div>
    </div>`;
  }
  const rows = state.items
    .map((o) => {
      const sisa = o.status === 'batal'
        ? '<span class="text-gray-400">—</span>'
        : o.sisa > 0
          ? `<span class="font-semibold text-red-600 dark:text-red-400">${rp(o.sisa)}</span>`
          : `<span class="font-semibold text-emerald-600 dark:text-emerald-400">Lunas</span>`;
      return `
      <tr data-row="${o.id}" class="cursor-pointer" data-ord-buka="${o.id}" title="Buka rincian pesanan">
        <td class="td">
          <div class="cell-strong tabular-nums">${esc(o.order_no)}</div>
          <div class="cell-sub tabular-nums">${esc(tglPendek(o.created_at.slice(0, 10)))}</div>
        </td>
        <td class="td">
          <div class="cell-strong">${esc(o.customer_name)}</div>
          <div class="cell-sub">${o.n_items} item · ${esc(o.cashier)}${o.sale_id ? ' · nota terbit' : ''}</div>
        </td>
        <td class="td">${badgeStatus(o.status)}</td>
        <td class="td td-num">${rp(o.total)}</td>
        <td class="td td-num">${rp(o.dibayar)}</td>
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
            <th class="th">Nomor</th>
            <th class="th">Pelanggan</th>
            <th class="th">Status</th>
            <th class="th text-right">Total</th>
            <th class="th text-right">Dibayar</th>
            <th class="th text-right">Sisa</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagerHtml(state.offset, state.limit, state.total)}
  </div>`;
}

function paintList(): void {
  const body = host?.querySelector('#ord-body');
  if (body) body.innerHTML = renderTable();
  const p = host?.querySelector('#ord-piutang');
  if (p) p.textContent = rp(state.ringkas.piutang);
  // Chip filter: aktif + hitungan ikut data segar (chip statis, tidak
  // di-render ulang bersama tabel — teksnya diganti di sini).
  host?.querySelectorAll<HTMLElement>('[data-ostatus]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.ostatus === state.status);
    const key = (b.dataset.ostatus ?? 'semua') as 'semua' | StatusOrder;
    b.textContent = `${b.dataset.olabel ?? ''} (${jumlahStatus(key)})`;
  });
  bindListRows();
}

function bindListRows(): void {
  if (!host) return;
  bindPager(host, (o) => {
    state.offset = o;
    void load();
  });
  bindPagerLimit(host, (v) => {
    state.limit = v;
    state.offset = 0;
    void load();
  });
  host.querySelectorAll<HTMLElement>('[data-ord-buka]').forEach((tr) =>
    tr.addEventListener('click', () => {
      location.hash = `#/orders/${tr.dataset.ordBuka}`;
    }),
  );
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paintList();
  try {
    const r = await apiGet<{ data: OrderRow[]; total: number; ringkas: Ringkas }>(
      `/api/orders?status=${encodeURIComponent(state.status)}&q=${encodeURIComponent(state.q)}&limit=${state.limit}&offset=${state.offset}`,
    );
    state.items = r.data;
    state.total = r.total;
    state.ringkas = r.ringkas;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paintList();
}

/* ---------- FORM PESANAN BARU ---------- */

function renderBaru(): string {
  const opsi = state.customers
    .map((c) => `<option value="${c.id}"${state.custId === c.id ? ' selected' : ''}>${esc(c.name)} · ${esc(c.code)}</option>`)
    .join('');
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <button type="button" data-ord-kembali class="btn btn-ghost">${icon('chevL')}<span>Kembali</span></button>
          <div>
            <p class="text-sm font-semibold text-gray-900 dark:text-white">Pesanan baru</p>
            <p class="text-xs text-gray-500 dark:text-gray-400">Item = teks bebas (tanpa potong stok). Nomor urut dibuat server.</p>
          </div>
        </div>
        <button type="button" id="ord-simpan" class="btn btn-primary">${icon('check')}<span>Simpan pesanan</span></button>
      </div>
    </div>
    <div class="card">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="ord-cust">Pelanggan *</label>
          <select id="ord-cust" class="input">
            <option value="">— pilih pelanggan —</option>
            ${opsi}
          </select>
        </div>
        <div class="field">
          <label class="label" for="ord-note">Catatan pesanan</label>
          <input id="ord-note" class="input" maxlength="200" placeholder="cth: ambil sore, warna biru" value="${esc(state.formNote)}" />
        </div>
      </div>
    </div>
    <div class="card-flush">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="th">Nama item / jasa *</th>
              <th class="th !w-24 text-right">Qty</th>
              <th class="th !w-36 text-right">Harga</th>
              <th class="th !w-32 text-right">Jumlah</th>
              <th class="th !w-12"></th>
            </tr>
          </thead>
          <tbody id="ord-baris">${barisHtml()}</tbody>
          <tfoot>
            <tr>
              <td class="td" colspan="3">
                <button type="button" id="ord-add" class="btn btn-ghost">${icon('plus')}<span>Tambah baris</span></button>
              </td>
              <td class="td td-num"><b id="ord-total">${rp(totalBaris())}</b></td>
              <td class="td"></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  </div>`;
}

function barisHtml(): string {
  return state.baris
    .map(
      (b, i) => `
      <tr data-ob-row="${i}">
        <td class="td"><input class="input input-sm w-full" data-ob="name" value="${esc(b.name)}" placeholder="cth: Banner 1x3 m, pasang" autocomplete="off" /></td>
        <td class="td"><input class="input input-sm !w-20 text-right tabular-nums" data-ob="qty" type="number" min="0" step="any" value="${esc(b.qty)}" /></td>
        <td class="td"><input class="input input-sm !w-32 text-right tabular-nums" data-ob="price" type="number" min="0" step="any" value="${esc(b.price)}" placeholder="0" /></td>
        <td class="td td-num tabular-nums" data-ob-amt>${rp(jumlahBaris(b))}</td>
        <td class="td"><button type="button" class="row-btn row-btn-danger" data-ob-del="${i}" title="Hapus baris" aria-label="Hapus baris ${i + 1}">${icon('trash')}</button></td>
      </tr>`,
    )
    .join('');
}

const qtyDari = (s: string): number => Number(String(s).replace(',', '.'));

function jumlahBaris(b: { qty: string; price: string }): number {
  const q = qtyDari(b.qty);
  const p = Number(b.price);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q < 0 || p < 0) return 0;
  return Math.round(q * p);
}

const totalBaris = (): number => state.baris.reduce((a, b) => a + jumlahBaris(b), 0);

function paintBaris(): void {
  if (!host) return;
  const tb = host.querySelector('#ord-baris');
  if (tb) tb.innerHTML = barisHtml();
  const t = host.querySelector('#ord-total');
  if (t) t.textContent = rp(totalBaris());
}

function bindBaru(el: HTMLElement): void {
  el.querySelector('#ord-cust')?.addEventListener('change', (ev) => {
    const v = (ev.target as HTMLSelectElement).value;
    state.custId = v ? Number(v) : null;
  });
  el.querySelector<HTMLInputElement>('#ord-note')?.addEventListener('input', (ev) => {
    state.formNote = (ev.target as HTMLInputElement).value;
  });
  // Delegasi input: baris bisa di-render ulang tanpa kehilangan listener.
  el.addEventListener('input', (ev) => {
    const t = ev.target as HTMLElement;
    const f = t.dataset.ob as 'name' | 'qty' | 'price' | undefined;
    if (!f) return;
    const tr = t.closest<HTMLElement>('[data-ob-row]');
    const i = Number(tr?.dataset.obRow);
    const b = state.baris[i];
    if (!b) return;
    b[f] = (t as HTMLInputElement).value;
    const amt = tr?.querySelector('[data-ob-amt]');
    if (amt) amt.textContent = rp(jumlahBaris(b));
    const tot = host?.querySelector('#ord-total');
    if (tot) tot.textContent = rp(totalBaris());
  });
  el.addEventListener('click', (ev) => {
    const del = (ev.target as HTMLElement).closest<HTMLElement>('[data-ob-del]');
    if (del) {
      const i = Number(del.dataset.obDel);
      if (state.baris.length > 1) state.baris.splice(i, 1);
      else state.baris = [{ name: '', qty: '1', price: '' }];
      paintBaris();
      return;
    }
    if ((ev.target as HTMLElement).closest('#ord-add')) {
      state.baris.push({ name: '', qty: '1', price: '' });
      paintBaris();
      host?.querySelector<HTMLInputElement>(`[data-ob-row="${state.baris.length - 1}"] [data-ob="name"]`)?.focus();
    }
  });
  el.querySelector('#ord-simpan')?.addEventListener('click', () => void simpanBaru());
  el.querySelectorAll('[data-ord-kembali]').forEach((b) => b.addEventListener('click', keDaftar));
}

async function simpanBaru(): Promise<void> {
  if (!punyaIzin('pesanan.buat')) {
    toast('Butuh izin Buat pesanan', 'warning');
    return;
  }
  if (state.custId === null) {
    toast('Pilih pelanggan dulu', 'warning');
    return;
  }
  const isi: { name: string; qty: number; price: number }[] = [];
  for (let i = 0; i < state.baris.length; i++) {
    const b = state.baris[i];
    const nama = b.name.trim();
    if (!nama) continue; // baris kosong diabaikan
    const qty = qtyDari(b.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast(`Baris ${i + 1}: qty harus > 0`, 'warning');
      return;
    }
    if (!String(b.price).trim()) {
      toast(`Baris ${i + 1}: isi harga (boleh 0)`, 'warning');
      return;
    }
    const price = Number(b.price);
    if (!Number.isFinite(price) || price < 0) {
      toast(`Baris ${i + 1}: harga harus angka >= 0`, 'warning');
      return;
    }
    isi.push({ name: nama, qty, price });
  }
  if (isi.length === 0) {
    toast('Isi minimal 1 item pesanan', 'warning');
    return;
  }
  try {
    const r = await apiPost<{ data: { order: OrderRow } }>('/api/orders', {
      customer_id: state.custId,
      items: isi,
      note: state.formNote.trim(),
      cashier: getCashier(),
    });
    toast(`Pesanan ${r.data.order.order_no} tersimpan`, 'success');
    location.hash = `#/orders/${r.data.order.id}`;
  } catch (e) {
    toast(`Gagal simpan: ${errMsg(e)}`, 'error');
  }
}

/* ---------- RINCIAN ---------- */

function renderDetail(): string {
  if (state.detLoading) {
    return `<div class="space-y-3"><div class="card"><div class="skel h-6 w-52"></div></div></div>`;
  }
  if (state.detError || !state.detail) {
    return `
    <div class="space-y-3">
      <div class="card">
        <button type="button" data-ord-kembali class="btn btn-ghost">${icon('chevL')}<span>Kembali</span></button>
      </div>
      <div class="card">
        <div class="empty">${icon('alert')}<span>Gagal memuat pesanan: ${esc(state.detError || 'tidak ditemukan')}</span></div>
      </div>
    </div>`;
  }
  const o = state.detail.order;
  const aktif = o.status === 'dikerjakan' || o.status === 'selesai';
  const aksi = [
    o.status === 'dikerjakan' && punyaIzin('pesanan.buat')
      ? `<button type="button" class="btn btn-ghost" data-oact="selesai">${icon('check')}<span>Tandai selesai</span></button>`
      : o.status === 'selesai' && punyaIzin('pesanan.buat')
        ? `<button type="button" class="btn btn-ghost" data-oact="dikerjakan">${icon('sync')}<span>Kembali dikerjakan</span></button>`
        : '',
    aktif && punyaIzin('pesanan.bayar') ? `<button type="button" class="btn btn-primary" data-oact="serahkan">${icon('check')}<span>Serahkan</span></button>` : '',
    aktif && punyaIzin('pesanan.batal') ? `<button type="button" class="btn btn-ghost !text-red-600 dark:!text-red-400" data-oact="batalkan">${icon('trash')}<span>Batalkan</span></button>` : '',
    `<button type="button" class="btn btn-ghost" data-oact="cetak-nota">${icon('print')}<span>Nota pesanan</span></button>`,
    o.sale_id ? `<button type="button" class="btn btn-ghost" data-oact="cetak-struk">${icon('receipt')}<span>Struk penjualan</span></button>` : '',
  ].join('');

  const info: { l: string; v: string; sub?: string }[] = [
    { l: 'Pelanggan', v: esc(o.customer_name) },
    { l: 'Dibuat', v: esc(tglLokal(o.created_at)), sub: esc(o.cashier) },
    o.taken_at
      ? { l: 'Diserahkan', v: esc(tglLokal(o.taken_at)), sub: o.sale_id ? `nota ${esc(o.sale_id.slice(0, 8))}…` : '' }
      : { l: 'Diserahkan', v: '<span class="text-gray-400">belum</span>' },
  ];
  if (o.batal_at) info.push({ l: 'Dibatalkan', v: esc(tglLokal(o.batal_at)), sub: o.batal_note ? esc(o.batal_note) : '' });

  const items = state.detail.items
    .map(
      (it) => `
      <tr>
        <td class="td">
          <div class="cell-strong">${esc(it.name)}</div>
          ${it.note?.trim() ? `<div class="cell-sub">${esc(it.note.trim())}</div>` : ''}
        </td>
        <td class="td td-num tabular-nums">${it.qty}</td>
        <td class="td td-num tabular-nums">${rp(it.price)}</td>
        <td class="td td-num tabular-nums">${rp(it.amount)}</td>
      </tr>`,
    )
    .join('');

  const payments = state.detail.payments.length
    ? `
    <div class="card-flush">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="th">Waktu</th>
              <th class="th">Jenis</th>
              <th class="th">Metode</th>
              <th class="th text-right">Nominal</th>
              <th class="th">Shift</th>
              <th class="th">Kasir</th>
            </tr>
          </thead>
          <tbody>
            ${state.detail.payments
              .map(
                (p) => `
              <tr>
                <td class="td tabular-nums">${esc(tglLokal(p.created_at))}</td>
                <td class="td">${kindLabel(p.kind)}${p.note ? `<div class="cell-sub">${esc(p.note)}</div>` : ''}</td>
                <td class="td">${esc(metodeLabel(p.method))}</td>
                <td class="td td-num tabular-nums">${p.kind === 'refund' ? `-${rp(p.amount)}` : rp(p.amount)}</td>
                <td class="td">${p.shift_id ? `#${p.shift_id}` : '<span class="text-gray-400">—</span>'}</td>
                <td class="td">${esc(p.cashier)}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>`
    : `<div class="card"><div class="empty">${icon('wallet')}<span>Belum ada pembayaran.</span></div></div>`;

  const sisaKelas = o.status === 'batal'
    ? 'text-gray-400'
    : o.sisa > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400';
  const catatanHutang = o.hutang_sisa > 0
    ? `<p class="mt-2 text-xs text-red-600 dark:text-red-400">${icon('alert')}<span> ${rp(o.hutang_sisa)} tercatat di <a href="#/debts" class="underline">halaman Hutang</a> (${esc(o.customer_name)}).</span></p>`
    : '';

  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" data-ord-kembali class="btn btn-ghost">${icon('chevL')}<span>Kembali</span></button>
          <span class="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">${esc(o.order_no)}</span>
          ${badgeStatus(o.status)}
        </div>
        <div class="flex flex-wrap items-center gap-2">${aksi}</div>
      </div>
      <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        ${info
          .map(
            (i) => `
        <div>
          <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${i.l}</p>
          <p class="mt-0.5 text-sm text-gray-900 dark:text-white">${i.v}</p>
          ${i.sub ? `<p class="text-xs text-gray-500 dark:text-gray-400">${i.sub}</p>` : ''}
        </div>`,
          )
          .join('')}
      </div>
      ${o.note ? `<p class="mt-3 text-xs text-gray-500 dark:text-gray-400">Catatan: ${esc(o.note)}</p>` : ''}
    </div>
    <div class="card">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="grid flex-1 gap-3 sm:grid-cols-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Total</p>
            <p class="mt-0.5 text-lg font-bold tabular-nums text-gray-900 dark:text-white">${rp(o.total)}</p>
          </div>
          <div>
            <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Dibayar</p>
            <p class="mt-0.5 text-lg font-bold tabular-nums text-gray-900 dark:text-white">${rp(o.dibayar)}</p>
          </div>
          <div>
            <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Sisa</p>
            <p class="mt-0.5 text-lg font-bold tabular-nums ${sisaKelas}">${o.status === 'batal' ? '—' : rp(o.sisa)}</p>
          </div>
        </div>
        ${
          aktif && o.sisa > 0 && punyaIzin('pesanan.bayar')
            ? `<button type="button" class="btn btn-ghost" data-oact="dp">${icon('plus')}<span>Tambah DP</span></button>`
            : ''
        }
      </div>
      ${catatanHutang}
    </div>
    <div class="card-flush">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="th">Item (${state.detail.items.length})</th>
              <th class="th text-right !w-20">Qty</th>
              <th class="th text-right !w-32">Harga</th>
              <th class="th text-right !w-32">Jumlah</th>
            </tr>
          </thead>
          <tbody>${items}</tbody>
        </table>
      </div>
    </div>
    ${payments}
  </div>`;
}

function paintDetail(): void {
  if (!host) return;
  host.innerHTML = renderDetail();
  bindDetail();
}

function bindDetail(): void {
  if (!host) return;
  host.querySelectorAll('[data-ord-kembali]').forEach((b) => b.addEventListener('click', keDaftar));
  host.querySelectorAll<HTMLElement>('[data-oact]').forEach((b) =>
    b.addEventListener('click', () => void aksiDetail(b.dataset.oact ?? '')),
  );
}

async function loadDetail(id: number): Promise<void> {
  state.detLoading = true;
  state.detError = '';
  paintDetail();
  try {
    const r = await apiGet<{ data: { order: OrderRow; items: OrderItem[]; payments: OrderPayment[] } }>(
      `/api/orders/${id}`,
    );
    state.detail = r.data;
  } catch (e) {
    state.detError = errMsg(e);
  }
  state.detLoading = false;
  if (host?.isConnected) paintDetail();
}

async function aksiDetail(act: string): Promise<void> {
  const d = state.detail;
  if (!d) return;
  const o = d.order;
  // Cermin izin server per aksi — tombolnya sudah disembunyikan, ini jaring
  // kedua supaya pintasan/klik programatik tidak menabrak 403 tanpa penjelasan.
  const butuh: Record<string, string> = {
    selesai: 'pesanan.buat',
    dikerjakan: 'pesanan.buat',
    serahkan: 'pesanan.bayar',
    dp: 'pesanan.bayar',
    batalkan: 'pesanan.batal',
  };
  const izin = butuh[act];
  if (izin && !punyaIzin(izin)) {
    toast(`Butuh izin ${izin === 'pesanan.buat' ? 'Buat pesanan' : izin === 'pesanan.bayar' ? 'Bayar pesanan' : 'Batalkan pesanan'}`, 'warning');
    return;
  }
  if (act === 'selesai' || act === 'dikerjakan') {
    try {
      await apiPost(`/api/orders/${o.id}/status`, { status: act });
      toast(act === 'selesai' ? 'Pesanan selesai — siap diambil' : 'Pesanan kembali dikerjakan', 'success');
      await loadDetail(o.id);
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
    return;
  }
  if (act === 'serahkan') return dialogSerahkan(o);
  if (act === 'batalkan') return dialogBatal(o);
  if (act === 'dp') return dialogDp(o);
  if (act === 'cetak-nota') return void cetakNotaPesanan(d.order, d.items, d.payments);
  if (act === 'cetak-struk' && o.sale_id) {
    try {
      const r = await apiGet<{ data: { sale: SaleRow } }>(`/api/sales/${encodeURIComponent(o.sale_id)}`);
      await cetakUlang(r.data.sale);
    } catch (e) {
      toast(`Gagal ambil nota: ${errMsg(e)}`, 'error');
    }
  }
}

/* ---------- DIALOG: METODE + UANG ---------- */

function metodeChips(idPrefix: string, awal: Metode): string {
  return (['tunai', 'qris', 'transfer'] as Metode[])
    .map(
      (m) => `<button type="button" class="chip-tab${m === awal ? ' is-active' : ''}" data-${idPrefix}="${m}">${metodeLabel(m)}</button>`,
    )
    .join('');
}

/** Bind chips metode di dalam elemen modal: klik = pindah aktif. Mengembalikan
 *  getter metode terpilih. */
function bindMetode(el: HTMLElement, idPrefix: string, awal: Metode): () => Metode {
  let metode: Metode = awal;
  el.querySelectorAll<HTMLElement>(`[data-${idPrefix}]`).forEach((b) =>
    b.addEventListener('click', () => {
      metode = (b.dataset[idPrefix.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] as Metode) ?? awal;
      el.querySelectorAll<HTMLElement>(`[data-${idPrefix}]`).forEach((x) => {
        const aktif = x === b;
        x.classList.toggle('is-active', aktif);
        x.setAttribute('aria-pressed', String(aktif));
      });
    }),
  );
  return () => metode;
}

function barisInfo(l: string, v: string, kelas = ''): string {
  return `<div class="flex items-baseline justify-between gap-3"><span class="text-xs text-gray-500 dark:text-gray-400">${l}</span><span class="text-sm font-semibold tabular-nums ${kelas}">${v}</span></div>`;
}

/* ---------- DIALOG: TAMBAH DP ---------- */

function dialogDp(o: OrderRow): void {
  if (!punyaIzin('pesanan.bayar')) {
    toast('Butuh izin Bayar pesanan', 'warning');
    return;
  }
  openModal({
    title: `Tambah DP — ${o.order_no}`,
    okLabel: 'Simpan DP',
    body: `
      <div class="space-y-3">
        <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/60">
          ${barisInfo('Sisa tagihan', rp(o.sisa))}
          ${barisInfo('Pelanggan', esc(o.customer_name))}
        </div>
        <div class="field">
          <span class="label">Metode</span>
          <div class="chip-tabs">${metodeChips('dpmetode', 'tunai')}</div>
        </div>
        <div class="field">
          <label class="label" for="dp-nominal">Nominal DP (Rp) *</label>
          <input id="dp-nominal" class="input" type="number" inputmode="numeric" min="1" placeholder="cth: 50000" />
          <button type="button" class="btn btn-ghost mt-1 !min-h-[30px] !px-2.5" id="dp-penuh">Penuh ${rp(o.sisa)}</button>
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">${
          state.shiftId
            ? `Tercatat pada Shift #${state.shiftId} (menambah laci saat diterima).`
            : 'Di luar shift — tetap tercatat, tidak menambah laci shift mana pun.'
        }</p>
      </div>`,
    onMount: ({ el, ok, close }) => {
      const getMetode = bindMetode(el, 'dpmetode', 'tunai');
      const inp = el.querySelector<HTMLInputElement>('#dp-nominal')!;
      inp.focus();
      el.querySelector('#dp-penuh')?.addEventListener('click', () => {
        inp.value = String(o.sisa);
        inp.focus();
      });
      ok.addEventListener('click', async () => {
        const amount = Number(inp.value || 0);
        if (!Number.isInteger(amount) || amount <= 0) {
          toast('Nominal harus rupiah bulat > 0', 'warning');
          inp.focus();
          return;
        }
        if (amount > o.sisa) {
          toast(`Melebihi sisa tagihan (${rp(o.sisa)})`, 'warning');
          inp.focus();
          return;
        }
        try {
          await apiPost(`/api/orders/${o.id}/payments`, {
            method: getMetode(),
            amount,
            cashier: getCashier(),
            ...(state.shiftId !== null ? { shift_id: state.shiftId } : {}),
          });
          close();
          toast(`DP ${rp(amount)} tersimpan`, 'success');
          await loadDetail(o.id);
        } catch (e) {
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

/* ---------- DIALOG: SERAHKAN (TAKE) ---------- */

function dialogSerahkan(o: OrderRow): void {
  if (!punyaIzin('pesanan.bayar')) {
    toast('Butuh izin Bayar pesanan', 'warning');
    return;
  }
  openModal({
    title: `Serahkan — ${o.order_no}`,
    okLabel: 'Serahkan',
    wide: true,
    body: `
      <div class="space-y-3">
        <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/60">
          ${barisInfo('Total pesanan', rp(o.total))}
          ${barisInfo('Sudah dibayar', rp(o.dibayar))}
          ${barisInfo('Sisa tagihan', rp(o.sisa), '!text-red-600 dark:!text-red-400')}
        </div>
        <div class="field">
          <span class="label">Metode pelunasan</span>
          <div class="chip-tabs">${metodeChips('srmetode', 'tunai')}</div>
        </div>
        <div class="field">
          <label class="label" for="sr-terima">Uang diterima sekarang (Rp)</label>
          <input id="sr-terima" class="input" type="number" inputmode="numeric" min="0" placeholder="cth: ${o.sisa}" />
          <button type="button" class="btn btn-ghost mt-1 !min-h-[30px] !px-2.5" id="sr-pas">Uang pas ${rp(o.sisa)}</button>
        </div>
        <div class="rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-600" id="sr-out"></div>
        <p class="text-xs text-gray-500 dark:text-gray-400">Kurang dari sisa tagihan otomatis dicatat sebagai <b>hutang pelanggan</b> (halaman Hutang). Nota penjualan penuh diterbitkan saat Serahkan — omzet dikakui di sini.</p>
      </div>`,
    onMount: ({ el, ok, close }) => {
      const getMetode = bindMetode(el, 'srmetode', 'tunai');
      const inp = el.querySelector<HTMLInputElement>('#sr-terima')!;
      const out = el.querySelector<HTMLElement>('#sr-out')!;
      const hitung = (): { terima: number; bayar: number; kembali: number; hutang: number } => {
        const terima = Number(inp.value || 0);
        const bayar = Math.min(Number.isFinite(terima) ? terima : 0, o.sisa);
        return { terima, bayar, kembali: (Number.isFinite(terima) ? terima : 0) - bayar, hutang: o.sisa - bayar };
      };
      const paint = (): void => {
        const h = hitung();
        out.innerHTML = [
          barisInfo('Uang diterima', rp(h.terima)),
          barisInfo('Pelunasan', rp(h.bayar)),
          ...(h.kembali > 0 ? [barisInfo('Kembalian', rp(h.kembali))] : []),
          ...(h.hutang > 0
            ? [barisInfo('Masuk Hutang', rp(h.hutang), '!text-red-600 dark:!text-red-400')]
            : []),
        ].join('');
      };
      inp.addEventListener('input', paint);
      el.querySelector('#sr-pas')?.addEventListener('click', () => {
        inp.value = String(o.sisa);
        paint();
        inp.focus();
      });
      inp.focus();
      paint();
      ok.addEventListener('click', async () => {
        const h = hitung();
        if (!Number.isInteger(h.terima) || h.terima < 0) {
          toast('Uang diterima harus rupiah bulat >= 0', 'warning');
          inp.focus();
          return;
        }
        try {
          const r = await apiPost<{
            data: { order: OrderRow; sale: SaleRow; kembalian: number; hutang: number };
          }>(`/api/orders/${o.id}/take`, {
            method: getMetode(),
            diterima: h.terima,
            cashier: getCashier(),
            ...(state.shiftId !== null ? { shift_id: state.shiftId } : {}),
          });
          close();
          const hasil = r.data;
          const ekstra = [
            hasil.kembalian > 0 ? `kembalian ${rp(hasil.kembalian)}` : '',
            hasil.hutang > 0 ? `hutang ${rp(hasil.hutang)} (${o.customer_name})` : '',
          ].filter(Boolean).join(' · ');
          toast(`Pesanan ${o.order_no} diserahkan${ekstra ? ` · ${ekstra}` : ''}`, 'success', 8000);
          await loadDetail(o.id);
          await dialogSesudahSerah(hasil.order.order_no, hasil.sale);
        } catch (e) {
          toast(`Gagal serahkan: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

/** Setelah serah: pilihan cetak (maks 3 slot swal — pola pilihan cetak POS).
 *  Struk penjualan = jalur cetak ulang Riwayat (satu susunan struk dengan
 *  nota POS asli); nota pesanan = builder thermal lokal di bawah. */
async function dialogSesudahSerah(orderNo: string, sale: SaleRow): Promise<void> {
  const pilih = await choiceDialog({
    title: 'Pesanan diserahkan',
    message: `${orderNo} → nota penjualan ${sale.invoice_no ?? ''}. Mau cetak sekarang?`,
    icon: 'success',
    choices: [
      { key: 'struk', label: 'Struk penjualan' },
      { key: 'nota', label: 'Nota pesanan' },
    ],
    cancelLabel: 'Selesai',
  });
  if (pilih === 'struk') {
    try {
      const r = await apiGet<{ data: { sale: SaleRow } }>(`/api/sales/${encodeURIComponent(sale.id)}`);
      await cetakUlang(r.data.sale);
    } catch (e) {
      toast(`Struk tidak tercetak: ${errMsg(e)}`, 'warning', 9000);
    }
    return;
  }
  if (pilih === 'nota' && state.detail) {
    await cetakNotaPesanan(state.detail.order, state.detail.items, state.detail.payments);
  }
}

/* ---------- DIALOG: BATALKAN ---------- */

function dialogBatal(o: OrderRow): void {
  if (!punyaIzin('pesanan.batal')) {
    toast('Butuh izin Batalkan pesanan', 'warning');
    return;
  }
  const kembali = o.dibayar;
  openModal({
    title: `Batalkan — ${o.order_no}`,
    okLabel: 'Batalkan pesanan',
    danger: true,
    body: `
      <div class="space-y-3">
        <p class="text-sm text-gray-600 dark:text-gray-300">Pesanan dibatalkan sebelum diserahkan. Kalau sudah ada uang masuk, otomatis tercatat sebagai <b>refund</b> (ke luar laci).</p>
        <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/60">
          ${barisInfo('Uang masuk sejauh ini', rp(kembali))}
          ${barisInfo('Refund saat batal', rp(kembali), kembali > 0 ? '!text-red-600 dark:!text-red-400' : '')}
        </div>
        <div class="field">
          <span class="label">Metode refund</span>
          <div class="chip-tabs">${metodeChips('bmetode', 'tunai')}</div>
        </div>
        <div class="field">
          <label class="label" for="batal-note">Alasan (catatan)</label>
          <input id="batal-note" class="input" maxlength="200" placeholder="cth: pelanggan batal cetak" />
        </div>
      </div>`,
    onMount: ({ el, ok, close }) => {
      const getMetode = bindMetode(el, 'bmetode', 'tunai');
      (el.querySelector('#batal-note') as HTMLInputElement).focus();
      ok.addEventListener('click', async () => {
        try {
          const r = await apiPost<{ data: { order: OrderRow; refund: number } }>(
            `/api/orders/${o.id}/cancel`,
            {
              note: (el.querySelector('#batal-note') as HTMLInputElement).value.trim(),
              method: getMetode(),
              cashier: getCashier(),
              ...(state.shiftId !== null ? { shift_id: state.shiftId } : {}),
            },
          );
          close();
          toast(
            `Pesanan ${o.order_no} dibatalkan${r.data.refund > 0 ? ` · refund ${rp(r.data.refund)}` : ''}`,
            'success',
          );
          await loadDetail(o.id);
        } catch (e) {
          toast(`Gagal batalkan: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

/* ---------- CETAK NOTA PESANAN (thermal 58mm) ---------- */

/** Nota PESANAN (bukan nota penjualan): dikirim ke print-agent layout thermal
 *  (keputusan pemilik #5). Susunan sengaja mengikuti pola struk POS
 *  (judul/meta/item/baris/kaki) supaya terbaca sama di printer yang sama. */
async function cetakNotaPesanan(o: OrderRow, items: OrderItem[], payments: OrderPayment[]): Promise<void> {
  try {
    if (getPrintPause()) {
      toast('Cetak sedang dijeda — nyalakan di halaman Pengaturan', 'warning', 8000);
      return;
    }
    const bayar = payments.filter((p) => p.kind !== 'refund');
    const refund = payments.reduce((a, p) => a + (p.kind === 'refund' ? p.amount : 0), 0);
    const qtyTotal = items.reduce((a, it) => a + (Number(it.qty) || 0), 0);
    const s: Struk = {
      judul: getToko(),
      subjudul: 'NOTA PESANAN',
      meta: [
        // Nomor pesanan TIDAK dipendekkan oleh opsi "nomor struk pendek":
        // prefiks ORD-YYMMDD adalah identitas pesanan (bukan nomor nota
        // penjualan), dan memotongnya menyisakan urutan yang bisa tertukar.
        o.order_no,
        tglLokal(o.created_at),
        `Kasir: ${o.cashier}`,
        // Nama pelanggan SELALU dicetak di nota pesanan: ini dokumen serah
        // barang/jasa, bukan struk belanja — nota tanpa nama pemilik pesanan
        // tidak berguna. Opsi "detail pelanggan" (alamat/telepon) sengaja
        // hanya berlaku di struk penjualan thermal (POS/Riwayat), karena
        // halaman ini tidak menyimpan kontak pelanggan.
        `Pelanggan: ${o.customer_name || 'Pelanggan Umum'}`,
        ...(o.status === 'diambil'
          ? ['Status: DIAMBIL']
          : o.status === 'batal'
            ? ['Status: DIBATALKAN']
            : []),
      ],
      jumlahItem: teksJumlahItem(items.length, qtyTotal),
      items: items.map((it) => ({
        name: it.name, qty: it.qty, price: it.price,
        ...(it.note?.trim() ? { note: it.note.trim() } : {}),
      })),
      baris: [
        { kiri: 'Total', kanan: rp(o.total), tebal: true },
        ...bayar.map((p) => ({ kiri: `${kindLabel(p.kind)} (${metodeLabel(p.method)})`, kanan: rp(p.amount) })),
        ...(refund > 0 ? [{ kiri: 'Refund', kanan: `-${rp(refund)}` }] : []),
        { kiri: 'Dibayar', kanan: rp(o.dibayar) },
        { kiri: 'Sisa', kanan: rp(o.status === 'batal' ? 0 : o.sisa) },
      ],
      kaki: [
        o.status === 'dikerjakan' ? 'Pesanan sedang dikerjakan' : o.status === 'selesai' ? 'Pesanan siap diambil' : 'Simpan nota ini',
        ...(footerStruk() ? [footerStruk()] : []),
      ],
    };
    await kirimPrint(await strukUntukTercetak(s, 'thermal'));
    toast(`Nota ${o.order_no} dicetak`, 'success');
  } catch (e) {
    toast(`Nota tidak tercetak: ${errMsg(e)}`, 'warning', 9000);
  }
}

/* ---------- MUAT DATA ---------- */

async function loadShift(): Promise<void> {
  // Shift terbuka kasir ini (pola kas-masuk) — pembayaran/DP ikut shift ini.
  // Gagal = di luar shift (null), bukan error halaman.
  try {
    const r = await apiGet<{ data: { id: number } | null }>(
      `/api/shifts/open?cashier=${encodeURIComponent(getCashier())}`,
    );
    state.shiftId = r.data?.id ?? null;
  } catch {
    state.shiftId = null;
  }
}

async function loadCustomers(): Promise<void> {
  try {
    const r = await apiGet<{ data: { id: number; code: string; name: string }[] }>('/api/customers?limit=200');
    state.customers = r.data;
  } catch {
    state.customers = [];
  }
}

/* ---------- ENTRY ---------- */

export async function mountOrdersPage(el: HTMLElement): Promise<void> {
  host = el;
  try {
    // Nama toko + opsi struk (footer, jumlah item, detail pelanggan) —
    // sumber yang sama dengan POS/Riwayat.
    const r = await apiGet<{ data: Parameters<typeof syncDariServerSettings>[0] }>('/api/settings');
    syncDariServerSettings(r.data);
  } catch {}
  const sub = subRute();
  // Alt+N = pesanan baru (ui/aksi-baru.ts) — satu pintu dengan tombol toolbar.
  // Hanya didaftarkan bila boleh membuat pesanan (tombolnya pun disembunyikan).
  if (punyaIzin('pesanan.buat')) {
    pasangAksiBaru(() => {
      location.hash = '#/orders/baru';
    });
  }
  if (sub.view === 'baru' && !punyaIzin('pesanan.buat')) {
    toast('Butuh izin Buat pesanan', 'warning');
    location.hash = '#/orders';
    return;
  }
  if (sub.view === 'list') {
    state.status = 'semua';
    state.offset = 0;
    state.q = '';
    el.innerHTML = renderList();
    paintList();
    el.querySelector('#ord-new')?.addEventListener('click', () => {
      location.hash = '#/orders/baru';
    });
    el.querySelectorAll<HTMLElement>('[data-ostatus]').forEach((b) =>
      b.addEventListener('click', () => {
        state.status = (b.dataset.ostatus as 'semua' | StatusOrder) ?? 'semua';
        state.offset = 0;
        void load();
      }),
    );
    el.querySelector<HTMLInputElement>('#ord-q')?.addEventListener('input', (ev) => {
      state.q = (ev.target as HTMLInputElement).value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.offset = 0;
        void load();
      }, 250);
    });
    await Promise.all([loadShift(), load()]);
    return;
  }
  if (sub.view === 'baru') {
    state.custId = null;
    state.formNote = '';
    state.baris = [{ name: '', qty: '1', price: '' }];
    el.innerHTML = renderBaru();
    bindBaru(el);
    await Promise.all([loadShift(), loadCustomers()]);
    if (!host?.isConnected) return;
    // Isi ulang select setelah pelanggan termuat (render pertama masih kosong);
    // pilihan user dipertahankan lewat state.custId.
    const sel = el.querySelector<HTMLSelectElement>('#ord-cust');
    if (sel) {
      const nilai = sel.value;
      sel.innerHTML = `<option value="">— pilih pelanggan —</option>${state.customers
        .map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.code)}</option>`)
        .join('')}`;
      sel.value = state.custId !== null ? String(state.custId) : nilai;
    }
    return;
  }
  await Promise.all([loadShift(), loadDetail(sub.id)]);
}
