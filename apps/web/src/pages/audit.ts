// Halaman Jejak audit (#/audit, baru 2026-10-16) — khusus pemilik.
//
// Menampilkan `audit_log` (server: helper catatAudit di index.ts): siapa
// (username/role snapshot), kapan, aksi apa, di entitas apa, plus detail
// ringkas. Cakupan SENGAJA tidak semua mutasi: penjualan/topup/pembelian
// punya tabelnya sendiri (nota = jejaknya), jadi audit hanya mengisi celah
// yang tidak terlihat dari tabel aslinya (master, stok, pengaturan,
// pengeluaran, piutang, retur dibatalkan, users, backup restore, login).
//
// READ-ONLY: tidak ada tombol hapus — jejak yang bisa dihapus dari UI bukan
// jejak. Server: GET /api/audit?entity=&q=&date=&limit=&offset=.
//
// Server: urutan id DESC (terbaru di atas), `q` multi-kata, `date`
// divalidasi round-trip (tanggal mustahil = 400, bukan halaman kosong).

import { apiGet, HttpError } from '../api';
import { icon } from '../ui/icons';
import { openModal } from '../ui/modal';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { waktu } from '../ui/waktu';

type Baris = {
  id: number;
  at: string;
  user_id: number | null;
  username: string;
  role: string;
  action: string;
  entity: string;
  entity_id: string;
  detail: string;
};

const state = {
  items: [] as Baris[],
  total: 0,
  q: '',
  entity: '',
  date: '',
  limit: PAGE_SIZE,
  // Paginasi (pola halaman master lain): RESET ke 0 tiap filter berubah.
  offset: 0,
  loading: true,
  error: '',
};

let host: HTMLElement | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/** Label manusiawi per aksi — kunci DB tetap bahasa Inggris (kontrak audit). */
const AKSI_LABEL: Record<string, string> = {
  create: 'Tambah',
  update: 'Ubah',
  delete: 'Hapus',
  restock: 'Restock',
  opname: 'Opname',
  import: 'Impor',
  restore: 'Pulihkan',
  login: 'Masuk',
  'login-gagal': 'Masuk gagal',
};

/** Pewarnaan chip per aksi — palet yang sama dengan chip tabel lain
 *  (emerald=aman, primary=netral penting, amber=perhatian, red=destruktif). */
function aksiChip(action: string): string {
  const label = AKSI_LABEL[action] ?? action;
  const gaya: Record<string, string> = {
    create: '!border-emerald-500/40 !text-emerald-700 dark:!text-emerald-400',
    update: '!border-primary/40 !text-primary',
    delete: '!border-red-500/40 !text-red-700 dark:!text-red-400',
    restock: '!border-emerald-500/40 !text-emerald-700 dark:!text-emerald-400',
    opname: '!border-amber-500/40 !text-amber-700 dark:!text-amber-400',
    import: '!border-primary/40 !text-primary',
    restore: '!border-amber-500/40 !text-amber-700 dark:!text-amber-400',
    'login-gagal': '!border-red-500/40 !text-red-700 dark:!text-red-400',
  };
  return `<span class="chip ${gaya[action] ?? ''}">${esc(label)}</span>`;
}

const ENTITAS_LABEL: Record<string, string> = {
  product: 'Produk',
  category: 'Kategori',
  unit: 'Satuan',
  customer: 'Pelanggan',
  supplier: 'Supplier',
  user: 'Pengguna',
  setting: 'Pengaturan',
  stock: 'Stok',
  expense: 'Pengeluaran',
  debt: 'Hutang',
  return: 'Retur',
  backup: 'Backup',
  session: 'Sesi',
};

function entitasLabel(e: string): string {
  return ENTITAS_LABEL[e] ?? e;
}

