// INVOICE A4 gaya Aronium — layout meniru cetak invoice Aronium (contoh
// pemilik: 23-200-000036.pdf) dengan template RPOS `print_a4.blade.php` sebagai
// rujukan implementasi. Dicetak lewat window.print() browser (Chrome -> CUPS ->
// printer A4, contoh: Epson L3110), BUKAN lewat print-agent: agent menulis byte
// mentah ke device dan WAJIB tetap nol-dependensi — tidak bisa merender HTML.
//
// Struk THERMAL tetap lewat print-agent (ESC/POS 32 kolom). Pemilihan terjadi
// lewat dialog choiceDialog "Cetak struk?" [Thermal] [A4] [Tidak] setelah
// transaksi (pos.ts) dan tombol Cetak ulang di halaman Riwayat.

import { apiGet } from './api';

/** Dokumen laporan generik (menu Laporan ala Aronium, 2026-10-11): satu
 *  builder untuk semua menu — judul + periode + tabel + ringkasan. `baris`
 *  = sel SELALU string (pemanggil memformat Rp/tanggal dulu); `ringkas` =
 *  pasangan [label, nilai] di kotak kanan. */
export interface DokLaporan {
  judul: string;
  periode: string;
  meta: [string, string][];
  kolom: { label: string; kanan?: boolean; tengah?: boolean }[];
  baris: string[][];
  ringkas: [string, string][];
  catatan?: string;
  /** Seksi tabel TAMBAHAN setelah tabel utama — dipakai menu Analitik
   *  (valuasi + tidak laku dalam SATU dokumen cetak). Opsional: pemanggil
   *  lama tanpa `bagian` menghasilkan HTML yang persis sama. */
  bagian?: {
    judul: string;
    kolom: { label: string; kanan?: boolean; tengah?: boolean }[];
    baris: string[][];
    catatan?: string;
  }[];
}

/** URL ABSOLUT slot logo dokumen A4. Popup cetak (`window.open('')` +
 *  `document.write`) ber-`about:blank`, jadi `src` RELATIF tidak akan
 *  teresolusi — origin app ditempel. Endpoint-nya publik (pengecualian
 *  token, AGENTS §3): 200 = gambar, 204 = belum ada logo. */
export function urlLogoA4(): string {
  const o = typeof location !== 'undefined' ? location.origin : '';
  return `${o}/api/settings/logo`;
}

/** Slot logo kanan-atas SEMUA dokumen A4 — permintaan pemilik 19 Okt 2026:
 *  "logo itu harusnya juga di terapkan pada a4 juga". Dipakai bersama oleh
 *  invoice, laporan, rekap shift (file ini), nota PO (purchases.ts), dan
 *  rincian hutang (debts.ts) supaya kelima dokumen tampil sama. `<img>`
 *  MENIMPA bulatan fallback "R" saat logo toko ada; belum ada logo / gagal
 *  dimuat → `onerror` menyembunyikan img dan bulatan fallback tetap tampil
 *  (hiasan tidak pernah membatalkan cetak). */
export function logoA4Html(): string {
  return `<div class="logo" aria-hidden="true"><span class="logo-fb">R</span><img class="logo-img" src="${urlLogoA4()}" alt="" onerror="this.style.display='none'"></div>`;
}

/** CSS slot logo bersama — disisipkan `${CSS_LOGO_A4}` di <style> tiap
 *  dokumen (menggantikan aturan .logo lama). Img diberi latar putih supaya
 *  logo berlatar transparan tetap menutup bulatan fallback; ukuran 84px
 *  mendekati proporsi logo pada contoh Aronium pemilik (23-200-000036.pdf). */
export const CSS_LOGO_A4 = `.logo { position: relative; width: 84px; height: 84px; flex: none; }
  .logo-fb { position: absolute; inset: 0; border-radius: 50%; background: #4a90d9; color: #fff;
             font-size: 50px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
  .logo-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #fff; }`;

