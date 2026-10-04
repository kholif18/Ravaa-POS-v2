// Halaman Satuan: master satuan untuk struk (pcs, btl, lembar, ...).
// Form produk memakai daftar ini sebagai DROPDOWN, jadi satuan tidak lagi
// diketik bebas -> tidak ada lagi ejaan "pcs" vs "PCs" yang berbeda untuk
// produk yang sama.
//
// Server: GET/POST /api/units (upsert by slug), DELETE /api/units/:slug
// (ditolak 400 bila masih dipakai produk — FK products.unit -> units.slug).

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { type Unit } from '../store';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';

type EditUnit = { isNew: boolean; slug: string; name: string };

const state = {
  units: [] as Unit[],
  loading: true,
  error: '',
};

let host: HTMLElement | null = null;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

// Lebar penuh ke seluruh body (tanpa max-w/mx-auto) — konsisten dengan
// halaman Stok & Produk.
function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Satuan</h2>
          <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Satuan untuk struk. Form produk memilih dari daftar ini.
          </p>
        </div>
        <button type="button" id="unit-new" class="btn btn-primary">${icon('plus')}<span>Tambah Satuan</span></button>
      </div>
    </div>

    <div id="unit-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat satuan: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.units.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('categories')}
        <span>Belum ada satuan. Tambahkan dulu, misal "Pcs" atau "Lembar".</span>
      </div>
    </div>`;
  }

  const rows = state.units
    .map(
      (u) => `
      <tr data-row="${u.slug}">
        <td class="td">
          <div class="cell-strong">${esc(u.name)}</div>
          <div class="cell-sub">${esc(u.slug)}</div>
        </td>
        <td class="td">${u.dipakai ?? 0} produk</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            <button type="button" data-unit-edit="${esc(u.slug)}" class="row-btn" title="Ubah satuan" aria-label="Ubah ${esc(u.name)}">${icon('pencil')}</button>
            <button type="button" data-unit-del="${esc(u.slug)}" class="row-btn row-btn-danger" title="Hapus satuan" aria-label="Hapus ${esc(u.name)}">${icon('trash')}</button>
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
            <th class="th">Satuan</th>
            <th class="th">Dipakai</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    ${state.units.length} satuan, urut dari A-Z. Dipakai dropdown satuan di form produk.
    Satuan yang masih dipakai produk tidak bisa dihapus.
  </p>`;
}

function paint(): void {
  const body = host?.querySelector('#unit-body');
  if (body) body.innerHTML = renderTable();
  bindRows();
}

/* ---------- FORM ---------- */

function unitForm(u: EditUnit): void {
  const slugLocked = !u.isNew;
  openModal({
    title: u.isNew ? 'Tambah Satuan' : `Ubah Satuan: ${u.name}`,
    okLabel: u.isNew ? 'Tambah' : 'Simpan',
    body: `
      <div class="field">
        <label class="label" for="u-name">Nama satuan *</label>
        <input id="u-name" class="input" value="${esc(u.name)}" placeholder="cth: Pcs, Lembar, Dus" />
      </div>
      <div class="field">
        <span class="label">Slug (otomatis dari nama)</span>
        <input id="u-slug" class="input bg-gray-50 text-gray-500 dark:bg-gray-900/50" value="${esc(u.slug)}" readonly aria-describedby="u-slug-hint" />
        <span class="text-xs text-gray-500 dark:text-gray-400" id="u-slug-hint">${
          slugLocked
            ? 'Slug tidak bisa diubah setelah satuan dibuat (produk sudah terikat ke slug ini).'
            : 'Otomatis: huruf kecil, angka, dan strip. Tidak bisa diubah nanti.'
        }</span>
      </div>`,
    onMount: ({ el, ok, close }) => {
      const name = el.querySelector('#u-name') as HTMLInputElement;
      const slug = el.querySelector('#u-slug') as HTMLInputElement;
      if (u.isNew) {
        name.addEventListener('input', () => { slug.value = slugify(name.value); });
      }
      name.focus();
      ok.addEventListener('click', async () => {
        const n = name.value.trim();
        const s = (slugLocked ? u.slug : slugify(n)).trim().toLowerCase();
        if (!n || !s) { toast('Nama satuan wajib diisi', 'warning'); return; }
        if (!/^[a-z0-9-]+$/.test(s)) { toast('Slug hanya boleh huruf kecil, angka, dan strip', 'warning'); return; }
        try {
          await apiPost('/api/units', { name: n, slug: s });
          close(); // modal tidak menutup sendiri (lihat ui/modal.ts)
          toast(u.isNew ? `Satuan "${n}" ditambahkan` : `Satuan "${n}" disimpan`, 'success');
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
  host!.querySelectorAll<HTMLElement>('[data-unit-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const u = state.units.find((x) => x.slug === b.dataset.unitEdit);
      if (u) unitForm({ isNew: false, slug: u.slug, name: u.name });
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-unit-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const slug = b.dataset.unitDel ?? '';
      const u = state.units.find((x) => x.slug === slug);
      if (!u) return;
      const n = u.dipakai ?? 0;
      const yes = await confirmDialog({
        title: `Hapus satuan "${u.name}"?`,
        message:
          n > 0
            ? `Satuan ini dipakai ${n} produk, jadi server akan menolak. Pindahkan produknya ke satuan lain dulu.`
            : 'Satuan tidak dipakai produk dan akan dihapus permanen.',
        okLabel: 'Hapus',
        cancelLabel: 'Batal, jangan dihapus',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/units/${encodeURIComponent(slug)}`);
        toast(`Satuan "${u.name}" dihapus`, 'success');
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
    const u = await apiGet<{ data: Unit[] }>('/api/units');
    state.units = u.data;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

/* ---------- ENTRY ---------- */

export async function mountSatuanPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderPage();
  paint();
  el.querySelector('#unit-new')?.addEventListener('click', () =>
    unitForm({ isNew: true, slug: '', name: '' }),
  );
  await load();
}
