// Dialog TUTUP SHIFT — sumber TUNGGAL untuk halaman Shift (#/shifts) DAN
// tombol merah "Tutup shift" di info bar POS (keputusan pemilik 2026-10-06:
// "tombol merah di pos seperti kula pos"). Jangan menduplikasi dialog /
// rumusnya di tempat lain (AGENTS §5: satu sumber kebenaran).
//
// PERHATIAN soal "selisih": rumus expected-cash mengikuti KEPUTUSAN PEMILIK
// 2026-10-01 (ROADMAP §1.3), tidak dikarang sendiri:
//   1. Topup = pelanggan bayar tunai -> laci NAIK (nominal + admin).
//   2. Tarik tunai JANGAN mengurangi laci — cukup dicatat.
//   3. QRIS/transfer TETAP masuk hitungan laci (bukan dana rekening terpisah).
//   4. Pengeluaran tunai (Tahap 1, 2026-10-11) -> laci TURUN (hanya yang
//      terikat shift_id ini; yang di luar shift tidak ikut hitungan laci).
//   5. Retur tunai (Tahap 2, 2026-10-11, keputusan pemilik (a)) -> laci TURUN
//      (uang kembali ke pelanggan; hanya yang terikat shift ini).
//   6. Pembelian tunai (Tahap 3, 2026-10-11, keputusan pemilik (b)) -> laci
//      TURUN sebesar yang DIBAYAR (bukan total nota — sisa hutang supplier
//      tak gerakkan kas); hanya nota received yang terikat shift ini.
//   7. Hutang TERBENTUK (tunai kurang, pelanggan valid) -> laci TIDAK
//      menerima porsinya: omzet tercatat penuh tapi uangnya tidak masuk,
//      jadi dikurangkan dari omzet (ala "credit" Z-report Aronium).
//   8. Piutang TERBAYAR ke laci shift ini -> laci NAIK (ala "credit payments
//      collected" Z-report butir 7-8; ledger diikat lewat periode
//      opened_at..closed_at karena tak punya shift_id).
//   9. Kas masuk (butir ROADMAP 1.6.2, 2026-10-19) -> laci NAIK (injeksi
//      modal / koreksi laci; hanya yang terikat shift ini — pasangan
//      pengeluaran butir 4).
//  10. Pesanan jasa (butir ROADMAP 1.6.6, 2026-10-19) -> DUA suku:
//      `order_masuk_total` (Σ dp + pelunasan − refund shift ini) laci NAIK,
//      dan `order_omzet_total` (nilai nota penjualan yang lahir dari take,
//      link orders.sale_id) DIKURANGKAN dari omzet — nota pesanan ikut
//      terhitung di `omzet` (semua sales shift ini), padahal uangnya sudah
//      dibawa suku order_masuk; tanpa pengurangan ini uang pesanan dobel.
//      (Sisa hutang saat serah TIDAK ikut `hutang_baru`: selisihnya sudah
//      tercermin di order_masuk < order_omzet — jangan kurangkan dua kali.)
// Jadi:
//   kas seharusnya = modal_awal + (omzet − hutang_baru − order_omzet)
//                    + order_masuk + (topup nominal+admin) + piutang_bayar
//                    + kas masuk − pengeluaran − retur − pembelian
//                    (terbayar, shift ini)
//   selisih        = modal_akhir − kas seharusnya
// Rumusnya ada di DUA fungsi kecil di bawah (kasSeharusnya/hitungSelisih) —
// bila keputusan berubah, ubah di situ, jangan menyebar ke tempat lain.
// REKAP CETAK ala Z-report Aronium (2026-10-11): dialog ini + dialog pasca-
// tutup memuat tombol [Thermal] (struk 32 kolom via print-agent, builder
// bangunStrukRekap di bawah — objek Struk yang SAMA dipakai struk())
// dan [PDF] (dokumen A4 browser via htmlRekapShift/cetakRekapShift di
// invoice.ts, pola cetakInvoice). X = cetak kapan pun tanpa menutup shift
// (tanpa fisik/selisih); Z = setelah tutup (lengkap fisik + selisih).

