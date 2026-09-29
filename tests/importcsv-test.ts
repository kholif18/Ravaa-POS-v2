// Test parser Impor Produk (apps/web/src/importcsv.ts).
// Jalankan: npx tsx importcsv-test.ts
let gagal = 0, lolos = 0;
function ok(nama: string, cond: boolean, info: unknown = ''): void {
  if (cond) { lolos++; console.log(`  OK   ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama} ${info !== '' ? `| ${JSON.stringify(info)}` : ''}`); }
}
/** Deep-equal yang MENGABAIKAN urutan key objek: payload import memang
 *  membangun properti dalam urutan kolom CSV, jadi membandingkan JSON.stringify
 *  langsung akan menyalahkan test, bukan kode. */
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = norm(o[k]);
    return out;
  }
  return v;
}
function eq(nama: string, a: unknown, b: unknown): void {
  const same = JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  if (same) { lolos++; console.log(`  OK   ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}\n         dapat : ${JSON.stringify(a)}\n         harap : ${JSON.stringify(b)}`); }
}

import { parseTable, mapRows, parseAngka, parseAktif, bacaStok, csvProduk, csvStok, CONTOH_KOLOM, HEADER_ARONIUM_ORI, HEADER_STOK, HEADER_TEMPLATE, templateProduk, type ProdukEkspor } from '../apps/web/src/importcsv.ts';

console.log('=== A. parseTable: pemisah & kutip ===');
{
  const t = parseTable('sku,nama,harga\nA1,Aqua,1500\nB1,Indomie,2500\n');
  eq('judul terbaca', t.header, ['sku', 'nama', 'harga']);
  eq('2 baris data', t.rows.length, 2);
  eq('baris 1', t.rows[0], ['A1', 'Aqua', '1500']);
}
{
  // koma di dalam kutip tidak boleh memecah sel
  const t = parseTable('sku,nama\nX,"Bimoli, 2 liter"\n');
  eq('koma dalam kutip = satu sel', t.rows[0], ['X', 'Bimoli, 2 liter']);
}
{
  const t = parseTable('sku,nama\nX,"dia bilang ""halo"""\n');
  eq('kutip ganda jadi kutip tunggal', t.rows[0], ['X', 'dia bilang "halo"']);
}
{
  const t = parseTable('sku,nama\nX,"baris\nkedua"\n');
  eq('baris baru dalam kutip tetap 1 baris', t.rows.length, 1);
  eq('isinya baris baru', t.rows[0][1], 'baris\nkedua');
}
{
  // tempel dari Excel -> tab
  const t = parseTable('sku\tnama\tharga\nA1\tAqua\t1500\n');
  eq('TAB terdeteksi (tempelan Excel)', t.delim, '\t');
  eq('header TSV', t.header, ['sku', 'nama', 'harga']);
  eq('isi TSV', t.rows[0], ['A1', 'Aqua', '1500']);
}
{
  const t = parseTable('sku;nama;harga\nA1;Aqua;1500\n');
  eq('; terdeteksi', t.delim, ';');
  eq('header ; ', t.header, ['sku', 'nama', 'harga']);
}
{
  const t = parseTable('\uFEFFsku,nama\nA1,Aqua\n');
  eq('BOM dibuang', t.header[0], 'sku');
}
{
  const t = parseTable('sku,nama\nA1,Aqua\n\n\nB1,Indomie\n');
  eq('baris kosong dibuang', t.rows.length, 2);
}
{
  const t = parseTable('sku,nama\nA1,Aqua\n\n\n');
  eq('baris kosong di kaki file dibuang', t.rows.length, 1);
}
{
  const t = parseTable('   ');
  eq('teks kosong -> tabel kosong', { h: t.header.length, r: t.rows.length }, { h: 0, r: 0 });
}
{
  const t = parseTable('sku,nama\nA1,akhir-tanpa-newline');
  eq('tanpa \\n akhir tetap terbaca', t.rows[0], ['A1', 'akhir-tanpa-newline']);
}

