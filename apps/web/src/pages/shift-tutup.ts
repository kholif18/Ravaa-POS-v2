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
// Jadi:
//   kas seharusnya = modal_awal + penjualan (SEMUA metode) + topup (nominal+admin)
//   selisih        = modal_akhir − kas seharusnya
// Rumusnya ada di DUA fungsi kecil di bawah (kasSeharusnya/hitungSelisih) —
// bila keputusan berubah, ubah di situ, jangan menyebar ke tempat lain.

import { apiPost, HttpError } from '../api';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { rp } from '../escpos';

/** Baris `GET /api/shifts` (kontrak lengkap dengan agregat subquery —
 *  n_sales, omzet, tunai/qris/transfer, topup/tarik). */
export type ShiftRow = {
  id: number; opened_at: string; closed_at: string | null;
  modal_awal: number; modal_akhir: number | null; cashier: string; status: string;
  n_sales: number; omzet: number; tunai: number; qris: number; transfer: number;
  n_topup: number;
  topup_nominal: number; topup_admin: number;
  tarik_nominal: number; tarik_admin: number;
};

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/** Kas yang SEHARUSNYA ada di laci menurut keputusan pemilik 2026-10-01
 *  (lihat komentar kepala file): modal awal + penjualan semua metode +
 *  topup (nominal + admin, dua angka dipisah di tampilan tapi keduanya
 *  masuk laci). Tarik tunai sengaja TIDAK ikut. */
export function kasSeharusnya(s: ShiftRow): number {
  return s.modal_awal + s.omzet + s.topup_nominal + s.topup_admin;
}

/** Selisih kas = kas fisik − kas seharusnya (rumus di satu tempat). */
export function hitungSelisih(modalAkhir: number, kasSeharusnyaDiLaci: number): number {
  return modalAkhir - kasSeharusnyaDiLaci;
}

/** Dialog tutup shift (identik untuk #/shifts dan POS): rincian laci +
 *  input modal akhir + selisih live. `onSelesai` dipanggil setelah POST
 *  close sukses — halaman Shift memakainya untuk reload tabel, POS untuk
 *  memuat ulang shift (gate "Buka shift dulu" muncul kembali). */
export function dialogTutupShift(s: ShiftRow, onSelesai: () => void | Promise<void>): void {
  const nonTunai = s.omzet - s.tunai;
  const kasHarus = kasSeharusnya(s);
  const baris = (label: string, nilai: number, kelas = '') =>
    `<div class="flex justify-between gap-2"><span>${label}</span><b class="tabular-nums text-gray-900 dark:text-white ${kelas}">${rp(nilai)}</b></div>`;
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
        <div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Topup — pelanggan bayar, laci naik</div>
        ${baris('Nominal', s.topup_nominal)}
        ${baris('Admin', s.topup_admin)}
        <div class="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Tarik tunai — dicatat saja, di luar hitungan</div>
        ${baris('Nominal', s.tarik_nominal)}
        ${baris('Admin', s.tarik_admin)}
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
        Kas seharusnya = modal awal + penjualan (semua metode) + topup
        (nominal + admin), sesuai keputusan pemilik 2026-10-01. Tarik tunai
        tidak mengurangi laci — hanya dicatat sebagai info.
      </p>`,
    onMount: ({ el, ok, close }) => {
      const akhir = el.querySelector('#sh-akhir') as HTMLInputElement;
      const sel = el.querySelector('#sh-selisih') as HTMLElement;
      akhir.focus();
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
          toast(`Shift #${s.id} ditutup`, 'success');
          await onSelesai();
        } catch (e) {
          // 404 = sudah tutup / tidak ada (baris berubah di tab lain).
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}
