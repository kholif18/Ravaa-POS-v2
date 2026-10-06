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

/** Baris sale_items dari GET /api/sales/:id (kolom yang relevan utk invoice). */
export interface ItemNota {
  name: string; qty: number; price: number; amount: number;
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
  /** Penanda nota berhutang (computed server, `sisa_hutang` putaran 13) —
   *  kas sisa nota INI (tunai + kurang + pelanggan valid). 0 = lunas. */
  sisa_hutang?: number;
}
interface Toko {
  store_name: string; store_address: string;
  store_phone: string; store_email: string;
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
 * `sale.sisa_hutang` (deterministik, ikut walau ledger gagal dimuat). */
export function htmlInvoice(sale: SaleNota, items: ItemNota[], toko: Toko, piutang = 0): string {
  // Diskon agregat = diskon transaksi + seluruh diskon per baris (persis rumus
  // laporan: sales.diskon). Dipakai untuk baris "Discount (...%)" ala Aronium.
  const discItem = items.reduce((a, i) => a + (i.discount || 0), 0);
  const discTotal = Math.max(0, sale.discount) + discItem;
  const pct = sale.subtotal > 0 && discTotal > 0 ? Math.round((discTotal / sale.subtotal) * 100) : 0;
  const metode = LABEL_METODE[sale.pay_method] ?? sale.pay_method.toUpperCase();
  // Lunas di muka = tunai cukup / QRIS / transfer. Uang kurang (putaran 12 POS:
  // uang kurang/0 otomatis jadi hutang) membuat nota INI belum lunas ->
  // Payment status "Belum lunas" + baris Hutang di rincian pembayaran.
  const sisaNota = sale.sisa_hutang ?? 0;
  const paid = sale.pay_method === 'tunai' ? sale.cash_in : sale.total;
  const tampilKembalian = sale.pay_method === 'tunai';

  const barisItem = items.map((it, i) => {
    const qtyTampil = it.unit && it.base_unit && it.unit !== it.base_unit
      ? `${it.qty} ${it.unit}`
      : `${it.qty}`;
    const utama = `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}</td>
      <td class="r">${esc(qtyTampil)}</td>
      <td class="r">${num(it.price)}</td>
      <td class="r">${num(it.amount)}</td>
    </tr>`;
    // Catatan per baris (sale_items.note) — pola print_a4.blade.php RPOS:
    // baris mungil italic di bawah itemnya, colspan penuh.
    const catatan = it.note?.trim()
      ? `<tr class="nota"><td colspan="5">* ${esc(it.note.trim())}</td></tr>`
      : '';
    return utama + catatan;
  }).join('');

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Invoice ${esc(sale.invoice_no ?? sale.id.slice(0, 8))}</title>
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
  table.items { width: 100%; border-collapse: collapse; }
  table.items th { font-size: 10px; text-transform: none; padding: 5px 6px; border-top: 1px solid #444;
                   border-bottom: 1px solid #444; text-align: left; }
  table.items th.r, table.items td.r { text-align: right; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items td { padding: 5px 6px; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
  table.items td.c { color: #444; }
  tr.nota td { border: none; padding: 0 6px 5px 34px; font-size: 10px; font-style: italic; color: #555; }
  .ringkas { width: 55%; margin-left: auto; margin-top: 14px; }
  .kotak { display: flex; justify-content: space-between; border: 1px solid #444; padding: 5px 9px; margin-bottom: 7px; }
  .kotak .lbl { font-weight: 700; }
  .putus { border-top: 1px dashed #999; margin: 4px 0 11px; }
  .bayar { margin-top: 6px; }
  .bayar .ttl { font-weight: 700; margin-bottom: 3px; }
  .bayar .baris { display: flex; justify-content: space-between; width: 100%; padding: 1px 0; }
  .bayar .baris .lbl { font-weight: 700; }
  .bayar .baris.hutang, .bayar .baris.hutang .lbl { color: #b91c1c; font-weight: 700; }
  .foot { margin-top: 34px; font-size: 9px; color: #aaa; }
</style>
</head>
<body>
  <div class="kop">
    <div>
      <div class="judul">INVOICE</div>
      <div class="nama-toko">${esc(toko.store_name || 'RAVA POS')}</div>
      ${toko.store_address ? `<div class="alamat">${esc(toko.store_address)}</div>` : ''}
      ${toko.store_phone ? `<div class="baris-kop"><span class="lbl">Phone:</span><span>${esc(toko.store_phone)}</span></div>` : ''}
      ${toko.store_email ? `<div class="baris-kop"><span class="lbl">Email:</span><span>${esc(toko.store_email)}</span></div>` : ''}
    </div>
    <div class="logo" aria-hidden="true">R</div>
  </div>
  <hr>
  <div class="meta">
    <div>
      <div class="ttl">Bill to</div>
      <div>${esc((sale.customer_name ?? '').trim() || 'Pelanggan Umum')}</div>
    </div>
    <div class="rincian">
      <div class="baris"><span class="lbl">Invoice No.:</span><span>${esc(sale.invoice_no ?? '—')}</span></div>
      <div class="baris"><span class="lbl">Date:</span><span>${tglAronium(sale.created_at)}</span></div>
      <div class="baris"><span class="lbl">Payment status:</span><span>${sisaNota > 0 ? 'Belum lunas' : 'Lunas'}</span></div>
      <div class="baris"><span class="lbl">Kasir:</span><span>${esc(sale.cashier)}</span></div>
    </div>
  </div>
  <table class="items">
    <thead>
      <tr>
        <th class="c" style="width:34px">#</th>
        <th>Item</th>
        <th class="r" style="width:90px">Quantity</th>
        <th class="r" style="width:110px">Unit price</th>
        <th class="r" style="width:120px">Total</th>
      </tr>
    </thead>
    <tbody>${barisItem}</tbody>
  </table>
  <div class="ringkas">
    ${discTotal > 0 ? `<div class="kotak"><span class="lbl">Discount${pct > 0 ? ` (${pct}%)` : ''}</span><span>-${rpNum(discTotal)}</span></div>` : ''}
    <div class="putus"></div>
    <div class="kotak"><span class="lbl">Total</span><span>${rpNum(sale.total)}</span></div>
    <div class="bayar">
      <div class="ttl">Payment method:</div>
      <div class="baris"><span class="lbl">${metode}:</span><span>${rpNum(sale.total)}</span></div>
      <div class="baris"><span class="lbl">Paid amount:</span><span>${rpNum(paid)}</span></div>
      ${sisaNota > 0
        ? `<div class="baris hutang"><span class="lbl">Hutang:</span><span>${rpNum(sisaNota)}</span></div>`
        : ''}
      ${tampilKembalian ? `<div class="baris"><span class="lbl">Change:</span><span>${rpNum(sale.change)}</span></div>` : ''}
    </div>
    ${piutang > 0 && piutang !== sisaNota
      ? `<div class="kotak"><span class="lbl">Sisa hutang (semua nota)</span><span>${rpNum(piutang)}</span></div>`
      : ''}
  </div>
  <div class="foot">Dicetak dari Ravaa POS</div>
  <script>
    // Cetak otomatis begitu dokumen siap (pola RPOS print_a4.blade.php).
    // Print STALL/Failure TIDAK PERNAH membatalkan apa pun — kasir bisa klik
    // print lagi dari tab ini. Tab sengaja TIDAK ditutup otomatis (setelah
    // dialog print ditutup, kasir masih bisa mencetak ulang lalu menutup tab).
    window.addEventListener('load', function () { window.print(); });
  </script>
</body>
</html>`;
}

/** Ambil nota + kop lalu buka tab invoice A4 dan cetak (window.print()).
 *  Melempar Error bila API tidak terjangkau / popup diblokir — pemanggil
 *  (pos.ts / history.ts) hanya memberi toast; penjualan TIDAK dibatalkan. */
export async function cetakInvoice(saleId: string): Promise<void> {
  const nota = await apiGet<{ data: { sale: SaleNota; items: ItemNota[] } }>(
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
  const html = htmlInvoice(nota.data.sale, nota.data.items, set.data, piutang);
  const w = window.open('', '_blank');
  if (!w) throw new Error('popup diblokir browser — izinkan popup untuk mencetak invoice A4');
  w.document.open();
  w.document.write(html);
  w.document.close();
}
