// Preferensi cetak PER DEVICE — disimpan di localStorage browser ini, BUKAN di
// server (`POST /api/settings`), karena keduanya memang beda sifat:
//
//   * Aturan server (stok minus, tolak kadaluarsa) = fakta bisnis yang harus
//     seragam di SEMUA device -> server.
//   * Preferensi cetak = sifat HARDWARE masing-masing PC kasir: satu device
//     menempel ke thermal 58mm, device lain ke Epson L3110 (A4), dan ada device
//     tanpa printer sama sekali (matikan cetak otomatis). Menyimpannya di server
//     justru salah: satu ganti saklar akan memaksa device lain ikut.
//
// Satu sumber kebenaran untuk dua tempat: panel Sistem (kartu "Cetak struk")
// dan scan bar POS (saklar "Cetak struk otomatis"). Keduanya lewat fungsi di
// sini, jadi tidak bisa beda pendapat.

/** Layout struk. `thermal` = 58mm 32 kolom + potong; `a4` = Epson L3110
 *  64 kolom + form-feed (eject) tanpa perintah potong — inkjet tidak punya
 *  pisau, jadi akhir stream-nya adalah 0x0C yang mengeluarkan kertas. */
export type LayoutStruk = 'thermal' | 'a4';

export const KEY_CETAK = 'ravaa.cetak';
export const KEY_LAYOUT = 'ravaa.struklayout';

/** Izin mengirim struk ke printer setelah tiap penjualan/topup (sejak
 *  putaran 11 2026-10-05: modal resume + pilihan Thermal/A4 muncul SETELAH
 *  SETIAP penjualan tanpa syarat — saklar ini hanya menentukan apakah tombol
 *  Thermal/A4 benar-benar mengirim ke printer; klik saat mati = toast).
 *  Default NYALA — toko punya printer dan pelanggan mengharapkan struk;
 *  matikan lewat panel Sistem atau saklar di scan bar kalau device ini
 *  memang tidak punya printer. */
export function getAutoPrint(): boolean {
  try {
    return localStorage.getItem(KEY_CETAK) !== '0';
  } catch {
    return true;
  }
}

export function setAutoPrint(nyala: boolean): void {
  try {
    localStorage.setItem(KEY_CETAK, nyala ? '1' : '0');
  } catch {
    /* private mode: pref tetap berlaku selama sesi via memori pemanggil */
  }
}

/** Layout aktif device ini. Default `thermal` (perangkat bawaan toko);
 *  pindah ke `a4` lewat panel Sistem -> Cetak struk. Nilai rusak/tak dikenal
 *  jatuh balik ke `thermal` — lebih baik cetak pada layout yang memang diuji
 *  daripada mengeluarkan byte yang tidak dikenali printer. */
export function getStrukLayout(): LayoutStruk {
  try {
    return localStorage.getItem(KEY_LAYOUT) === 'a4' ? 'a4' : 'thermal';
  } catch {
    return 'thermal';
  }
}

export function setStrukLayout(layout: LayoutStruk): void {
  try {
    localStorage.setItem(KEY_LAYOUT, layout);
  } catch {
    /* abaikan */
  }
}
