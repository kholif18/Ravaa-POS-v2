// Halaman Pengguna (#/users, 2026-10-11, khusus pemilik): akun kasir &
// pemilik — tambah, ubah peran/nama/status, reset sandi, hapus. Guard berat
// (diri sendiri, pemilik aktif terakhir) ditegakkan SERVER (400) — halaman
// ini hanya menampilkan pesannya. Daftar TIDAK PERNAH memuat hash sandi.
//
// Server: GET /api/users, POST /api/users (tanpa id = baru, id = update
// parsial), POST /api/users/:id/password (reset), DELETE /api/users/:id.

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import type { Peran } from '../ui/auth';

type UserRow = {
  id: number;
  username: string;
  name: string;
  role: Peran;
  is_active: number;
  must_change: number;
  created_at: string;
};

const state = { items: [] as UserRow[], loading: true, error: '' };
let host: HTMLElement | null = null;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

function badgePeran(role: string): string {
  return role === 'pemilik'
    ? `<span class="badge-dyn">Owner</span>`
    : `<span class="chip">Kasir</span>`;
}

function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Pengguna</h2>
          <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Akun kasir & pemilik. Kasir hanya membuka POS, Riwayat, Retur, Pelanggan, Hutang, Stok, dan shift sendiri.
          </p>
        </div>
        <button type="button" id="usr-new" class="btn btn-primary">${icon('plus')}<span>Tambah Pengguna</span></button>
      </div>
    </div>
    <div id="usr-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat pengguna: ${esc(state.error)}</span></div>
    </div>`;
  }
  const rows = state.items
    .map(
      (u) => `
      <tr data-row="${u.id}">
        <td class="td">
          <div class="cell-strong">${esc(u.name)}${u.must_change ? ' <span class="text-xs font-medium text-amber-600 dark:text-amber-400">(wajib ganti sandi)</span>' : ''}</div>
          <div class="cell-sub"><span class="font-mono">${esc(u.username)}</span></div>
        </td>
        <td class="td">${badgePeran(u.role)}</td>
        <td class="td">${u.is_active ? '<span class="text-emerald-600 dark:text-emerald-400">Aktif</span>' : '<span class="text-gray-400">Nonaktif</span>'}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            <button type="button" data-usr-edit="${u.id}" class="row-btn" title="Ubah pengguna" aria-label="Ubah ${esc(u.username)}">${icon('pencil')}</button>
            <button type="button" data-usr-reset="${u.id}" class="row-btn" title="Reset sandi (target wajib ganti saat masuk)" aria-label="Reset sandi ${esc(u.username)}">${icon('sync')}</button>
            <button type="button" data-usr-del="${u.id}" class="row-btn row-btn-danger" title="Hapus pengguna" aria-label="Hapus ${esc(u.username)}">${icon('trash')}</button>
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
            <th class="th">Pengguna</th>
            <th class="th">Peran</th>
            <th class="th">Status</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    Diri sendiri dan owner aktif terakhir dilindungi server — tidak bisa
    diubah perannya, dinonaktifkan, atau dihapus.
  </p>`;
}

function paint(): void {
  const body = host?.querySelector('#usr-body');
  if (body) body.innerHTML = renderTable();
  bindRows();
}

function formSimpan(id: number | null, awal?: UserRow): void {
  const isNew = id === null;
  openModal({
    title: isNew ? 'Tambah Pengguna' : `Ubah Pengguna: ${awal?.username ?? ''}`,
    okLabel: isNew ? 'Tambah' : 'Simpan',
    body: `
      ${isNew ? `
      <div class="field">
        <label class="label" for="u-username">Username *</label>
        <input id="u-username" class="input font-mono" autocomplete="off" placeholder="cth: kasir1" />
      </div>` : ''}
      <div class="field">
        <label class="label" for="u-name">Nama tampil (nama kasir) *</label>
        <input id="u-name" class="input" value="${esc(awal?.name ?? '')}" placeholder="cth: Budi" />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="u-role">Peran *</label>
          <select id="u-role" class="input">
            <option value="kasir"${(awal?.role ?? 'kasir') === 'kasir' ? ' selected' : ''}>Kasir</option>
            <option value="pemilik"${awal?.role === 'pemilik' ? ' selected' : ''}>Owner</option>
          </select>
        </div>
        ${isNew ? '' : `
        <div class="field">
          <label class="label" for="u-active">Status</label>
          <select id="u-active" class="input">
            <option value="1"${awal?.is_active ? ' selected' : ''}>Aktif</option>
            <option value="0"${awal?.is_active ? '' : ' selected'}>Nonaktif</option>
          </select>
        </div>`}
      </div>
      <div class="field">
        <label class="label" for="u-pass">Sandi${isNew ? ' * (min. 4 karakter)' : ' (kosongkan bila tidak diganti)'}</label>
        <input id="u-pass" class="input" type="password" autocomplete="new-password" />
      </div>`,
    onMount: ({ el, ok, close }) => {
      const first = el.querySelector<HTMLInputElement>(isNew ? '#u-username' : '#u-name');
      first?.focus();
      ok.addEventListener('click', async () => {
        try {
          const payload: Record<string, unknown> = {
            ...(id === null ? {} : { id }),
            ...(isNew ? { username: (el.querySelector('#u-username') as HTMLInputElement).value.trim() } : {}),
            name: (el.querySelector('#u-name') as HTMLInputElement).value.trim(),
            role: (el.querySelector('#u-role') as HTMLSelectElement).value,
            ...(!isNew ? { is_active: (el.querySelector('#u-active') as HTMLSelectElement).value === '1' ? 1 : 0 } : {}),
          };
          const pw = (el.querySelector('#u-pass') as HTMLInputElement).value;
          if (isNew || pw) payload.password = pw;
          await apiPost('/api/users', payload);
          close();
          toast(isNew ? 'Pengguna ditambahkan (wajib ganti sandi saat masuk pertama)' : 'Pengguna disimpan', 'success');
          await load();
        } catch (e) {
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

function bindRows(): void {
  host!.querySelectorAll<HTMLElement>('[data-usr-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const u = state.items.find((x) => x.id === Number(b.dataset.usrEdit));
      if (u) formSimpan(u.id, u);
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-usr-reset]').forEach((b) =>
    b.addEventListener('click', () => {
      const u = state.items.find((x) => x.id === Number(b.dataset.usrReset));
      if (!u) return;
      openModal({
        title: `Reset sandi: ${u.username}`,
        okLabel: 'Reset',
        body: `
          <div class="field">
            <label class="label" for="u-newpass">Sandi baru (min. 4 karakter)</label>
            <input id="u-newpass" class="input" type="password" autocomplete="new-password" />
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            Semua sesi perangkat akun ini diputus — yang bersangkutan masuk ulang lalu wajib menggantinya lagi.
          </p>`,
        onMount: ({ el, ok, close }) => {
          const inp = el.querySelector<HTMLInputElement>('#u-newpass')!;
          inp.focus();
          ok.addEventListener('click', async () => {
            try {
              await apiPost(`/api/users/${u.id}/password`, { password: inp.value });
              close();
              toast(`Sandi ${u.username} di-reset`, 'success');
              await load();
            } catch (e) {
              toast(`Gagal: ${errMsg(e)}`, 'error');
            }
          });
        },
      });
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-usr-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const u = state.items.find((x) => x.id === Number(b.dataset.usrDel));
      if (!u) return;
      const yes = await confirmDialog({
        title: `Hapus pengguna "${u.username}"?`,
        message: 'Sesi di semua device ikut diputus. Riwayat shift/laporan atas nama ini tetap tersimpan.',
        okLabel: 'Hapus',
        cancelLabel: 'Batal, jangan dihapus',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/users/${u.id}`);
        toast(`Pengguna "${u.username}" dihapus`, 'success');
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
    const r = await apiGet<{ data: UserRow[] }>('/api/users');
    state.items = r.data;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

export async function mountUsersPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderPage();
  paint();
  el.querySelector('#usr-new')?.addEventListener('click', () => formSimpan(null));
  await load();
}
