// Halaman Shift Kasir (#/shifts): riwayat shift + buka/tutup shift.
//
// Daftar dari `GET /api/shifts?status=` (endpoint baru) — tiap baris sudah
// membawa agregatnya (n_sales, omzet, tunai/qris/transfer, n_topup,
// topup_nominal/admin, tarik_nominal/admin) lewat subquery, jadi
// tabel tidak memicu N+1. Filter status memakai enum yang sama dengan server
// (`open|closed|semua`), bukan menyaring di klien.
//
// DUA AKSI:
//   Buka   -> POST /api/shifts/open {cashier, modal_awal}  (409 = kasir ini
//             masih punya shift open — UNIQUE INDEX, bukan cek SELECT).
//   Tutup  -> POST /api/shifts/:id/close {modal_akhir}.
//
// PERHATIAN soal "selisih": rumus expected-cash mengikuti KEPUTUSAN PEMILIK
// 2026-10-01 (ROADMAP §1.3), tidak dikarang sendiri — rinciannya tertulis di
// kepala file `shift-tutup.ts` bersama DUA fungsi rumusnya
// (kasSeharusnya/hitungSelisih) dan dialog tutup yang kini DIPAKAI BERSAMA
// dengan tombol merah POS. Halaman ini tinggal memanggil
// `dialogTutupShift(s, () => load())`; jangan menduplikasi dialognya.

import { apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { openModal } from '../ui/modal';
import { getCashier } from '../ui/user';
import { waktu } from '../ui/waktu';
import { rp } from '../escpos';
import { dialogTutupShift, type ShiftRow } from './shift-tutup';

/* ---------- tipe (kontrak GET /api/shifts — lihat shift-tutup.ts) ---------- */

type Filter = 'semua' | 'open' | 'closed';

/* ---------- state ---------- */

const state = {
  filter: 'semua' as Filter,
  rows: [] as ShiftRow[],
  total: 0,
  loading: true,
  error: '',
};

let host: HTMLElement | null = null;

/* ---------- util ---------- */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/** Kas seharusnya & selisih = di `shift-tutup.ts` (satu sumber kebenaran,
 *  dipakai bersama tombol merah POS — jangan diduplikasi). */

const FILTER_LABEL: Record<Filter, string> = { semua: 'Semua', open: 'Terbuka', closed: 'Tutup' };

/* ---------- render ---------- */

function toolbar(): string {
  return `
  <div class="card">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filter status shift">
        ${(Object.keys(FILTER_LABEL) as Filter[])
          .map(
            (f) => `<button type="button" data-f="${f}" class="btn btn-ghost !min-h-[34px] !px-3 !py-1.5${
              state.filter === f ? ' is-on' : ''
            }" aria-pressed="${state.filter === f}">${FILTER_LABEL[f]}</button>`,
          )
          .join('')}
        <span class="chip">${icon('clock')}<span>${state.total} shift</span></span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" id="sh-reload" class="chip" title="Muat ulang">${icon('sync')}<span>Segarkan</span></button>
        <button type="button" id="sh-open" class="btn btn-primary !min-h-[34px] !px-3 !py-1.5">
          ${icon('plus')}<span>Buka shift</span>
        </button>
      </div>
    </div>
  </div>`;
}

function tabel(): string {
  if (!state.rows.length) {
    const pesan =
      state.filter === 'open' ? 'Tidak ada shift yang sedang terbuka.'
      : state.filter === 'closed' ? 'Belum ada shift yang pernah ditutup.'
      : 'Belum ada shift sama sekali. Buka shift pertama lewat tombol di atas atau dari layar Kasir.';
    return `<div class="card"><div class="empty">${icon('shifts')}<span>${pesan}</span></div></div>`;
  }
  return `
  <div class="card card-flush">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="th">#</th>
            <th class="th">Kasir</th>
            <th class="th">Dibuka</th>
            <th class="th">Ditutup</th>
            <th class="th text-right">Modal awal</th>
            <th class="th text-right">Modal akhir</th>
            <th class="th text-right">Penjualan</th>
            <th class="th text-right">Topup/tarik</th>
            <th class="th">Status</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${state.rows
            .map((s) => {
              const nonTunai = s.omzet - s.tunai;
              return `<tr data-shift="${s.id}">
                <td class="td font-semibold">${s.id}</td>
                <td class="td">${esc(s.cashier)}</td>
                <td class="td td-num">${esc(waktu(s.opened_at))}</td>
                <td class="td td-num">${s.closed_at ? esc(waktu(s.closed_at)) : '—'}</td>
                <td class="td td-num">${rp(s.modal_awal)}</td>
                <td class="td td-num">${s.modal_akhir == null ? '—' : rp(s.modal_akhir)}</td>
                <td class="td td-num">
                  <div class="cell-strong">${rp(s.omzet)}</div>
                  <div class="cell-sub">${s.n_sales} nota · tunai ${rp(s.tunai)}${nonTunai ? ` · non-tunai ${rp(nonTunai)}` : ''}</div>
                </td>
                <td class="td td-num">${s.n_topup ? `${s.n_topup} tx` : '—'}</td>
                <td class="td">${s.status === 'open' ? '<span class="badge-ok">Terbuka</span>' : '<span class="badge-off">Tutup</span>'}</td>
                <td class="td text-right">
                  ${
                    s.status === 'open'
                      ? `<button type="button" class="btn btn-ghost !min-h-[30px] !px-2.5 !py-1 text-xs" data-tutup="${s.id}">${icon('check')}<span>Tutup</span></button>`
                      : '<span class="cell-sub">—</span>'
                  }
                </td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  </div>
  <p class="text-xs text-gray-500 dark:text-gray-400">
    Menampilkan ${state.rows.length} dari ${state.total} shift (maks 200 per muat).
    Penjualan & topup dihitung dari baris yang terikat shift ini — penjualan
    offline ikut terhitung setelah tersinkron. Topup/tarik di luar omzet,
    tapi topup (nominal + admin) ikut hitungan "kas seharusnya" di dialog
    Tutup shift — rinciannya di sana.
  </p>`;
}

function isi(): string {
  if (state.loading) {
    return `<div class="space-y-3">
      <div class="card"><div class="skel h-6 w-72"></div></div>
      <div class="card"><div class="skel h-40 w-full"></div></div>
    </div>`;
  }
  if (state.error) {
    return `<div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat shift: ${esc(state.error)}</span></div></div>`;
  }
  return tabel();
}

function paint(): void {
  const body = host?.querySelector('#sh-body');
  if (!body) return;
  body.innerHTML = toolbar() + `<div class="mt-3 space-y-3">${isi()}</div>`;
  bind();
}

function bind(): void {
  const root = host?.querySelector('#sh-body');
  if (!root) return;
  root.querySelectorAll<HTMLElement>('[data-f]').forEach((b) =>
    b.addEventListener('click', () => {
      state.filter = b.dataset.f as Filter;
      void load();
    }),
  );
  root.querySelector('#sh-reload')?.addEventListener('click', () => void load());
  root.querySelector('#sh-open')?.addEventListener('click', () => dialogBuka());
  root.querySelectorAll<HTMLElement>('[data-tutup]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.tutup);
      const s = state.rows.find((r) => r.id === id);
      // Dialog + rumus selisih = modul bersama `shift-tutup.ts` (juga dipakai
      // tombol merah POS); setelah sukses tabel dimuat ulang dari sini.
      if (s) dialogTutupShift(s, () => void load());
    }),
  );
}