console.log('=== B. parseAngka ===');
for (const [inN, want] of [
  ['1500', 1500], ['1.500', 1500], ['1.500,50', 1500.5], ['1500,50', 1500.5],
  ['1,500', 1500], ['1,234,567', 1234567], ['1,5', 1.5], ['0', 0],
  ['  2500  ', 2500], ['Rp 3000', 3000], ['Rp 3000'.replace('Rp ', ''), 3000],
] as [string, number][]) {
  eq(`parseAngka(${JSON.stringify(inN)}) = ${want}`, parseAngka(inN), want);
}
eq('parseAngka(abc) = null', parseAngka('abc'), null);
eq('parseAngka(kosong) = null', parseAngka('   '), null);
eq('parseAngka(12ab) = null', parseAngka('12ab'), null);

console.log('=== C. parseAktif ===');
eq('ya -> 1', parseAktif('ya'), 1);
eq('aktif -> 1', parseAktif('AKTIF'), 1);
eq('1 -> 1', parseAktif('1'), 1);
eq('tidak -> 0', parseAktif('tidak'), 0);
eq('nonaktif -> 0', parseAktif('Nonaktif'), 0);
eq('0 -> 0', parseAktif('0'), 0);
eq('kosong -> null (jangan kirim kunci)', parseAktif(''), null);
eq('ngawur -> null', parseAngka('x') === null && parseAktif('barang') === null, true);

console.log('=== D. mapRows ===');
const KAT = [{ slug: 'atk', name: 'Alat Tulis Kantor' }, { slug: 'snack', name: 'Snack' }];
// 'bungkus' ikut dimock karena dipakai master seed (SKU rook bungkus).
const SAT = [
  { slug: 'pcs', name: 'Pcs' }, { slug: 'lembar', name: 'Lembar' },
  { slug: 'bungkus', name: 'Bungkus' },
];
const kosong = { kategori: KAT, satuan: SAT, adaSku: (_: string) => false };
const satuanS = (tb: ReturnType<typeof parseTable>) => mapRows(tb, kosong);

