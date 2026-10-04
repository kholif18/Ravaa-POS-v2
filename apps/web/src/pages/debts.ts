// Halaman Hutang (#/debts, baru 2026-10-04) — buku piutang toko.
//
// Model: LEDGER dua arah di `customer_debts` — type 'charge' = pelanggan
// berhutang, 'payment' = pembayaran. Saldo TIDAK PERNAH disimpan sebagai angka:
// sisa = SUM(charge) − SUM(payment), dihitung server saat dibaca, jadi hapus 1
// baris salah ketik tidak pernah meninggalkan angka basi.
//
// Server: GET /api/customer-debts?status=open|semua (ringkasan per pelanggan +
// total), GET /api/customer-debts/:id (rincian ledger + sisa berjalan per baris),
// POST /api/customer-debts (payment > sisa -> 400), DELETE /api/customer-debts/:id.
//
// Hutang DICATAT MANUAL di sini — POS sengaja tidak punya metode bayar piutang
// (kontrak POST /api/sales tidak berubah).

import { apiDelete, apiGet, apiPost, HttpError } from '../api';
import { rp } from '../escpos';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { waktu } from '../ui/waktu';

type Ringkasan = {
  customer_id: number;
  name: string;
  phone: string;
  charge: number;
  bayar: number;
  sisa: number;
  terakhir: string | null;
};

type Baris = {
  id: number;
  customer_id: number;
  type: 'charge' | 'payment';
  amount: number;
  note: string;
  created_at: string;
  sisa: number;
};

type Rincian = {
  customer: { id: number; name: string; phone: string; note: string };
  rows: Baris[];
  charge: number;
  bayar: number;
  sisa: number;
};

type Customer = { id: number; name: string; phone: string; note: string };

const state = {
  rows: [] as Ringkasan[],
  total: 0,
  status: 'open' as 'open' | 'semua',
  loading: true,
  error: '',
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

function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Hutang pelanggan</h2>
          <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Catat siapa berhutang dan pembayarannya. Pelanggan &rarr; master kontak di halaman Pelanggan.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          {/* 2026-10-04: tombol "Catat bayar" global DIHAPUS — tiap baris
              tabel kini punya tombol Bayar sendiri (prefill nama + sisa),
              lebih cepat dan tidak mungkin salah pilih pelanggan. */}
          <button type="button" id="hutang-charge" class="btn btn-primary">${icon('plus')}<span>Catat hutang</span></button>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <span class="chip" title="Total piutang yang belum lunas (semua pelanggan)">
          ${icon('wallet')}<span class="font-semibold tabular-nums" id="hutang-total">…</span>
        </span>
        <span class="chip" id="hutang-count">${icon('users')}<span>…</span></span>
        <span class="ml-auto flex items-center gap-1">
          <button type="button" class="chip" data-status="open">Masih berhutang</button>
          <button type="button" class="chip" data-status="semua">Semua riwayat</button>
        </span>
      </div>
    </div>

    <div id="hutang-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat hutang: ${esc(state.error)}</span></div>
    </div>`;
  }
  if (state.rows.length === 0) {
    return `<div class="card">
      <div class="empty">${icon('wallet')}
        <span>${state.status === 'open' ? 'Tidak ada pelanggan yang sedang berhutang. 👍' : 'Belum ada catatan hutang sama sekali.'}</span>
      </div>
    </div>`;
  }

  const rows = state.rows
    .map((r) => {
      const lunas = r.sisa <= 0;
      return `
      <tr data-row="${r.customer_id}">
        <td class="td">
          <div class="cell-strong">${esc(r.name)}</div>
          <div class="cell-sub">${esc(r.phone || 'tanpa no. HP')}</div>
        </td>
        <td class="td text-right tabular-nums">${rp(r.charge)}</td>
        <td class="td text-right tabular-nums">${rp(r.bayar)}</td>
        <td class="td text-right">
          ${lunas ? '<span class="badge-ok">Lunas</span>' : `<span class="font-semibold text-red-600 dark:text-red-400 tabular-nums">${rp(r.sisa)}</span>`}
        </td>
        <td class="td text-right">${r.terakhir ? esc(waktu(r.terakhir)) : '—'}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            ${
              // Tombol BAYAR per baris (permintaan pemilik 2026-10-04): hanya
              // untuk yang masih berhutang — pelanggan lunas tak punya yang
              // bisa dibayar. Buka modal pembayaran yang sudah terkunci ke
              // pelanggan ini (tanpa dropdown), lengkap dengan sisa hutangnya.
              lunas
                ? ''
                : `<button type="button" data-bayar="${r.customer_id}" class="row-btn" title="Catat pembayaran${r.sisa > 0 ? ` — sisa ${rp(r.sisa)}` : ''}" aria-label="Bayar hutang ${esc(r.name)}">${icon('wallet')}</button>`
            }
            <button type="button" data-rincian="${r.customer_id}" class="row-btn" title="Rincian hutang &amp; cetak A4" aria-label="Rincian ${esc(r.name)}">${icon('receipt')}</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  return `
  <div class="card-flush">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="th">Pelanggan</th>
            <th class="th text-right">Dihutang</th>
            <th class="th text-right">Dibayar</th>
            <th class="th text-right">Sisa</th>
            <th class="th text-right">Terakhir</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    Saldo dihitung ulang dari mutasi (hutang &minus; bayar), bukan angka tersimpan.
    Ikon dompet pada baris = catat pembayaran langsung untuk pelanggan itu;
    ikon nota = rincian ledger + cetak A4.
  </p>`;
}