export function htmlLaporan(d: DokLaporan, toko: Toko): string {
  const cls = (k: { kanan?: boolean; tengah?: boolean }) => (k.kanan ? ' class="r"' : k.tengah ? ' class="c"' : '');
  const sel = (v: string, kanan: boolean) =>
    `<td${kanan || /[\d.,]/.test(v.replace(/[^0-9.,]/g, '')) && /[0-9]/.test(v) ? ' class="r"' : ''}>${esc(v)}</td>`;
  const tglCetak = tglLengkap(new Date().toISOString());
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>${esc(d.judul)} — ${esc(d.periode)}</title>
<style>
  @page { size: A4; margin: 1cm; }
  * { box-sizing: border-box; }
  body { font-family: 'Courier New', Courier, monospace; font-size: 11px; color: #333; margin: 0; padding: 0; line-height: 1.2; }
  .container { width: 100%; margin: 0; padding: 0; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
  .logo { font-size: 24px; font-weight: bold; }
  .info-title { font-weight: bold; text-transform: uppercase; border-bottom: 1px solid #333; margin-bottom: 5px; padding-bottom: 2px; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 15px; table-layout: fixed; }
  th { text-align: left; padding: 5px; border-bottom: 1.5px solid #333; text-transform: uppercase; font-size: 10px; }
  td { padding: 5px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tbody tr:nth-child(even) { background-color: #fafafa; }
  .text-right { text-align: right; }
  .text-center { text-align: center; }
  .font-mono { font-family: 'Courier New', Courier, monospace; }
  .total-section { margin-left: auto; width: 250px; }
  .total-row { display: flex; justify-content: space-between; padding: 5px 0; font-weight: bold; }
  .grand-total { font-size: 14px; border-top: 2px solid #333; padding-top: 10px; margin-top: 5px; }
  .signature { display: flex; justify-content: flex-end; margin-top: 50px; }
  .signature-box { text-align: right; }
  .sig-date { font-size: 11px; }
  .sig-label { font-size: 11px; margin-top: 10px; }
  .sig-name { font-size: 11px; font-weight: bold; margin-top: 5px; }
  .foot { margin-top: 30px; text-align: center; color: #aaa; font-size: 10px; border-top: 1px dashed #ddd; padding-top: 10px; }
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
          <div class="nama-toko">${esc(toko.store_name || 'Ravaa POS')}</div>
          ${toko.store_address ? `<div style="font-size: 11px;">${esc(toko.store_address)}</div>` : ''}
          ${toko.store_phone || toko.store_email
            ? `<div style="font-size: 11px;">Telp: ${esc(toko.store_phone ?? '')}${(toko.store_phone && toko.store_email) ? ' | ' : ''}${esc(toko.store_email ?? '')}</div>`
            : ''}
        </div>
      </div>
      <div style="text-align: right;">
        <h1 style="margin: 0; color: #333;">${esc(d.judul)}</h1>
        <div style="font-size: 18px; font-weight: bold;">${esc(d.periode)}</div>
      </div>
    </div>

    <div class="meta">
      <div class="info-box" style="width: 48%;">
        <div class="info-title">PERIODE</div>
        <div style="font-size: 14px; font-weight: bold;">${esc(d.periode)}</div>
      </div>
      <div class="info-box" style="width: 48%; text-align: right;">
        <div class="info-title">DETAIL</div>
        ${d.meta.map(([k, v]) => `<div>${esc(k)}: <strong>${esc(v)}</strong></div>`).join('')}
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          ${d.kolom.map((k) => `<th${cls(k)}>${esc(k.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${d.baris.map((r) => `<tr>${r.map((v, i) => sel(v, !!d.kolom[i]?.kanan)).join('')}</tr>`).join('')}
      </tbody>
    </table>

    ${(d.bagian ?? [])
      .map(
        (b) => `
      <div style="margin-top: 20px;">
        <div class="info-title" style="font-size: 12px; margin-bottom: 6px;">${esc(b.judul)}</div>
        <table class="items">
          <thead>
            <tr>
              ${b.kolom.map((k) => `<th${cls(k)}>${esc(k.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${b.baris.map((r) => `<tr>${r.map((v, i) => sel(v, !!b.kolom[i]?.kanan)).join('')}</tr>`).join('')}
          </tbody>
        </table>
        ${b.catatan ? `<div style="margin-top: 8px; font-size: 10px; color: #555; font-style: italic;">${esc(b.catatan)}</div>` : ''}
      </div>`,
      )
      .join('')}

    ${d.ringkas.length ? `
    <div style="display: flex; justify-content: space-between;">
      <div style="width: 50%;"></div>
      <div class="total-section">
        ${d.ringkas.map(([k, v]) => `<div class="total-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}
      </div>
    </div>` : ''}

    ${d.catatan ? `<div style="margin-top: 20px; font-size: 10px; color: #555; font-style: italic;">${esc(d.catatan)}</div>` : ''}

    <div class="foot">
      ${footerDokumenA4(toko) ? `<div class="foot-line">${esc(footerDokumenA4(toko))}</div>` : ''}
    </div>
  </div>
  <script>
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`;
}

export function cityToko(toko: Toko): string {
  return toko.store_address ? String(toko.store_address).split(',')[0].trim() : 'Nganjuk';
}

/** Buka tab dokumen laporan dan cetak (window.print() — simpan sebagai PDF
 *  dari dialog browser). Kop diambil dari server; popup diblokir = Error
 *  (pemanggil toast saja, pola cetakInvoice). */
export async function cetakLaporan(dok: DokLaporan): Promise<void> {
  const set = await apiGet<{ data: Toko }>('/api/settings');
  const w = window.open('', '_blank');
  if (!w) throw new Error('popup diblokir browser — izinkan popup untuk mencetak laporan');
  w.document.open();
  w.document.write(htmlLaporan(dok, set.data));
  w.document.close();
}

/** Baris sale_items dari GET /api/sales/:id (kolom yang relevan utk invoice). */
export interface ItemNota {
  name: string; sku: string; qty: number; price: number; amount: number;
  discount: number; unit: string; base_unit: string | null; note: string;
}
/** sales row dari GET /api/sales/:id (SELECT * — memuat invoice_no). */
export interface SaleNota {
  id: string; invoice_no: string | null; created_at: string;
  pay_method: string; subtotal: number; discount: number; total: number;
  cash_in: number; change: number; cashier: string; shift_id: number | null;
  /** Pelanggan pada transaksi (SNAPSHOT dari server, sejak 2026-10-04).
   *  '' / absen = baris lama tanpa kontak -> "Pelanggan Umum". */
  customer_name?: string | null;
  /** id pelanggan (server, `s.*`) — kunci ambil sisa piutang ledger;
   *  null = baris lama tanpa kontak -> tanpa baris sisa hutang. */
  customer_id?: number | null;
  /** Kontak LIVE pelanggan (sejak 2026-10-20, LEFT JOIN customers) untuk
   *  cetak detail pelanggan di invoice A4. Null bila tanpa pelanggan atau
   *  pelanggan sudah dihapus. */
  customer_phone?: string | null;
  customer_address?: string | null;
  /** Catatan transaksi tingkat nota (sales.note, sejak 2026-10-10). */
  note?: string | null;
  /** Penanda nota berhutang (computed server, `sisa_hutang` putaran 13) —
   *  kas sisa nota INI (tunai + kurang + pelanggan valid). 0 = lunas. */
  sisa_hutang?: number;
}
export interface Toko {
  store_name: string; store_address: string;
  store_phone: string; store_email: string;
  /** Opsi dokumen server (GET /api/settings, 2026-10-20). Opsional supaya
   *  pemanggil/test lama yang hanya mengirim empat kolom store_* tetap
   *  mencetak teks lama. String kosong = footer/judul memang disembunyikan. */
  invoice_title?: string;
  invoice_footer?: string;
}

/** Footer dokumen A4 dari pengaturan server; `undefined` (data lama/test) =
 *  teks lama, `''` = pemilik mengosongkan footernya. */
export function footerDokumenA4(toko: { invoice_footer?: string }): string {
  return toko.invoice_footer ?? '';
}

/** Judul invoice A4 (default lama INVOICE). */
export function judulInvoiceA4(toko: { invoice_title?: string }): string {
  return toko.invoice_title ?? 'INVOICE';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Angka gaya Aronium: `470,000.00` / `Rp376,000.00` (titik-ribuan, koma desimal). */
function num(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function rpNum(n: number): string {
  return `Rp${num(n)}`;
}

/** Tanggal gaya Aronium `M/D/YYYY` + jam lokal — created_at selalu UTC (Z). */
function tglAronium(createdAt: string): string {
  const t = /[Zz]$|[+-]\d{2}:\d{2}$/.test(createdAt) || createdAt.includes('T')
    ? createdAt
    : `${createdAt.replace(' ', 'T')}Z`;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const LABEL_METODE: Record<string, string> = {
  tunai: 'TUNAI', qris: 'QRIS', transfer: 'TRANSFER',
};

/** Seluruh isi invoice jadi satu string HTML (A4, print-only).
 *
 * `piutang` (opsional, putaran 14 2026-10-06) = sisa ledger HALAMAN HUTANG
 * milik pelanggan nota ini (`GET /api/customer-debts/:customerId` -> `sisa`)
 * — ditampilkan sebagai baris "Sisa hutang (semua nota)" bila > 0 DAN berbeda
 * dari hutang nota ini. Nota berhutang sendiri memakai snapshot
 * `sale.sisa_hutang` (deterministik, ikut walau ledger gagal dimuat).
 * `payments` (opsional, split 1.6.5 2026-10-19) = baris ATRIBUSI per metode
 * (`GET /api/sales/:id` -> `payments`): >1 baris = rincian Payment method
 * ditulis per metode (tunai = uang diserahkan, non-tunai = porsi). Absen /
 * ≤1 baris = keluaran invoice PERSIS seperti sebelum fitur. */
/** Angka gaya Indonesia: `Rp 20.000` (titik ribuan, tanpa desimal). */
export function rpIdr(n: number): string {
  return `Rp ${n.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
}

/** Tanggal gaya Indonesia `d F Y H:i` (Contoh: 10 Juli 2026 21:48). */
export function tglId(createdAt: string): string {
  const t = /[Zz]$|[+-]\d{2}:\d{2}$/.test(createdAt) || createdAt.includes('T')
    ? createdAt
    : `${createdAt.replace(' ', 'T')}Z`;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const bulan = ['Januari','Februari','Maret','April','Mei','Juni',
    'Juli','Agustus','September','Oktober','November','Desember'];
  return `${d.getDate()} ${bulan[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Cetak tanggal `d F Y` untuk tanda tangan. */
export function tglSingkat(iso: string): string {
  const t = /[Zz]$|[+-]\d{2}:\d{2}$/.test(iso) || iso.includes('T')
    ? iso
    : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const bulan = ['Januari','Februari','Maret','April','Mei','Juni',
    'Juli','Agustus','September','Oktober','November','Desember'];
  return `${d.getDate()} ${bulan[d.getMonth()]} ${d.getFullYear()}`;
}

/** Cetak tanggal lengkap `d F Y H:i:s` untuk footer. */
export function tglLengkap(iso: string): string {
  const t = /[Zz]$|[+-]\d{2}:\d{2}$/.test(iso) || iso.includes('T')
    ? iso
    : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const bulan = ['Januari','Februari','Maret','April','Mei','Juni',
    'Juli','Agustus','September','Oktober','November','Desember'];
  return `${d.getDate()} ${bulan[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function htmlInvoice(sale: SaleNota, items: ItemNota[], toko: Toko, piutang = 0, payments: { method: string; amount: number }[] = []): string {
  // Diskon agregat = diskon transaksi + seluruh diskon per baris (persis rumus
  // laporan: sales.diskon).
  const discItem = items.reduce((a, i) => a + (i.discount || 0), 0);
  const discTotal = Math.max(0, sale.discount) + discItem;
  // Split payment (1.6.5): >1 baris `payments` = nota dibayar dua metode.
  const split = payments.length > 1 ? payments : [];
  const labelM = (m: string) => (m === 'tunai' ? 'TUNAI' : (LABEL_METODE[m] ?? m.toUpperCase()));
  const sisaNota = sale.sisa_hutang ?? 0;
  const paid = split.length ? sale.total - sisaNota : sale.pay_method === 'tunai' ? sale.cash_in : sale.total;
  const tampilKembalian = split.length ? split.some((p) => p.method === 'tunai') : sale.pay_method === 'tunai';

  const barisItem = items.map((it, i) => {
    const qtyTampil = it.unit && it.base_unit && it.unit !== it.base_unit
      ? `${it.qty} ${it.unit}`
      : `${it.qty}`;
    const utama = `<tr>
      <td class="c">${i + 1}</td>
      <td><strong>${esc(it.name)}</strong></td>
      <td class="font-mono">${esc(it.sku ?? '')}</td>
      <td class="text-center">${Number(it.qty)}</td>
      <td class="text-right">Rp ${Number(it.price).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</td>
      <td class="text-right">Rp ${Number(it.discount || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</td>
      <td class="text-right">Rp ${Number(it.amount).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</td>
    </tr>`;
    // Catatan per baris (sale_items.note) — pola print_a4.blade.php RPOS:
    // baris mungil italic di bawah itemnya, colspan penuh.
    const catatan = it.note?.trim()
      ? `<tr>
          <td colspan="7" style="font-size: 10px; color: #666; padding: 0 5px 5px 55px; border: none;">
            <em>* ${esc(it.note.trim())}</em>
          </td>
        </tr>`
      : '';
    return utama + catatan;
  }).join('');

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Invoice ${esc(sale.invoice_no ?? sale.id.slice(0, 8))}</title>
<style>
  @page { size: A4; margin: 1cm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; padding: 0; line-height: 1.4; }
  .container { width: 100%; margin: 0; padding: 0; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
  .nama-toko { font-size: 16px; font-weight: 800; margin-top: 4px; letter-spacing: .2px; }
  .alamat-toko { font-size: 11px; color: #374151; margin-top: 2px; }
  .baris-kop { display: flex; margin-top: 2px; font-size: 11px; color: #374151; }
  .baris-kop .lbl { width: 72px; font-weight: 700; }
  .title { font-size: 26px; font-weight: 900; color: #111827; margin: 0; letter-spacing: -.5px; }
  .title-no { font-size: 20px; font-weight: 700; color: #111827; margin-top: 2px; letter-spacing: -.5px; }
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
          <div class="nama-toko">${esc(toko.store_name || 'Ravaa POS')}</div>
          ${toko.store_address ? `<div style="font-size: 11px;">${esc(toko.store_address)}</div>` : ''}
          ${toko.store_phone || toko.store_email
            ? `<div style="font-size: 11px;">Telp: ${esc(toko.store_phone ?? '')}${(toko.store_phone && toko.store_email) ? ' | ' : ''}${esc(toko.store_email ?? '')}</div>`
            : ''}
        </div>
      </div>
      <div style="text-align: right;">
        <h1 style="margin: 0; color: #333;">INVOICE</h1>
        <div style="font-size: 18px; font-weight: bold;">#${esc(sale.invoice_no ?? '—')}</div>
      </div>
    </div>

    <div class="info">
      <div class="info-box">
        <div class="info-title">PELANGGAN</div>
        <div style="font-size: 14px; font-weight: bold;">${esc((sale.customer_name ?? '').trim() || 'Walk-In Customer')}</div>
        <div>${esc(sale.customer_phone ?? '-')}</div>
        <div>${esc(sale.customer_address ?? '-')}</div>
      </div>
      <div class="info-box" style="text-align: right;">
        <div class="info-title">DETAIL TRANSAKSI</div>
        <div>Tanggal: <strong>${tglId(sale.created_at)}</strong></div>
        <div>Metode Bayar: <strong>${labelM(sale.pay_method)}</strong></div>
        <div>Kasir: <strong>${esc(sale.cashier)}</strong></div>
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th class="text-center" width="40">NO</th>
          <th>NAMA PRODUK</th>
          <th>SKU</th>
          <th class="text-center" width="60">QTY</th>
          <th class="text-right" width="100">HARGA</th>
          <th class="text-right" width="100">DISC</th>
          <th class="text-right" width="120">SUBTOTAL</th>
        </tr>
      </thead>
      <tbody>${barisItem}</tbody>
    </table>

    <div style="display: flex; justify-content: space-between;">
      <div class="info-box" style="width: 50%;">
        <div class="info-title">CATATAN</div>
        <p style="font-style: italic;">${esc(sale.note ?? '-')}</p>
      </div>
      <div class="total-section">
        <div class="total-row"><span>Subtotal</span><span>Rp ${Number(sale.subtotal).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span></div>
        ${discTotal > 0 ? `<div class="total-row"><span>Diskon</span><span>-Rp ${Number(discTotal).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span></div>` : ''}
        <div class="total-row grand-total"><span>TOTAL</span><span>Rp ${Number(sale.total).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span></div>
        <div class="total-row" style="margin-top: 10px; border-top: 1px dashed #ddd; padding-top: 5px;"><span>Dibayar</span><span>Rp ${Number(paid).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span></div>
        <div class="total-row"><span>Kembali</span><span>Rp ${Number(sale.change).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span></div>
        <div class="total-row"><span>Status pembayaran</span><span>${sisaNota > 0 ? 'Belum lunas' : 'Lunas'}</span></div>
        ${sisaNota > 0 ? `<div class="total-row"><span>Hutang</span><span>Rp ${Number(sisaNota).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span></div>` : ''}
      </div>
    </div>

    <div class="foot">
      ${footerDokumenA4(toko) ? `<div class="foot-line">${esc(footerDokumenA4(toko))}</div>` : ''}
    </div>
  </div>
  <script>
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`;
}

/** Baris shift untuk rekap cetak (kontrak GET /api/shifts + agregat Z-report —
 *  `import type` dari shift-tutup agar satu sumber, tanpa runtime cycle). */
import type { ShiftRow } from './pages/shift-tutup';

/** Tanggal lokal `D/M/YYYY HH:MM` untuk rekap (pola tglAronium di atas). */
function tglRekap(iso: string | null): string {
  if (!iso) return '—';
  const t = /[Zz]$|[+-]\d{2}:\d{2}$/.test(iso) || iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Rekap tutup shift ala Z-report Aronium (2026-10-11) — dokumen A4 mandiri
 *  (CSS inline sendiri, kelas meniru invoice di atas: kop/meta/table/ringkas).
 *  `fisik` = modal akhir hitung kasir; null = sementara (X, tanpa fisik &
 *  selisih). Kas seharusnya dihitung ulang di sini? TIDAK — pemanggil
 *  mengirim angka final? Kontrak: fungsi ini MENGHITUNG dari baris (rumus
 *  kasSeharusnya ada di shift-tutup, tak diimpor agar invoice.ts tetap
 *  mandiri): modal + (omzet − hutang − omzet nota pesanan) + uang pesanan
 *  masuk + topup + piutang + kas masuk (1.6.2, 2026-10-19) − expense − retur
 *  − purchase. Pesanan jasa (1.6.6, 2026-10-19): nota take ikut terhitung di
 *  `omzet` padahal uangnya lewat `order_masuk_total` — dikurangkan di sini.
 *  Rumus ditulis SEKALI di sini + SEKALI di kasSeharusnya — duplikasi
 *  disengaja & ditandai; bila rumus berubah, ubah keduanya (dicek test
 *  rekap: angka PDF = angka dialog). */
export function htmlRekapShift(s: ShiftRow, toko: Toko, fisik: number | null): string {
  const orderOmzet = s.order_omzet_total ?? 0;
  const kasHarus = s.modal_awal + (s.omzet - (s.hutang_baru ?? 0) - orderOmzet)
    + (s.order_masuk_total ?? 0) + s.topup_nominal + s.topup_admin + (s.piutang_bayar ?? 0)
    + (s.kas_masuk_total ?? 0)
    - (s.expense_total ?? 0) - (s.retur_total ?? 0) - (s.purchase_total ?? 0);
  const d = fisik !== null ? fisik - kasHarus : null;
  const nota = s.inv_awal && s.inv_akhir ? `${s.inv_awal} – ${s.inv_akhir}` : 'Tanpa penjualan';
  const rpIdr = (n: number) => `Rp ${n.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
  const tglCetak = tglLengkap(new Date().toISOString());
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Rekap Shift #\${s.id}</title>
<style>
  @page { size: A4; margin: 1cm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; padding: 0; line-height: 1.4; }
  .container { width: 100%; margin: 0; padding: 0; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
  .nama-toko { font-size: 16px; font-weight: 800; margin-top: 4px; letter-spacing: .2px; }
  .alamat-toko { font-size: 11px; color: #374151; margin-top: 2px; }
  .baris-kop { display: flex; margin-top: 2px; font-size: 11px; color: #374151; }
  .baris-kop .lbl { width: 72px; font-weight: 700; }
  .title { font-size: 26px; font-weight: 900; color: #111827; margin: 0; letter-spacing: -.5px; }
  .title-no { font-size: 20px; font-weight: 700; color: #111827; margin-top: 2px; letter-spacing: -.5px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 15px; table-layout: fixed; }
  th { text-align: left; padding: 5px; border-bottom: 1.5px solid #333; text-transform: uppercase; font-size: 10px; }
  td { padding: 5px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tbody tr:nth-child(even) { background-color: #fafafa; }
  .text-right { text-align: right; }
  .text-center { text-align: center; }
  .font-mono { font-family: 'Courier New', Courier, monospace; }
  .total-section { margin-left: auto; width: 250px; }
  .total-row { display: flex; justify-content: space-between; padding: 5px 0; font-weight: bold; }
  .grand-total { font-size: 14px; border-top: 2px solid #333; padding-top: 10px; margin-top: 5px; }
  .foot { margin-top: 30px; text-align: center; color: #aaa; font-size: 10px; border-top: 1px dashed #ddd; padding-top: 10px; }
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
          <div class="nama-toko">${esc(toko.store_name || 'Ravaa POS')}</div>
          ${toko.store_address ? `<div style="font-size: 11px;">\${esc(toko.store_address)}</div>` : ''}
          ${toko.store_phone || toko.store_email
            ? `<div style="font-size: 11px;">Telp: \${esc(toko.store_phone ?? '')}\${(toko.store_phone && toko.store_email) ? ' | ' : ''}\${esc(toko.store_email ?? '')}</div>`
            : ''}
        </div>
      </div>
      <div style="text-align: right;">
        <h1 style="margin: 0; color: #333;">REKAP TUTUP SHIFT</h1>
        <div style="font-size: 18px; font-weight: bold;">#\${s.id}</div>
      </div>
    </div>

    <div class="meta">
      <div class="info-box" style="width: 48%;">
        <div class="info-title">SHIFT</div>
        <div style="font-size: 14px; font-weight: bold;">#\${s.id} · ${esc(s.cashier)}</div>
      </div>
      <div class="info-box" style="width: 48%; text-align: right;">
        <div class="info-title">DETAIL</div>
        <div>Buka: <strong>\${tglRekap(s.opened_at)}</strong></div>
        <div>Tutup: <strong>\${tglRekap(s.closed_at)}</strong></div>
        <div>Nota: <strong>\${esc(nota)}</strong></div>
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th>Uraian</th>
          <th class="text-right" width="150">Nilai</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>Modal awal</td><td class="text-right">\${rpIdr(s.modal_awal)}</td></tr>
        <tr><td>Penjualan (\${s.n_sales} nota)</td><td class="text-right">\${rpIdr(s.omzet)}</td></tr>
        <tr><td style="padding-left:20px">Tunai</td><td class="text-right">\${rpIdr(s.tunai)}</td></tr>
        <tr><td style="padding-left:20px">QRIS</td><td class="text-right">\${rpIdr(s.qris)}</td></tr>
        <tr><td style="padding-left:20px">Transfer</td><td class="text-right">\${rpIdr(s.transfer)}</td></tr>
        <tr><td>Diskon</td><td class="text-right">\${rpIdr(s.diskon_total ?? 0)}</td></tr>
        <tr><td>Uang pesanan masuk</td><td class="text-right">\${rpIdr(s.order_masuk_total ?? 0)}</td></tr>
        <tr><td>Nota pesanan (keluar)</td><td class="text-right">\${orderOmzet > 0 ? '-' + rpIdr(orderOmzet) : rpIdr(0)}</td></tr>
        <tr><td>Topup nominal</td><td class="text-right">\${rpIdr(s.topup_nominal)}</td></tr>
        <tr><td>Topup admin</td><td class="text-right">\${rpIdr(s.topup_admin)}</td></tr>
        <tr><td>Tarik nominal</td><td class="text-right">\${rpIdr(s.tarik_nominal)}</td></tr>
        <tr><td>Tarik admin</td><td class="text-right">\${rpIdr(s.tarik_admin)}</td></tr>
        <tr><td>Retur (\${s.n_retur})</td><td class="text-right">\${rpIdr(s.retur_total)}</td></tr>
        <tr><td>Pengeluaran (\${s.n_expense})</td><td class="text-right">\${rpIdr(s.expense_total)}</td></tr>
        <tr><td>Kas masuk (\${s.n_kas_masuk})</td><td class="text-right">\${rpIdr(s.kas_masuk_total)}</td></tr>
        <tr><td>Pembelian (\${s.n_purchase})</td><td class="text-right">\${rpIdr(s.purchase_total)}</td></tr>
        <tr><td>Hutang terbentuk</td><td class="text-right">\${rpIdr(s.hutang_baru ?? 0)}</td></tr>
        <tr><td>Piutang terbayar</td><td class="text-right">\${rpIdr(s.piutang_bayar ?? 0)}</td></tr>
      </tbody>
    </table>

    <div style="display: flex; justify-content: space-between;">
      <div style="width: 50%;"></div>
      <div class="total-section">
        <div class="total-row"><span>Kas seharusnya</span><span>\${rpIdr(kasHarus)}</span></div>
        ${fisik !== null ? `<div class="total-row"><span>Modal akhir (fisik)</span><span>\${rpIdr(fisik)}</span></div>` : ''}
        ${d !== null ? `<div class="total-row grand-total"><span>Selisih</span><span>\${d < 0 ? '-' : ''}\${rpIdr(Math.abs(d))}</span></div>` : ''}
      </div>
    </div>

    <div style="margin-top: 20px;"></div>

    <div class="foot">
      ${footerDokumenA4(toko) ? `<div class="foot-line">${esc(footerDokumenA4(toko))}</div>` : ''}
    </div>
  </div>
  <script>
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`;
}

/** Ambil kop toko + buka tab rekap A4 dan cetak (window.print()).
 *  Baris shift SUDAH di tangan pemanggil (tanpa endpoint baru) — hanya kop
 *  yang di-fetch. Melempar Error bila popup diblokir (pemanggil toast saja). */
export async function cetakRekapShift(s: ShiftRow, fisik: number | null): Promise<void> {
  const set = await apiGet<{ data: Toko }>('/api/settings');
  const html = htmlRekapShift(s, set.data, fisik);
  const w = window.open('', '_blank');
  if (!w) throw new Error('popup diblokir browser — izinkan popup untuk mencetak rekap A4/PDF');
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Ambil nota + kop lalu buka tab invoice A4 dan cetak (window.print()).
 *  Melempar Error bila API tidak terjangkau / popup diblokir — pemanggil
 *  (pos.ts / history.ts) hanya memberi toast; penjualan TIDAK dibatalkan. */
export async function cetakInvoice(saleId: string): Promise<void> {
  const nota = await apiGet<{ data: { sale: SaleNota; items: ItemNota[]; payments?: { method: string; amount: number }[] } }>(
    `/api/sales/${encodeURIComponent(saleId)}`,
  );
  // Piutang = pelengkap (putaran 14): sisa ledger halaman Hutang untuk
  // pelanggan nota ini, dicetak sebagai "Sisa hutang (semua nota)" — menutupi
  // hutang NOTA LAIN milik pelanggan yang sama. Gagal dimuat / pelanggan
  // absen -> 0 (barisnya tidak tampil); invoice TETAP tercetak — hutang nota
  // INI sendiri datang dari snapshot `sisa_hutang`, bukan dari ledger ini.
  const [set, piutang] = await Promise.all([
    apiGet<{ data: Toko }>('/api/settings'),
    nota.data.sale.customer_id
      ? apiGet<{ data: { sisa: number } }>(`/api/customer-debts/${nota.data.sale.customer_id}`)
          .then((d) => d.data?.sisa ?? 0)
          .catch(() => 0)
      : Promise.resolve(0),
  ]);
  const html = htmlInvoice(nota.data.sale, nota.data.items, set.data, piutang, nota.data.payments ?? []);
  const w = window.open('', '_blank');
  if (!w) throw new Error('popup diblokir browser — izinkan popup untuk mencetak invoice A4');
  w.document.open();
  w.document.write(html);
  w.document.close();
}
