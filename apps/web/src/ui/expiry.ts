// Status kadaluarsa produk — SUMBER BERSAMA tabel Produk dan layar POS.
//
// Sebelum 2026-09-30 dua fungsi ini hidup duplikat di `pages/products.ts`;
// POS kini ikut memakainya (strip peringatan + badge baris keranjang), jadi
// ambang hari dan format tanggal tidak boleh berdiri sendiri-sendiri — kalau
// salah satu diubah, tabel dan keranjang harus melihat angka yang sama.

/** Batas "segera kadaluarsa" dalam hari. 30 hari = satu siklus belanja toko. */
export const AMBAT_EXPIRY = 30;

export type StatusExpiry = 'lewat' | 'dekat' | 'jauh' | null;

/** Status kadaluarsa: `lewat` (melewati hari ini) / `dekat` (<= 30 hari) / `jauh`.
 *
 *  Batas harinya dihitung dari akhir hari (`T23:59:59`) supaya tanggal hari ini
 *  masih dihitung `dekat`, bukan `lewat` — kasir baru boleh menandai produk
 *  lewat setelah tanggalnya benar-benar lewat. Tanggal tidak sah (null/kosong)
 *  mengembalikan `null`: produk tanpa tanggal memang tidak punya status. */
export function statusExpiry(iso: string | null): StatusExpiry {
  if (!iso) return null;
  const t = Date.parse(`${iso}T23:59:59`);
  if (Number.isNaN(t)) return null;
  const hari = (t - Date.now()) / 86_400_000;
  return hari < 0 ? 'lewat' : hari <= AMBAT_EXPIRY ? 'dekat' : 'jauh';
}

/** Tanggal kadaluarsa pendek ("15 Okt 2026"). Tanggal tidak sah ditampilkan
 *  apa adanya, jadi struk/tabel tidak pernah menyembunyikan data rusak. */
export function tglExpiry(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00`);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}
