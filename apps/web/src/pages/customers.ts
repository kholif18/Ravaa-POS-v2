// Halaman Pelanggan (#/customers, baru 2026-10-04): master kontak pembeli —
// nama, HP, catatan. Sumber angka/hutang BUKAN di sini: sisa piutang dihitung
// server di halaman Hutang (#/debts, ledger customer_debts).
//
// Server: GET /api/customers?q= (multi-kata), POST /api/customers (tanpa id =
// baru, id = update), DELETE /api/customers/:id (400 bila masih ada catatan
// hutang — pesannya menyuruh menghapus catatan di halaman Hutang dulu).

import { apiDelete, apiGet, apiPost } from '../api';
import { icon } from '../ui/icons';
import { punyaIzin } from '../ui/auth';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { pasangAksiBaru } from '../ui/aksi-baru';
import { rp } from '../escpos';
import { waktu } from '../ui/waktu';
import { esc } from '../ui/html';
import { errMsg } from '../ui/http';

type Customer = {
  id: number;
  /** No. customer otomatis dari server (`CUS-000001`); '' = baris lama
   *  yang nomornya belum pernah diisi (diisi server saat disimpan ulang). */
  code: string;
  /** Tier harga (`ecer` bawaan | `grosir`) — POS memakai price_grosir bila grosir. */
  tier: string;
  name: string;
  phone: string;
  address: string;
  note: string;
  created_at: string;
  updated_at: string;
};

type EditCustomer = { id: number | null; name: string; phone: string; address: string; note: string; code: string; tier: string };

/** Baris nota yang dibutuhkan modal riwayat pelanggan (subset GET /api/sales). */
type SalePelanggan = {
  id: string;
  invoice_no: string | null;
  created_at: string;
  total: number;
  pay_method: string;
  pay_methods: string | null;
  n_items: number;
  sisa_hutang: number;
  n_retur: number;
  retur_total: number;
  order_no: string | null;
};

/** Baris pesanan jasa untuk modal riwayat pelanggan (subset GET /api/orders
 *  — butir ROADMAP 1.10). `sisa` computed server (SQL_ORDER_UANG). */
type OrderPelanggan = {
  id: number;
  order_no: string | null;
  created_at: string;
  status: 'dikerjakan' | 'selesai' | 'diambil' | 'batal';
  total: number;
  n_items: number;
  dibayar: number;
  sisa: number;
};

const state = {
  items: [] as Customer[],
  total: 0,
  q: '',
  // Paginasi (2026-10-11): offset halaman; limit = PAGE_SIZE (ui/pager.ts).
  // RESET ke 0 setiap kata kunci berubah — kalau tidak, halaman 3 hasil cari
  // baru yang cuma 1 halaman menampilkan tabel kosong.
  offset: 0,
  limit: PAGE_SIZE,
  loading: true,
  error: '',
};

