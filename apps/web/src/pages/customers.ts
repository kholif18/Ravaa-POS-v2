// Halaman Pelanggan (#/customers, baru 2026-10-04): master kontak pembeli —
// nama, HP, catatan. Sumber angka/hutang BUKAN di sini: sisa piutang dihitung
// server di halaman Hutang (#/debts, ledger customer_debts).
//
// Server: GET /api/customers?q= (multi-kata), POST /api/customers (tanpa id =
// baru, id = update), DELETE /api/customers/:id (400 bila masih ada catatan
// hutang — pesannya menyuruh menghapus catatan di halaman Hutang dulu).

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';

type Customer = {
  id: number;
  /** No. customer otomatis dari server (`CUS-000001`); '' = baris lama
   *  yang nomornya belum pernah diisi (diisi server saat disimpan ulang). */
  code: string;
  /** No. supplier otomatis (`SUP-000001`) — master supplier belum ada,
   *  nomornya disimpan di kontak dulu. */
  supplier_no: string;
  name: string;
  phone: string;
  address: string;
  note: string;
  created_at: string;
  updated_at: string;
};

type EditCustomer = { id: number | null; name: string; phone: string; address: string; note: string; code: string; supplier_no: string };

const state = {
  items: [] as Customer[],
  total: 0,
  q: '',
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

// Lebar penuh ke seluruh body — konsisten dengan Satuan/Stok/Produk.
function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Pelanggan</h2>
          <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Kontak pembeli (nama, HP, catatan). Hutang mereka dicatat di halaman Hutang.
          </p>
        </div>
        <button type="button" id="cust-new" class="btn btn-primary">${icon('plus')}<span>Tambah Pelanggan</span></button>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <div class="relative w-full max-w-sm">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
          <input id="cust-q" class="input pl-9" type="search" placeholder="Cari nama / HP / catatan…" autocomplete="off" />
        </div>
      </div>
    </div>

    <div id="cust-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat pelanggan: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.items.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('users')}
        <span>${state.q ? `Tidak ada pelanggan yang cocok dengan “${esc(state.q)}”.` : 'Belum ada pelanggan. Tambahkan dulu — dibutuhkan untuk mencatat hutang.'}</span>
      </div>
    </div>`;
  }

  const rows = state.items
    .map(
      (u) => `
      <tr data-row="${u.id}">
        <td class="td">
          <div class="cell-strong">${esc(u.name)}</div>
          <div class="cell-sub">${u.code ? `<span class="font-mono">${esc(u.code)}</span> · ` : ''}${esc(u.phone || 'tanpa no. HP')}</div>
        </td>
        <td class="td">${u.address ? esc(u.address) : '<span class="text-gray-400">—</span>'}</td>
        <td class="td">${u.note ? esc(u.note) : '<span class="text-gray-400">—</span>'}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            <button type="button" data-cust-edit="${u.id}" class="row-btn" title="Ubah pelanggan" aria-label="Ubah ${esc(u.name)}">${icon('pencil')}</button>
            <button type="button" data-cust-del="${u.id}" class="row-btn row-btn-danger" title="Hapus pelanggan" aria-label="Hapus ${esc(u.name)}">${icon('trash')}</button>
          </div>
        </td>
      </tr>`,
    )
    .join('');

  return `
  <div class="card-flush">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="th">Pelanggan</th>
            <th class="th">Alamat</th>
            <th class="th">Catatan</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    Menampilkan ${state.items.length} dari ${state.total} pelanggan.
    No. customer/supplier di-assign otomatis server (urut, tidak berubah setelah terbit).
    Pelanggan yang masih punya catatan hutang tidak bisa dihapus.
  </p>`;
}

function paint(): void {
  const body = host?.querySelector('#cust-body');
  if (body) body.innerHTML = renderTable();
  bindRows();
}

/* ---------- FORM ---------- */

function customerForm(c: EditCustomer): void {
  const isNew = c.id === null;
  // Nomor urut DI-ASSIGN SERVER (CUS-/SUP-) — form hanya menampilkannya.
  // Baris baru belum punya nomor sampai disimpan (server mengisi saat INSERT).
  const nomor = (v: string) => (v ? `<span class="font-mono text-sm">${esc(v)}</span>` : '<span class="text-gray-400">otomatis saat disimpan</span>');
  openModal({
    title: isNew ? 'Tambah Pelanggan' : `Ubah Pelanggan: ${c.name}`,
    okLabel: isNew ? 'Tambah' : 'Simpan',
    body: `
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="c-code">No. customer</label>
          <div class="rounded border border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-700 dark:bg-gray-800">${nomor(c.code)}</div>
        </div>
        <div class="field">
          <label class="label" for="c-sup">No. supplier</label>
          <div class="rounded border border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-700 dark:bg-gray-800">${nomor(c.supplier_no)}</div>
        </div>
      </div>
      <div class="field">
        <label class="label" for="c-name">Nama pelanggan *</label>
        <input id="c-name" class="input" value="${esc(c.name)}" placeholder="cth: Budi Santoso" />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="c-phone">No. HP</label>
          <input id="c-phone" class="input" value="${esc(c.phone)}" placeholder="cth: 081234567890" inputmode="tel" />
        </div>
        <div class="field">
          <label class="label" for="c-address">Alamat</label>
          <input id="c-address" class="input" value="${esc(c.address)}" placeholder="cth: Jl. Merpati No. 7" />
        </div>
      </div>
      <div class="field">
        <label class="label" for="c-note">Catatan</label>
        <input id="c-note" class="input" value="${esc(c.note)}" placeholder="cth: langganan warung sebelah" />
      </div>`,
    onMount: ({ el, ok, close }) => {
      const name = el.querySelector('#c-name') as HTMLInputElement;
      name.focus();
      ok.addEventListener('click', async () => {
        const n = name.value.trim();
        if (!n) { toast('Nama pelanggan wajib diisi', 'warning'); name.focus(); return; }
        try {
          await apiPost('/api/customers', {
            ...(c.id === null ? {} : { id: c.id }),
            name: n,
            phone: (el.querySelector('#c-phone') as HTMLInputElement).value.trim(),
            address: (el.querySelector('#c-address') as HTMLInputElement).value.trim(),
            note: (el.querySelector('#c-note') as HTMLInputElement).value.trim(),
          });
          close(); // modal tidak menutup sendiri (lihat ui/modal.ts)
          toast(isNew ? `Pelanggan "${n}" ditambahkan` : `Pelanggan "${n}" disimpan`, 'success');
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
  host!.querySelectorAll<HTMLElement>('[data-cust-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.custEdit);
      const c = state.items.find((x) => x.id === id);
      if (c) customerForm({ id: c.id, name: c.name, phone: c.phone, address: c.address, note: c.note, code: c.code, supplier_no: c.supplier_no });
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-cust-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.custDel);
      const c = state.items.find((x) => x.id === id);
      if (!c) return;
      const yes = await confirmDialog({
        title: `Hapus pelanggan "${c.name}"?`,
        message: 'Pelanggan tanpa riwayat hutang akan dihapus permanen.',
        okLabel: 'Hapus',
        cancelLabel: 'Batal, jangan dihapus',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/customers/${id}`);
        toast(`Pelanggan "${c.name}" dihapus`, 'success');
        await load();
      } catch (e) {
        // 400 = masih punya catatan hutang — pesan server sudah menunjuk halaman Hutang.
        toast(`Gagal hapus: ${errMsg(e)}`, 'error');
      }
    }),
  );
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const r = await apiGet<{ data: Customer[]; total: number }>(
      `/api/customers${state.q ? `?q=${encodeURIComponent(state.q)}` : ''}`,
    );
    state.items = r.data;
    state.total = r.total;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

/* ---------- ENTRY ---------- */

export async function mountCustomersPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderPage();
  paint();
  el.querySelector('#cust-new')?.addEventListener('click', () =>
    customerForm({ id: null, name: '', phone: '', address: '', note: '', code: '', supplier_no: '' }),
  );
  // Debounce 250ms (pola halaman lain) — Enter mempercepat.
  el.querySelector<HTMLInputElement>('#cust-q')?.addEventListener('input', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = v.trim();
      void load();
    }, 250);
  });
  el.querySelector<HTMLInputElement>('#cust-q')?.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      clearTimeout(searchTimer);
      state.q = (ev.target as HTMLInputElement).value.trim();
      void load();
    }
  });
  await load();
}
