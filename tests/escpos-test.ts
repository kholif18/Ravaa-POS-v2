// Test modul ESC/POS (apps/web/src/escpos.ts).
// Jalankan: npx tsx escpos-test.ts
import {
  COLS, ascii, rp, potong, tengah, kanan, labelHarga, teksLabel, gabungLabel,
  keBase64, struk, type ProdukLabel,
} from '../apps/web/src/escpos.ts';

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

/** Decode bytes latin-1 (aman untuk ESC/POS: perintah non-tekstual dibuang). */
const teksDari = (b: number[]): string => {
  let out = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x1b) {                       // ESC @ (2 byte) | ESC E/d/a n (3 byte)
      i += b[i + 1] === 0x40 ? 1 : 2;
      continue;
    }
    if (c === 0x1d) {                       // GS k m n d.. (4+n) | GS V/!/h/w n (3)
      i += b[i + 1] === 0x6b ? 3 + (b[i + 3] ?? 0) : 2;
      continue;
    }
    if (c === 10) { out += '\n'; continue; }   // LF = pemisah baris struk
    if (c >= 32 && c < 127) out += String.fromCharCode(c);
  }
  return out;
};

console.log('=== A. ascii() & format ===');
eq('akses dicabut', ascii('Café Krim'), 'Cafe Krim');
eq('tanda hubung aneh diseragamkan', ascii('A · B – C'), 'A - B - C');
eq('kutip smart jadi biasa', ascii('“halo” ' + "'dunia'"), '"halo" \'dunia\'');
eq('karakter asing dibuang', ascii('Pulpen ✦ ñ'), 'Pulpen n');
eq('emoji dibuang', ascii('Kopi ☕'), 'Kopi');
eq('rp(Rp) aman', rp(2000), 'Rp2.000');
eq('rp desimal dibulatkan', rp(1999.6), 'Rp2.000');
eq('potong 40 jadi 32', potong('x'.repeat(40), COLS).length, COLS);
eq('potong menambah titik', potong('x'.repeat(40), COLS).endsWith('.'), true);
eq('potong pendek tidak dipotong', potong('abc', COLS), 'abc');
eq('tengah rata', JSON.stringify(tengah('ab', 6)), JSON.stringify('  ab  '));
eq('kanan rata', JSON.stringify(kanan('ab', 6)), JSON.stringify('    ab'));

console.log('=== B. semua baris pratinjau <= 32 kolom ===');
const contoh: ProdukLabel = {
  name: 'Sampoerna Mild (keteng/batang)', sku: 'RK-SMP-KETENG', price: 4000, unit: 'batang', barcode: '8991002103017',
};
for (const p of [
  contoh,
  { ...contoh, name: 'A' .repeat(80), sku: 'SANGAT-PANJANG-BANGET-UNTUK-SATU-BARIS-LABEL', barcode: null },
  { ...contoh, name: 'Kopi Kapal Api Special Sachet 2026', unit: null, barcode: '12345' },
] as ProdukLabel[]) {
  const baris = teksLabel(p);
  const panjang = baris.map((b) => b.length);
  ok(`<= ${COLS} kolom: "${p.name.slice(0, 24)}…"`, Math.max(...panjang) <= COLS,
    baris.filter((b) => b.length > COLS).map((b) => `${b.length}:${b}`));
}
ok('baris terpanjang pratinjau', Math.max(...teksLabel(contoh).map((b) => b.length)) <= COLS, teksLabel(contoh));