function renderPage(): string {
  const opsiEntitas = ['', 'product', 'category', 'unit', 'customer', 'supplier', 'user', 'setting', 'stock', 'expense', 'debt', 'return', 'backup', 'session'];
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Jejak audit</h2>
          <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Siapa mengubah apa: master, stok, pengaturan, pengeluaran, piutang, pengguna, restore backup, dan login.
            Nota penjualan/topup/pembelian tidak diduplikasi di sini.
          </p>
        </div>
        <span class="chip" id="audit-count">${icon('shieldCheck')}<span>…</span></span>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <div class="relative w-full max-w-sm min-w-[220px] flex-1">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
          <input id="audit-q" class="input pl-9" type="search" placeholder="Cari aktor / aksi / detail…" autocomplete="off" />
        </div>
        <select id="audit-entity" class="input !w-auto" aria-label="Filter entitas">
          ${opsiEntitas.map((e) => `<option value="${e}">${e === '' ? 'Semua entitas' : entitasLabel(e)}</option>`).join('')}
        </select>
        <label class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          Tanggal
          <input id="audit-date" class="input input-sm !w-auto" type="date" aria-label="Filter tanggal" />
        </label>
      </div>
    </div>

    <div id="audit-body"></div>
  </div>`;
}

/** Detail tampil ringkas: JSON dirapikan kalau bisa, kalau tidak apa adanya. */
function detailRingkas(d: string): string {
  if (!d) return '<span class="text-gray-400">—</span>';
  try {
    const o = JSON.parse(d) as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''))}`)
      .join(' · ');
  } catch {
    return esc(d);
  }
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat jejak audit: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.items.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('shieldCheck')}
        <span>${state.q || state.entity || state.date ? 'Tidak ada catatan yang cocok dengan filter.' : 'Belum ada catatan audit. Jejak akan terisi begitu ada perubahan master, stok, atau pengaturan.'}</span>
      </div>
    </div>`;
  }

  const rows = state.items
    .map(
      (r) => `
      <tr data-audit-row="${r.id}" class="cursor-pointer">
        <td class="td whitespace-nowrap tabular-nums">${esc(waktu(r.at))}</td>
        <td class="td">
          <div class="cell-strong">${esc(r.username || '—')}</div>
          <div class="cell-sub">${esc(r.role || (r.user_id === null ? 'tanpa akun' : ''))}</div>
        </td>
        <td class="td">${aksiChip(r.action)}</td>
        <td class="td">
          <div>${esc(entitasLabel(r.entity))}</div>
          ${r.entity_id ? `<div class="cell-sub font-mono">${esc(r.entity_id)}</div>` : ''}
        </td>
        <td class="td text-gray-600 dark:text-gray-300">${detailRingkas(r.detail)}</td>
      </tr>`,
    )
    .join('');

  return `
  <div class="card-flush">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="th">Waktu</th>
            <th class="th">Aktor</th>
            <th class="th">Aksi</th>
            <th class="th">Entitas</th>
            <th class="th">Detail</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagerHtml(state.offset, state.limit, state.total)}
  </div>
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    Jejak ini hanya-baca (tanpa tombol hapus) dan disimpan di database yang sama —
    ikut terbawa backup. Klik baris untuk melihat detail lengkap.
  </p>`;
}

function paint(): void {
  const countEl = host?.querySelector('#audit-count span');
  if (countEl) countEl.textContent = `${state.total} catatan`;
  const body = host?.querySelector('#audit-body');
  if (body) body.innerHTML = renderTable();
  bindRows();
}

/* ---------- MODAL DETAIL ---------- */

function detailModal(r: Baris): void {
  let detailTampil = r.detail || '(tanpa detail)';
  try {
    detailTampil = JSON.stringify(JSON.parse(r.detail), null, 2);
  } catch {
    /* bukan JSON — tampilkan apa adanya */
  }
  openModal({
    title: `Jejak audit #${r.id}`,
    cancelLabel: 'Tutup',
    onMount: (api) => api.ok.remove(), // hanya-baca — cukup satu tombol "Tutup" (pola riwayatForm)
    body: `
      <div class="grid gap-2 text-sm sm:grid-cols-2">
        <div class="field !mb-0">
          <span class="label">Waktu</span>
          <div class="font-semibold text-gray-900 dark:text-white">${esc(waktu(r.at))}</div>
        </div>
        <div class="field !mb-0">
          <span class="label">Aktor</span>
          <div class="font-semibold text-gray-900 dark:text-white">${esc(r.username || '—')} <span class="font-normal text-gray-500">(${esc(r.role || 'tanpa akun')}${r.user_id === null ? '' : ` · id ${r.user_id}`})</span></div>
        </div>
        <div class="field !mb-0">
          <span class="label">Aksi</span>
          <div>${aksiChip(r.action)}</div>
        </div>
        <div class="field !mb-0">
          <span class="label">Entitas</span>
          <div class="font-semibold text-gray-900 dark:text-white">${esc(entitasLabel(r.entity))}${r.entity_id ? ` <span class="font-mono font-normal text-gray-500">${esc(r.entity_id)}</span>` : ''}</div>
        </div>
      </div>
      <div class="field">
        <span class="label">Detail</span>
        <pre class="overflow-x-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs leading-relaxed text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">${esc(detailTampil)}</pre>
      </div>`,
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
  host!.querySelectorAll<HTMLElement>('[data-audit-row]').forEach((tr) =>
    tr.addEventListener('click', () => {
      const id = Number(tr.dataset.auditRow);
      const r = state.items.find((x) => x.id === id);
      if (r) detailModal(r);
    }),
  );
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.entity) p.set('entity', state.entity);
    if (state.date) p.set('date', state.date);
    p.set('limit', String(state.limit));
    p.set('offset', String(state.offset));
    const r = await apiGet<{ data: Baris[]; total: number }>(`/api/audit?${p}`);
    state.items = r.data;
    state.total = r.total;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

/* ---------- ENTRY ---------- */

export async function mountAuditPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderPage();
  paint();
  // Debounce 250ms (pola halaman lain) — Enter mempercepat.
  el.querySelector<HTMLInputElement>('#audit-q')?.addEventListener('input', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = v.trim();
      state.offset = 0;
      void load();
    }, 250);
  });
  el.querySelector<HTMLInputElement>('#audit-q')?.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      clearTimeout(searchTimer);
      state.q = (ev.target as HTMLInputElement).value.trim();
      state.offset = 0;
      void load();
    }
  });
  el.querySelector<HTMLSelectElement>('#audit-entity')?.addEventListener('change', (ev) => {
    state.entity = (ev.target as HTMLSelectElement).value;
    state.offset = 0;
    void load();
  });
  el.querySelector<HTMLInputElement>('#audit-date')?.addEventListener('change', (ev) => {
    state.date = (ev.target as HTMLInputElement).value;
    state.offset = 0;
    void load();
  });
  await load();
}