function paint(): void {
  const totalEl = host?.querySelector('#hutang-total');
  if (totalEl) totalEl.textContent = rp(state.total);
  const countEl = host?.querySelector('#hutang-count span');
  if (countEl) countEl.textContent = `${state.rows.length} pelanggan`;
  // Chip status: tandai yang aktif (gaya primary, pola chip filter history).
  host?.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => {
    const aktif = b.dataset.status === state.status;
    b.classList.toggle('!border-primary/40', aktif);
    b.classList.toggle('!text-primary', aktif);
    b.classList.toggle('font-semibold', aktif);
  });
  const body = host?.querySelector('#hutang-body');
  if (body) body.innerHTML = renderTable();
  bindRows();
}

/* ---------- CETAK A4 (rincian hutang) ----------
   Permintaan pemilik 2026-10-04: dari modal rincian bisa dicetak dalam format
   A4. Pola PERSIS `cetakInvoice()` (invoice.ts): bangun HTML print-only ->
   window.open -> document.write -> window.print() otomatis saat load.
   BUKAN lewat print-agent: agent hanya menulis byte mentah (nol-dependensi),
   tidak bisa merender HTML — sama alasan dengan invoice A4.
   Gagal cetak/popup diblokir TIDAK PERNAH merusak apa pun: hanya toast. */

type Toko = { store_name: string; store_address: string; store_phone: string; store_email: string };