{
  const r = satuanS(parseTable('sku,nama,kategori,satuan,harga,modal,stok\nA1,Aqua Botol,atk,pcs,1500,1000,12\n'));
  eq('1 baris hasil', r.length, 1);
  eq('payload benar', r[0].data, { sku: 'A1', name: 'Aqua Botol', category_slug: 'atk', unit: 'pcs', price: 1500, cost: 1000, stock: 12 });
  eq('aksi baru', r[0].aksi, 'baru');
  eq('tanpa error', r[0].error, null);
}
{
  // kategori ditulis sebagai NAMA, bukan slug
  const r = satuanS(parseTable('nama,kategori,harga\nMie,Alat Tulis Kantor,2500\n'));
  eq('nama kategori -> slug', r[0].data?.category_slug, 'atk');
  eq('SLUG kategori (case beda) juga jalan', satuanS(parseTable('nama,kategori\nMie,ATK\n'))[0].data?.category_slug, 'atk');
}
{
  const r = satuanS(parseTable('nama,kategori\nAqua,\n'));
  eq('kategori kosong -> gagal', r[0].aksi, 'gagal');
  ok('pesan kategori kosong', /Kategori kosong/.test(r[0].error ?? ''), r[0].error);
}
{
  const r = satuanS(parseTable('nama,kategori\nAqua,Tidak Ada\n'));
  eq('kategori tak dikenal -> gagal', r[0].aksi, 'gagal');
  ok('pesan kategori tak dikenal', /tidak ada di master/.test(r[0].error ?? ''), r[0].error);
}
{
  const r = satuanS(parseTable('nama,kategori,satuan\nAqua,atk,Kardus\n'));
  eq('satuan tak dikenal -> gagal', r[0].aksi, 'gagal');
  ok('pesan satuan tak dikenal', /Satuan "Kardus"/.test(r[0].error ?? ''), r[0].error);
  const r2 = satuanS(parseTable('nama,kategori,satuan\nAqua,atk,Lembar\n'));
  eq('nama satuan -> slug', r2[0].data?.unit, 'lembar');
}
{
  const r = satuanS(parseTable('nama,kategori,satuan\nAqua,atk,\n'));
  eq('satuan kosong -> kunci TIDAK dikirim (server default pcs)', 'unit' in (r[0].data ?? {}), false);
}
{
  const r = satuanS(parseTable('nama,kategori,harga\nAqua,atk,abc\n'));
  eq('harga bukan angka -> gagal', r[0].aksi, 'gagal');
  ok('pesan angka', /bukan angka/.test(r[0].error ?? ''), r[0].error);
}
{
  const r = satuanS(parseTable('nama,kategori,harga,stok\nAqua,atk,,7\n'));
  eq('harga kosong -> kolom tidak dikirim (server default 0)', 'price' in (r[0].data ?? {}), false);
  eq('stok tetap terkirim', r[0].data?.stock, 7);
}
{
  const r = satuanS(parseTable('nama,kategori,aktif\nAqua,atk,nonaktif\n'));
  eq('is_active nonaktif -> 0', r[0].data?.is_active, 0);
  const r2 = satuanS(parseTable('nama,kategori,aktif\nAqua,atk,\n'));
  eq('is_active kosong -> tidak dikirim', 'is_active' in (r2[0].data ?? {}), false);
}
{
  // judul kolom gaya lain (ID & spasi & underscore)
  const r = satuanS(parseTable('SKU,Nama Produk,Category Slug,Min Stok,Price Dynamic\nA1,Aqua,atk,3,1\n'));
  eq('alias SKU/Nama Produk', { s: r[0].data?.sku, n: r[0].data?.name }, { s: 'A1', n: 'Aqua' });
  eq('alias Category Slug', r[0].data?.category_slug, 'atk');
  eq('alias Min Stok', r[0].data?.min_stock, 3);
  eq('alias Price Dynamic', r[0].data?.price_dynamic, 1);
}
{
  const r = satuanS(parseTable('kolom_ngawur,apa\nA1,B\n'));
  eq('judul tak dikenal -> semua gagal', r[0].aksi, 'gagal');
  ok('pesan judul', /Judul kolom tidak dikenal/.test(r[0].error ?? ''), r[0].error);
}
{
  const r = satuanS(parseTable('sku,nama,kategori\nAQUA, Aqua Botol ,atk\n'));
  eq('nama di-trim', r[0].data?.name, 'Aqua Botol');
}
{
  const r = satuanS(parseTable('nama,kategori\nAqua Botol,atk\nAqua Botol,atk\n'));
  eq('2 baris identik tanpa SKU -> 2 payload (server turunkan SKU -2)', r.length, 2);
}
{
  // tanda baris: sku sudah ada -> timpa
  const r = mapRows(parseTable('sku,nama,kategori\nAQUA,Aqua,atk\n'), { ...kosong, adaSku: (s) => s === 'AQUA' });
  eq('SKU sudah ada -> timpa', r[0].aksi, 'timpa');
}
{
  // nomor baris asli: header = baris 1, data pertama = baris 2
  const r = satuanS(parseTable('nama,kategori\nAqua,atk\nMie,snack\nBad,\n'));
  eq('nomor baris asli', r.map((x) => x.baris), [2, 3, 4]);
}
{
  eq('contoh kolom tanpa baris data', CONTOH_KOLOM.includes('\n'), false);
}