/* ---------- aksi: buka shift ---------- */

function dialogBuka(): void {
  openModal({
    title: 'Buka shift',
    okLabel: 'Buka shift',
    body: `
      <div class="field">
        <label class="label" for="sh-kasir">Nama kasir *</label>
        <input id="sh-kasir" class="input" value="${esc(getCashier())}" autocomplete="off" />
        <span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">
          Tiap device wajib nama kasir berbeda + shift sendiri (1 shift terbuka per kasir).
        </span>
      </div>
      <div class="field">
        <label class="label" for="sh-modal">Modal awal (uang di laci) *</label>
        <input id="sh-modal" class="input" type="number" inputmode="numeric" min="0" step="1" value="0" />
      </div>`,
    onMount: ({ el, ok, close }) => {
      const kasir = el.querySelector('#sh-kasir') as HTMLInputElement;
      const modal = el.querySelector('#sh-modal') as HTMLInputElement;
      kasir.focus();
      kasir.select();
      ok.addEventListener('click', async () => {
        const nama = kasir.value.trim();
        const awal = Number(modal.value);
        if (!nama) { toast('Nama kasir wajib diisi', 'warning'); return; }
        if (!Number.isFinite(awal) || awal < 0) { toast('Modal awal harus angka >= 0', 'warning'); return; }
        try {
          await apiPost('/api/shifts/open', { cashier: nama, modal_awal: awal });
          close();
          toast(`Shift kasir "${nama}" terbuka`, 'success');
          await load();
        } catch (e) {
          // 409 = UNIQUE INDEX idx_shifts_open_cashier — pesan server yang jelas.
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

/* ---------- muat ---------- */

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const j = await apiGet<{ data: ShiftRow[]; total: number }>(
      `/api/shifts?status=${state.filter}&limit=200`,
    );
    state.rows = j.data;
    state.total = j.total;
  } catch (e) {
    state.error = errMsg(e);
    state.rows = [];
    state.total = 0;
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

/* ---------- entry ---------- */

export async function mountShiftsPage(el: HTMLElement): Promise<void> {
  host = el;
  // Lebar penuh ke seluruh body (tanpa max-w/mx-auto) — konsisten dengan
  // halaman Stok & Produk; tabel 10 kolom jadi tidak sempit di desktop.
  el.innerHTML = `<div class="space-y-3"><div id="sh-body"></div></div>`;
  paint();
  await load();
}
