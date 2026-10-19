// Harga borongan per jumlah qty (2026-10-19) — model "kelipatan paket".
//
// KEPUTUSAN PEMILIK (dari contoh nyata toko, 2026-10-18/19):
//   - cetak foto 3x4 Rp1.000/lembar -> "beli 6 = Rp5.000";
//   - buku tulis Rp3.500           -> "beli 10 = Rp33.000".
// Arti aturan: SETIAP kelipatan qty berharga paket, sisanya harga normal —
//   foto: 6 = 5.000; 7 = 5.000 + 1.000 = 6.000; 12 = 2 x 5.000 = 10.000;
//   buku: 10 = 33.000; 12 = 33.000 + 2 x 3.500 = 40.000; 20 = 2 x 33.000.
//   BUKAN "qty >= 6 semua jadi 5.000" — pola itu akan merugikan toko saat qty
//   besar, dan tidak cocok dengan harga per lembar yang dipakai pemilik.
//
// Aturan lain (keputusan pemilik 2026-10-19, semua opsi rekomendasi diterima):
//   - Berlaku untuk barang MAUPUN jasa (opt-in per produk; produk tanpa baris
//     `product_borongan` berperilaku persis seperti sebelumnya);
//   - HANYA untuk SATUAN DASAR. Pak/dus memakai harga `product_units` sendiri;
//     borongan dan pak tidak pernah dicampur dalam satu baris;
//   - Interaksi harga grosir: potongan dihitung dari HARGA BARIS saat itu
//     (ecer ATAU grosir), sehingga hasil akhirnya otomatis "yang termurah
//     menang" tanpa menumpuk dua aturan (mis. grosir 900/lbr + paket 6=5.000:
//     qty 7 = 5.000 + 900 = 5.900 — bukan 5.000 + grosir penuh 6.300);
//   - Server tetap penjaga harga: yang dikirim ke `POST /api/sales` tetap
//     `items[].price` terkunci + `items[].discount` (jalur diskon baris yang
//     sudah tervalidasi `0 <= discount <= qty*price`). Modul ini murni hitungan
//     client untuk MENAMPILKAN potongan; bukan sumber harga baru di server.
//
// Matematika: total termurah untuk `qty` satuan = min-cost cover dengan
// "koin" paket (`qty` satuan seharga `price`) dan "koin" 1 satuan (harga
// normal). DP O(qty x jumlah tingkat) — jumlah tingkat realistis 1-3, qty
// toko realistis < 10.000, jadi tidak terasa di UI.

export type TingkatBorongan = { qty: number; price: number };

/** Batas qty yang dihitung DP penuh. Di atas ini hanya mungkin dari salah
 *  ketik (kolom Qty POS tidak membatasi angka ketikan tangan) — pakai
 *  aproksimasi siklus tingkat termurah supaya UI tidak beku. */
const MAKS_DP = 100_000;

/** Total harga termurah untuk `qty` satuan dengan aturan borongan `tiers`.
 *  Tanpa tingkat yang sah -> `qty x hargaSatuan` (perilaku lama). */
export function totalBorongan(
  qty: number,
  hargaSatuan: number,
  tiers: readonly TingkatBorongan[] | null | undefined,
): number {
  const n = Math.floor(Number(qty));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const dasar = Math.max(0, Math.round(Number(hargaSatuan) || 0));
  // Validasi ringan di sisi baca: data cache bisa berasal dari versi lain /
  // payload impor — baris rusak diabaikan, bukan membuat total NaN.
  const paket = (tiers ?? []).filter(
    (t) => Number.isInteger(t?.qty) && t.qty >= 2 && Number.isFinite(t?.price) && t.price >= 0,
  );
  if (paket.length === 0) return n * dasar;
  if (n > MAKS_DP) {
    // Hanya mungkin dari salah ketik: pakai tingkat dengan harga per unit
    // termurah berulang sebanyak mungkin, sisanya dihitung DP kecil.
    const t = paket.reduce((a, b) => (b.price / b.qty < a.price / a.qty ? b : a));
    const m = Math.floor(n / t.qty);
    return m * t.price + totalBorongan(n - m * t.qty, dasar, paket);
  }
  // best[i] = total termurah untuk i satuan (0..n).
  const best = new Array<number>(n + 1);
  best[0] = 0;
  for (let i = 1; i <= n; i += 1) {
    let v = best[i - 1] + dasar; // ambil 1 satuan dengan harga normal
    for (const t of paket) {
      if (t.qty <= i) v = Math.min(v, best[i - t.qty] + t.price);
    }
    best[i] = v;
  }
  return best[n];
}

/** Potongan rupiah untuk `qty` satuan = harga normal penuh - total termurah.
 *  Selalu >= 0 dan <= qty x hargaSatuan (di-clamp pemanggil ke jumlah baris). */
export function diskonBorongan(
  qty: number,
  hargaSatuan: number,
  tiers: readonly TingkatBorongan[] | null | undefined,
): number {
  const n = Math.floor(Number(qty));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const dasar = Math.max(0, Math.round(Number(hargaSatuan) || 0));
  return Math.max(0, n * dasar - totalBorongan(n, dasar, tiers));
}
