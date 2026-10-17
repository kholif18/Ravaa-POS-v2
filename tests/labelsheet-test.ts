// Test modul label harga (apps/web/src/labelsheet.ts) — murni, tanpa browser.
// Jalankan: npx tsx labelsheet-test.ts
import {
  SETELAN_AWAL, setelanAwal, normalisasiSetelan, getSetelanLabel, setSetelanLabel,
  ukuranKertas, hitungTataLetak, hitungHalaman, bagiLembar, denganSalinan,
  checksumEan, kodeBarcode, barcodeSvg, kode128, barcode128Svg, MAKS_KODE128, hargaPromo,
  labelHtml, lembarHtml, htmlLembarSemua, htmlDokumenLabel, CSS_LABEL,
  type ProdukCetak,
} from '../apps/web/src/labelsheet.ts';

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

const aqua: ProdukCetak = {
  name: 'Aqua 600ml', sku: 'PRD00001', price: 4000, unit: 'btl',
  barcode: '8991002103017', discount_type: 'rp', discount: 0,
};
// Barcode uji dengan checksum EAN yang VALID (contoh seed 8991002103017
// checksum-nya tidak valid — jangan dipakai untuk asersi encoder).
const EAN13 = '5901234123457';
const EAN8 = '96385074';

console.log('=== A. setelan & normalisasi ===');
eq('preset a4 = 210 × 297', ukuranKertas(SETELAN_AWAL), { lebarMm: 210, tinggiMm: 297 });
eq('preset folio = 215 × 330', ukuranKertas({ ...SETELAN_AWAL, kertas: 'folio' }), { lebarMm: 215, tinggiMm: 330 });
eq('custom pakai angka manual', ukuranKertas({ ...SETELAN_AWAL, kertas: 'custom', lebarMm: 150, tinggiMm: 200 }), { lebarMm: 150, tinggiMm: 200 });
eq('normalisasi kolom 99 -> 6', normalisasiSetelan({ kolom: 99 }).kolom, 6);
eq('normalisasi kolom 0 -> 2', normalisasiSetelan({ kolom: 0 }).kolom, 2);
eq('normalisasi salinan 0 -> 1', normalisasiSetelan({ salinan: 0 }).salinan, 1);
eq('normalisasi kertas asing -> a4', normalisasiSetelan({ kertas: 'letter' }).kertas, 'a4');
ok('normalisasi JSON rusak -> setelan awal utuh', JSON.stringify(normalisasiSetelan(null)) === JSON.stringify(setelanAwal()));
eq('normalisasi isi parsial: sisanya default', normalisasiSetelan({ isi: { nama: false } }).isi.harga, true);
ok('setelanAwal tidak berbagi objek isi', (() => { const a = setelanAwal(); a.isi.nama = false; return setelanAwal().isi.nama === true; })());
ok('getSetelanLabel valid walau tanpa localStorage', getSetelanLabel().kertas === 'a4' && getSetelanLabel().kolom === SETELAN_AWAL.kolom);
ok('setSetelanLabel tidak melempar tanpa localStorage', (() => { try { setSetelanLabel(normalisasiSetelan({ kolom: 5 })); return true; } catch { return false; } })());

console.log('=== B. tata letak & halaman ===');
eq('A4: lebar label 3 kolom', hitungTataLetak(SETELAN_AWAL).lebarLabelMm, 62);
eq('A4: baris per lembar', hitungTataLetak(SETELAN_AWAL).barisPerLembar, 8);
eq('A4: label per lembar', hitungTataLetak(SETELAN_AWAL).perLembar, 24);
eq('setelan sehat tanpa pesan', hitungTataLetak(SETELAN_AWAL).pesan, '');
ok('kertas sempit -> pesan terisi', hitungTataLetak({ ...SETELAN_AWAL, kertas: 'custom', lebarMm: 40, tinggiMm: 60, marginKiri: 10, marginKanan: 10, kolom: 3 }).pesan !== '');
eq('Folio 4 kolom: lebar label', hitungTataLetak({ ...SETELAN_AWAL, kertas: 'folio', kolom: 4 }).lebarLabelMm, 47.25);
eq('25 label -> 2 halaman (24/lembar)', hitungHalaman(25, SETELAN_AWAL), { perLembar: 24, halaman: 2 });
eq('0 label -> 0 halaman', hitungHalaman(0, SETELAN_AWAL).halaman, 0);
eq('bagiLembar 25 label -> [24, 1]', bagiLembar(SETELAN_AWAL, new Array(25).fill(aqua)).map((x) => x.length), [24, 1]);
eq('bagiLembar kosong -> []', bagiLembar(SETELAN_AWAL, []), []);
eq('bagiLembar setelan tak muat -> []', bagiLembar({ ...SETELAN_AWAL, kertas: 'custom', lebarMm: 40, tinggiMm: 60, marginKiri: 10, marginKanan: 10, kolom: 3 }, [aqua]), []);