import { apiGet, apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { choiceDialog } from '../ui/confirm';
import { getAutoPrint, getPrintPause } from '../ui/print-pref';
import { kirimPrint, rp, strukUntukTercetak, type Struk } from '../escpos';
import { cetakRekapShift, tglLengkap } from '../invoice';

/** Baris `GET /api/shifts` (kontrak lengkap dengan agregat subquery —
 *  n_sales, omzet, tunai/qris/transfer, topup/tarik, pengeluaran, kas masuk,
 *  retur, pembelian + rekap Z-report: rentang nota, diskon, hutang, piutang). */
export type ShiftRow = {
  id: number; opened_at: string; closed_at: string | null;
  modal_awal: number; modal_akhir: number | null; cashier: string; status: string;
  n_sales: number; omzet: number; tunai: number; qris: number; transfer: number;
  n_topup: number;
  topup_nominal: number; topup_admin: number;
  /** Potongan bank/agen topup (2026-10-27): porsi admin yang dibayar ke bank.
   *  Laba bersih topup = topup_admin − topup_bank_fee. Laci TIDAK berubah. */
  topup_bank_fee: number;
  tarik_nominal: number; tarik_admin: number;
  n_expense: number; expense_total: number;
  /** Kas masuk non-penjualan (butir ROADMAP 1.6.2, 2026-10-19) — menambah laci. */
  n_kas_masuk: number; kas_masuk_total: number;
  n_retur: number; retur_total: number;
  n_purchase: number; purchase_total: number;
  /** Pesanan jasa (butir ROADMAP 1.6.6, 2026-10-19): uang pesanan yang MASUK
   *  laci shift ini (Σ dp + pelunasan − refund) — laci NAIK. */
  order_masuk_total: number;
  /** Nilai nota penjualan yang lahir dari take pesanan (orders.sale_id)
   *  yang terikat shift ini — DIKURANGKAN dari omzet (uangnya sudah dihitung
   *  lewat order_masuk_total, kalau tidak akan dobel). */
  order_omzet_total: number;
  /** Nota pertama/terakhir shift (MIN/MAX invoice_no, NULL bila tanpa jual). */
  inv_awal: string | null; inv_akhir: string | null;
  /** Diskon shift = transaksi + per baris (rumus SAMA dengan reports/daily). */
  diskon_total: number;
  /** Hutang TERBENTUK (tunai kurang + pelanggan valid) — laci tak menerimanya. */
  hutang_baru: number;
  /** Piutang TERBAYAR ke laci dalam periode shift — laci naik. */
  piutang_bayar: number;
};

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/** Kas yang SEHARUSNYA ada di laci menurut keputusan pemilik 2026-10-01
 *  (lihat komentar kepala file) + Tahap 1–3 (2026-10-11) + kas masuk
 *  (1.6.2, 2026-10-19) + pesanan jasa (1.6.6, 2026-10-19) + rekap Z-report:
 *  modal awal + (omzet − hutang terbentuk − omzet nota pesanan, karena omzet
 *  nota pesanan uangnya lewat `order_masuk_total`) + uang pesanan masuk +
 *  topup (nominal + admin) + piutang terbayar + kas masuk − pengeluaran −
 *  retur − pembelian (terbayar, shift ini). Tarik tunai sengaja TIDAK ikut.
 *  `?? 0` = baris lama/server lama tanpa kolom baru (kontrak aditif). */
export function kasSeharusnya(s: ShiftRow): number {
  return s.modal_awal + (s.omzet - (s.hutang_baru ?? 0) - (s.order_omzet_total ?? 0))
    + (s.order_masuk_total ?? 0) + s.topup_nominal + s.topup_admin
    + (s.piutang_bayar ?? 0) + (s.kas_masuk_total ?? 0)
    - (s.expense_total ?? 0) - (s.retur_total ?? 0) - (s.purchase_total ?? 0);
}

/** Selisih kas = kas fisik − kas seharusnya (rumus di satu tempat). */
export function hitungSelisih(modalAkhir: number, kasSeharusnyaDiLaci: number): number {
  return modalAkhir - kasSeharusnyaDiLaci;
}

/* ---------- Rekap cetak ala Z-report Aronium ---------- */

async function namaToko(): Promise<string> {
  try {
    const r = await apiGet<{ data: { store_name: string } }>('/api/settings');
    return r.data.store_name.trim() || 'RAVA POS';
  } catch {
    return 'RAVA POS'; // kop gagal dimuat = fallback, cetak TETAP jalan
  }
}

const potongTgl = (iso: string | null): string => (iso ?? '').slice(0, 16) || '—';

/** Susun objek Struk rekap shift (dipakai Thermal via print-agent).
 *  `fisik` = modal akhir hitung kasir; null = rekap SEMENTARA (X, tanpa
 *  fisik/selisih). Semua butir tampil walau 0 (auditabel, pola Z-report) —
 *  kecuali blok fisik/selisih yang hanya ada di Z pasca-tutup. */
export function bangunStrukRekap(s: ShiftRow, toko: string, fisik: number | null): Struk {
  const nota = s.inv_awal && s.inv_akhir ? `${s.inv_awal} - ${s.inv_akhir}` : 'Tanpa penjualan';
  const kasHarus = kasSeharusnya(s);
  const baris: Struk['baris'] = [
    { kiri: 'Modal awal', kanan: rp(s.modal_awal) },
    { kiri: `Penjualan (${s.n_sales} nota)`, kanan: rp(s.omzet) },
    { kiri: '  Tunai', kanan: rp(s.tunai) },
    { kiri: '  QRIS', kanan: rp(s.qris) },
    { kiri: '  Transfer', kanan: rp(s.transfer) },
    { kiri: 'Diskon', kanan: rp(s.diskon_total ?? 0) },
    // Pesanan jasa (1.6.6): uang masuk laci (+, DP/pelunasan) vs nota yang
    // lahir dari serah (−, uangnya sudah di suku pertama — cegah dobel).
    { kiri: 'Uang pesanan masuk', kanan: rp(s.order_masuk_total ?? 0) },
    { kiri: 'Nota pesanan (keluar)', kanan: (s.order_omzet_total ?? 0) > 0 ? `-${rp(s.order_omzet_total)}` : rp(0) },
    { kiri: 'Topup nominal', kanan: rp(s.topup_nominal) },
    { kiri: 'Topup admin', kanan: rp(s.topup_admin) },
    ...(s.topup_bank_fee > 0 ? [
      { kiri: '  Potongan bank', kanan: `-${rp(s.topup_bank_fee)}` },
      { kiri: '  Laba bersih topup', kanan: rp(s.topup_admin - s.topup_bank_fee), tebal: true },
    ] : []),
    { kiri: 'Tarik nominal', kanan: rp(s.tarik_nominal) },
    { kiri: 'Tarik admin', kanan: rp(s.tarik_admin) },
    { kiri: `Retur (${s.n_retur})`, kanan: rp(s.retur_total) },
    { kiri: `Pengeluaran (${s.n_expense})`, kanan: rp(s.expense_total) },
    { kiri: `Kas masuk (${s.n_kas_masuk})`, kanan: rp(s.kas_masuk_total) },
    // BERTAHAP sejak butir 3.7 (2026-10-25): satu PO bisa datang beberapa
    // kali, jadi angka ini = jumlah KEDATANGAN (event) di shift ini.
    { kiri: `Pembelian (${s.n_purchase} kedatangan)`, kanan: rp(s.purchase_total) },
    { kiri: 'Hutang terbentuk', kanan: rp(s.hutang_baru ?? 0) },
    { kiri: 'Piutang terbayar', kanan: rp(s.piutang_bayar ?? 0) },
    { kiri: 'Kas seharusnya', kanan: rp(kasHarus), tebal: true },
  ];
  if (fisik !== null) {
    const d = hitungSelisih(fisik, kasHarus);
    baris.push(
      { kiri: 'Modal akhir (fisik)', kanan: rp(fisik) },
      { kiri: 'Selisih', kanan: `${d < 0 ? '-' : ''}${rp(Math.abs(d))}` },
    );
  }
  return {
    judul: toko,
    subjudul: fisik !== null ? 'REKAP TUTUP SHIFT' : 'REKAP SEMENTARA (X)',
    meta: [
      `Shift #${s.id} · ${s.cashier}`,
      `Buka ${potongTgl(s.opened_at)}${s.closed_at ? ` · Tutup ${potongTgl(s.closed_at)}` : ''}`,
      `Nota ${nota}`,
    ],
    items: [],
    baris,
    kaki: [`Dicetak melalui Ravaa POS pada: ${tglLengkap(new Date().toISOString())}`],
  };
}

/** Kirim rekap ke printer thermal. Gagal cetak TAK PERNAH membatalkan apa
 *  pun — hanya toast (pola cetak() POS). Saklar mati = info, bukan error. */
async function kirimRekapThermal(s: ShiftRow, fisik: number | null): Promise<void> {
  if (!getAutoPrint()) {
    toast('Cetak sedang mati — nyalakan saklar "Cetak struk otomatis" bila ingin mengirim ke printer.', 'info');
    return;
  }
  try {
    await kirimPrint(await strukUntukTercetak(bangunStrukRekap(s, await namaToko(), fisik), 'thermal'));
  } catch (e) {
    toast(`Rekap tidak tercetak: ${e instanceof Error ? e.message : 'print-agent tidak jalan'}.`, 'warning', 9000);
  }
}

/** PDF browser (pola cetakInvoice — window.print, bukan print-agent). */
async function kirimRekapPdf(s: ShiftRow, fisik: number | null): Promise<void> {
  try {
    await cetakRekapShift(s, fisik);
  } catch (e) {
    toast(`Rekap PDF gagal: ${e instanceof Error ? e.message : 'popup diblokir?'}.`, 'warning', 9000);
  }
}

/** Dialog rekap PASCA-tutup (Z): ringkasan + [Thermal][PDF][Selesai].
 *  Dipanggil setelah POST close sukses dengan baris SEGAR dari server
 *  (agregat + modal_akhir + closed_at sudah final). */
async function rekapPascaTutup(id: number, onSelesai: () => void | Promise<void>): Promise<void> {
  let segar: ShiftRow | null = null;
  try {
    const r = await apiGet<{ data: ShiftRow[] }>('/api/shifts?status=closed&limit=200');
    segar = r.data.find((x) => x.id === id) ?? null;
  } catch { /* jatuh ke toast di bawah */ }
  if (!segar) {
    toast(`Shift #${id} ditutup`, 'success');
    await onSelesai();
    return;
  }
  const fisik = segar.modal_akhir ?? 0;
  const d = hitungSelisih(fisik, kasSeharusnya(segar));
  const pilihan = await choiceDialog({
    title: `Shift #${id} ditutup — selisih ${d === 0 ? 'Rp0 (pas)' : `${d < 0 ? 'kurang' : 'lebih'} ${rp(Math.abs(d))}`}`,
    html: `<div class="struk-muka">
      <div class="struk-tengah struk-redup">Rekap tutup shift tersimpan.</div>
      <div class="struk-tengah struk-tebal">Shift #${segar.id} · ${segar.cashier}</div>
      <div class="struk-garis"></div>
      <div class="struk-baris"><span>Omzet (${segar.n_sales} nota)</span><span>${rp(segar.omzet)}</span></div>
      <div class="struk-baris"><span>Kas seharusnya</span><span>${rp(kasSeharusnya(segar))}</span></div>
      <div class="struk-baris"><span>Modal akhir</span><span>${rp(fisik)}</span></div>
      <div class="struk-garis"></div>
      <div class="struk-baris struk-total"><span>Selisih</span><span>${d < 0 ? '-' : ''}${rp(Math.abs(d))}</span></div>
    </div>`,
    icon: d === 0 ? 'success' : 'warning',
    choices: [
      { key: 'thermal', label: 'Thermal' },
      { key: 'pdf', label: 'PDF' },
    ],
    cancelLabel: 'Selesai',
  });
  if (pilihan === 'thermal') await kirimRekapThermal(segar, fisik);
  else if (pilihan === 'pdf') await kirimRekapPdf(segar, fisik);
  await onSelesai();
}

/** Dialog tutup shift (identik untuk #/shifts dan POS): rincian laci +
 *  input modal akhir + selisih live. `onSelesai` dipanggil setelah POST
 *  close sukses — halaman Shift memakainya untuk reload tabel, POS untuk
 *  memuat ulang shift (gate "Buka shift dulu" muncul kembali). */
export function dialogTutupShift(s: ShiftRow, onSelesai: () => void | Promise<void>): void {
  const nonTunai = s.omzet - s.tunai;
  const kasHarus = kasSeharusnya(s);
  // `nilai` negatif tampil dengan tanda minus di depan (baris pengurang
  // seperti omzet nota pesanan yang dipindah ke suku uang pesanan masuk).
  const baris = (label: string, nilai: number, kelas = '') =>
    `<div class="flex justify-between gap-2"><span>${label}</span><b class="tabular-nums text-gray-900 dark:text-white ${kelas}">${nilai < 0 ? `−${rp(Math.abs(nilai))}` : rp(nilai)}</b></div>`;
  openModal({
    title: `Tutup shift #${s.id} — ${s.cashier}`,
    okLabel: 'Tutup shift',
    body: `
      <div class="space-y-1 text-sm text-gray-600 dark:text-gray-300">
        <div class="flex justify-between gap-2"><span>Modal awal</span><b class="tabular-nums text-gray-900 dark:text-white">${rp(s.modal_awal)}</b></div>
        <div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Penjualan (semua metode — masuk laci)</div>
        ${baris(`Tunai (${s.n_sales} nota)`, s.tunai)}
        ${baris('QRIS', s.qris)}
        ${baris('Transfer', s.transfer)}
        ${nonTunai !== s.qris + s.transfer ? baris('Metode lain', s.omzet - s.tunai - s.qris - s.transfer) : ''}
        ${(s.order_masuk_total ?? 0) > 0 || (s.order_omzet_total ?? 0) > 0 ? `<div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Pesanan jasa — omzet & uang masuk</div>${baris('Uang pesanan masuk (DP/pelunasan)', s.order_masuk_total ?? 0)}${baris('Nilai nota pesanan (keluar dari omzet)', -(s.order_omzet_total ?? 0))}` : ''}
        <div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Topup — pelanggan bayar, laci naik</div>
        ${baris('Nominal', s.topup_nominal)}
        ${baris('Admin', s.topup_admin)}
        ${s.topup_bank_fee > 0 ? baris('Potongan bank', -s.topup_bank_fee) + baris('Laba bersih topup', s.topup_admin - s.topup_bank_fee) : ''}
        <div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Tarik tunai — dicatat saja, di luar hitungan</div>
        ${baris('Nominal', s.tarik_nominal)}
        ${baris('Admin', s.tarik_admin)}
        ${s.n_expense > 0 || s.expense_total > 0 ? `<div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Pengeluaran — mengurangi laci</div>${baris(`Kas keluar (${s.n_expense} catatan)`, s.expense_total)}` : ''}
        ${s.n_kas_masuk > 0 || s.kas_masuk_total > 0 ? `<div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Kas masuk — menambah laci</div>${baris(`Kas masuk (${s.n_kas_masuk} catatan)`, s.kas_masuk_total)}` : ''}
        ${s.n_retur > 0 || s.retur_total > 0 ? `<div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Retur — uang kembali, mengurangi laci</div>${baris(`Kembali ke pelanggan (${s.n_retur} retur)`, s.retur_total)}` : ''}
        ${s.n_purchase > 0 || s.purchase_total > 0 ? `<div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Pembelian — kulakan tunai, mengurangi laci</div>${baris(`Bayar supplier (${s.n_purchase} kedatangan)`, s.purchase_total)}` : ''}
        <div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Piutang (butir Z-report: credit)</div>
        ${baris('Hutang terbentuk (tak masuk laci)', s.hutang_baru ?? 0)}
        ${baris('Piutang terbayar (masuk laci)', s.piutang_bayar ?? 0)}
        <div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Rekap sementara (X) — tanpa menutup shift</div>
        <div class="flex gap-2">
          <button type="button" data-rekap="thermal" class="btn btn-ghost flex-1 justify-center">${icon('print')}<span>Thermal</span></button>
          <button type="button" data-rekap="pdf" class="btn btn-ghost flex-1 justify-center">${icon('download')}<span>PDF</span></button>
        </div>
        <div class="mt-2 flex justify-between gap-2 border-t border-gray-200 pt-2 dark:border-gray-700">
          <span class="font-medium text-gray-900 dark:text-white">Kas seharusnya di laci</span>
          <b id="sh-harus" class="tabular-nums text-gray-900 dark:text-white">${rp(kasHarus)}</b>
        </div>
      </div>
      <div class="field mt-4">
        <label class="label" for="sh-akhir">Modal akhir (hitung fisik di laci) *</label>
        <input id="sh-akhir" class="input" type="number" inputmode="numeric" min="0" step="1" placeholder="isi setelah uang dihitung" />
      </div>
      <p class="mt-2 text-sm">
        <span class="text-gray-500 dark:text-gray-400">Selisih (kas fisik − kas seharusnya):</span>
        <b id="sh-selisih" class="ml-1 tabular-nums">—</b>
      </p>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Kas seharusnya = modal awal + (omzet − hutang terbentuk − omzet nota
        pesanan) + uang pesanan masuk + topup (nominal + admin) + piutang
        terbayar + kas masuk − pengeluaran − retur − pembelian (terbayar)
        shift ini, sesuai keputusan pemilik 2026-10-01 + Tahap 1–3
        (2026-10-11) + kas masuk (1.6.2) + pesanan jasa (1.6.6, 2026-10-19) +
        rekap Z-report. Tarik tunai tidak mengurangi laci — hanya dicatat
        sebagai info.
      </p>`,
    onMount: ({ el, ok, close }) => {
      const akhir = el.querySelector('#sh-akhir') as HTMLInputElement;
      const sel = el.querySelector('#sh-selisih') as HTMLElement;
      akhir.focus();
      // Rekap SEMENTARA (X): cetak kapan pun tanpa menutup shift (tanpa
      // fisik/selisih — fisik baru diketahui saat kasir mengisi kolom).
      el.querySelectorAll<HTMLElement>('[data-rekap]').forEach((b) =>
        b.addEventListener('click', () => {
          if (b.dataset.rekap === 'pdf') void kirimRekapPdf(s, null);
          else void kirimRekapThermal(s, null);
        }),
      );
      akhir.addEventListener('input', () => {
        const v = akhir.value.trim();
        if (v === '' || !Number.isFinite(Number(v))) { sel.textContent = '—'; sel.className = 'ml-1 tabular-nums'; return; }
        const d = hitungSelisih(Number(v), kasHarus);
        sel.textContent = `${d >= 0 ? '' : '−'}${rp(Math.abs(d))}`;
        sel.className = `ml-1 tabular-nums ${d === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`;
      });
      ok.addEventListener('click', async () => {
        const v = akhir.value.trim();
        if (v === '' || !Number.isFinite(Number(v)) || Number(v) < 0) {
          toast('Modal akhir harus angka >= 0', 'warning');
          return;
        }
        try {
          await apiPost(`/api/shifts/${s.id}/close`, { modal_akhir: Number(v) });
          close();
          // Z pasca-tutup: dialog rekap (Thermal/PDF/Selesai) + onSelesai di
          // dalamnya — toast "ditutup" diganti judul dialog (tak redundan).
          await rekapPascaTutup(s.id, onSelesai);
        } catch (e) {
          // 404 = sudah tutup / tidak ada (baris berubah di tab lain).
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}