console.log('=== C. labelHarga -> bytes ===');
{
  const b = labelHarga(contoh);
  const s = teksDari(b);
  ok('memuat nama', s.includes('Sampoerna Mild'));
  ok('memuat SKU', s.includes('RK-SMP-KETENG'));
  ok('memuat harga', s.includes('Rp4.000'));
  ok('diawali INIT (ESC @)', b[0] === 0x1b && b[1] === 0x40);
  ok('diakhiri CUT (GS V 0)', b[b.length - 3] === 0x1d && b[b.length - 2] === 0x56 && b[b.length - 1] === 0x00);
  ok('ada perintah feed sebelum cut', b.some((_, i) => b[i] === 0x1b && b[i + 1] === 0x64 && b[i + 2] === 3));
  ok('ada perintah ukuran 2x2 (GS ! 0x11)', b.includes(0x1d) && b.includes(0x21) && b.includes(0x11));
}
console.log('=== D. barcode ===');
{
  const b = labelHarga(contoh);
  const i = b.findIndex((_, k) => b[k] === 0x1d && b[k + 1] === 0x6b);
  ok('EAN13 13 digit -> GS k m=67', i >= 0 && b[i + 2] === 67, i >= 0 ? b.slice(i, i + 6) : 'tidak ada GS k');
  ok('panjang data = 13', i >= 0 && b[i + 3] === 13, i >= 0 ? b[i + 3] : '-');
}
{
  const b = labelHarga({ ...contoh, barcode: '012345678901' }); // 12 digit
  const i = b.findIndex((_, k) => b[k] === 0x1d && b[k + 1] === 0x6b);
  ok('12 digit -> EAN13 m=67', i >= 0 && b[i + 2] === 67);
}
{
  const b = labelHarga({ ...contoh, barcode: '0123456' }); // 7 digit
  const i = b.findIndex((_, k) => b[k] === 0x1d && b[k + 1] === 0x6b);
  ok('7 digit -> EAN8 m=68', i >= 0 && b[i + 2] === 68);
}
{
  const b = labelHarga({ ...contoh, barcode: 'BUKAN-ANGKA' });
  const ada = b.some((_, k) => b[k] === 0x1d && b[k + 1] === 0x6b);
  ok('barcode non-angka TIDAK dikirim sebagai barcode', !ada);
  ok('tapi tetap tercetak sebagai teks', teksDari(b).includes('BUKAN-ANGKA'));
}
{
  const b = labelHarga({ ...contoh, barcode: '123456789012345' }); // 15 digit
  const ada = b.some((_, k) => b[k] === 0x1d && b[k + 1] === 0x6b);
  ok('15 digit (di luar EAN/UPC) TIDAK dikirim', !ada);
}
{
  const b = labelHarga({ ...contoh, barcode: null });
  ok('tanpa barcode -> tanpa perintah GS k', !b.some((_, k) => b[k] === 0x1d && b[k + 1] === 0x6b));
}

console.log('=== E. gabung label & base64 ===');
{
  const gabung = gabungLabel([contoh, contoh, contoh]);
  const satu = labelHarga(contoh);
  eq('3 label = 3x panjang', gabung.length, satu.length * 3);
  const potongCount = gabung.filter((_, i) => gabung[i] === 0x1d && gabung[i + 1] === 0x56 && gabung[i + 2] === 0x00).length;
  eq('ada 3 potongan', potongCount, 3);
  const b64 = keBase64(gabung);
  ok('base64 valid', /^[A-Za-z0-9+/=]+$/.test(b64));
  const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  eq('base64 roundtrip', back.length, gabung.length);
}
{
  // String.fromCharCode(...besar) bisa overflow stack; uji ukuran wajar
  const besar = new Array(5000).fill(65);
  const b64 = keBase64(besar);
  const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  eq('5000 byte tetap roundtrip', back.length, 5000);
}

