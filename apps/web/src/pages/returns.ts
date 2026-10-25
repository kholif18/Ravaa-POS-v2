// Halaman Retur (#/returns, Tahap 2 2026-10-11): barang kembali dari
// pelanggan + uang kembali ke pelanggan (tunai keluar laci).
//
// Server: GET /api/returns?date=&limit=&offset= (+`jumlah` uang kembali hari
// itu), GET /api/returns/:id (rincian), POST /api/returns (ber-nota via
// `sale_item_id` dengan guard sisa qty, atau manual via `product_id`+`price`),
// DELETE /api/returns/:id (batalkan: stok keluar lagi + guard stok cukup).
// Retur DARI nota dibuat lewat tombol "Retur" per nota di #/history (prefill
// item nota); halaman ini = linimasa + retur manual (tanpa nota) + rincian.
// Stok hanya kembali untuk produk track_stock=1; uang kembali dihitung untuk
// semua baris. Hari = UTC persis server & Riwayat/Laporan.

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { punyaIzin } from '../ui/auth';
import { confirmDialog } from '../ui/confirm';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { getCashier } from '../ui/user';
import { hariIni, geser, tglPanjang } from '../ui/waktu';
import { rp } from '../escpos';
import { pasangAksiBaru } from '../ui/aksi-baru';

type Retur = {
  id: number;
  created_at: string;
  sale_id: string | null;
  invoice_no: string | null;
  total: number;
  cashier: string;
  shift_id: number | null;
  note: string;
  n_items: number;
};

type ReturItem = {
  id: number; return_id: number; sale_item_id: number | null;
  product_id: number | null; name: string; qty: number; price: number; amount: number;
};

type ProdukCari = { id: number; sku: string; name: string; price: number; stock: number };