console.log('=== E. gabungan: tempel Excel asli (tab) ===');
{
  const paste = 'SKU\tNama\tKategori\tSatuan\tHarga\tStok\n'
    + 'PRD00015\tSampoerna Mild\trokok\tbungkus\t28000\t10\n'
    + 'AQUA-600\tAqua 600ml\tatk\tpcs\t3000\t24\n';
  const r = mapRows(parseTable(paste), { ...kosong, kategori: [...KAT, { slug: 'rokok', name: 'Rokok' }] });
  eq('2 baris valid', { n: r.length, g: r.filter((x) => x.aksi === 'gagal').length }, { n: 2, g: 0 });
  eq('harga rokok', r[0].data?.price, 28000);
  eq('stok aqua', r[1].data?.stock, 24);
}

console.log('=== F. Format Aronium: (a) file lama 16 kolom tetap masuk, (b) template kita = gaya Aronium isinya form Ravaa ===');
{
  // Header persis lampiran help.aronium.com "Import products using CSV"
  // (products.csv, 443 byte) — termasuk CRLF dan kolom yang Ravaa tidak pakai.
  // IsPriceChangeAllowed sengaja diisi 1 (bukan 0 seperti template Aronium
  // asli) supaya tes membuktikan kolomnya benar-benar terbawa — nilai 0 bisa
  // juga berarti kolomnya gagal dipetakan lalu jatuh default.
  const csv = 'Name,ProductGroup,SKU,Barcode,MeasurementUnit,Cost,Markup,Price,Tax,IsTaxInclusivePrice,IsPriceChangeAllowed,IsUsingDefaultQuantity,IsService,IsEnabled,Description,Quantity\r\n'
    + 'Pulpen Hitam,Alat Tulis Kantor,ATK-PLV-1,8991234567890,pcs,2000,50,3000,0,1,1,1,0,1,Deskripsi bebas,12\r\n';
  const r = satuanS(parseTable(csv));
  eq('baris Aronium tidak gagal', r[0].aksi, 'baru');
  eq('Name -> name', r[0].data?.name, 'Pulpen Hitam');
  eq('ProductGroup cocok lewat NAMA kategori', r[0].data?.category_slug, 'atk');
  eq('SKU -> sku', r[0].data?.sku, 'ATK-PLV-1');
  eq('Barcode -> barcode', r[0].data?.barcode, '8991234567890');
  eq('MeasurementUnit -> unit', r[0].data?.unit, 'pcs');
  eq('Cost -> cost', r[0].data?.cost, 2000);
  eq('Markup -> markup', r[0].data?.markup, 50);
  eq('Price -> price', r[0].data?.price, 3000);
  eq('IsPriceChangeAllowed -> price_dynamic', r[0].data?.price_dynamic, 1);
  eq('IsEnabled -> is_active', r[0].data?.is_active, 1);
  eq('Quantity -> stock', r[0].data?.stock, 12);
  ok('kolom Tax/IsService/Description diabaikan tanpa error', r[0].error === null, r[0].error);
  eq('payload hanya berisi field API yang sah', Object.keys(r[0].data ?? {}).sort(),
    ['barcode', 'category_slug', 'cost', 'is_active', 'markup', 'name', 'price', 'price_dynamic', 'sku', 'stock', 'unit']);
}
{
  // Template ARONIUM ASLI (kategori "Group 1/2" tidak ada di master Ravaa):
  // gagalnya harus TEPAT di kategori saja — bukti kolom lain semua terpetakan.
  const asli = 'Name,ProductGroup,SKU,Barcode,MeasurementUnit,Cost,Markup,Price,Tax,IsTaxInclusivePrice,IsPriceChangeAllowed,IsUsingDefaultQuantity,IsService,IsEnabled,Description,Quantity\r\n'
    + 'Item 1,Group 1,1,501234567890,pcs,1,20,1.2,0,1,0,1,0,1,Item description,10\r\n'
    + 'Item 3,Group 2,3,,hr,3,20,3.6,0,1,0,1,1,1,Service item,0\r\n';
  const r = satuanS(parseTable(asli));
  eq('2 baris template Aronium terbaca', r.length, 2);
  ok('gagal HANYA di kategori (kolom lain terpetakan semua)',
    r.every((x) => /^Kategori "Group \d+" tidak ada di master$/.test(x.error ?? '')),
    r.map((x) => x.error));
}
{
  // Varian ejaan yang dipakai tabel bantuan Aronium (berspasi), bukan template.
  const r = satuanS(parseTable('Name,Product group,SKU,Measurement Unit,Price,Enabled,Quantity\nAqua,Snack,A-1,pcs,4000,1,7\n'));
  eq('varian berspasi: Product group', r[0].data?.category_slug, 'snack');
  eq('varian berspasi: Measurement Unit', r[0].data?.unit, 'pcs');
  eq('varian berspasi: Enabled -> is_active', r[0].data?.is_active, 1);
  eq('varian berspasi: Quantity -> stock', r[0].data?.stock, 7);
}
{
  // Template unduhan harus kembali utuh: di-parse lagi, keduanya siap diimpor.
  const teks = templateProduk(
    [{ slug: 'atk', name: 'Alat Tulis Kantor', track_stock: 1 }, { slug: 'snack', name: 'Snack' }],
    [{ slug: 'pcs', name: 'Pcs' }],
  );
  const header = teks.split('\r\n')[0];
  const kolom = header.split(',');

  // (a) gaya Aronium, tapi isinya form kita
  eq('header = HEADER_TEMPLATE', header, HEADER_TEMPLATE);
  ok('template kita MEMANG disesuaikan (bukan 16 kolom Aronium utuh)',
    header !== HEADER_ARONIUM_ORI, header);
  eq('12 kolom = jumlah field form', kolom.length, 12);
  ok('kolom Aronium yang tak ada di form TIDAK ikut',
    !kolom.some((c) => ['Tax', 'IsTaxInclusivePrice', 'IsUsingDefaultQuantity',
      'IsService', 'Description'].includes(c)), kolom);
  ok('semua judul = label form (bukan istilah Aronium)',
    ['Nama', 'Kategori', 'SKU', 'Barcode', 'Satuan',
      'Harga beli', 'Markup', 'Harga jual', 'Boleh ubah harga saat jual',
      'Aktif', 'Stok', 'Stok minimum']
      .every((c, i) => kolom[i] === c), kolom);
  ok('ProductGroup / MeasurementUnit / MinStock sudah tidak dipakai',
    !kolom.some((c) => ['ProductGroup', 'MeasurementUnit', 'MinStock'].includes(c)), kolom);

  // (b) file hasil unduh harus tetap valid dan siap diimpor
  eq('pakai CRLF seperti template Aronium', teks.includes('\r\n'), true);
  eq('tanpa baris kosong di kaki file', teks.endsWith('\r\n'), false);
  const r = satuanS(parseTable(teks));
  eq('2 baris contoh terbaca', r.length, 2);
  ok('kedua baris contoh siap diimpor (bukan gagal)',
    r.every((x) => x.aksi === 'baru'), r.map((x) => x.error));
  eq('SKU contoh', r[0].data?.sku, 'CONTOH-1');
  eq('kategori contoh diambil dari master hidup', r[0].data?.category_slug, 'atk');
  eq('harga jual contoh konsisten dengan markup', r[0].data?.price, 3000);
  eq('Stok minimum terbaca jadi min_stok', r[0].data?.min_stock, 2);
  // Baris 1 diisi 1, baris 2 diisi 0 -> pemetaan kolom panjang terbukti nyata,
  // bukan kebetulan sama dengan default.
  eq('Boleh ubah harga saat jual -> price_dynamic (nilai 1)', r[0].data?.price_dynamic, 1);
  eq('Boleh ubah harga saat jual -> price_dynamic (nilai 0)', r[1].data?.price_dynamic, 0);
  eq('BOM Excel tidak bocor ke nama kolom', parseTable('\uFEFF' + teks).header[0], 'Nama');
  eq('nama contoh memuat penanda CONTOH', /^CONTOH /.test(String(r[0].data?.name)), true);
}


