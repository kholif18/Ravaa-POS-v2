/** ONE-SUMBER format ribuan NOMINAL (2026-10-27, keputusan pemilik: semua
 *  form nominal di project = titik pemisah LIVE saat mengetik, pola kolom
 *  uang POS) — diekstrak dari pos.ts yang lama punya helper identik
 *  (formatRibu/parseRibu/formatInputRibu). Modul murni + listener DOM;
 *  tidak berhubungan dengan ui/currency.ts (yang itu format DISPLAY rp()
 *  untuk teks statis, bukan input).
 *
 *  KONTRAK PEMAKAI (WAJIB tuntas):
 *  - Input yang hidup di-format WAJIB type="text" + inputmode="numeric"
 *    (type=number tidak kompatibel dengan titik).
 *  - Semua pembaca observer harus akses via bacaNominal inp (atau
 *    strip-digit sendiri) — Number('100.000')===100 dan parseInt berhenti
 *    di titik: jawaban salah diam tiada orang yang melupakannya.
 *  - Prefill nominal 0 -> tulis '' + placeholder="0" (bukan value="0"),
 *    karena formatter menghilangkan leading zero ("01"->"1", "0"->''); */
/* eslint-enable */

/** Nominal -> tampilan bertitik ('50.000'). n <= 0 = '' (kolom uang kosong,
 *  bukan '0' — pola kolom uang diterima POS). Deterministik (tanpa
 *  toLocaleString). */
export function formatNominal(n: number): string {
  if (!(n > 0)) return '';
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Tampilan bertitik ('50.000', 'Rp 50.000', '50abc000') -> angka: ambil
 *  digitnya saja, abaikan pemisah/sampah ketik. Angka raksasa terpotong
 *  ke 12 digit supaya Number() tidak melepas presisi saat kasir salah
 *  tempel — nilai sah terjauh (Rp999.999.999.999) tetap utuh. */
export function parseNominal(v: string): number {
  const digit = (v.match(/\d/g) ?? []).slice(0, 12).join('');
  return Number(digit) || 0;
}

/** pembaca observer baku untuk input nominal yang hidup diformat */
export function bacaNominal(inp: HTMLInputElement | null): number {
  return parseNominal(inp?.value ?? '');
}

/** Format ribuan LIVE saat mengetik + caret dikembalikan ke digit yang sama
 *  (titik sisipan menggeser posisi — tanpa ini caret loncat ke ujung tiap
 *  ketik di tengah angka). Mengembalikan nilai numeriknya (guard NaN). */
export function formatNominalLive(inp: HTMLInputElement): number {
  const digitSebelum = (inp.value.slice(0, inp.selectionStart ?? inp.value.length).match(/\d/g) ?? []).length;
  const nilai = parseNominal(inp.value);
  const tampil = formatNominal(nilai);
  if (inp.value !== tampil) {
    inp.value = tampil;
    let hitung = 0;
    let pos = tampil.length;
    for (let i = 0; i < tampil.length; i++) {
      if (/\d/.test(tampil[i])) hitung++;
      if (hitung >= digitSebelum) { pos = i + 1; break; }
    }
    inp.setSelectionRange(pos, pos);
  }
  return nilai;
}

/** Pasang listener 'input' yang hidup memformat + (opsional) callback
 *  menerima nilai numerik tiap perubahan — callback dipanggil SETELAH input
 *  diformat supaya state rapi. */
export function pasangNominal(inp: HTMLInputElement | null, cb?: (n: number) => void): void {
  if (!inp) return;
  inp.addEventListener('input', () => {
    const n = formatNominalLive(inp);
    cb?.(n);
  });
}

/** Prefill input nominal: 0/NaN = kosong + selalu tulis placeholder="0"
 *  (klausa keluhan "modal awal 0100000" — kotaknya angka 0 akan ikut
 *  terformat padahal kosong). */
export function prefillNominal(inp: HTMLInputElement | null, n: number | '' | null | undefined, ph = '0'): void {
  if (!inp) return;
  inp.value = n === '' || n == null || !(n > 0) ? '' : formatNominal(n);
  if (!inp.getAttribute('placeholder')) inp.setAttribute('placeholder', ph);
}