function escA4(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Tanggal cetak gaya Indonesia, zona waktu KASIR (bukan UTC) — sama seperti
 *  invoice A4: created_at disimpan UTC (Z), di sini diparse lalu tampil lokal. */
function tglLokal(createdAt: string): string {
  const t = /[Zz]$|[+-]\d{2}:\d{2}$/.test(createdAt) || createdAt.includes('T')
    ? createdAt
    : `${createdAt.replace(' ', 'T')}Z`;
  return new Date(t).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Seluruh dokumen rincian hutang jadi satu string HTML (A4, print-only). */
function htmlHutangA4(r: Rincian, toko: Toko, tglCetak: string): string {
  const lunas = r.sisa <= 0;
  // Dicetak KRONOLOGIS (dari mutasi pertama -> terakhir): kolom "Sisa" berjalan
  // baru terbaca wajar dari atas ke bawah. Layar sengaja DESC (terbaru di atas).
  const asc = [...r.rows].reverse();
  const baris = asc
    .map((b, i) => {
      const charge = b.type === 'charge';
      return `<tr>
        <td class="c">${i + 1}</td>
        <td class="nowrap">${escA4(tglLokal(b.created_at))}</td>
        <td>${charge ? 'Hutang' : 'Bayar'}</td>
        <td>${b.note ? escA4(b.note) : '&mdash;'}</td>
        <td class="r">${charge ? '+' : '&minus;'}${rp(b.amount)}</td>
        <td class="r">${rp(b.sisa)}</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Rincian hutang — ${escA4(r.customer.name)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 14mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 0; line-height: 1.45; }
  .kop { display: flex; justify-content: space-between; align-items: flex-start; }
  .judul { font-size: 15px; font-weight: 700; letter-spacing: .3px; }
  .nama-toko { font-size: 13px; font-weight: 700; margin-top: 4px; }
  .alamat { margin-top: 4px; max-width: 60%; }
  .baris-kop { display: flex; margin-top: 2px; }
  .baris-kop .lbl { width: 72px; }
  .logo { width: 66px; height: 66px; border-radius: 50%; background: #4a90d9; color: #fff;
          font-size: 40px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex: none; }
  hr { border: 0; border-top: 1px solid #444; margin: 12px 0; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 16px; }
  .meta .ttl { font-weight: 700; margin-bottom: 4px; }
  .rincian .baris { display: flex; }
  .rincian .baris .lbl { width: 118px; }
  table.ledger { width: 100%; border-collapse: collapse; }
  table.ledger th { font-size: 10px; padding: 5px 6px; border-top: 1px solid #444;
                    border-bottom: 1px solid #444; text-align: left; }
  table.ledger th.r, table.ledger td.r { text-align: right; }
  table.ledger th.c, table.ledger td.c { text-align: center; }
  table.ledger td { padding: 5px 6px; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
  .nowrap { white-space: nowrap; }
  .kosong { padding: 14px 6px; color: #777; border-bottom: 1px solid #e2e2e2; }
  .ringkas { width: 55%; margin-left: auto; margin-top: 14px; }
  .kotak { display: flex; justify-content: space-between; border: 1px solid #444; padding: 5px 9px; margin-bottom: 7px; }
  .kotak .lbl { font-weight: 700; }
  .kotak.sisa { border-width: 2px; font-size: 13px; }
  .status { display: inline-block; padding: 2px 8px; border: 1px solid #444; font-weight: 700; font-size: 10px; }
  .foot { margin-top: 34px; font-size: 9px; color: #aaa; }
</style>
</head>
<body>
  <div class="kop">
    <div>
      <div class="judul">RINCIAN HUTANG PELANGGAN</div>
      <div class="nama-toko">${escA4(toko.store_name || 'RAVA POS')}</div>
      ${toko.store_address ? `<div class="alamat">${escA4(toko.store_address)}</div>` : ''}
      ${toko.store_phone ? `<div class="baris-kop"><span class="lbl">Phone:</span><span>${escA4(toko.store_phone)}</span></div>` : ''}
      ${toko.store_email ? `<div class="baris-kop"><span class="lbl">Email:</span><span>${escA4(toko.store_email)}</span></div>` : ''}
    </div>
    <div class="logo" aria-hidden="true">R</div>
  </div>
  <hr>
  <div class="meta">
    <div>
      <div class="ttl">Pelanggan</div>
      <div>${escA4(r.customer.name)}</div>
      ${r.customer.phone ? `<div>${escA4(r.customer.phone)}</div>` : ''}
    </div>
    <div class="rincian">
      <div class="baris"><span class="lbl">Tanggal cetak:</span><span>${escA4(tglCetak)}</span></div>
      <div class="baris"><span class="lbl">Jumlah mutasi:</span><span>${r.rows.length} baris</span></div>
      <div class="baris"><span class="lbl">Status:</span><span class="status">${lunas ? 'LUNAS' : 'BELUM LUNAS'}</span></div>
    </div>
  </div>
  ${
    r.rows.length === 0
      ? `<div class="kosong">Belum ada catatan hutang untuk pelanggan ini.</div>`
      : `<table class="ledger">
    <thead>
      <tr>
        <th class="c" style="width:34px">#</th>
        <th style="width:132px">Tanggal</th>
        <th style="width:70px">Jenis</th>
        <th>Catatan</th>
        <th class="r" style="width:120px">Jumlah</th>
        <th class="r" style="width:120px">Sisa</th>
      </tr>
    </thead>
    <tbody>${baris}</tbody>
  </table>`
  }
  <div class="ringkas">
    <div class="kotak"><span class="lbl">Total dihutang</span><span>${rp(r.charge)}</span></div>
    <div class="kotak"><span class="lbl">Total dibayar</span><span>${rp(r.bayar)}</span></div>
    <div class="kotak sisa"><span class="lbl">${lunas ? 'Sisa (lunas)' : 'Sisa hutang'}</span><span>${rp(Math.max(0, r.sisa))}</span></div>
  </div>
  <div class="foot">Dicetak dari Ravaa POS &middot; ${escA4(tglCetak)}</div>
  <script>
    // Cetak otomatis begitu dokumen siap (pola invoice.ts). Gagal/stall print
    // tidak merusak apa pun — tab sengaja tidak ditutup supaya bisa print ulang.
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`;
}

/** Ambil rincian + kop lalu buka tab cetak A4. Lempar Error bila API tak
 *  terjangkau / popup diblokir — pemanggil hanya memberi toast. */
async function cetakHutangA4(customerId: number): Promise<void> {
  const [rincian, set] = await Promise.all([
    apiGet<{ data: Rincian }>(`/api/customer-debts/${customerId}`),
    apiGet<{ data: Toko }>('/api/settings'),
  ]);
  const tglCetak = new Date().toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const html = htmlHutangA4(rincian.data, set.data, tglCetak);
  const w = window.open('', '_blank');
  if (!w) throw new Error('popup diblokir browser — izinkan popup untuk mencetak A4');
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* ---------- MODAL RINCIAN (ledger per pelanggan) ---------- */

async function muatRincian(el: HTMLElement, customerId: number): Promise<void> {
  const box = el.querySelector<HTMLElement>('#rincian-body');
  if (!box) return;
  try {
    const resp = await apiGet<{ data: Rincian }>(`/api/customer-debts/${customerId}`);
    const r = resp.data;
    const c = r.customer;
    box.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span class="chip">${rp(r.charge)}<span class="text-gray-500">dihutang</span></span>
        <span class="chip">${rp(r.bayar)}<span class="text-gray-500">dibayar</span></span>
        <span class="chip ${r.sisa > 0 ? '!border-red-500/40 !text-red-700 dark:!text-red-400' : '!border-emerald-500/40 !text-emerald-700 dark:!text-emerald-400'}">
          <span class="font-semibold tabular-nums">${rp(r.sisa)}</span><span>${r.sisa > 0 ? 'sisa' : 'lunas'}</span>
        </span>
        ${c.phone ? `<span class="chip">${icon('users')}<span>${esc(c.phone)}</span></span>` : ''}
      </div>
      ${
        r.rows.length === 0
          ? `<div class="empty">${icon('wallet')}<span>Belum ada mutasi.</span></div>`
          : `<div class="card-flush"><div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="th">Waktu</th>
            <th class="th">Jenis</th>
            <th class="th">Catatan</th>
            <th class="th text-right">Jumlah</th>
            <th class="th text-right">Sisa</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${r.rows
            .map((b) => {
              const charge = b.type === 'charge';
              return `
            <tr>
              <td class="td whitespace-nowrap">${esc(waktu(b.created_at))}</td>
              <td class="td">${
                charge
                  ? `<span class="chip !border-red-500/40 !text-red-700 dark:!text-red-400">${icon('plus')}<span>Hutang</span></span>`
                  : `<span class="chip !border-emerald-500/40 !text-emerald-700 dark:!text-emerald-400">${icon('check')}<span>Bayar</span></span>`
              }</td>
              <td class="td">${b.note ? esc(b.note) : '<span class="text-gray-400">—</span>'}</td>
              <td class="td text-right tabular-nums ${charge ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}">${charge ? '+' : '−'}${rp(b.amount)}</td>
              <td class="td text-right font-semibold tabular-nums">${rp(b.sisa)}</td>
              <td class="td text-right">
                <button type="button" data-del-baris="${b.id}" class="row-btn row-btn-danger" title="Hapus catatan ini" aria-label="Hapus catatan">${icon('trash')}</button>
              </td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div></div>`
      }`;

    box.querySelectorAll<HTMLButtonElement>('[data-del-baris]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.delBaris);
        const baris = r.rows.find((x) => x.id === id);
        if (!baris) return;
        const yes = await confirmDialog({
          title: `Hapus catatan ${baris.type === 'charge' ? 'hutang' : 'bayar'} ${rp(baris.amount)}?`,
          message: 'Catatan ini salah ketik dan akan dihapus; sisa hutang ikut dihitung ulang.',
          okLabel: 'Hapus',
          cancelLabel: 'Batal, jangan dihapus',
          danger: true,
        });
        if (!yes) return;
        try {
          await apiDelete(`/api/customer-debts/${id}`);
          toast('Catatan dihapus', 'success');
          await muatRincian(el, customerId); // muat ulang ledger
          await load(); // ringkasan tabel + total ikut berubah
        } catch (e) {
          toast(`Gagal hapus: ${errMsg(e)}`, 'error');
        }
      }),
    );
  } catch (e) {
    box.innerHTML = `<div class="empty">${icon('alert')}<span>Gagal memuat rincian: ${errMsg(e)}</span></div>`;
  }
}

function rincianForm(r: Ringkasan): void {
  openModal({
    title: `Rincian hutang — ${r.name}`,
    wide: true,
    // Tombol primer = Cetak A4 (permintaan pemilik 2026-10-04); "Tutup" jadi
    // tombol kiri. Modal TIDAK menutup sendiri setelah cetak (openModal tak
    // auto-close) — kasir masih bisa melihat ledger / mencetak ulang.
    okLabel: 'Cetak A4',
    cancelLabel: 'Tutup',
    body: `<div id="rincian-body" class="text-sm text-gray-500 dark:text-gray-400">Memuat rincian…</div>`,
    onMount: (api) => {
      void muatRincian(api.el, r.customer_id);
      api.ok.addEventListener('click', async () => {
        try {
          await cetakHutangA4(r.customer_id);
        } catch (e) {
          // Cetak tidak pernah membatalkan/menghapus apa pun — hanya toast.
          toast(`Gagal cetak A4: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

/* ---------- MODAL CATAT (charge / payment) ---------- */

/** Prefill dari tombol BAYAR per baris: pelanggan sudah pasti, jadi tanpa
 *  dropdown — kasir tinggal mengetik nominal. `sisa` dipakai untuk preview
 *  "sisa setelah bayar" dan peringatan melebihi sisa. */
type PrefillBayar = { id: number; name: string; sisa: number };

async function catatForm(jenis: 'charge' | 'payment', prefill?: PrefillBayar): Promise<void> {
  // Pelanggan dipilih dari master — kalau belum ada, suruh buat dulu.
  // Prefill tidak butuh master (namanya sudah jelas dari baris yang diklik).
  let pelanggan: Customer[] = [];
  if (!prefill) {
    try {
      const r = await apiGet<{ data: Customer[] }>('/api/customers');
      pelanggan = r.data;
    } catch (e) {
      toast(`Gagal memuat pelanggan: ${errMsg(e)}`, 'error');
      return;
    }
    if (pelanggan.length === 0) {
      toast('Belum ada pelanggan — tambahkan dulu di halaman Pelanggan', 'warning');
      location.hash = '#/customers';
      return;
    }
  }

  const hutang = jenis === 'charge';
  openModal({
    title: hutang ? 'Catat hutang baru' : 'Catat pembayaran',
    okLabel: hutang ? 'Catat hutang' : 'Catat pembayaran',
    body: `
      ${
        prefill
          ? `<div class="card !p-3">
               <div class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Pelanggan</div>
               <div class="mt-0.5 text-sm font-semibold text-gray-900 dark:text-white">${esc(prefill.name)}</div>
               <div class="mt-1 flex items-baseline justify-between text-xs">
                 <span class="text-gray-500 dark:text-gray-400">Sisa hutang saat ini</span>
                 <span class="font-semibold tabular-nums ${prefill.sisa > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}">${rp(prefill.sisa)}</span>
               </div>
               <div class="flex items-baseline justify-between text-xs">
                 <span class="text-gray-500 dark:text-gray-400">Sisa setelah bayar</span>
                 <span id="h-sisa-setelah" class="font-semibold tabular-nums text-gray-900 dark:text-white">&mdash;</span>
               </div>
             </div>`
          : `<div class="field">
               <label class="label" for="h-cust">Pelanggan *</label>
               <select id="h-cust" class="input">
                 ${pelanggan
                   .map((c) => `<option value="${c.id}">${esc(c.name)}${c.phone ? ` — ${esc(c.phone)}` : ''}</option>`)
                   .join('')}
               </select>
             </div>`
      }
      <div class="field">
        <label class="label" for="h-amount">Nominal (Rp) *</label>
        <input id="h-amount" class="input text-right font-semibold tabular-nums" type="number" inputmode="numeric" min="1" step="1" placeholder="cth: 50000" autofocus />
        ${
          hutang
            ? ''
            : '<span class="text-xs text-gray-500 dark:text-gray-400">Pembayaran lebih besar dari sisa hutang akan ditolak server.</span>'
        }
        <span id="h-lebih" class="hidden text-xs font-semibold text-red-600 dark:text-red-400"></span>
      </div>
      <div class="field">
        <label class="label" for="h-note">Catatan</label>
        <input id="h-note" class="input" placeholder="${hutang ? 'cth: beli ATK 4 Oktober' : 'cth: bayar tunai'}" maxlength="200" />
      </div>`,
    onMount: ({ el, ok, close }) => {
      const amount = el.querySelector('#h-amount') as HTMLInputElement;
      amount.focus();

      // Preview "sisa setelah bayar" + peringatan dini bila melebihi sisa.
      // Server tetap penentu akhir (400 "melebihi sisa") — ini hanya bantuan
      // mengetik supaya kasir tidak perlu trial-and-error.
      const sisaEl = el.querySelector('#h-sisa-setelah');
      const lebihEl = el.querySelector('#h-lebih');
      const nilai = (): number => (Number.isFinite(Number(amount.value)) ? Number(amount.value) : 0);
      const preview = (): void => {
        if (sisaEl) {
          // Nominal masih kosong -> tampilkan "—" netral (bukan sisa saat ini
          // yang seolah-olah sudah dibayar) — biar jelas angka itu hasil proyeksi.
          const kosong = nilai() <= 0;
          const setelah = prefill!.sisa - nilai();
          sisaEl.textContent = kosong ? '—' : setelah > 0 ? rp(setelah) : 'LUNAS';
          sisaEl.classList.toggle('text-emerald-600', !kosong && setelah <= 0);
          sisaEl.classList.toggle('text-red-600', !kosong && setelah > 0);
          sisaEl.classList.toggle('text-gray-900', kosong);
          sisaEl.classList.toggle('dark:text-white', kosong);
        }
        if (lebihEl) {
          const lewat = prefill ? nilai() - prefill.sisa : 0;
          const lebih = nilai() > 0 && lewat > 0;
          lebihEl.classList.toggle('hidden', !lebih);
          lebihEl.textContent = lebih ? `melebihi sisa (${rp(prefill!.sisa)})` : '';
        }
      };
      if (prefill) {
        amount.addEventListener('input', preview);
        preview();
      }

      ok.addEventListener('click', async () => {
        const v = Number(amount.value);
        if (!Number.isInteger(v) || v <= 0) {
          toast('Nominal harus bilangan bulat rupiah lebih dari 0', 'warning');
          amount.focus();
          return;
        }
        const customerId = prefill ? prefill.id : Number((el.querySelector('#h-cust') as HTMLSelectElement).value);
        try {
          await apiPost('/api/customer-debts', {
            customer_id: customerId,
            type: jenis,
            amount: v,
            note: (el.querySelector('#h-note') as HTMLInputElement).value.trim(),
          });
          close();
          const nama = prefill ? prefill.name : (pelanggan.find((c) => c.id === customerId)?.name ?? '');
          toast(hutang ? `Hutang ${rp(v)} untuk "${nama}" dicatat` : `Pembayaran ${rp(v)} dari "${nama}" dicatat`, 'success');
          await load();
        } catch (e) {
          // 400 "pembayaran melebihi sisa…" tetap membuka modal — biar kasir
          // membetulkan nominalnya, bukan mulai dari nol.
          toast(`Gagal: ${errMsg(e)}`, 'error');
          amount.focus();
          amount.select();
        }
      });
    },
  });
}

/* ---------- AKSI ---------- */

function bindRows(): void {
  host!.querySelectorAll<HTMLElement>('[data-rincian]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.rincian);
      const r = state.rows.find((x) => x.customer_id === id);
      if (r) rincianForm(r);
    }),
  );
  // Tombol BAYAR per baris (permintaan pemilik 2026-10-04): modal pembayaran
  // langsung terkunci ke pelanggan ini + membawa sisa hutangnya.
  host!.querySelectorAll<HTMLElement>('[data-bayar]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.bayar);
      const r = state.rows.find((x) => x.customer_id === id);
      if (r && r.sisa > 0) void catatForm('payment', { id: r.customer_id, name: r.name, sisa: r.sisa });
    }),
  );
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const r = await apiGet<{ data: Ringkasan[]; total: number }>(
      `/api/customer-debts?status=${state.status}`,
    );
    state.rows = r.data;
    state.total = r.total;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

/* ---------- ENTRY ---------- */

export async function mountDebtsPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderPage();
  paint();
  el.querySelector('#hutang-charge')?.addEventListener('click', () => void catatForm('charge'));
  el.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = b.dataset.status === 'semua' ? 'semua' : 'open';
      if (s === state.status) return;
      state.status = s;
      void load();
    }),
  );
  await load();
}