let host: HTMLElement | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

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
        ${punyaIzin('pelanggan.ubah') ? `<button type="button" id="cust-new" class="btn btn-primary" title="Buat pelanggan baru (Alt+N)">${icon('plus')}<span>Tambah Pelanggan</span><kbd class="kbd">Alt+N</kbd></button>` : ''}
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
      (u, i) => `
      <tr data-row="${u.id}">
        <td class="td tabular-nums">${state.offset + i + 1}</td>
        <td class="td">
          <div class="cell-strong">${esc(u.name)}</div>
          <div class="cell-sub">${u.code ? `<span class="font-mono">${esc(u.code)}</span> · ` : ''}${esc(u.phone || 'tanpa no. HP')}${u.tier === 'grosir' ? ' · <span class="font-semibold text-primary">Grosir</span>' : ''}</div>
        </td>
        <td class="td">${u.address ? esc(u.address) : '<span class="text-gray-400">—</span>'}</td>
        <td class="td">${u.note ? esc(u.note) : '<span class="text-gray-400">—</span>'}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            ${punyaIzin('riwayat.lihat') ? `<button type="button" data-cust-hist="${u.id}" class="row-btn" title="Riwayat transaksi pelanggan" aria-label="Riwayat transaksi ${esc(u.name)}">${icon('clock')}</button>` : ''}
            ${punyaIzin('pelanggan.ubah') ? `<button type="button" data-cust-edit="${u.id}" class="row-btn" title="Ubah pelanggan" aria-label="Ubah ${esc(u.name)}">${icon('pencil')}</button>` : ''}
            ${punyaIzin('pelanggan.hapus') ? `<button type="button" data-cust-del="${u.id}" class="row-btn row-btn-danger" title="Hapus pelanggan" aria-label="Hapus ${esc(u.name)}">${icon('trash')}</button>` : ''}
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
            <th class="th">No</th>
            <th class="th">Pelanggan</th>
            <th class="th">Alamat</th>
            <th class="th">Catatan</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagerHtml(state.offset, state.limit, state.total)}
  </div>
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    No. customer di-assign otomatis server (urut, tidak berubah setelah terbit).
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
  // Server menjaga `pelanggan.ubah`; formnya pun tidak dibuka untuk yang
  // tidak berhak (tombolnya sudah disembunyikan — ini jaring kedua).
  if (!punyaIzin('pelanggan.ubah')) {
    toast('Butuh izin Ubah pelanggan', 'warning');
    return;
  }
  const isNew = c.id === null;
  // Nomor urut DI-ASSIGN SERVER (CUS-) — form hanya menampilkannya.
  // Baris baru belum punya nomor sampai disimpan (server mengisi saat INSERT).
  // No. supplier DICABUT 2026-10-11 (pindah ke halaman Supplier).
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
          <label class="label" for="c-tier">Tier harga</label>
          <select id="c-tier" class="input">
            <option value="ecer"${(c.tier ?? 'ecer') === 'ecer' ? ' selected' : ''}>Ecer — harga jual biasa</option>
            <option value="grosir"${c.tier === 'grosir' ? ' selected' : ''}>Grosir — harga grosir produk</option>
          </select>
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
            tier: (el.querySelector('#c-tier') as HTMLSelectElement).value === 'grosir' ? 'grosir' : 'ecer',
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

/* ---------- RIWAYAT PELANGGAN ---------- */

const METODE: Record<string, string> = {
  tunai: 'Tunai',
  qris: 'QRIS',
  transfer: 'Transfer',
  campuran: 'Campuran',
};

/** Nama metode nota: satu metode = label biasa; `campuran` (split 1.6.5)
 *  dibaca dari CSV `pay_methods` agar "Tunai + QRIS" tidak hilang. */
function teksMetode(s: SalePelanggan): string {
  if (s.pay_method === 'campuran' && s.pay_methods) {
    return s.pay_methods
      .split(',')
      .map((m) => METODE[m] ?? m)
      .join(' + ');
  }
  return METODE[s.pay_method] ?? s.pay_method;
}

/** Riwayat nota satu pelanggan (2026-10-25). Server: GET /api/sales?customer_id=
 *  — tanpa `date` berarti SELURUH riwayat, bukan hari ini saja. Tanpa izin
 *  `riwayat.semua`, server hanya mengirim nota atas nama akun ini; modal
 *  menyebutkannya supaya angka tidak disangka "pelanggan tak pernah belanja".
 *  Hanya-baca: tidak ada tombol simpan, cukup "Tutup". */
async function riwayatPelanggan(c: Customer): Promise<void> {
  if (!punyaIzin('riwayat.lihat')) {
    toast('Butuh izin Riwayat transaksi', 'warning');
    return;
  }
  let rows: SalePelanggan[] = [];
  let total = 0;
  let orders: OrderPelanggan[] = [];
  try {
    const r = await apiGet<{ data: SalePelanggan[]; total: number }>(
      `/api/sales?customer_id=${c.id}&limit=50`,
    );
    rows = r.data;
    total = r.total;
  } catch (e) {
    toast(`Gagal memuat riwayat: ${errMsg(e)}`, 'error');
    return;
  }
  // Pesanan jasa (butir ROADMAP 1.10): gagal = modal tetap tampil dengan nota
  // saja — pesanan adalah pelengkap, bukan sumber utama riwayat.
  try {
    const r = await apiGet<{ data: OrderPelanggan[] }>(
      `/api/orders?customer_id=${c.id}&limit=50`,
    );
    orders = r.data;
  } catch {
    orders = [];
  }
  const semuaKasir = punyaIzin('riwayat.semua');
  const jumlahTampil = rows.reduce((a, s) => a + s.total, 0);
  const terpotong = total > rows.length;
  // Status pesanan → label + warna chip (pola chip hutang/retur halaman ini).
  const statusPesanan: Record<OrderPelanggan['status'], { label: string; kelas: string }> = {
    dikerjakan: { label: 'Dikerjakan', kelas: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' },
    selesai: { label: 'Siap diambil', kelas: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
    diambil: { label: 'Diambil', kelas: 'bg-gray-100 text-gray-600 dark:bg-gray-500/15 dark:text-gray-300' },
    batal: { label: 'Batal', kelas: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300' },
  };
  const nAktif = orders.filter((o) => o.status === 'dikerjakan' || o.status === 'selesai').length;
  const seksiPesanan = orders.length === 0
    ? ''
    : `
      <h3 class="form-sec mt-4">Pesanan jasa</h3>
      <div class="table-wrap table-scroll">
        <table class="table table-compact">
          <thead>
            <tr>
              <th class="th">No.</th>
              <th class="th">Waktu</th>
              <th class="th text-right">Item</th>
              <th class="th">Status</th>
              <th class="th text-right">Dibayar</th>
              <th class="th text-right">Sisa</th>
            </tr>
          </thead>
          <tbody>
            ${orders
              .map((o) => {
                const st = statusPesanan[o.status] ?? { label: o.status, kelas: 'bg-gray-100 text-gray-600' };
                const aktif = o.status === 'dikerjakan' || o.status === 'selesai';
                return `
              <tr class="tr">
                <td class="td">
                  <div class="cell-strong font-mono">${esc(o.order_no ?? String(o.id))}</div>
                  ${o.status === 'diambil' ? '<div class="cell-sub">tercatat di Riwayat (nota)</div>' : ''}
                </td>
                <td class="td whitespace-nowrap">${esc(waktu(o.created_at))}</td>
                <td class="td text-right tabular-nums">${o.n_items}</td>
                <td class="td">
                  <span class="chip ${st.kelas}">${st.label}</span>
                  ${aktif && o.sisa > 0 ? `<div class="mt-1"><span class="chip bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300">Hutang ${rp(o.sisa)}</span></div>` : ''}
                </td>
                <td class="td text-right tabular-nums">${o.dibayar > 0 ? rp(o.dibayar) : '—'}</td>
                <td class="td text-right font-semibold tabular-nums">${aktif && o.sisa > 0 ? rp(o.sisa) : '—'}</td>
              </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>`;
  const isi =
    rows.length === 0 && orders.length === 0
      ? `<div class="empty">${icon('receipt')}<span>${
          semuaKasir
            ? 'Pelanggan ini belum pernah bertransaksi.'
            : 'Belum ada nota atas nama Anda untuk pelanggan ini.'
        }</span></div>`
      : `
      <div class="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span class="chip">${icon('receipt')}<span>${total} nota</span></span>
        <span class="chip">${terpotong ? `${rows.length} terbaru` : 'Semua'} · ${rp(jumlahTampil)}</span>
        ${orders.length ? `<span class="chip">${icon('clock')}<span>${orders.length} pesanan${nAktif ? ` (${nAktif} aktif)` : ''}</span></span>` : ''}
        ${!semuaKasir ? `<span class="chip">hanya nota Anda</span>` : ''}
      </div>
      ${rows.length === 0 ? '' : `
      <div class="table-wrap table-scroll">
        <table class="table table-compact">
          <thead>
            <tr>
              <th class="th">Nota</th>
              <th class="th">Waktu</th>
              <th class="th text-right">Item</th>
              <th class="th">Metode</th>
              <th class="th text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (s) => `
              <tr class="tr">
                <td class="td">
                  <div class="cell-strong font-mono">${esc(s.invoice_no ?? s.id.slice(0, 8))}</div>
                  ${s.order_no ? `<div class="cell-sub">Pesanan ${esc(s.order_no)}</div>` : ''}
                </td>
                <td class="td whitespace-nowrap">${esc(waktu(s.created_at))}</td>
                <td class="td text-right tabular-nums">${s.n_items}</td>
                <td class="td">
                  <div>${esc(teksMetode(s))}</div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    ${s.sisa_hutang > 0 ? `<span class="chip bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300">Hutang ${rp(s.sisa_hutang)}</span>` : ''}
                    ${s.n_retur > 0 ? `<span class="chip bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Retur ${rp(s.retur_total)}</span>` : ''}
                  </div>
                </td>
                <td class="td text-right font-semibold tabular-nums">${rp(s.total)}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`}
      ${seksiPesanan}
      ${terpotong
        ? `<p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Menampilkan ${rows.length} nota terbaru dari ${total}. Buka menu Riwayat transaksi untuk arsip per hari.</p>`
        : ''}`;
  openModal({
    title: `Riwayat transaksi — ${c.name}`,
    wide: true,
    cancelLabel: 'Tutup',
    body: isi,
    onMount: (api) => {
      // Hanya-baca: satu tombol "Tutup" (pola riwayatForm di halaman Audit).
      api.ok.remove();
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
  host!.querySelectorAll<HTMLElement>('[data-cust-hist]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.custHist);
      const c = state.items.find((x) => x.id === id);
      if (c) void riwayatPelanggan(c);
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-cust-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!punyaIzin('pelanggan.ubah')) {
        toast('Butuh izin Ubah pelanggan', 'warning');
        return;
      }
      const id = Number(b.dataset.custEdit);
      const c = state.items.find((x) => x.id === id);
      if (c) customerForm({ id: c.id, name: c.name, phone: c.phone, address: c.address, note: c.note, code: c.code, tier: c.tier ?? 'ecer' });
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-cust-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!punyaIzin('pelanggan.hapus')) {
        toast('Butuh izin Hapus pelanggan', 'warning');
        return;
      }
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
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    p.set('limit', String(state.limit));
    p.set('offset', String(state.offset));
    const r = await apiGet<{ data: Customer[]; total: number }>(`/api/customers?${p}`);
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
  const bukaBaru = () =>
    customerForm({ id: null, name: '', phone: '', address: '', note: '', code: '', tier: 'ecer' });
  el.querySelector('#cust-new')?.addEventListener('click', bukaBaru);
  // Alt+N = pintasan tombol yang sama (ui/aksi-baru.ts). Hanya bila izinnya
  // ada — tombolnya sendiri juga tidak dirender tanpa `pelanggan.ubah`.
  if (punyaIzin('pelanggan.ubah')) pasangAksiBaru(bukaBaru);
  // Debounce 250ms (pola halaman lain) — Enter mempercepat.
  el.querySelector<HTMLInputElement>('#cust-q')?.addEventListener('input', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = v.trim();
      state.offset = 0;
      void load();
    }, 250);
  });
  el.querySelector<HTMLInputElement>('#cust-q')?.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      clearTimeout(searchTimer);
      state.q = (ev.target as HTMLInputElement).value.trim();
      state.offset = 0;
      void load();
    }
  });
  await load();
}