const state = {
  date: hariIni(),
  items: [] as Retur[],
  total: 0,
  jumlah: 0,
  // Paginasi (2026-10-11): RESET ke 0 setiap tanggal berubah.
  offset: 0,
  limit: PAGE_SIZE,
  loading: true,
  error: '',
  shiftId: null as number | null,
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

const jam = (iso: string) => (iso ?? '').slice(11, 16) || '—';

function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="ret-prev" class="row-btn" title="Hari sebelumnya" aria-label="Hari sebelumnya">${icon('chevL')}</button>
          <input id="ret-date" type="date" class="input input-sm !w-44" value="${esc(state.date)}" aria-label="Pilih tanggal retur" />
          <button type="button" id="ret-next" class="row-btn" title="Hari berikutnya" aria-label="Hari berikutnya">${icon('chevR')}</button>
          <span class="chip">${icon('calendar')}<span>${esc(tglPanjang(state.date))}</span></span>
        </div>
        ${punyaIzin('retur.buat') ? `<button type="button" id="ret-new" class="btn btn-primary" title="Retur manual tanpa nota (Alt+N)">${icon('plus')}<span>Retur manual</span><kbd class="kbd">Alt+N</kbd></button>` : ''}
      </div>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Retur dari nota dibuat lewat tombol “Retur” di tiap nota halaman Riwayat — otomatis terisi item nota.</p>
    </div>
    <div class="card">
      <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Uang kembali hari ini</p>
      <p class="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-white" id="ret-jumlah">${rp(state.jumlah)}</p>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400" id="ret-sub">${state.total} retur · stok fisik kembali masuk · tunai keluar laci</p>
    </div>
    <div id="ret-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat retur: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.items.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('sync')}
        <span>Belum ada retur hari ini.</span>
      </div>
    </div>`;
  }
  const rows = state.items
    .map(
      (r) => `
      <tr data-row="${r.id}" class="cursor-pointer" data-ret-buka="${r.id}" title="Buka rincian">
        <td class="td tabular-nums" title="${esc(r.created_at)}">${esc(jam(r.created_at))}</td>
        <td class="td">
          <div class="cell-strong">${r.invoice_no ? `Nota ${esc(r.invoice_no)}` : 'Tanpa nota'}</div>
          <div class="cell-sub">${r.n_items} baris · ${r.shift_id ? `Shift #${r.shift_id}` : 'di luar shift'} · ${esc(r.cashier)}</div>
        </td>
        <td class="td td-num">${rp(r.total)}</td>
        <td class="td">${r.note ? esc(r.note) : '<span class="text-gray-400">—</span>'}</td>
      </tr>`,
    )
    .join('');
  return `
  <div class="card-flush">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="th">Jam</th>
            <th class="th">Retur</th>
            <th class="th text-right">Uang kembali</th>
            <th class="th">Catatan</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagerHtml(state.offset, state.limit, state.total)}
  </div>`;
}

function paint(): void {
  const body = host?.querySelector('#ret-body');
  if (body) body.innerHTML = renderTable();
  const j = host?.querySelector('#ret-jumlah');
  if (j) j.textContent = rp(state.jumlah);
  const s = host?.querySelector('#ret-sub');
  if (s) s.textContent = `${state.total} retur · stok fisik kembali masuk · tunai keluar laci`;
  bindRows();
}

/* ---------- RINCIAN + BATAL ---------- */

async function bukaRincian(id: number): Promise<void> {
  let data: { retur: Retur; items: ReturItem[] } | null = null;
  try {
    const r = await apiGet<{ data: { retur: Retur; items: ReturItem[] } }>(`/api/returns/${id}`);
    data = r.data;
  } catch (e) {
    toast(`Gagal: ${errMsg(e)}`, 'error');
    return;
  }
  const { retur, items } = data;
  openModal({
    title: `Retur #${retur.id}${retur.invoice_no ? ` — Nota ${retur.invoice_no}` : ''}`,
    okLabel: 'Tutup',
    body: `
      <div class="space-y-1 text-sm">
        ${items.map((it) => `
          <div class="flex items-baseline justify-between gap-2 border-b border-gray-100 py-1.5 last:border-0 dark:border-gray-800">
            <span class="min-w-0"><b>${it.qty} ×</b> ${esc(it.name)} <span class="cell-sub">(${rp(it.price)})</span></span>
            <span class="shrink-0 font-semibold tabular-nums">${rp(it.amount)}</span>
          </div>`).join('')}
        <div class="flex items-baseline justify-between gap-2 pt-1">
          <span class="font-semibold">Uang kembali</span>
          <span class="font-semibold tabular-nums">${rp(retur.total)}</span>
        </div>
        ${retur.note ? `<p class="text-xs text-gray-500 dark:text-gray-400">Catatan: ${esc(retur.note)}</p>` : ''}
      </div>`,
    onMount: ({ el, ok, close }) => {
      ok.addEventListener('click', () => close());
      const kaki = el.querySelector('.modal-footer [data-x]');
      // Batalkan retur = stok keluar lagi + uang ditarik — server menjaga
      // `retur.batal`, jadi tombolnya tidak dirender tanpa izin itu.
      if (kaki && punyaIzin('retur.batal')) {
        const batal = document.createElement('button');
        batal.type = 'button';
        batal.className = 'btn btn-ghost !text-red-600 dark:!text-red-400';
        batal.innerHTML = `${icon('trash')}<span>Batalkan retur</span>`;
        batal.addEventListener('click', async () => {
          if (!punyaIzin('retur.batal')) {
            toast('Butuh izin Batalkan retur', 'warning');
            return;
          }
          const yes = await confirmDialog({
            title: `Batalkan retur #${retur.id}?`,
            message: 'Stok keluar lagi sebesar yang dikembalikan. Ditolak bila stok tidak cukup.',
            okLabel: 'Ya, batalkan',
            cancelLabel: 'Jangan',
            danger: true,
          });
          if (!yes) return;
          try {
            await apiDelete(`/api/returns/${retur.id}`);
            toast(`Retur #${retur.id} dibatalkan`, 'success');
            close();
            await load();
          } catch (e) {
            toast(`Gagal: ${errMsg(e)}`, 'error');
          }
        });
        kaki.before(batal);
      }
    },
  });
}

