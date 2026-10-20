// Format currency PER DEVICE — disimpan di localStorage browser ini.
//
// Default Rp Indonesia. Format dapat disesuaikan jika toko ingin ganti
// simbol atau pemisah ribuan/desimal. Semua angka uang di layar dan cetak
// harus melalui fungsi di sini, bukan `toLocaleString` langsung di halaman.

export type FormatCurrency = {
  simbol: string;   // mis. 'Rp', '$', '€'
  kode: string;     // 'id-ID', 'en-US', ...
  desimal: number;  // 0, 2, ...
};

export const KEY_CURRENCY = 'ravaa.currency';

export const CURRENCY_BAWAAN: FormatCurrency = {
  simbol: 'Rp',
  kode: 'id-ID',
  desimal: 0,
};

/** Format currency aktif device ini. Default Rp Indonesia tanpa desimal. */
export function getCurrencyFormat(): FormatCurrency {
  try {
    const v = localStorage.getItem(KEY_CURRENCY);
    if (v) {
      const p = JSON.parse(v);
      if (p && typeof p.simbol === 'string' && typeof p.kode === 'string') {
        return {
          simbol: p.simbol,
          kode: p.kode,
          desimal: Number.isInteger(p.desimal) ? p.desimal : CURRENCY_BAWAAN.desimal,
        };
      }
    }
  } catch {
    /* private mode: fallback ke bawaan */
  }
  return { ...CURRENCY_BAWAAN };
}

export function setCurrencyFormat(f: FormatCurrency): void {
  try {
    localStorage.setItem(KEY_CURRENCY, JSON.stringify(f));
  } catch {
    /* private mode */
  }
}

/** Format angka uang sesuai preferensi device.
 *  Contoh default: "Rp 20.000". */
export function formatRupiah(n: number): string {
  const f = getCurrencyFormat();
  try {
    const angka = n.toLocaleString(f.kode, {
      minimumFractionDigits: f.desimal,
      maximumFractionDigits: f.desimal,
    });
    return `${f.simbol} ${angka}`;
  } catch {
    // fallback jika kode locale tidak valid
    const angka = Math.abs(n).toLocaleString('id-ID', {
      minimumFractionDigits: f.desimal,
      maximumFractionDigits: f.desimal,
    });
    const minus = n < 0 ? '-' : '';
    return `${minus}${f.simbol} ${angka}`;
  }
}

/** Format angka uang dengan tanda minus dalam kurung (akuntansi). */
export function formatRupiahAkuntansi(n: number): string {
  const f = getCurrencyFormat();
  if (n < 0) {
    return `(${formatRupiah(-n)})`;
  }
  return formatRupiah(n);
}