console.log('=== F. struk ===');
const strukJual = {
  judul: 'TOKO MAJU JAYA',
  subjudul: 'Jl. Merdeka No 1',
  meta: ['27/09/2026 19:12 · No. a1b2c3d4', 'Kasir: Budi', 'Shift: 1'],
  items: [
    { name: 'Aqua 600ml', qty: 2, price: 3000 },
    { name: 'Pulpen Hitam', qty: 1, price: 2000 },
    { name: 'Kopi Kapal Api Special Sachet', qty: 5, price: 1500 },
  ],
  baris: [
    { kiri: 'Subtotal', kanan: 'Rp15.500' },
    { kiri: 'Diskon', kanan: '-Rp500' },
    { kiri: 'TOTAL', kanan: 'Rp15.000', tebal: true },
    { kiri: 'Tunai', kanan: 'Rp20.000' },
    { kiri: 'Kembalian', kanan: 'Rp5.000' },
  ],
  kaki: ['Terima kasih sudah berbelanja'],
};
{
  const b = struk(strukJual);
  const s2 = teksDari(b);
  ok('diawali INIT', b[0] === 0x1b && b[1] === 0x40);
  ok('diakhiri CUT', b[b.length - 3] === 0x1d && b[b.length - 2] === 0x56 && b[b.length - 1] === 0x00);
  ok('memuat nama toko', s2.includes('TOKO MAJU JAYA'));
  ok('memuat no transaksi', s2.includes('a1b2c3d4'));
  ok('memuat kasir', s2.includes('Kasir: Budi'));
  ok('memuat item dgn qty', s2.includes('2 x Aqua 600ml'));
  ok('memuat line total', s2.includes('Rp6.000'));
  ok('memuat subtotal & diskon', s2.includes('Subtotal') && s2.includes('-Rp500'));
  ok('memuat TOTAL', s2.includes('TOTAL'));
  ok('memuat kembalian', s2.includes('Rp5.000'));
  ok('memuat kaki', s2.includes('Terima kasih sudah berbelanja'));
  ok('ada garis pemisah', s2.includes('-'.repeat(COLS)));

  // TOTAL ditebalkan: sebelum "TOTAL" harus ada ESC E 1, sesudahnya ESC E 0
  const idx = b.findIndex((_, i) =>
    b[i] === 0x1b && b[i + 1] === 0x45 && b[i + 2] === 1 &&
    b.slice(i + 3, i + 3 + 'TOTAL'.length).every((c, k) => c === 'TOTAL'.charCodeAt(k)));
  ok('baris TOTAL dicetak tebal', idx >= 0, idx);

  // semua baris teks <= 32 kolom
  const barisStruk = s2.match(/[\x20-\x7E]+/g) ?? [];
  const lewat = barisStruk.filter((x) => x.length > COLS && !x.startsWith('-'.repeat(3)));
  ok('semua baris struk <= 32 kolom', lewat.length === 0, lewat.slice(0, 3));
}
{
  // struk topup: tanpa item -> tanpa "(tanpa item)" dan tanpa garis ganda
  const b = struk({
    judul: 'TOKO MAJU JAYA',
    subjudul: 'TOPUP Pulsa',
    meta: ['27/09/2026 19:12 · No. b1c2d3e4'],
    items: [],
    baris: [
      { kiri: 'Nomor HP tujuan', kanan: '081234567890' },
      { kiri: 'Nominal', kanan: 'Rp50.000' },
      { kiri: 'Admin', kanan: 'Rp3.000' },
      { kiri: 'TOTAL', kanan: 'Rp53.000', tebal: true },
      { kiri: 'Kembalian', kanan: 'Rp2.000' },
    ],
  });
  const s2 = teksDari(b);
  ok('struk topup TIDAK mencetak "(tanpa item)"', !s2.includes('tanpa item'));
  const garisCount = (s2.match(/-{32}/g) || []).length;
  ok('hanya 2 garis (tanpa blok item)', garisCount === 2, garisCount);
  ok('memuat nominal & admin', s2.includes('Rp50.000') && s2.includes('Rp3.000'));
  const barisStruk = s2.match(/[\x20-\x7E]+/g) ?? [];
  ok('semua baris <= 32', barisStruk.filter((x) => x.length > COLS && !x.startsWith('----')).length === 0);
}
{
  // nama item sangat panjang: uang tetap menempel di tepi kanan
  const b = struk({
    judul: 'T',
    meta: [],
    items: [{ name: 'X'.repeat(60), qty: 3, price: 1500 }],
    baris: [{ kiri: 'TOTAL', kanan: 'Rp4.500', tebal: true }],
  });
  const s2 = teksDari(b);
  const barisItem = s2.split(/\n|\r/).find((x) => x.includes('Rp4.500'));
  ok('item panjang tidak menggeser kolom uang', barisItem !== undefined && barisItem.trimEnd().length <= COLS,
    barisItem);
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