/* ---------- RETUR MANUAL (tanpa nota) ---------- */

type BarisManual = { product_id: number; name: string; qty: number; price: number };

function dialogManual(): void {
  if (!punyaIzin('retur.buat')) {
    toast('Butuh izin Buat retur', 'warning');
    return;
  }
  const baris: BarisManual[] = [];
  const gambarBaris = (box: HTMLElement) => {
    const total = baris.reduce((s, b) => s + Math.round(b.qty * b.price), 0);
    box.innerHTML = baris.length
      ? baris.map((b, i) => `
        <div class="flex items-center justify-between gap-2 border-b border-gray-100 py-1.5 last:border-0 dark:border-gray-800">
          <span class="min-w-0 text-sm"><b>${b.qty} ×</b> ${esc(b.name)} <span class="cell-sub">(${rp(b.price)})</span></span>
          <span class="flex shrink-0 items-center gap-2">
            <span class="text-sm font-semibold tabular-nums">${rp(Math.round(b.qty * b.price))}</span>
            <button type="button" data-man-del="${i}" class="row-btn row-btn-danger" aria-label="Hapus baris">${icon('trash')}</button>
          </span>
        </div>`).join('') +
        `<div class="flex items-baseline justify-between gap-2 pt-1 text-sm">
          <span class="font-semibold">Uang kembali</span>
          <span class="font-semibold tabular-nums" id="man-total">${rp(total)}</span>
        </div>`
      : `<div class="empty">Belum ada baris — cari produk di bawah.</div>`;
    box.querySelectorAll<HTMLElement>('[data-man-del]').forEach((btn) =>
      btn.addEventListener('click', () => {
        baris.splice(Number(btn.dataset.manDel), 1);
        gambarBaris(box);
      }),
    );
  };
  openModal({
    title: 'Retur manual (tanpa nota)',
    okLabel: 'Simpan retur',
    wide: true,
    body: `
      <div class="relative">
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
        <input id="man-q" class="input pl-9" type="search" placeholder="Cari produk (nama / SKU / barcode)…" autocomplete="off" />
      </div>
      <div id="man-hasil" class="mt-2 max-h-44 space-y-1 overflow-y-auto"></div>
      <div class="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700">
        <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Baris retur</p>
        <div id="man-baris"></div>
      </div>
      <div class="field mt-3">
        <label class="label" for="man-note">Catatan</label>
        <input id="man-note" class="input" maxlength="200" placeholder="cth: dus rusak saat dibuka" />
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">${
        state.shiftId
          ? `Masuk hitungan Shift #${state.shiftId} (uang keluar laci, stok kembali masuk).`
          : 'Di luar shift — tercatat + masuk laporan.'
      }</p>`,
    onMount: ({ el, ok, close }) => {
      const box = el.querySelector('#man-baris') as HTMLElement;
      const hasil = el.querySelector('#man-hasil') as HTMLElement;
      const q = el.querySelector('#man-q') as HTMLInputElement;
      gambarBaris(box);
      q.focus();
      q.addEventListener('input', () => {
        clearTimeout(cariTimer);
        cariTimer = setTimeout(async () => {
          const v = q.value.trim();
          if (v.length < 2) { hasil.innerHTML = ''; return; }
          try {
            const r = await apiGet<{ data: ProdukCari[] }>(`/api/products?q=${encodeURIComponent(v)}&status=aktif`);
            hasil.innerHTML = r.data.slice(0, 8).map((p) => `
              <button type="button" data-man-add="${p.id}" class="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 px-2 py-1.5 text-left text-sm hover:border-primary dark:border-gray-700">
                <span class="min-w-0"><b>${esc(p.name)}</b> <span class="cell-sub">${esc(p.sku)} · stok ${p.stock}</span></span>
                <span class="shrink-0 font-semibold tabular-nums">${rp(p.price)}</span>
              </button>`).join('') || `<div class="empty">Tidak ketemu.</div>`;
            hasil.querySelectorAll<HTMLElement>('[data-man-add]').forEach((btn) =>
              btn.addEventListener('click', () => {
                const pd = r.data.find((x) => x.id === Number(btn.dataset.manAdd));
                if (!pd) return;
                const ada = baris.find((b) => b.product_id === pd.id && b.price === pd.price);
                if (ada) ada.qty += 1;
                else baris.push({ product_id: pd.id, name: pd.name, qty: 1, price: pd.price });
                gambarBaris(box);
                q.value = '';
                hasil.innerHTML = '';
                q.focus();
              }),
            );
          } catch (e) {
            hasil.innerHTML = `<div class="empty">Gagal cari: ${esc(errMsg(e))}</div>`;
          }
        }, 250);
      });
      ok.addEventListener('click', async () => {
        if (!baris.length) { toast('Belum ada baris retur', 'warning'); q.focus(); return; }
        try {
          const r = await apiPost<{ data: { retur: Retur } }>('/api/returns', {
            items: baris.map((b) => ({ product_id: b.product_id, qty: b.qty, price: b.price })),
            note: (el.querySelector('#man-note') as HTMLInputElement).value.trim(),
            cashier: getCashier(),
            ...(state.shiftId !== null ? { shift_id: state.shiftId } : {}),
          });
          close();
          toast(`Retur #${r.data.retur.id} tersimpan · kembali ${rp(r.data.retur.total)}`, 'success');
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
  bindPager(host!, (o) => {
    state.offset = o;
    void load();
  });
  bindPagerLimit(host!, (v) => {
    state.limit = v;
    state.offset = 0;
    void load();
  });
  host!.querySelectorAll<HTMLElement>('[data-ret-buka]').forEach((tr) =>
    tr.addEventListener('click', () => void bukaRincian(Number(tr.dataset.retBuka))),
  );
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const r = await apiGet<{ data: Retur[]; total: number; jumlah: number }>(
      `/api/returns?date=${encodeURIComponent(state.date)}&limit=${state.limit}&offset=${state.offset}`,
    );
    state.items = r.data;
    state.total = r.total;
    state.jumlah = r.jumlah;
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

/** Ganti tanggal + RESET offset pager (satu-satunya jalan ganti hari —
 *  dipakai 6 titik di bawah supaya tak ada yang lupa me-reset). */
function setDate(v: string): void {
  state.date = v;
  state.offset = 0;
  refresh();
}

export async function mountReturnsPage(el: HTMLElement): Promise<void> {
  host = el;
  state.date = hariIni();
  state.offset = 0;
  el.innerHTML = renderPage();
  paint();
  const bukaBaru = () => dialogManual();
  el.querySelector('#ret-new')?.addEventListener('click', bukaBaru);
  // Alt+N = pintasan tombol yang sama (ui/aksi-baru.ts) — retur DARI nota tetap
  // lewat tombol di halaman Riwayat; ini retur manual tanpa nota. Hanya
  // didaftarkan bila izinnya ada, supaya pintasan tidak menabrak 403.
  if (punyaIzin('retur.buat')) pasangAksiBaru(bukaBaru);
  el.querySelector('#ret-prev')?.addEventListener('click', () => setDate(geser(state.date, -1)));
  el.querySelector('#ret-next')?.addEventListener('click', () => setDate(geser(state.date, 1)));
  el.querySelector<HTMLInputElement>('#ret-date')?.addEventListener('change', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    if (v) setDate(v);
  });
  await loadShift();
  await load();
}

/** Gambar ulang toolbar tanggal + isi tanpa reset state lain. */
function refresh(): void {
  if (!host) return;
  host.innerHTML = renderPage();
  paint();
  host.querySelector('#ret-new')?.addEventListener('click', () => dialogManual());
  host.querySelector('#ret-prev')?.addEventListener('click', () => setDate(geser(state.date, -1)));
  host.querySelector('#ret-next')?.addEventListener('click', () => setDate(geser(state.date, 1)));
  host.querySelector<HTMLInputElement>('#ret-date')?.addEventListener('change', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    if (v) setDate(v);
  });
  void load();
}