console.log('=== C. checksum EAN ===');
eq('EAN-13 payload 12 digit', checksumEan('590123412345'), 7);
eq('EAN-8 payload 7 digit', checksumEan('9638507'), 4);
eq('payload nol semua', checksumEan('000000000000'), 0);

console.log('=== D. barcode SVG ===');
ok('EAN-13 valid -> svg', barcodeSvg(EAN13, 10) !== null);
ok('EAN-13: viewBox 117 modul (95 + quiet 22)', barcodeSvg(EAN13, 10)!.includes('viewBox="0 0 117 100"'));
eq('12 digit & 13 digit -> svg identik', barcodeSvg('590123412345', 10), barcodeSvg(EAN13, 10));
eq('kodeBarcode menghitung digit cek', kodeBarcode('590123412345')!.digit, EAN13);
eq('EAN-8: 7 & 8 digit identik', barcodeSvg('9638507', 8), barcodeSvg(EAN8, 8));
eq('EAN-8 7 digit -> lengkap 8', kodeBarcode('9638507')!.digit, EAN8);
eq('barcode non-numerik -> null', barcodeSvg('SKU-XYZ', 10), null);
eq('panjang tak dikenal -> null', barcodeSvg('123456789', 10), null);
eq('kosong -> null', barcodeSvg('', 10), null);
ok('batang tergambar (>= 20 rect)', (barcodeSvg(EAN13, 10)!.match(/<rect/g) ?? []).length >= 20);
ok('tinggi barcode mengikuti setelan', barcodeSvg(EAN13, 12)!.includes('height="12mm"'));

console.log('=== D2. Code 128 (non-EAN / fallback SKU) ===');
// Vektor tetap 'PRD00001' dengan angka dari tabel Wikipedia "Code 128" (sumber
// kedua selain tabel encoder): START B (104) = 11010010000; checksum 24 =
// 11101001100 (104 + 48+100+108+64+80+96+112+136 = 848; 848 mod 103 = 24);
// STOP (106) = 1100011101011. Panjang = 11×(n+2)+13 = 123 modul.
const c128 = kode128('PRD00001')!;
ok('kode128 PRD00001 -> ter-encode', c128 !== null);
eq('mulai dengan START B (104)', c128.modul.slice(0, 11), '11010010000');
eq('checksum 24 + STOP benar', c128.modul.slice(-24), '111010011001100011101011');
eq('panjang modul = 11×(n+2)+13', c128.modul.length, 123);
ok('svg 128: viewBox 145 modul (123 + quiet 22)', barcode128Svg('PRD00001', 10)!.includes('viewBox="0 0 145 100"'));
ok('svg 128: lebar 47.85 mm (145 × 0,33)', barcode128Svg('PRD00001', 10)!.includes('width="47.85mm"'));
ok('svg 128: tinggi mengikuti setelan', barcode128Svg('PRD00001', 12)!.includes('height="12mm"'));
ok(`kode ${MAKS_KODE128} karakter -> masih muat`, kode128('ABCDEFGHIJ') !== null);
eq(`kode ${MAKS_KODE128 + 1} karakter -> null (terlalu lebar)`, kode128('ABCDEFGHIJK'), null);
eq('non-ASCII -> null', kode128('CAFÉ'), null);
eq('kosong -> null', kode128(''), null);
eq('tak muat lebar label -> null', barcode128Svg('PRD00001', 10, 40), null);
ok('muat lebar label normal -> svg', barcode128Svg('PRD00001', 10, 60) !== null);

console.log('=== E. builder label ===');
ok('label memuat nama & harga', labelHtml(SETELAN_AWAL, aqua).includes('Aqua 600ml') && labelHtml(SETELAN_AWAL, aqua).includes('Rp4.000'));
ok('tanpa kaki SKU · satuan (dihapus 2026-10-17 — SKU tampil di barcode)',
  !labelHtml(SETELAN_AWAL, aqua).includes('lb-kaki'));
ok('default ber-border', labelHtml(SETELAN_AWAL, aqua).includes('lb-border'));
ok('border bisa dimatikan', !labelHtml({ ...SETELAN_AWAL, isi: { ...SETELAN_AWAL.isi, border: false } }, aqua).includes('lb-border'));
ok('barcode tampil saat isi.barcode', labelHtml(SETELAN_AWAL, { ...aqua, barcode: EAN13 }).includes('<svg'));
ok('barcode non-EAN pendek -> Code 128 svg', labelHtml(SETELAN_AWAL, { ...aqua, barcode: 'ABC' }).includes('<svg'));
ok('barcode non-EAN kepanjangan -> tercetak sebagai TEKS apa adanya',
  (() => { const h = labelHtml(SETELAN_AWAL, { ...aqua, barcode: 'KODE-12345678' });
    return !h.includes('<svg') && h.includes('lb-barcode-num">KODE-12345678'); })());
