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
export const KEY_PAUSE = 'ravaa.printpause';
export const KEY_AGENT = 'ravaa.printagent';
export const KEY_LACI = 'ravaa.lacikick';
export const KEY_LACI_BYTES = 'ravaa.lacibytes';

export const AGENT_BAWAAN = 'http://localhost:9100';

/** Perintah kick laci bawaan Epson: `ESC p 0 25 250`
 *  (0x1B 0x70 0x00 0x19 0xFA). Dulu di-hardcode di `bukaLaci()`; kini dapat
 *  diganti per device dari kartu "Cetak struk" — sebagian printer/laci butuh
 *  pin/parameter berbeda. */
export const LACI_BAWAAN: readonly number[] = [0x1b, 0x70, 0x00, 0x19, 0xfa];
export const LACI_BAWAAN_HEX = LACI_BAWAAN.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
/** Batas wajar: perintah kick bukan tempat menempel payload besar. */
export const MAKS_LACI_BYTES = 64;

/** Parse teks hex perintah laci. Menerima `1B 70 00 19 FA`, `0x1B,0x70,...`,
 *  atau deretan rapat `1B700019FA`. Mengembalikan `null` untuk teks kosong,
 *  token bukan byte 00..FF, atau lebih dari `MAKS_LACI_BYTES` — pemanggil
 *  menampilkan pesan validasi, bukan diam-diam memakai perintah salah. */
export function parseDrawerKickBytes(teks: string): number[] | null {
  const bersih = teks.trim();
  if (!bersih) return null;
  let token: string[];
  if (/^[0-9a-f]{4,}$/i.test(bersih) && bersih.length % 2 === 0) {
    token = bersih.match(/.{2}/g) ?? [];
  } else {
    token = bersih
      .split(/[\s,]+/)
      .map((p) => p.trim().replace(/^0x/i, ''))
      .filter(Boolean);
  }
  if (!token.length || token.length > MAKS_LACI_BYTES) return null;
  if (token.some((p) => !/^[0-9a-f]{1,2}$/i.test(p))) return null;
  return token.map((p) => parseInt(p, 16));
}

/** Teks hex ternormalisasi (huruf besar, satu spasi) untuk isi input. */
export function laciBytesHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** Perintah kick laci device ini. Kunci absen/rusak = perintah Epson bawaan;
 *  kegagalan baca localStorage tidak boleh membuat penjualan tunai gagal. */
export function getDrawerKickBytes(): number[] {
  try {
    return parseDrawerKickBytes(localStorage.getItem(KEY_LACI_BYTES) ?? '') ?? [...LACI_BAWAAN];
  } catch {
    return [...LACI_BAWAAN];
  }
}

/** Nilai untuk ditampilkan di input pengaturan. */
export function getDrawerKickHex(): string {
  return laciBytesHex(getDrawerKickBytes());
}

/** Simpan perintah laci. Teks kosong = hapus preferensi (kembali ke Epson
 *  bawaan) dan tetap dianggap sukses. Format salah = `false`, nilai lama
 *  TIDAK diubah. */
export function setDrawerKickBytes(teks: string): boolean {
  const bersih = teks.trim();
  if (!bersih) {
    try {
      localStorage.removeItem(KEY_LACI_BYTES);
    } catch {
      /* private mode: panggilan berikutnya tetap jatuh ke bawaan */
    }
    return true;
  }
  const bytes = parseDrawerKickBytes(bersih);
  if (!bytes) return false;
  try {
    localStorage.setItem(KEY_LACI_BYTES, laciBytesHex(bytes));
  } catch {
    /* private mode: preferensi tidak persisten, tapi sesi ini tetap jalan */
  }
  return true;
}

/** JEDA SEMUA CETAK — keputusan pemilik 2026-10-06: *"jangan print dulu sebelum
 *  saya perintah … menghabiskan kertas terus"*. Selama `true`,
 *  `kirimPrint()` di escpos.ts BERHENTI sebelum menyentuh print-agent:
 *  struk, label harga, invoice ESC/POS, MAUPUN kick laci (bukaLaci) tidak
 *  pernah keluar dari browser — nol risiko kertas terbuang saat dev/test.
 *
 *  Default **PAUSED** (kunci absen = jeda; harus `setPrintPause(false)` untuk
 *  mengaktifkan) — keselamatan kertas didahulukan sampai pemilik memberi
 *  perintah menyala. Nyalakan/matikan lewat kartu "Cetak struk" di halaman
 *  Sistem (saklar "Jeda semua cetak"). Per-device seperti pref lain. */
export function getPrintPause(): boolean {
  try {
    return localStorage.getItem(KEY_PAUSE) !== '0';
  } catch {
    return true; // gagal baca = tetap jeda (aman untuk kertas)
  }
}

export function setPrintPause(jeda: boolean): void {
  try {
    localStorage.setItem(KEY_PAUSE, jeda ? '1' : '0');
  } catch {
    /* private mode: pref tetap berlaku sesi ini via memori pemanggil */
  }
}

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

/** Alamat print-agent device ini (mis. `http://192.168.1.10:9100` bila agent
 *  tidak jalan di PC yang membuka web). Dulu hanya bisa diisi lewat devtools;
 *  sekarang dapat diubah dari kartu "Cetak struk" tanpa menyentuh kode. */
export function getAgentUrl(): string {
  try {
    return (localStorage.getItem(KEY_AGENT) || AGENT_BAWAAN).replace(/\/+$/, '');
  } catch {
    return AGENT_BAWAAN;
  }
}

/** Simpan alamat agent; string kosong = kembali ke bawaan (localhost:9100).
 *  Normalisasi slash akhir supaya `fetch(url + '/print')` tidak menjadi `//print`. */
export function setAgentUrl(url: string): void {
  try {
    const bersih = url.trim().replace(/\/+$/, '');
    if (!bersih || bersih === AGENT_BAWAAN) localStorage.removeItem(KEY_AGENT);
    else localStorage.setItem(KEY_AGENT, bersih);
  } catch {
    /* private mode: pemanggil tetap memakai nilai di layar */
  }
}

/** Kick laci otomatis saat penjualan tunai (default NYALA — perilaku lama).
 *  Matikan di device yang print-agent/printernya tidak terhubung ke laci;
 *  perintah `ESC p` yang tidak dikenal sebagian printer bisa tercetak sebagai
 *  karakter aneh. Per-device karena laci menempel ke printer masing-masing. */
export function getDrawerKick(): boolean {
  try {
    return localStorage.getItem(KEY_LACI) !== '0';
  } catch {
    return true;
  }
}

export function setDrawerKick(nyala: boolean): void {
  try {
    localStorage.setItem(KEY_LACI, nyala ? '1' : '0');
  } catch {
    /* private mode: pref tetap berlaku sesi ini via memori pemanggil */
  }
}
