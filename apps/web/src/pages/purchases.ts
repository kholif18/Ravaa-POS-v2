// Halaman Pembelian (#/purchases, Tahap 3 2026-10-11): nota kulakan ke
// supplier — order dulu, barang datang baru receive (stok masuk), bayar tunai
// (bawaan lunas; boleh sisa hutang — keputusan pemilik (b): praktik selalu
// tunai, kolom hutang hanya bila suatu saat terjadi).
//
// Server: GET /api/purchases?status=&limit=&offset= (+`sisa` computed,
// `n_items`), GET /api/purchases/:id, POST /api/purchases (order, tanpa stok),
// POST /:id/receive (stok masuk rumus restock + terbayar + shift),
// POST /:id/pay (cicil sisa, maks total), POST /:id/cancel (order saja).
// Kas keluar = `terbayar` di shift PO (agregat purchase_total → kasSeharusnya).

import { apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { getCashier } from '../ui/user';
import { rp } from '../escpos';

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
type ProdukCari = { id: number; sku: string; name: string; price: number; cost: number; stock: number };

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
        <div class="flex flex-wrap items-center gap-1.5">
          ${STATUS.map((s) => `<button type="button" data-pstatus="${s.key}" class="chip${state.status === s.key ? ' !border-primary !text-primary' : ''}">${s.label}</button>`).join('')}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="chip !border-amber-500/40 !text-amber-700 dark:!text-amber-400" id="po-lewat" hidden
                title="Ada nota diterima dengan sisa hutang lebih dari 30 hari — segera dibayar">
            ${icon('alert')}<span id="po-lewat-n">0</span><span>lewat 30 hari</span>
          </span>
          <button type="button" id="po-new" class="btn btn-primary">${icon('plus')}<span>Buat PO</span></button>
        </div>
      </div>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Order dulu, barang datang baru Terima (stok masuk + kas keluar). Bawaan tunai penuh — kurangi bila hutang.</p>
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
        <span>Belum ada nota pembelian${state.status === 'semua' ? '.' : ' status ini.'}</span>
      </div>
    </div>`;
  }
  const rows = state.items
    .map((o) => {
      // Umur hutang supplier (2026-10-16): hari sejak barang diterima; server
      // hanya mengirim angka untuk PO received yang masih bersisa.
      const umur = o.umur_hari ?? null;
      return `
      <tr data-row="${o.id}" class="cursor-pointer" data-po-buka="${o.id}" title="Buka rincian">
        <td class="td tabular-nums">PO-${o.id}</td>
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
    const aktif = b.dataset.pstatus === state.status;
    b.classList.toggle('!border-primary', aktif);
    b.classList.toggle('!text-primary', aktif);
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

/* ---------- RINCIAN + AKSI ---------- */

async function bukaRincian(id: number): Promise<void> {
  let data: { purchase: Po; items: PoItem[] } | null = null;
  try {
    const r = await apiGet<{ data: { purchase: Po; items: PoItem[] } }>(`/api/purchases/${id}`);
    data = r.data;
  } catch (e) {
    toast(`Gagal: ${errMsg(e)}`, 'error');
    return;
  }
  const { purchase: po, items } = data;
  const aksi: string[] = [];
  if (po.status === 'order') {
    aksi.push(`<button type="button" data-po-act="terima" class="btn btn-primary flex-1 justify-center">${icon('check')}<span>Terima barang</span></button>`);
    aksi.push(`<button type="button" data-po-act="batal" class="btn btn-ghost !text-red-600 dark:!text-red-400">Batalkan</button>`);
  } else if (po.status === 'received' && po.sisa > 0) {
    aksi.push(`<button type="button" data-po-act="bayar" class="btn btn-primary flex-1 justify-center">${icon('wallet')}<span>Bayar sisa ${rp(po.sisa)}</span></button>`);
  }
  openModal({
    title: `PO-${po.id} — ${po.supplier_name || 'Tanpa supplier'}`,
    okLabel: 'Tutup',
    wide: true,
    body: `
      <div class="mb-2 flex flex-wrap items-center gap-2">${badge(po)}
        <span class="cell-sub">dibuat ${esc(po.created_at)}${po.received_at ? ` · diterima ${esc(po.received_at)}` : ''}${po.shift_id ? ` · Shift #${po.shift_id}` : ''}</span>
      </div>
      <div class="space-y-1 text-sm">
        ${items.map((it) => `
          <div class="flex items-baseline justify-between gap-2 border-b border-gray-100 py-1.5 last:border-0 dark:border-gray-800">
            <span class="min-w-0"><b>${it.qty} ×</b> ${esc(it.name)} <span class="cell-sub">(${rp(it.harga_beli)})</span></span>
            <span class="shrink-0 font-semibold tabular-nums">${rp(it.amount)}</span>
          </div>`).join('')}
        <div class="flex items-baseline justify-between gap-2 pt-1">
          <span class="font-semibold">Total</span>
          <span class="font-semibold tabular-nums">${rp(po.total)}</span>
        </div>
        <div class="flex items-baseline justify-between gap-2">
          <span>Terbayar</span><span class="tabular-nums">${rp(po.terbayar)}</span>
        </div>
        ${po.sisa > 0 && po.status === 'received' ? `<div class="flex items-baseline justify-between gap-2 font-semibold text-red-600 dark:text-red-400"><span>Sisa hutang</span><span class="tabular-nums">${rp(po.sisa)}</span></div>` : ''}
        ${po.note ? `<p class="text-xs text-gray-500 dark:text-gray-400">Catatan: ${esc(po.note)}</p>` : ''}
      </div>
      ${aksi.length ? `<div class="mt-3 flex gap-2">${aksi.join('')}</div>` : ''}`,
    onMount: ({ el, ok, close }) => {
      ok.addEventListener('click', () => close());
      el.querySelector<HTMLElement>('[data-po-act="terima"]')?.addEventListener('click', () => {
        close();
        dialogTerima(po);
      });
      el.querySelector<HTMLElement>('[data-po-act="batal"]')?.addEventListener('click', async () => {
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
          close();
          await load();
        } catch (e) {
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
      el.querySelector<HTMLElement>('[data-po-act="bayar"]')?.addEventListener('click', () => {
        close();
        dialogBayar(po);
      });
    },
  });
}

/** Terima barang: stok masuk + kas keluar. `dibayar` prefill total (tunai
 *  penuh, praktik toko) — kurangi bila hutang, sisanya tercatat. */
function dialogTerima(po: Po): void {
  openModal({
    title: `Terima PO-${po.id} (${rp(po.total)})`,
    okLabel: 'Terima + bayar',
    body: `
      <div class="field">
        <label class="label" for="pt-bayar">Dibayar tunai (Rp)</label>
        <input id="pt-bayar" class="input text-right font-bold tabular-nums" type="number" inputmode="numeric" min="0" max="${po.total}" step="500" value="${po.total}" />
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Isi penuh = lunas. Kurangi bila hutang — sisanya tercatat sebagai hutang supplier.</p>
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">${
        state.shiftId
          ? `Masuk hitungan Shift #${state.shiftId} (stok masuk, kas keluar ${rp(po.total)}).`
          : 'Di luar shift — tercatat + masuk laporan.'
      }</p>`,
    onMount: ({ el, ok, close }) => {
      ok.addEventListener('click', async () => {
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
          close();
          toast(dibayar === po.total ? `PO-${po.id} diterima lunas` : `PO-${po.id} diterima · hutang ${rp(po.total - dibayar)}`, 'success');
          await load();
        } catch (e) {
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

/** Bayar sisa hutang supplier (cicil, maks sisa). */
function dialogBayar(po: Po): void {
  openModal({
    title: `Bayar PO-${po.id} (sisa ${rp(po.sisa)})`,
    okLabel: 'Bayar',
    body: `
      <div class="field">
        <label class="label" for="pb-amount">Jumlah bayar (Rp)</label>
        <input id="pb-amount" class="input text-right font-bold tabular-nums" type="number" inputmode="numeric" min="1" max="${po.sisa}" step="500" value="${po.sisa}" />
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Maks sisa hutang. Kas keluar diatribusikan ke Shift #${po.shift_id ?? '—'} PO ini.</p>
      </div>`,
    onMount: ({ el, ok, close }) => {
      ok.addEventListener('click', async () => {
        const amount = Number((el.querySelector('#pb-amount') as HTMLInputElement).value || 0);
        if (!Number.isInteger(amount) || amount <= 0) { toast('Jumlah harus rupiah bulat > 0', 'warning'); return; }
        try {
          const r = await apiPost<{ data: Po }>(`/api/purchases/${po.id}/pay`, { amount });
          close();
          toast(r.data.sisa === 0 ? `PO-${po.id} lunas` : `Terbayar · sisa ${rp(r.data.sisa)}`, 'success');
          await load();
        } catch (e) {
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

/* ---------- BUAT PO ---------- */

type BarisPo = { product_id: number; name: string; qty: number; harga_beli: number };

function dialogPo(): void {
  const baris: BarisPo[] = [];
  const gambarBaris = (box: HTMLElement) => {
    const total = baris.reduce((s, b) => s + Math.round(b.qty * b.harga_beli), 0);
    box.innerHTML = baris.length
      ? baris.map((b, i) => `
        <div class="flex items-center justify-between gap-2 border-b border-gray-100 py-1.5 last:border-0 dark:border-gray-800">
          <span class="min-w-0 text-sm"><b>${b.qty} ×</b> ${esc(b.name)} <span class="cell-sub">(${rp(b.harga_beli)})</span></span>
          <span class="flex shrink-0 items-center gap-2">
            <span class="text-sm font-semibold tabular-nums">${rp(Math.round(b.qty * b.harga_beli))}</span>
            <button type="button" data-po-del="${i}" class="row-btn row-btn-danger" aria-label="Hapus baris">${icon('trash')}</button>
          </span>
        </div>`).join('') +
        `<div class="flex items-baseline justify-between gap-2 pt-1 text-sm">
          <span class="font-semibold">Total PO</span>
          <span class="font-semibold tabular-nums">${rp(total)}</span>
        </div>`
      : `<div class="empty">Belum ada baris — cari produk di bawah.</div>`;
    box.querySelectorAll<HTMLElement>('[data-po-del]').forEach((btn) =>
      btn.addEventListener('click', () => {
        baris.splice(Number(btn.dataset.poDel), 1);
        gambarBaris(box);
      }),
    );
  };
  const supOpts = state.suppliers.length
    ? `<option value="">— Tanpa supplier (eceran) —</option>` +
      state.suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}${s.code ? ` · ${esc(s.code)}` : ''}</option>`).join('')
    : `<option value="">— Tanpa supplier (eceran) —</option>`;
  openModal({
    title: 'Buat PO (order)',
    okLabel: 'Simpan PO',
    wide: true,
    body: `
      <div class="field">
        <label class="label" for="po-sup">Supplier</label>
        <select id="po-sup" class="input">${supOpts}</select>
      </div>
      <div class="relative mt-3">
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
        <input id="po-q" class="input pl-9" type="search" placeholder="Cari produk (nama / SKU / barcode)…" autocomplete="off" />
      </div>
      <div id="po-hasil" class="mt-2 max-h-44 space-y-1 overflow-y-auto"></div>
      <div class="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700">
        <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Baris PO (qty + harga beli bisa diubah per baris)</p>
        <div id="po-baris"></div>
      </div>
      <div class="field mt-3">
        <label class="label" for="po-note">Catatan</label>
        <input id="po-note" class="input" maxlength="200" placeholder="cth: pesan Senin, datang Selasa" />
      </div>`,
    onMount: ({ el, ok, close }) => {
      const box = el.querySelector('#po-baris') as HTMLElement;
      const hasil = el.querySelector('#po-hasil') as HTMLElement;
      const q = el.querySelector('#po-q') as HTMLInputElement;
      gambarBaris(box);
      q.focus();
      q.addEventListener('input', () => {
        clearTimeout(cariTimer);
        cariTimer = setTimeout(async () => {
          const v = q.value.trim();
          if (v.length < 2) { hasil.innerHTML = ''; return; }
          try {
            const r = await apiGet<{ data: ProdukCari[] }>(`/api/products?q=${encodeURIComponent(v)}&status=aktif`);
            hasil.innerHTML = r.data.slice(0, 8).map((pd) => `
              <div class="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-2 py-1.5 text-sm dark:border-gray-700">
                <span class="min-w-0"><b>${esc(pd.name)}</b> <span class="cell-sub">${esc(pd.sku)} · stok ${pd.stock}</span></span>
                <span class="flex shrink-0 items-center gap-1.5">
                  <input data-po-qty="${pd.id}" class="input input-sm !w-20 text-right tabular-nums" type="number" min="0" step="any" value="0" aria-label="Qty ${esc(pd.name)}" />
                  <input data-po-hb="${pd.id}" class="input input-sm !w-24 text-right tabular-nums" type="number" min="0" step="1" value="${pd.cost || ''}" placeholder="hbeli" aria-label="Harga beli ${esc(pd.name)}" />
                  <button type="button" data-po-add="${pd.id}" class="btn btn-ghost !min-h-[30px] !px-2.5" aria-label="Tambah ${esc(pd.name)}">${icon('plus')}</button>
                </span>
              </div>`).join('') || `<div class="empty">Tidak ketemu.</div>`;
            hasil.querySelectorAll<HTMLElement>('[data-po-add]').forEach((btn) =>
              btn.addEventListener('click', () => {
                const pid = Number(btn.dataset.poAdd);
                const pd = r.data.find((x) => x.id === pid);
                if (!pd) return;
                const qty = Number((hasil.querySelector(`[data-po-qty="${pid}"]`) as HTMLInputElement)?.value || 0);
                const hbRaw = (hasil.querySelector(`[data-po-hb="${pid}"]`) as HTMLInputElement)?.value || '';
                const hb = hbRaw === '' ? pd.cost : Number(hbRaw);
                if (!(qty > 0)) { toast('Isi qty dulu', 'warning'); return; }
                if (!Number.isFinite(hb) || hb < 0) { toast('Harga beli harus angka >= 0', 'warning'); return; }
                const ada = baris.find((b) => b.product_id === pid && b.harga_beli === Math.round(hb));
                if (ada) ada.qty += qty;
                else baris.push({ product_id: pid, name: pd.name, qty, harga_beli: Math.round(hb) });
                gambarBaris(box);
              }),
            );
          } catch (e) {
            hasil.innerHTML = `<div class="empty">Gagal cari: ${esc(errMsg(e))}</div>`;
          }
        }, 250);
      });
      ok.addEventListener('click', async () => {
        if (!baris.length) { toast('Belum ada baris PO', 'warning'); q.focus(); return; }
        const supVal = (el.querySelector('#po-sup') as HTMLSelectElement).value;
        try {
          const r = await apiPost<{ data: { purchase: Po } }>('/api/purchases', {
            ...(supVal ? { supplier_id: Number(supVal) } : {}),
            items: baris.map((b) => ({ product_id: b.product_id, qty: b.qty, harga_beli: b.harga_beli })),
            note: (el.querySelector('#po-note') as HTMLInputElement).value.trim(),
            cashier: getCashier(),
          });
          close();
          toast(`PO-${r.data.purchase.id} tersimpan · ${rp(r.data.purchase.total)}`, 'success');
          await load();
        } catch (e) {
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

/* ---------- AKSI ---------- */

function bindRows(): void {
  host!.querySelectorAll<HTMLElement>('[data-po-buka]').forEach((tr) =>
    tr.addEventListener('click', () => void bukaRincian(Number(tr.dataset.poBuka))),
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
  el.innerHTML = renderPage();
  paint();
  el.querySelector('#po-new')?.addEventListener('click', () => dialogPo());
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
