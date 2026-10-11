// Pager KAKI TABEL halaman admin (2026-10-11) — SATU pola untuk semua
// daftar: dirender DI DALAM `.card-flush` (lihat `.table-foot` di styles.css),
// kiri = info "Hal X dari Y · A–B dari N" + pilih jumlah baris,
// kanan = nomor halaman (‹ 1 … 4 5 6 … 20 ›). Dipakai customers, suppliers,
// debts, shifts, purchases, returns, expenses, history (client-side).
// Pengecualian: Produk & Stok = infinite scroll (tetap, jangan disamakan).
//
// Cara pakai per halaman: simpan `offset` + `limit` (bawaan PAGE_SIZE) di
// state, kirim keduanya ke API, render `pagerHtml(offset, limit, total)` di
// bawah tabel, panggil `bindPager` + `bindPagerLimit` di bind. RESET offset=0
// setiap filter/cari/tanggal/status/limit berubah, kalau tidak halaman 3
// filter baru yang hasilnya 1 halaman menampilkan tabel kosong.

import { icon } from './icons';

/** Baris per halaman bawaan tabel admin — SATU angka untuk semua daftar. */
export const PAGE_SIZE = 20;

/** Pilihan jumlah baris per halaman. */
export const PAGE_CHOICES = [10, 20, 50, 100];

/** Info "A–B dari N" (1-based; N=0 → "0 dari 0"). */
export function infoHalaman(offset: number, limit: number, total: number): string {
  if (total <= 0) return '0 dari 0';
  const a = Math.min(offset + 1, total);
  const b = Math.min(offset + limit, total);
  return `${a}–${b} dari ${total}`;
}

/** Daftar nomor halaman + elipsis: selalu 1 & terakhir, ±1 sekitar aktif. */
export function nomorHalaman(hal: number, totalHal: number): (number | '…')[] {
  if (totalHal <= 7) return Array.from({ length: totalHal }, (_, i) => i + 1);
  const jaga = new Set([1, totalHal, hal - 1, hal, hal + 1]);
  const urut = [...jaga].filter((n) => n >= 1 && n <= totalHal).sort((a, b) => a - b);
  const keluar: (number | '…')[] = [];
  urut.forEach((n, i) => {
    if (i > 0 && n - urut[i - 1] > 1) keluar.push('…');
    keluar.push(n);
  });
  return keluar;
}

export function pagerHtml(offset: number, limit: number, total: number): string {
  if (total <= limit) return '';
  const hal = Math.floor(offset / limit) + 1;
  const totalHal = Math.max(1, Math.ceil(total / limit));
  const tombolNo = (n: number): string =>
    n === hal
      ? `<button type="button" data-pg="goto" data-pg-off="${(n - 1) * limit}" class="btn btn-ghost !min-h-[30px] !px-2.5 !border-primary !text-primary" aria-current="page" disabled>${n}</button>`
      : `<button type="button" data-pg="goto" data-pg-off="${(n - 1) * limit}" class="btn btn-ghost !min-h-[30px] !px-2.5" aria-label="Halaman ${n}">${n}</button>`;
  const angka = nomorHalaman(hal, totalHal)
    .map((n) =>
      n === '…'
        ? `<span class="px-1 text-xs text-gray-400 dark:text-gray-500" aria-hidden="true">…</span>`
        : tombolNo(n),
    )
    .join('');
  return `
  <div class="table-foot">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span class="text-xs tabular-nums text-gray-500 dark:text-gray-400">Hal ${hal} dari ${totalHal} · ${infoHalaman(offset, limit, total)}</span>
      <label class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">Tampil
        <select data-pg-limit class="input input-sm !w-auto !min-h-[30px] !py-1" aria-label="Baris per halaman">
          ${PAGE_CHOICES.map((v) => `<option value="${v}"${v === limit ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="flex items-center gap-1">
      <button type="button" data-pg="prev" data-pg-off="${Math.max(0, offset - limit)}" class="btn btn-ghost !min-h-[30px] !px-2.5" title="Halaman sebelumnya" aria-label="Halaman sebelumnya"${offset <= 0 ? ' disabled' : ''}>${icon('chevL')}</button>
      ${angka}
      <button type="button" data-pg="next" data-pg-off="${offset + limit}" class="btn btn-ghost !min-h-[30px] !px-2.5" title="Halaman berikutnya" aria-label="Halaman berikutnya"${offset + limit >= total ? ' disabled' : ''}>${icon('chevR')}</button>
    </div>
  </div>`;
}

/** Lompat ke offset baru (dikirim lewat `data-pg-off` tombol). */
export function bindPager(root: ParentNode, onGoto: (offset: number) => void): void {
  root.querySelectorAll<HTMLElement>('[data-pg]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.hasAttribute('disabled')) return;
      onGoto(Number(b.dataset.pgOff ?? 0));
    }),
  );
}

/** Ganti jumlah baris per halaman (select `data-pg-limit`). */
export function bindPagerLimit(root: ParentNode, onLimit: (limit: number) => void): void {
  root.querySelectorAll<HTMLSelectElement>('select[data-pg-limit]').forEach((s) =>
    s.addEventListener('change', () => onLimit(Number(s.value) || PAGE_SIZE)),
  );
}
