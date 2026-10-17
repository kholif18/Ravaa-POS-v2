// Test modul ESC/POS (apps/web/src/escpos.ts).
// Jalankan: npx tsx escpos-test.ts
//
// Label harga TIDAK diuji di sini lagi: sejak 2026-10-17 halaman #/labels
// memakai cetak lembar browser (apps/web/src/labelsheet.ts) — suite label ada
// di labelsheet-test.ts + e2e-label.mjs. Blok ESC/POS label sudah dihapus.
import {
  COLS, COLS_A4, ascii, rp, potong, tengah, kanan,
  keBase64, struk, strukA4, strukUntuk, bukaLaci,
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
    if (c === 0x1d) {                       // GS V/!/h/w n (3 byte)
      i += 2;
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

console.log('=== B. base64 (jalur kirim print-agent) ===');
{
  const bytes = struk({
    judul: 'T', meta: [], items: [{ name: 'X', qty: 1, price: 1000 }],
    baris: [{ kiri: 'TOTAL', kanan: 'Rp1.000', tebal: true }],
  });
  const b64 = keBase64(bytes);
  ok('base64 valid', /^[A-Za-z0-9+/=]+$/.test(b64));
  const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  eq('base64 roundtrip', back.length, bytes.length);
}
{
  // String.fromCharCode(...besar) bisa overflow stack; uji ukuran wajar
  const besar = new Array(5000).fill(65);
  const b64 = keBase64(besar);
  const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  eq('5000 byte tetap roundtrip', back.length, 5000);
}

console.log('=== C. struk ===');
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

console.log('=== D. struk A4 (Epson L3110) & pilihan layout ===');
{
  const b = strukA4(strukJual);
  const s2 = teksDari(b);
  ok('A4: diawali INIT', b[0] === 0x1b && b[1] === 0x40);
  // Akhir WAJIB 1b 64 03 0c — FEED margin lalu Form Feed (eject inkjet).
  ok('A4: diakhiri FEED(3) + Form Feed 0x0C',
    b[b.length - 4] === 0x1b && b[b.length - 3] === 0x64 && b[b.length - 2] === 0x03 && b[b.length - 1] === 0x0c,
    b.slice(-6));
  ok('A4: TANPA perintah potong (GS V 0)',
    !b.some((_, i) => b[i] === 0x1d && b[i + 1] === 0x56 && b[i + 2] === 0x00));
  ok('A4: judul dobel lebar (GS ! 0x10)',
    b.some((_, i) => b[i] === 0x1d && b[i + 1] === 0x21 && b[i + 2] === 0x10));
  ok('A4: judul + kasir + TOTAL + kaki lengkap',
    s2.includes('TOKO MAJU JAYA') && s2.includes('Kasir: Budi') && s2.includes('TOTAL') && s2.includes('Rp15.000')
      && s2.includes('Terima kasih sudah berbelanja'));
  ok('A4: item dgn qty tetap ada', s2.includes('2 x Aqua 600ml'));
  ok('A4: garis pemisah 64 kolom', s2.includes('-'.repeat(COLS_A4)));
  const barisA4 = s2.match(/[\x20-\x7E]+/g) ?? [];
  const lewatA4 = barisA4.filter((x) => x.length > COLS_A4);
  ok('A4: semua baris <= 64 kolom', lewatA4.length === 0, lewatA4.slice(0, 3));
}
{
  // strukUntuk: node tidak punya localStorage -> pref = thermal (default),
  // dan parameter eksplisit harus memilih builder yang tepat.
  eq('strukUntuk tanpa pref = struk thermal', strukUntuk(strukJual), struk(strukJual));
  eq('strukUntuk(..., "thermal") = struk thermal', strukUntuk(strukJual, 'thermal'), struk(strukJual));
  eq('strukUntuk(..., "a4") = strukA4', strukUntuk(strukJual, 'a4'), strukA4(strukJual));
}
{
  // bukaLaci (Tahap 4a, kick ESC/POS): 5 byte persis ESC p m t1 t2 —
  // 0x1B 0x70 0x00 0x19 0xFA. Dipakai POS untuk penjualan tunai OTOMATIS
  // (tanpa syarat saklar cetak); byte ini wajib dikenali printer thermal.
  eq('bukaLaci = ESC p 00 19 FA (5 byte)', bukaLaci(), [0x1b, 0x70, 0x00, 0x19, 0xfa]);
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
