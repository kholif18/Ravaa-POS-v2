// Test modul harga borongan (apps/web/src/borongan.ts) — murni, tanpa browser.
// Jalankan: npx tsx tests/borongan-test.ts
//
// Angka acuan = contoh NYATA pemilik (2026-10-18/19): cetak foto 3x4
// Rp1.000/lembar "beli 6 = Rp5.000" dan buku tulis Rp3.500 "beli 10 =
// Rp33.000". Semua hasil di bawah harus cocok dengan aritmetika toko:
// 7 lembar = 5.000 + 1.000, 12 lembar = 2 x 5.000, 12 buku = 33.000 + 7.000.
import { totalBorongan, diskonBorongan, type TingkatBorongan } from '../apps/web/src/borongan.ts';

let lolos = 0, gagal = 0;
const ok = (n: string, c: boolean, info: unknown = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${JSON.stringify(info)}` : ''}`); }
};
const eq = (n: string, a: unknown, b: unknown) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}\n         dapat : ${JSON.stringify(a)}\n         harap : ${JSON.stringify(b)}`); }
};

// Aturan contoh pemilik.
const FOTO: TingkatBorongan[] = [{ qty: 6, price: 5000 }];
const BUKU: TingkatBorongan[] = [{ qty: 10, price: 33000 }];

console.log('=== A. contoh pemilik: foto Rp1.000/lembar, 6 -> Rp5.000 ===');
eq('1 lembar = harga normal', totalBorongan(1, 1000, FOTO), 1000);
eq('5 lembar belum capai paket', totalBorongan(5, 1000, FOTO), 5000);
eq('6 lembar = 5.000 (potongan 1.000)', totalBorongan(6, 1000, FOTO), 5000);
eq('7 lembar = 5.000 + 1.000', totalBorongan(7, 1000, FOTO), 6000);
eq('11 lembar = 5.000 + 5 x 1.000', totalBorongan(11, 1000, FOTO), 10000);
eq('12 lembar = 2 paket x 5.000', totalBorongan(12, 1000, FOTO), 10000);
eq('18 lembar = 3 paket (tanpa sisa)', totalBorongan(18, 1000, FOTO), 15000);
eq('potongan 7 lembar = 1.000 (harga normal 7.000)', diskonBorongan(7, 1000, FOTO), 1000);
eq('potongan 12 lembar = 2.000', diskonBorongan(12, 1000, FOTO), 2000);

console.log('=== B. contoh pemilik: buku Rp3.500, 10 -> Rp33.000 ===');
eq('9 buku belum capai paket = 31.500', totalBorongan(9, 3500, BUKU), 31500);
eq('10 buku = 33.000 (potongan 2.000)', totalBorongan(10, 3500, BUKU), 33000);
eq('12 buku = 33.000 + 2 x 3.500 = 40.000', totalBorongan(12, 3500, BUKU), 40000);
eq('20 buku = 2 paket x 33.000', totalBorongan(20, 3500, BUKU), 66000);
eq('25 buku = 2 paket + 5 buku', totalBorongan(25, 3500, BUKU), 83500);
eq('potongan 20 buku = 4.000', diskonBorongan(20, 3500, BUKU), 4000);

console.log('=== C. tanpa aturan / data aneh -> perilaku lama ===');
eq('tiers [] = harga normal', totalBorongan(7, 1000, []), 7000);
eq('tiers null = harga normal', totalBorongan(7, 1000, null), 7000);
eq('tiers undefined = harga normal', totalBorongan(7, 1000, undefined), 7000);
eq('tanpa aturan -> potongan 0', diskonBorongan(7, 1000, []), 0);
eq('qty 0 -> 0', totalBorongan(0, 1000, FOTO), 0);
eq('qty pecahan 6.9 -> dibulatkan ke bawah (6)', totalBorongan(6.9, 1000, FOTO), 5000);
eq('harga jual 0 -> 0 (tanpa potongan)', diskonBorongan(6, 0, FOTO), 0);
eq(
  'tier rusak diabaikan (qty 1 / harga negatif / qty 0)',
  totalBorongan(7, 1000, [{ qty: 1, price: 500 }, { qty: 6, price: -100 }, { qty: 0, price: 0 }]),
  7000,
);
eq('tier tidak lebih murah -> potongan 0 (defensif)', diskonBorongan(6, 1000, [{ qty: 6, price: 6000 }]), 0);

console.log('=== D. beberapa tingkatan + kombinasi termurah ===');
// Tingkat 3 -> 2.800 dan 10 -> 9.000 pada harga 1.000: qty 10 lebih murah
// paket langsung (9.000) daripada 3 paket + 1 satuan (8.400 + 1.000).
eq('qty 10 pilih satu-satunya kombinasi termurah', totalBorongan(10, 1000, [{ qty: 3, price: 2800 }, { qty: 10, price: 9000 }]), 9000);
eq('qty 12 = 9.000 + 2 x 1.000 (bukan 4 x 2.800)', totalBorongan(12, 1000, [{ qty: 3, price: 2800 }, { qty: 10, price: 9000 }]), 11000);
eq('qty 9 = 3 x 2.800 = 8.400', totalBorongan(9, 1000, [{ qty: 3, price: 2800 }, { qty: 10, price: 9000 }]), 8400);
// Dua tingkatan pada produk yang sama: 6 -> 5.000 dan 12 -> 9.500.
eq('qty 12 pakai paket besarnya (9.500 < 2 x 5.000)', totalBorongan(12, 1000, [{ qty: 6, price: 5000 }, { qty: 12, price: 9500 }]), 9500);
eq('qty 18 = 9.500 + 5.000', totalBorongan(18, 1000, [{ qty: 6, price: 5000 }, { qty: 12, price: 9500 }]), 14500);

console.log('=== E. guard qty besar (hanya mungkin salah ketik) ===');
// Di atas batas DP aproksimasi greedy dipakai — angka tetap pasti & benar
// untuk paket tunggal: 200.000 = 33.333 paket x 5.000 + 2 x 1.000.
eq('qty 200.000 tetap dihitung & benar', totalBorongan(200000, 1000, FOTO), 166667000);
eq('qty besar tanpa aturan = qty x harga', totalBorongan(200000, 1000, []), 200000000);

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