ok('barcode kosong -> SKU dipakai sebagai Code 128',
  (() => { const h = labelHtml(SETELAN_AWAL, { ...aqua, barcode: '' });
    return h.includes('<svg') && h.includes('lb-barcode-num">PRD00001'); })());
ok('barcode kosong & SKU panjang -> teks SKU',
  (() => { const h = labelHtml(SETELAN_AWAL, { ...aqua, barcode: '', sku: 'SKU-YANG-PANJANG-SEKALI' });
    return !h.includes('<svg') && h.includes('lb-barcode-num">SKU-YANG-PANJANG-SEKALI'); })());
ok('barcode & SKU kosong -> tanpa blok barcode',
  !labelHtml(SETELAN_AWAL, { ...aqua, barcode: '', sku: '' }).includes('lb-barcode'));
ok('label 4 kolom: SKU 8 char tak muat -> teks (bukan batang terpotong)',
  (() => { const h = labelHtml({ ...SETELAN_AWAL, kolom: 4 }, { ...aqua, barcode: '' });
    return !h.includes('<svg') && h.includes('lb-barcode-num">PRD00001'); })());
ok('nama bisa disembunyikan', !labelHtml({ ...SETELAN_AWAL, isi: { ...SETELAN_AWAL.isi, nama: false } }, aqua).includes('Aqua 600ml'));
ok('nama di-escape', labelHtml(SETELAN_AWAL, { ...aqua, name: 'A<b>&"x"' }).includes('A&lt;b&gt;&amp;&quot;x&quot;'));
{
  const lf = labelHtml({ ...SETELAN_AWAL, fontNamaPt: 11, fontHargaPt: 18 }, aqua);
  ok('font nama & harga mengikuti setelan', lf.includes('font-size:11pt') && lf.includes('font-size:18pt'));
}
ok('lembarHtml membawa geometri mm', (() => {
  const h = lembarHtml(SETELAN_AWAL, [aqua]);
  return h.includes('width:210mm;height:297mm') && h.includes('repeat(3,1fr)') && h.includes('grid-auto-rows:30mm');
})());

console.log('=== F. harga promo ===');
eq('promo pct 25%', hargaPromo({ ...aqua, discount_type: 'pct', discount: 25 }), { pokok: 4000, bayar: 3000 });
eq('promo rp', hargaPromo({ ...aqua, discount_type: 'rp', discount: 500 }), { pokok: 4000, bayar: 3500 });
eq('diskon 0 -> null', hargaPromo(aqua), null);
eq('diskon >= harga -> null', hargaPromo({ ...aqua, discount_type: 'rp', discount: 5000 }), null);
ok('promo tampil saat setelan nyala', labelHtml({ ...SETELAN_AWAL, hargaPromo: true }, { ...aqua, discount_type: 'rp', discount: 500 }).includes('lb-coret'));
ok('promo tersembunyi saat setelan mati', !labelHtml(SETELAN_AWAL, { ...aqua, discount_type: 'rp', discount: 500 }).includes('lb-coret'));

console.log('=== G. dokumen & salinan ===');
ok('dokumen @page A4', htmlDokumenLabel(SETELAN_AWAL, [aqua]).includes('@page{size:210mm 297mm;margin:0;}'));
ok('dokumen @page Folio', htmlDokumenLabel({ ...SETELAN_AWAL, kertas: 'folio' }, [aqua]).includes('@page{size:215mm 330mm;margin:0;}'));
eq('dokumen 25 label -> 2 lembar', (htmlDokumenLabel(SETELAN_AWAL, new Array(25).fill(aqua)).match(/class="lb-lembar"/g) ?? []).length, 2);
ok('lembar terakhir tanpa page-break', CSS_LABEL.includes('.lb-lembar:last-child{page-break-after:auto;}'));
ok('dokumen memicu print saat load', htmlDokumenLabel(SETELAN_AWAL, [aqua]).includes('window.print()'));
ok('dokumen tanpa label -> tanpa lembar', !htmlDokumenLabel(SETELAN_AWAL, []).includes('class="lb-lembar"'));
eq('salinan 3 -> 3 label', denganSalinan([aqua], 3).length, 3);
eq('salinan 1 -> daftar apa adanya', denganSalinan([aqua, aqua], 1).length, 2);
eq('htmlLembarSemua 24 label -> 1 lembar', (htmlLembarSemua(SETELAN_AWAL, new Array(24).fill(aqua)).match(/class="lb-lembar"/g) ?? []).length, 1);

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
