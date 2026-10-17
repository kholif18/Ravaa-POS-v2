// Halaman Pengeluaran (#/expenses, Tahap 1 2026-10-11): kas TUNAI keluar
// untuk operasional toko (plastik, bensin, listrik, ...).
//
// Server: GET /api/expenses?date=&limit=&offset= (+`jumlah` total hari itu),
// POST /api/expenses (kategori wajib, jumlah bulat > 0, note ≤ 200, shift_id
// opsional), DELETE /api/expenses/:id (koreksi salah ketik).
// Pengeluaran yang terikat shift mengurangi laci (agregat `expense_total` di
// GET /api/shifts → rumus kasSeharusnya di shift-tutup.ts); yang NULL (di
// luar shift) tetap tercatat + masuk laporan harian. Hari = UTC persis
// server & Riwayat/Laporan (`date(created_at)=date(?)`, lihat ui/waktu.ts).

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { getCashier } from '../ui/user';
import { hariIni, geser, tglPanjang } from '../ui/waktu';
import { rp } from '../escpos';
import { pasangAksiBaru } from '../ui/aksi-baru';

type Expense = {
  id: number;
  created_at: string;
  kategori: string;
  jumlah: number;
  note: string;
  cashier: string;
  shift_id: number | null;
};

const state = {
  date: hariIni(),
  items: [] as Expense[],
  total: 0,
  jumlah: 0,
  // Paginasi (2026-10-11): RESET ke 0 setiap tanggal berubah.
  offset: 0,
  limit: PAGE_SIZE,
  loading: true,
  error: '',
  /** Shift terbuka kasir ini (null = di luar shift). Diambil sekali saat
   *  mount; catatan baru ikut shift ini supaya mengurangi laci yang benar. */
  shiftId: null as number | null,
};

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

const jam = (iso: string) => (iso ?? '').slice(11, 16) || '—';