console.log('=== I. Ekspor produk: kolom identik dengan template impor ===');
{
  const contoh: ProdukEkspor = {
    name: 'Aqua 600ml', category_name: 'Minuman', sku: 'PRD00013',
    barcode: '8991', unit: 'btl', cost: 1000, markup: 50, price: 1500,
    price_dynamic: 0, is_active: 1, stock: 7, min_stock: 2,
  };
  const teks = csvProduk([contoh]);
  eq('header ekspor = HEADER_TEMPLATE persis', teks.split('\r\n')[0], HEADER_TEMPLATE);
  eq('header + 1 baris data', teks.split('\r\n').length, 2);
  const sel = parseTable(teks).rows[0];
  eq('12 kolom', sel.length, 12);
  eq('kolom 1 = Nama', sel[0], 'Aqua 600ml');
  eq('kolom 3 = SKU', sel[2], 'PRD00013');
  eq('kategori ditulis NAMA, bukan slug', sel[1], 'Minuman');
  eq('Stok ikut terbawa (bolak-balik utuh)', sel[10], '7');
  eq('Stok minimum ikut terbawa', sel[11], '2');

  // Bolak-balik: file ekspor halaman Produk harus bisa masuk dialog Impor Stok.
  const stok = bacaStok(teks);
  eq('ekspor produk dikenali pembaca stok', stok.ada, true);
  eq('bolak-balik: SKU terbaca', stok.baris[0].sku, 'PRD00013');
  eq('bolak-balik: angka stok terbaca', stok.baris[0].qty, 7);
}

