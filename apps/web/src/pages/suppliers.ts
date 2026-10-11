// Halaman Supplier (#/suppliers, baru 2026-10-11): master pemasok barang
// kulakan — nama, HP, alamat, catatan. Lahir dari pencabutan
// `customers.supplier_no` (perintah pemilik: no. supplier tidak pantas di
// modal customer) — nomor `SUP-000001` kini menjadi `code` master ini.
//
// Server: GET /api/suppliers?q= (multi-kata), POST /api/suppliers (tanpa id =
// baru, id = update), DELETE /api/suppliers/:id (langsung — belum ada tabel
// yang mereferensinya; Tahap 3 Pembelian wajib menambah guard 400 seperti
// hapus pelanggan berhutang). Dipakai Tahap 3 sebagai pilihan pemasok.

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';

type Supplier = {
  id: number;
  /** No. supplier otomatis dari server (`SUP-000001`); '' = baris lama
   *  yang nomornya belum pernah diisi (diisi server saat disimpan ulang). */
  code: string;
  name: string;
  phone: string;
  address: string;
  note: string;
  created_at: string;
  updated_at: string;
};

type EditSupplier = { id: number | null; name: string; phone: string; address: string; note: string; code: string };

const state = {
  items: [] as Supplier[],
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
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Supplier</h2>
          <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Pemasok barang kulakan (nama, HP, alamat, catatan). Dipakai untuk Pembelian (Tahap 3).
          </p>
        </div>
        <button type="button" id="sup-new" class="btn btn-primary">${icon('plus')}<span>Tambah Supplier</span></button>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <div class="relative w-full max-w-sm">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span>
          <input id="sup-q" class="input pl-9" type="search" placeholder="Cari nama / HP / catatan…" autocomplete="off" />
        </div>
      </div>
    </div>

    <div id="sup-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat supplier: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.items.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('truck')}
        <span>${state.q ? `Tidak ada supplier yang cocok dengan “${esc(state.q)}”.` : 'Belum ada supplier. Tambahkan dulu — dibutuhkan untuk Pembelian.'}</span>
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
            <button type="button" data-sup-edit="${u.id}" class="row-btn" title="Ubah supplier" aria-label="Ubah ${esc(u.name)}">${icon('pencil')}</button>
            <button type="button" data-sup-del="${u.id}" class="row-btn row-btn-danger" title="Hapus supplier" aria-label="Hapus ${esc(u.name)}">${icon('trash')}</button>
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
            <th class="th">Supplier</th>
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
    Menampilkan ${state.items.length} dari ${state.total} supplier.
    No. supplier di-assign otomatis server (urut, tidak berubah setelah terbit).
  </p>`;
}

function paint(): void {
  const body = host?.querySelector('#sup-body');
  if (body) body.innerHTML = renderTable();
  bindRows();
}

/* ---------- FORM ---------- */

function supplierForm(c: EditSupplier): void {
  const isNew = c.id === null;
  // Nomor urut DI-ASSIGN SERVER (SUP-) — form hanya menampilkannya.
  // Baris baru belum punya nomor sampai disimpan (server mengisi saat INSERT).
  const nomor = (v: string) => (v ? `<span class="font-mono text-sm">${esc(v)}</span>` : '<span class="text-gray-400">otomatis saat disimpan</span>');
  openModal({
    title: isNew ? 'Tambah Supplier' : `Ubah Supplier: ${c.name}`,
    okLabel: isNew ? 'Tambah' : 'Simpan',
    body: `
      <div class="field">
        <label class="label" for="s-code">No. supplier</label>
        <div class="rounded border border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-700 dark:bg-gray-800">${nomor(c.code)}</div>
      </div>
      <div class="field">
        <label class="label" for="s-name">Nama supplier *</label>
        <input id="s-name" class="input" value="${esc(c.name)}" placeholder="cth: Distributor Jaya Abadi" />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="s-phone">No. HP / Telepon</label>
          <input id="s-phone" class="input" value="${esc(c.phone)}" placeholder="cth: 081234567890" inputmode="tel" />
        </div>
        <div class="field">
          <label class="label" for="s-address">Alamat</label>
          <input id="s-address" class="input" value="${esc(c.address)}" placeholder="cth: Jl. Merpati No. 7" />
        </div>
      </div>
      <div class="field">
        <label class="label" for="s-note">Catatan</label>
        <input id="s-note" class="input" value="${esc(c.note)}" placeholder="cth: kirim tiap Senin pagi" />
      </div>`,
    onMount: ({ el, ok, close }) => {
      const name = el.querySelector('#s-name') as HTMLInputElement;
      name.focus();
      ok.addEventListener('click', async () => {
        const n = name.value.trim();
        if (!n) { toast('Nama supplier wajib diisi', 'warning'); name.focus(); return; }
        try {
          await apiPost('/api/suppliers', {
            ...(c.id === null ? {} : { id: c.id }),
            name: n,
            phone: (el.querySelector('#s-phone') as HTMLInputElement).value.trim(),
            address: (el.querySelector('#s-address') as HTMLInputElement).value.trim(),
            note: (el.querySelector('#s-note') as HTMLInputElement).value.trim(),
          });
          close(); // modal tidak menutup sendiri (lihat ui/modal.ts)
          toast(isNew ? `Supplier "${n}" ditambahkan` : `Supplier "${n}" disimpan`, 'success');
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
  host!.querySelectorAll<HTMLElement>('[data-sup-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.supEdit);
      const c = state.items.find((x) => x.id === id);
      if (c) supplierForm({ id: c.id, name: c.name, phone: c.phone, address: c.address, note: c.note, code: c.code });
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-sup-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.supDel);
      const c = state.items.find((x) => x.id === id);
      if (!c) return;
      const yes = await confirmDialog({
        title: `Hapus supplier "${c.name}"?`,
        message: 'Supplier akan dihapus permanen.',
        okLabel: 'Hapus',
        cancelLabel: 'Batal, jangan dihapus',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/suppliers/${id}`);
        toast(`Supplier "${c.name}" dihapus`, 'success');
        await load();
      } catch (e) {
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
    const r = await apiGet<{ data: Supplier[]; total: number }>(
      `/api/suppliers${state.q ? `?q=${encodeURIComponent(state.q)}` : ''}`,
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

export async function mountSuppliersPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderPage();
  paint();
  el.querySelector('#sup-new')?.addEventListener('click', () =>
    supplierForm({ id: null, name: '', phone: '', address: '', note: '', code: '' }),
  );
  // Debounce 250ms (pola halaman lain) — Enter mempercepat.
  el.querySelector<HTMLInputElement>('#sup-q')?.addEventListener('input', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = v.trim();
      void load();
    }, 250);
  });
  el.querySelector<HTMLInputElement>('#sup-q')?.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      clearTimeout(searchTimer);
      state.q = (ev.target as HTMLInputElement).value.trim();
      void load();
    }
  });
  await load();
}
