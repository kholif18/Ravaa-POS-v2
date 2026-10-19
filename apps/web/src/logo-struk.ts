// Logo struk thermal (butir ROADMAP 1.6.4, ACC pemilik 19 Okt 2026).
//
// Alur: halaman Sistem mengunggah logo (POST /api/settings/logo — file di
// `img/` sesuai DB, pola avatar) → tiap jalur cetak thermal memanggil
// `strukUntukTercetak()` (escpos.ts) → modul ini mengunduh logo
// (GET /api/settings/logo, endpoint publik) dan mengonversinya di KLIEN jadi
// raster ESC/POS `GS v 0` 1-bit, lalu menyisipkannya di AWAL struk.
//
// Kenapa konversi di klien: server sengaja nol-dependensi (tanpa pemroses
// gambar); canvas browser sudah tersedia di semua device kasir. Kenapa bukan
// localStorage: logo milik TOKO (semua device cetak sama), sumbernya server.
//
// Hasil konversi di-CACHE per sesi halaman — transaksi kedua dan seterusnya
// tidak mengunduh/menghitung ulang. Halaman Sistem memanggil
// `resetLogoStrukCache()` setelah unggah/hapus supaya struk berikutnya ikut
// berubah tanpa reload.
//
// Gagal apa pun (offline, file korup, canvas tak ada) = `null` — struk tetap
// tercetak TANPA logo; hiasan tidak boleh membatalkan transaksi.
//
// Modul ini sengaja TANPA import modul app lain (mis. api/auth) supaya fungsi
// murninya bisa diimpor unit test di Node (escpos-test) — `api.ts` menarik
// `ui/auth.ts` yang memakai `import.meta.env` dan jatuh di luar bundler.

/** Lebar maksimum printer thermal 58mm: 384 dot (48mm @ 8 dot/mm). */
export const LEBAR_LOGO = 384;

/** Ambang luminance (0-255): piksel lebih gelap dari ini menjadi dot hitam. */
const AMBANG = 160;

/** Tinggi maksimum bitmap yang diterima; lebih dari ini hampir pasti salah
 *  unggah (mis. poster) dan akan memakan kertas berpuluh sentimeter. */
const TINGGI_MAKS = 512;

/** Pack bitmap baris-per-baris (`true` = dot hitam) jadi byte data `GS v 0`:
 *  tiap baris dipad sampai kelipatan 8 byte, MSB = piksel paling kiri.
 *  Murni (tanpa DOM) — diuji unit di tests/escpos-test.ts. */
export function packBit(baris: boolean[][]): Uint8Array {
  const tinggi = baris.length;
  const lebar = baris[0]?.length ?? 0;
  const perBaris = Math.ceil(lebar / 8);
  const out = new Uint8Array(perBaris * tinggi);
  for (let y = 0; y < tinggi; y++) {
    const barisY = baris[y];
    for (let x = 0; x < lebar; x++) {
      if (barisY[x]) out[y * perBaris + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** Perintah ESC/POS raster bit-image (`GS v 0` m=0, normal):
 *  `1d 76 30 00 xL xH yL yH <data>`, lebar/tinggi dalam dot. Murni — diuji unit. */
export function perintahRaster(lebar: number, tinggi: number, data: Uint8Array): number[] {
  return [
    0x1d, 0x76, 0x30, 0x00,
    lebar & 0xff, (lebar >> 8) & 0xff,
    tinggi & 0xff, (tinggi >> 8) & 0xff,
    ...data,
  ];
}

/** `undefined` = belum dimuat (akan diunduh), `null` = tidak ada logo/gagal. */
let cache: number[] | null | undefined;

/** Panggil setelah unggah/hapus logo di halaman Sistem supaya struk
 *  berikutnya memakai logo terbaru tanpa reload halaman. */
export function resetLogoStrukCache(): void {
  cache = undefined;
}

/** Decode blob gambar → bitmap 1-bit → byte raster. Lebar diskalakan turun ke
 *  `LEBAR_LOGO` (tidak pernah diperbesar); latar dipaksa putih supaya PNG
 *  transparan tidak menjadi blok hitam. */
async function blobKeRaster(blob: Blob): Promise<number[] | null> {
  const url = URL.createObjectURL(blob);
  let img: HTMLImageElement;
  try {
    img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('logo tidak bisa dibaca'));
      i.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  const skala = Math.min(1, LEBAR_LOGO / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * skala));
  const h = Math.max(1, Math.round(img.naturalHeight * skala));
  if (h > TINGGI_MAKS) return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const baris: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    const barisY: boolean[] = [];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      barisY.push(px[i + 3] >= 128 && lum < AMBANG);
    }
    baris.push(barisY);
  }
  return perintahRaster(w, h, packBit(baris));
}

/** Byte raster logo untuk struk thermal (sudah termasuk header `GS v 0`),
 *  atau `null` bila tidak ada logo / gagal dimuat. Di-cache per sesi.
 *
 *  Server menjawab **204 tanpa body** bila logo belum diunggah (sengaja BUKAN
 *  404 — jalur cetak memanggil endpoint ini tiap sesi, dan 404 rutin mengotori
 *  console device + memerahkan suite e2e yang menjaga "tanpa error console").
 *  404 hanya untuk nilai korup / file hilang. */
export async function logoStrukBytes(): Promise<number[] | null> {
  if (cache !== undefined) return cache;
  try {
    const res = await fetch('/api/settings/logo');
    // 204 = belum ada logo; hasil PASTI → boleh di-cache.
    if (res.status === 204) {
      cache = null;
      return cache;
    }
    if (!res.ok) return null; // korup/hilang — JANGAN cache, coba lagi nanti
    const raster = await blobKeRaster(await res.blob());
    if (raster) cache = raster;
    return raster;
  } catch {
    return null; // offline/jaringan — JANGAN cache, cetak berikutnya coba lagi
  }
}
