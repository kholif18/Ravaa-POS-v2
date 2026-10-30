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

import { apiDelete, apiGet, apiPost } from '../api';
import { PAGE_SIZE, bindPager, bindPagerLimit, pagerHtml } from '../ui/pager';
import { kirimPrint, rp, strukUntukTercetak, type Struk } from '../escpos';
import { icon } from '../ui/icons';
import { punyaIzin } from '../ui/auth';
import { choiceDialog, confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { waktu } from '../ui/waktu';
import { pasangAksiBaru } from '../ui/aksi-baru';
import { getCashier, getToko } from '../ui/user';
import { esc } from '../ui/html';
import { errMsg } from '../ui/http';
import {
  footerStruk, syncDariServerSettings,
} from '../ui/identitas-struk';
// Slot logo & footer bersama semua dokumen A4 (permintaan pemilik 19 Okt 2026).
import { CSS_LOGO_A4, bukaTabCetak, footerDokumenA4, logoA4Html, rpIdr, tglSingkat, tglLengkap, cityToko } from '../invoice';

type Ringkasan = {
  customer_id: number;
  name: string;
  phone: string;
  charge: number;
  bayar: number;
  sisa: number;
  terakhir: string | null;
  /** Usia charge TERTUA yang belum terbayar (FIFO, dihitung server 2026-10-16).
   *  null = tidak dihitung (pelanggan lunas) — badge umur hanya untuk sisa > 0. */
  umur_hari: number | null;
};

type Baris = {
  id: number;
  customer_id: number;
  type: 'charge' | 'payment';
  amount: number;
  note: string;
  created_at: string;
  sisa: number;
  /** Atribusi laci (Paket A, 2026-10-20). Baris lama = null + ''. */
  shift_id?: number | null;
  cashier?: string;
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
  // `count` = jumlah pelanggan (untuk pager); `total` TETAP jumlah uang
  // (kartu piutang) — kontrak server, jangan dipakai hitung halaman.
  count: 0,
  // Pengingat umur piutang (2026-10-16): jumlah pelanggan berhutang >30 hari
  // (dihitung server dari SELURUH ledger, bukan cuma halaman ini).
  lewat30: 0,
  status: 'open' as 'open' | 'semua',
  limit: PAGE_SIZE,
  // Paginasi (2026-10-11): RESET ke 0 setiap toggle status.
  offset: 0,
  loading: true,
  error: '',
  /** Shift terbuka kasir ini saat halaman dimuat / pembayaran dikirim.
   *  null = di luar shift — pembayaran tetap tercatat, tapi tidak menggerakkan
   *  laci shift mana pun (baris baru selalu ber-cashier non-kosong). */
  shiftId: null as number | null,
};

let host: HTMLElement | null = null;

/** Shift terbuka kasir ini (pola expenses.ts). Gagal/jaringan putus = NULL
 *  (di luar shift), bukan error halaman: pembayaran tetap harus bisa dicatat. */
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

// Catatan (2026-10-04): tombol "Catat bayar" GLOBAL pernah ada di blok aksi
// halaman ini — DIHAPUS; tiap baris tabel kini punya tombol Bayar sendiri
// (prefill nama + sisa), lebih cepat dan tidak mungkin salah pilih pelanggan.
// JANGAN menulis catatan ini sebagai `{/* … */}` di dalam template — di
// template literal TS itu bukan komentar, tapi BOCOR sebagai teks di layar
// (nyata 2026-10-19, dilaporkan pemilik "perbaiki agar lebih rapi").
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
          ${punyaIzin('hutang.catat') ? `<button type="button" id="hutang-charge" class="btn btn-primary" title="Catat hutang baru (Alt+N)">${icon('plus')}<span>Catat hutang</span><kbd class="kbd">Alt+N</kbd></button>` : ''}
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <span class="chip" title="Total piutang yang belum lunas (semua pelanggan)">
          ${icon('wallet')}<span class="font-semibold tabular-nums" id="hutang-total">…</span>
        </span>
        <span class="chip" id="hutang-count">${icon('users')}<span>…</span></span>
        <span class="chip !border-amber-500/40 !text-amber-700 dark:!text-amber-400" id="hutang-lewat" hidden
              title="Ada pelanggan dengan hutang tertua lebih dari 30 hari — tagih segera">
          ${icon('alert')}<span id="hutang-lewat-n">0</span><span>lewat 30 hari</span>
        </span>
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
      // Umur piutang (2026-10-16): usia charge tertua yang belum terbayar.
      // Server hanya mengirim angka untuk pelanggan bersisa > 0.
      const umur = !lunas && r.umur_hari !== null ? r.umur_hari : null;
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
          ${
            umur === null
              ? ''
              : `<div class="cell-sub tabular-nums${umur >= 30 ? ' font-semibold !text-red-600 dark:!text-red-400' : ''}"
                      title="Usia hutang tertua yang belum dibayar (hitung FIFO)">${
                        umur <= 0 ? 'hari ini' : `${umur} hari`
                      }</div>`
          }
        </td>
        <td class="td text-right">${r.terakhir ? esc(waktu(r.terakhir)) : '—'}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            ${
              // Tombol BAYAR per baris (permintaan pemilik 2026-10-04): hanya
              // untuk yang masih berhutang — pelanggan lunas tak punya yang
              // bisa dibayar. Buka modal pembayaran yang sudah terkunci ke
              // pelanggan ini (tanpa dropdown), lengkap dengan sisa hutangnya.
              // Server menjaga `hutang.bayar`, jadi tombolnya ikut disembunyikan.
              lunas || !punyaIzin('hutang.bayar')
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
    ${pagerHtml(state.offset, state.limit, state.count)}
  </div>
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    Saldo dihitung ulang dari mutasi (hutang &minus; bayar), bukan angka tersimpan.
    Angka &ldquo;n hari&rdquo; di bawah Sisa = usia hutang tertua yang belum dibayar
    (dibayar masuk ke yang tertua dulu / FIFO); merah = sudah lewat 30 hari.
    Ikon dompet pada baris = catat pembayaran langsung untuk pelanggan itu;
    ikon nota = rincian ledger + cetak A4.
  </p>`;
}

function paint(): void {
  const totalEl = host?.querySelector('#hutang-total');
  if (totalEl) totalEl.textContent = rp(state.total);
  const countEl = host?.querySelector('#hutang-count span');
  if (countEl) countEl.textContent = `${state.rows.length} pelanggan`;
  // Pengingat umur piutang: chip hanya tampil bila memang ada yang lewat 30 hari.
  const lewatEl = host?.querySelector<HTMLElement>('#hutang-lewat');
  if (lewatEl) {
    lewatEl.hidden = state.lewat30 <= 0;
    const n = lewatEl.querySelector('#hutang-lewat-n');
    if (n) n.textContent = String(state.lewat30);
  }
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

type Toko = {
  store_name: string; store_address: string; store_phone: string; store_email: string;
  invoice_footer?: string;
};

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
        <td class="text-center">${i + 1}</td>
        <td class="nowrap">${escA4(tglLokal(b.created_at))}</td>
        <td>${charge ? 'Hutang' : 'Bayar'}</td>
        <td>${b.note ? escA4(b.note) : '&mdash;'}</td>
        <td class="text-right">${charge ? '+' : '-'} ${rpIdr(b.amount)}</td>
        <td class="text-right">${rpIdr(b.sisa)}</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Rincian hutang — ${escA4(r.customer.name)}</title>
<style>
  @page { size: A4; margin: 1cm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; padding: 0; line-height: 1.4; }
  .container { width: 100%; margin: 0; padding: 0; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
  .nama-toko { font-size: 16px; font-weight: 800; margin-top: 4px; letter-spacing: .2px; }
  .title { font-size: 18px; font-weight: 800; color: #111827; margin: 0; letter-spacing: -.3px; }
  .title-no { font-size: 14px; font-weight: 700; color: #111827; margin-top: 2px; letter-spacing: -.3px; }
  .info-title { font-weight: 700; text-transform: uppercase; border-bottom: 1px solid #333; margin-bottom: 6px; padding-bottom: 3px; font-size: 11px; letter-spacing: .3px; }
  .meta { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 15px; table-layout: fixed; }
  th { text-align: left; padding: 6px 5px; border-bottom: 1.5px solid #333; text-transform: uppercase; font-size: 10px; letter-spacing: .3px; }
  td { padding: 6px 5px; border-bottom: 1px solid #d1d5db; vertical-align: middle; }
  tbody tr:nth-child(even) { background-color: #f9fafb; }
  .text-right { text-align: right; }
  .text-center { text-align: center; }
  .nowrap { white-space: nowrap; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .total-section { margin-left: auto; width: 250px; }
  .total-row { display: flex; justify-content: space-between; padding: 5px 0; font-weight: 700; }
  .grand-total { font-size: 14px; border-top: 2px solid #333; padding-top: 10px; margin-top: 5px; }
  .foot { margin-top: 30px; text-align: center; color: #4b5563; font-size: 10px; border-top: 1px dashed #d1d5db; padding-top: 10px; }
  .foot-line { margin: 4px 0; }
  ${CSS_LOGO_A4}
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="display: flex; gap: 15px; align-items: flex-start;">
        ${logoA4Html()}
        <div>
          <div class="nama-toko">${escA4(toko.store_name || 'Ravaa POS')}</div>
          ${toko.store_address ? `<div class="alamat-toko">${escA4(toko.store_address)}</div>` : ''}
          ${toko.store_phone || toko.store_email
            ? `<div class="baris-kop"><span class="lbl">Telp:</span> ${escA4(toko.store_phone ?? '')}${(toko.store_phone && toko.store_email) ? ' | ' : ''}${escA4(toko.store_email ?? '')}</div>`
            : ''}
        </div>
      </div>
      <div style="text-align: right;">
        <h1 class="title">RINCIAN HUTANG PELANGGAN</h1>
        <div class="title-no">${escA4(r.customer.name)}</div>
      </div>
    </div>

    <div class="meta">
      <div class="info-box" style="width: 48%;">
        <div class="info-title">PELANGGAN</div>
        <div style="font-size: 14px; font-weight: bold;">${escA4(r.customer.name)}</div>
        ${r.customer.phone ? `<div>${escA4(r.customer.phone)}</div>` : ''}
      </div>
      <div class="info-box" style="width: 48%; text-align: right;">
        <div class="info-title">DETAIL TRANSAKSI</div>
        <div>Tanggal cetak: <strong>${escA4(tglCetak)}</strong></div>
        <div>Jumlah mutasi: <strong>${r.rows.length} baris</strong></div>
        <div>Status: <strong>${lunas ? 'LUNAS' : 'BELUM LUNAS'}</strong></div>
      </div>
    </div>

    ${
      r.rows.length === 0
        ? `<div class="info-box" style="width: 50%; font-style: italic; color: #777;">Belum ada catatan hutang untuk pelanggan ini.</div>`
        : `<table class="items">
      <thead>
        <tr>
          <th class="text-center" width="40">#</th>
          <th style="width:132px">Tanggal</th>
          <th style="width:70px">Jenis</th>
          <th>Catatan</th>
          <th class="text-right" width="120">Jumlah</th>
          <th class="text-right" width="120">Sisa</th>
        </tr>
      </thead>
      <tbody>${baris}</tbody>
    </table>`
    }

    <div style="display: flex; justify-content: space-between;">
      <div style="width: 50%;"></div>
      <div class="total-section">
        <div class="total-row"><span>Total dihutang</span><span>${rpIdr(r.charge)}</span></div>
        <div class="total-row"><span>Total dibayar</span><span>${rpIdr(r.bayar)}</span></div>
        <div class="total-row grand-total"><span>${lunas ? 'Sisa (lunas)' : 'Sisa hutang'}</span><span>${rpIdr(Math.max(0, r.sisa))}</span></div>
      </div>
    </div>

    <div class="foot">
      <div class="foot-line">Dicetak melalui Ravaa POS pada: ${escA4(tglCetak)}</div>
      ${footerDokumenA4(toko) ? `<div class="foot-line">${escA4(footerDokumenA4(toko))}</div>` : ''}
    </div>
  </div>
  <script>
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`;
}

async function cetakHutangA4(customerId: number): Promise<void> {
  // Tab dibuka SINKRON sebelum fetch — lihat `bukaTabCetak()` di invoice.ts.
  const w = bukaTabCetak(
    'popup diblokir browser — izinkan popup untuk mencetak A4',
    'Menyiapkan rincian hutang…',
  );
  let rincian: { data: Rincian };
  let set: { data: Toko };
  try {
    [rincian, set] = await Promise.all([
      apiGet<{ data: Rincian }>(`/api/customer-debts/${customerId}`),
      apiGet<{ data: Toko }>('/api/settings'),
    ]);
  } catch (e) {
    try { w.close(); } catch { /* sudah tertutup */ }
    throw e;
  }
  if (w.closed) return;
  const tglCetak = tglLengkap(new Date().toISOString());
  const html = htmlHutangA4(rincian.data, set.data, tglCetak);
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* ---------- BUKTI PEMBAYARAN (Paket A, 2026-10-20) ----------
   Setelah pembayaran hutang sukses, kasir ditawari [Thermal] [A4] [Batal]
   (pola dialog resume POS). Isi dibangun dari LEDGER SEGAR: baris pembayaran
   membawa `sisa` berjalan setelah mutasi, jadi `sisa sebelum = sisa + amount`.
   Thermal lewat print-agent (jeda cetak tetap menghormati getPrintPause) dan
   A4 lewat browser print + helper logo/footer bersama invoice.ts. Cetak gagal
   TIDAK pernah membatalkan pembayaran yang sudah tersimpan. */

function sisaSebelumBaris(b: Baris): number {
  return Math.max(0, b.sisa + b.amount);
}

function waktuCetakLokal(): string {
  return tglLengkap(new Date().toISOString());
}

function strukBuktiPembayaran(r: Rincian, b: Baris): Struk {
  const sebelum = sisaSebelumBaris(b);
  const sesudah = Math.max(0, b.sisa);
  const kasir = (b.cashier ?? '').trim() || '—';
  const shift = b.shift_id ? `Shift #${b.shift_id}` : 'Shift: di luar shift';
  const kaki: string[] = [];
  if (b.note.trim()) kaki.push(`Catatan: ${b.note.trim()}`);
  const footer = footerStruk();
  if (footer) kaki.push(footer);
  return {
    judul: getToko() || 'RAVA POS',
    subjudul: 'BUKTI PEMBAYARAN HUTANG',
    meta: [
      `Pelanggan: ${r.customer.name}`,
      ...(r.customer.phone ? [`Telp: ${r.customer.phone}`] : []),
      `Tanggal: ${tglLokal(b.created_at)}`,
      `Kasir: ${kasir}`,
      shift,
    ],
    items: [],
    baris: [
      { kiri: 'Jumlah dibayar', kanan: rp(b.amount) },
      { kiri: 'Sisa sebelum', kanan: rp(sebelum) },
      { kiri: 'Sisa setelah', kanan: sesudah > 0 ? rp(sesudah) : 'LUNAS', tebal: true },
    ],
    kaki,
  };
}

/** Dokumen A4 bukti pembayaran. Gaya mengikuti dokumen A4 lain (kop toko +
 *  logo kanan-atas + footer server); ringkas berupa tabel garis-bawah saja,
 *  bukan kotak. */
function htmlBuktiPembayaranA4(r: Rincian, b: Baris, toko: Toko, tglCetak: string): string {
  const sebelum = sisaSebelumBaris(b);
  const sesudah = Math.max(0, b.sisa);
  const lunas = sesudah <= 0;
  const kasir = (b.cashier ?? '').trim() || '—';
  const shift = b.shift_id ? `#${b.shift_id}` : 'di luar shift';
  const footer = footerDokumenA4(toko);
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Bukti pembayaran — ${escA4(r.customer.name)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 14mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 0; line-height: 1.45;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .kop { display: flex; justify-content: space-between; align-items: flex-start; }
  .judul { font-size: 15px; font-weight: 700; letter-spacing: .3px; }
  .nama-toko { font-size: 13px; font-weight: 700; margin-top: 4px; }
  .alamat { margin-top: 4px; max-width: 60%; }
  .baris-kop { margin-top: 2px; }
  .baris-kop .lbl { font-weight: 700; }
  ${CSS_LOGO_A4}
  hr { border: 0; border-top: 1px solid #444; margin: 12px 0; }
  .meta { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
  .meta .ttl { font-weight: 700; margin-bottom: 4px; }
  .meta .kanan .baris { display: flex; }
  .meta .kanan .lbl { width: 82px; }
  .hero { border-top: 1px solid #444; border-bottom: 1px solid #444; padding: 12px 4px;
          display: flex; justify-content: space-between; align-items: baseline; }
  .hero .lbl { font-weight: 700; font-size: 12px; }
  .hero .nominal { font-size: 22px; font-weight: 700; }
  table.ringkas { width: 58%; margin-left: auto; margin-top: 14px; border-collapse: collapse; }
  table.ringkas td { padding: 5px 9px; border-bottom: 1px solid #999; }
  table.ringkas td:first-child { font-weight: 700; }
  table.ringkas td.r { text-align: right; white-space: nowrap; }
  table.ringkas tr:nth-child(even) td { background: #f3f3f3; }
  table.ringkas tr:last-child td { border-bottom: 1px solid #444; font-weight: 700; }
  .status { display: inline-block; margin-top: 14px; padding: 2px 8px; border: 1px solid #444;
            font-weight: 700; font-size: 10px; }
  .catatan { margin-top: 14px; padding-top: 8px; border-top: 1px dashed #bbb; }
  .catatan .lbl { font-weight: 700; }
  .foot { margin-top: 34px; font-size: 9px; color: #4b5563; border-top: 1px dashed #d1d5db; padding-top: 8px; }
  .foot-line { margin: 3px 0; }
</style>
</head>
<body>
  <div class="kop">
    <div>
      <div class="judul">BUKTI PEMBAYARAN HUTANG</div>
      <div class="nama-toko">${escA4(toko.store_name || 'RAVA POS')}</div>
      ${toko.store_address ? `<div class="alamat">${escA4(toko.store_address)}</div>` : ''}
      ${toko.store_phone ? `<div class="baris-kop"><span class="lbl">Phone:</span> ${escA4(toko.store_phone)}</div>` : ''}
      ${toko.store_email ? `<div class="baris-kop"><span class="lbl">Email:</span> ${escA4(toko.store_email)}</div>` : ''}
    </div>
    ${logoA4Html()}
  </div>
  <hr>
  <div class="meta">
    <div>
      <div class="ttl">Pelanggan</div>
      <div>${escA4(r.customer.name)}</div>
      ${r.customer.phone ? `<div>${escA4(r.customer.phone)}</div>` : ''}
    </div>
    <div class="kanan">
      <div class="baris"><span class="lbl">No. bukti:</span><span>#${b.id}</span></div>
      <div class="baris"><span class="lbl">Tanggal:</span><span>${escA4(tglLokal(b.created_at))}</span></div>
      <div class="baris"><span class="lbl">Kasir:</span><span>${escA4(kasir)}</span></div>
      <div class="baris"><span class="lbl">Shift:</span><span>${escA4(shift)}</span></div>
      <div class="baris"><span class="lbl">Dicetak:</span><span>${escA4(tglCetak)}</span></div>
    </div>
  </div>
  <div class="hero">
    <span class="lbl">Jumlah dibayar</span>
    <span class="nominal">${rp(b.amount)}</span>
  </div>
  <table class="ringkas">
    <tbody>
      <tr><td>Sisa sebelum</td><td class="r">${rp(sebelum)}</td></tr>
      <tr><td>${lunas ? 'Sisa setelah (lunas)' : 'Sisa setelah'}</td><td class="r">${rp(sesudah)}</td></tr>
    </tbody>
  </table>
  <div class="status">${lunas ? 'LUNAS' : 'BELUM LUNAS'}</div>
  ${b.note.trim() ? `<div class="catatan"><span class="lbl">Catatan:</span> ${escA4(b.note.trim())}</div>` : ''}
  <div class="foot">
    <div class="foot-line">Dicetak melalui Ravaa POS pada: ${escA4(tglCetak)}</div>
    ${footer ? `<div class="foot-line">${escA4(footer)}</div>` : ''}
  </div>
  <script>
    // Cetak otomatis saat dokumen siap (pola invoice.ts); tab tidak ditutup
    // supaya kasir bisa mencetak ulang.
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`;
}

/** Tawarkan cetak bukti SETELAH pembayaran tersimpan. Tidak pernah melempar:
 *  kegagalan muat/cetak hanya toast, karena uang sudah tercatat. */
async function tawarkanBuktiPembayaran(awal: Baris, customerId: number, nama: string): Promise<void> {
  let r: Rincian;
  let toko: Toko;
  try {
    const [rr, ss] = await Promise.all([
      apiGet<{ data: Rincian }>(`/api/customer-debts/${customerId}`),
      apiGet<{ data: Toko }>('/api/settings'),
    ]);
    r = rr.data;
    toko = ss.data;
    // Nama toko + footer thermal mengikuti server (satu sumber dengan struk POS).
    syncDariServerSettings(ss.data);
  } catch (e) {
    toast(`Pembayaran tersimpan, tetapi bukti tidak bisa dimuat: ${errMsg(e)}`, 'warning');
    return;
  }
  // Ledger segar adalah sumber utama; `awal` (respons POST) tidak membawa
  // `sisa` komputasi, jadi jaring terakhir memakai saldo ledger saat ini —
  // pembayaran yang baru dibuat adalah mutasi terakhir pada alur normal.
  const b = r.rows.find((x) => x.id === awal.id)
    ?? { ...awal, sisa: Math.max(0, r.sisa) };
  const sesudah = Math.max(0, b.sisa);
  const pilihan = await choiceDialog({
    title: 'Pembayaran hutang tercatat',
    html: `
      <div style="text-align:left;font-size:13px;line-height:1.55">
        <div style="font-weight:600">${esc(nama || r.customer.name)}</div>
        <div style="display:flex;justify-content:space-between;gap:12px;margin-top:6px">
          <span>Dibayar</span><b>${rp(b.amount)}</b>
        </div>
        <div style="display:flex;justify-content:space-between;gap:12px">
          <span>Sisa setelah</span><b>${sesudah > 0 ? rp(sesudah) : 'LUNAS'}</b>
        </div>
        <div style="margin-top:8px;color:#6b7280">
          ${esc(tglLokal(b.created_at))} &middot; ${b.shift_id ? `Shift #${b.shift_id}` : 'di luar shift'}
        </div>
        <div style="margin-top:10px">Cetak bukti pembayaran?</div>
      </div>`,
    icon: 'success',
    choices: [
      { key: 'thermal', label: 'Thermal' },
      { key: 'a4', label: 'A4' },
    ],
    cancelLabel: 'Batal',
  });
  if (!pilihan) return;
  if (pilihan === 'thermal') {
    try {
      await kirimPrint(await strukUntukTercetak(strukBuktiPembayaran(r, b), 'thermal'));
      toast('Bukti pembayaran dikirim ke printer thermal', 'success');
    } catch (e) {
      toast(`Gagal cetak bukti: ${errMsg(e)}`, 'error');
    }
    return;
  }
  if (pilihan === 'a4') {
    try {
      const w = window.open('', '_blank');
      if (!w) throw new Error('popup diblokir browser — izinkan popup untuk mencetak A4');
      w.document.open();
      w.document.write(htmlBuktiPembayaranA4(r, b, toko, waktuCetakLokal()));
      w.document.close();
    } catch (e) {
      toast(`Gagal cetak A4: ${errMsg(e)}`, 'error');
    }
  }
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
              <td class="td whitespace-nowrap">${esc(waktu(b.created_at))}
                <div class="cell-sub">${b.shift_id ? `Shift #${b.shift_id}` : 'di luar shift'} · ${esc((b.cashier ?? '').trim() || '—')}</div>
              </td>
              <td class="td">${
                charge
                  ? `<span class="chip !border-red-500/40 !text-red-700 dark:!text-red-400">${icon('plus')}<span>Hutang</span></span>`
                  : `<span class="chip !border-emerald-500/40 !text-emerald-700 dark:!text-emerald-400">${icon('check')}<span>Bayar</span></span>`
              }</td>
              <td class="td">${b.note ? esc(b.note) : '<span class="text-gray-400">—</span>'}</td>
              <td class="td text-right tabular-nums ${charge ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}">${charge ? '+' : '−'}${rp(b.amount)}</td>
              <td class="td text-right font-semibold tabular-nums">${rp(b.sisa)}</td>
              <td class="td text-right">
                ${punyaIzin('hutang.hapus') ? `<button type="button" data-del-baris="${b.id}" class="row-btn row-btn-danger" title="Hapus catatan ini" aria-label="Hapus catatan">${icon('trash')}</button>` : ''}
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
        if (!punyaIzin('hutang.hapus')) {
          toast('Butuh izin Hapus catatan hutang', 'warning');
          return;
        }
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
  // Server menjaga `hutang.catat` / `hutang.bayar` (dua izin terpisah), jadi
  // modalnya pun tidak boleh terbuka untuk yang tidak berhak.
  if (jenis === 'charge' && !punyaIzin('hutang.catat')) {
    toast('Butuh izin Catat hutang', 'warning');
    return;
  }
  if (jenis === 'payment' && !punyaIzin('hutang.bayar')) {
    toast('Butuh izin Bayar hutang', 'warning');
    return;
  }
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
          // Atribusi laci (Paket A, 2026-10-20): shift bisa dibuka/ditutup
          // sejak halaman dimuat, jadi tanya server tepat sebelum menulis.
          // Gagal bertanya = NULL (di luar shift), bukan alasan menolak
          // mencatat uang yang sudah diterima kasir.
          await loadShift();
          const resp = await apiPost<{ data: Baris }>('/api/customer-debts', {
            customer_id: customerId,
            type: jenis,
            amount: v,
            note: (el.querySelector('#h-note') as HTMLInputElement).value.trim(),
            cashier: getCashier(),
            shift_id: state.shiftId,
          });
          close();
          const nama = prefill ? prefill.name : (pelanggan.find((c) => c.id === customerId)?.name ?? '');
          toast(hutang ? `Hutang ${rp(v)} untuk "${nama}" dicatat` : `Pembayaran ${rp(v)} dari "${nama}" dicatat`, 'success');
          await load();
          // Bukti hanya untuk PEMBAYARAN (charge = tidak ada uang diterima).
          // Gagal tawaran/cetak tidak pernah membatalkan mutasi yang sudah
          // tersimpan — semua kegagalan berhenti sebagai toast.
          if (!hutang) {
            try {
              await tawarkanBuktiPembayaran(resp.data, customerId, nama);
            } catch (e) {
              toast(`Pembayaran tersimpan, tetapi bukti gagal disiapkan: ${errMsg(e)}`, 'warning');
            }
          }
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
  bindPager(host!, (o) => {
    state.offset = o;
    void load();
  });
  bindPagerLimit(host!, (v) => {
    state.limit = v;
    state.offset = 0;
    void load();
  });
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
    const r = await apiGet<{ data: Ringkasan[]; total: number; count: number; lewat30: number }>(
      `/api/customer-debts?status=${state.status}&limit=${state.limit}&offset=${state.offset}`,
    );
    state.rows = r.data;
    state.total = r.total;
    state.count = r.count ?? r.data.length;
    state.lewat30 = r.lewat30 ?? 0;
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
  // Alt+N = pintasan tombol "Catat hutang" (ui/aksi-baru.ts). Hanya didaftarkan
  // bila izinnya ada — pintasan tidak boleh menabrak 403 server.
  if (punyaIzin('hutang.catat')) pasangAksiBaru(() => void catatForm('charge'));
  el.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = b.dataset.status === 'semua' ? 'semua' : 'open';
      if (s === state.status) return;
      state.status = s;
      state.offset = 0;
      void load();
    }),
  );
  // Daftar + shift terbuka paralel: shift dipakai saat pembayaran dikirim,
  // bukan untuk render, jadi tidak boleh menahan tampilan tabel.
  await Promise.all([loadShift(), load()]);
}