function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="exp-prev" class="row-btn" title="Hari sebelumnya" aria-label="Hari sebelumnya">${icon('chevL')}</button>
          <input id="exp-date" type="date" class="input input-sm !w-44" value="${esc(state.date)}" aria-label="Pilih tanggal pengeluaran" />
          <button type="button" id="exp-next" class="row-btn" title="Hari berikutnya" aria-label="Hari berikutnya">${icon('chevR')}</button>
          <span class="chip">${icon('calendar')}<span>${esc(tglPanjang(state.date))}</span></span>
        </div>
        <button type="button" id="exp-new" class="btn btn-primary" title="Catat pengeluaran baru (Alt+N)">${icon('plus')}<span>Catat Pengeluaran</span><kbd class="kbd">Alt+N</kbd></button>
      </div>
    </div>
    <div class="card">
      <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Pengeluaran hari ini</p>
      <p class="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-white" id="exp-jumlah">${rp(state.jumlah)}</p>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400" id="exp-sub">${state.total} catatan · mengurangi laci bila terikat shift</p>
    </div>
    <div id="exp-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat pengeluaran: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.items.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('coins')}
        <span>Belum ada pengeluaran hari ini.</span>
      </div>
    </div>`;
  }
  const rows = state.items
    .map(
      (e) => `
      <tr data-row="${e.id}">
        <td class="td tabular-nums" title="${esc(e.created_at)}">${esc(jam(e.created_at))}</td>
        <td class="td">
          <div class="cell-strong">${esc(e.kategori)}</div>
          <div class="cell-sub">${e.shift_id ? `Shift #${e.shift_id}` : 'di luar shift'} · ${esc(e.cashier)}</div>
        </td>
        <td class="td td-num">${rp(e.jumlah)}</td>
        <td class="td">${e.note ? esc(e.note) : '<span class="text-gray-400">—</span>'}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            <button type="button" data-exp-del="${e.id}" class="row-btn row-btn-danger" title="Hapus catatan" aria-label="Hapus pengeluaran ${esc(e.kategori)}">${icon('trash')}</button>
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
            <th class="th">Jam</th>
            <th class="th">Kategori</th>
            <th class="th text-right">Jumlah</th>
            <th class="th">Catatan</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagerHtml(state.offset, state.limit, state.total)}
  </div>`;
}

function paint(): void {
  const body = host?.querySelector('#exp-body');
  if (body) body.innerHTML = renderTable();
  const j = host?.querySelector('#exp-jumlah');
  if (j) j.textContent = rp(state.jumlah);
  const s = host?.querySelector('#exp-sub');
  if (s) s.textContent = `${state.total} catatan · mengurangi laci bila terikat shift`;
  bindRows();
}

/* ---------- FORM ---------- */

function expenseForm(): void {
  openModal({
    title: 'Catat Pengeluaran',
    okLabel: 'Simpan',
    body: `
      <div class="field">
        <label class="label" for="e-kategori">Kategori *</label>
        <input id="e-kategori" class="input" placeholder="cth: Plastik, Bensin, Listrik" autocomplete="off" />
      </div>
      <div class="field">
        <label class="label" for="e-jumlah">Jumlah (Rp) *</label>
        <input id="e-jumlah" class="input" type="number" inputmode="numeric" min="1" step="500" placeholder="cth: 15000" />
      </div>
      <div class="field">
        <label class="label" for="e-note">Catatan</label>
        <input id="e-note" class="input" maxlength="200" placeholder="cth: beli plastik 2 pack" />
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">${
        state.shiftId
          ? `Masuk hitungan Shift #${state.shiftId} (mengurangi laci).`
          : 'Di luar shift — tercatat + masuk laporan, tidak mengurangi laci shift mana pun.'
      }</p>`,
    onMount: ({ el, ok, close }) => {
      const kat = el.querySelector('#e-kategori') as HTMLInputElement;
      kat.focus();
      ok.addEventListener('click', async () => {
        const kategori = kat.value.trim();
        const jumlah = Number((el.querySelector('#e-jumlah') as HTMLInputElement).value || 0);
        if (!kategori) { toast('Kategori wajib diisi', 'warning'); kat.focus(); return; }
        if (!Number.isInteger(jumlah) || jumlah <= 0) {
          toast('Jumlah harus rupiah bulat > 0', 'warning');
          (el.querySelector('#e-jumlah') as HTMLInputElement).focus();
          return;
        }
        try {
          await apiPost('/api/expenses', {
            kategori,
            jumlah,
            note: (el.querySelector('#e-note') as HTMLInputElement).value.trim(),
            cashier: getCashier(),
            ...(state.shiftId !== null ? { shift_id: state.shiftId } : {}),
          });
          close(); // modal tidak menutup sendiri (lihat ui/modal.ts)
          toast(`Pengeluaran ${rp(jumlah)} tersimpan`, 'success');
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
  host!.querySelectorAll<HTMLElement>('[data-exp-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.expDel);
      const e = state.items.find((x) => x.id === id);
      if (!e) return;
      const yes = await confirmDialog({
        title: `Hapus pengeluaran "${e.kategori}" ${rp(e.jumlah)}?`,
        message: 'Catatan salah ketik dibuang permanen (kas bertambah kembali).',
        okLabel: 'Hapus',
        cancelLabel: 'Batal, jangan dihapus',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/expenses/${id}`);
        toast('Pengeluaran dihapus', 'success');
        await load();
      } catch (e2) {
        toast(`Gagal hapus: ${errMsg(e2)}`, 'error');
      }
    }),
  );
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const r = await apiGet<{ data: Expense[]; total: number; jumlah: number }>(
      `/api/expenses?date=${encodeURIComponent(state.date)}&limit=${state.limit}&offset=${state.offset}`,
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
  // Shift terbuka kasir ini (bila ada) — catatan baru ikut shift ini.
  // Gagal = di luar shift (NULL), bukan error halaman.
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
  mountExpensesPageRefresh();
}

export async function mountExpensesPage(el: HTMLElement): Promise<void> {
  host = el;
  state.date = hariIni();
  state.offset = 0;
  el.innerHTML = renderPage();
  paint();
  const bukaBaru = () => expenseForm();
  el.querySelector('#exp-new')?.addEventListener('click', bukaBaru);
  // Alt+N = pintasan tombol yang sama (ui/aksi-baru.ts) — didaftarkan sekali di
  // mount; refresh() hanya merender ulang isi, aksinya tetap closure ini.
  pasangAksiBaru(bukaBaru);
  el.querySelector('#exp-prev')?.addEventListener('click', () => setDate(geser(state.date, -1)));
  el.querySelector('#exp-next')?.addEventListener('click', () => setDate(geser(state.date, 1)));
  el.querySelector<HTMLInputElement>('#exp-date')?.addEventListener('change', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    if (v) setDate(v);
  });
  await loadShift();
  await load();
}

/** Gambar ulang toolbar tanggal + isi tanpa reset state lain. */
function mountExpensesPageRefresh(): void {
  if (!host) return;
  host.innerHTML = renderPage();
  paint();
  host.querySelector('#exp-new')?.addEventListener('click', () => expenseForm());
  host.querySelector('#exp-prev')?.addEventListener('click', () => setDate(geser(state.date, -1)));
  host.querySelector('#exp-next')?.addEventListener('click', () => setDate(geser(state.date, 1)));
  host.querySelector<HTMLInputElement>('#exp-date')?.addEventListener('change', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    if (v) setDate(v);
  });
  void load();
}