console.log('=== J. Ekspor stok ===');
{
  eq('csvStok kosong = header saja', csvStok([]), HEADER_STOK);
  const t = csvStok([{ sku: 'PRD00001', name: 'Pulpen', stock: 50, min_stock: 5 }]);
  eq('4 kolom', parseTable(t).rows[0].length, 4);
  eq('Stok minimum = kolom ke-4', parseTable(t).rows[0][3], '5');
  ok('nama berkoma ikut dikutip RFC4180',
    csvStok([{ sku: 'X', name: 'Kopi, hitam', stock: 1, min_stock: 0 }]).includes('"Kopi, hitam"'));
}

console.log('=== K. Pembaca stok: kolom lain dilewati, pemisah dideteksi ===');
{
  const b = bacaStok('SKU;Nama;Stok\nPRD1;Pulpen;1.500\nPRD2;Buku;');
  eq('pemisah ";" (Excel Indonesia) terdeteksi', b.ada, true);
  eq('angka gaya Indonesia 1.500 = 1500', b.baris[0].qty, 1500);
  eq('kolom Stok kosong -> qty null', b.baris[1].qty, null);
  ok('pesan error menyebut kolomnya', /Stok kosong/.test(b.baris[1].error ?? ''), b.baris[1].error);

  const x = bacaStok('Nama,Harga\nBudi,1000');
  eq('tanpa kolom SKU -> ada=false', x.ada, false);
  eq('tanpa kolom SKU -> tidak ada baris diproses', x.baris.length, 0);

  const y = bacaStok('sku;stock\nprd-a;10\n;5\nprd-b;abc');
  eq('alias huruf kecil sku/stock tetap dikenali', y.ada, true);
  eq('SKU diambil apa adanya', y.baris[0].sku, 'prd-a');
  ok('baris tanpa SKU -> error', /SKU kosong/.test(y.baris[1].error ?? ''), y.baris[1].error);
  ok('baris non-angka -> error memuat teks aslinya', /bukan angka: "abc"/.test(y.baris[2].error ?? ''), y.baris[2].error);
  eq('nomor baris asli (judul = 1)', y.baris[2].baris, 4);

  const tab = bacaStok('SKU\tStok\nPRD01\t3');
  eq('tempelan Excel (tab) terbaca', tab.baris[0]?.qty, 3);
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
