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

import { parseTable, mapRows, parseAngka, parseAktif, CONTOH_KOLOM } from '/home/seira/Projects/ravaaposv2/apps/web/src/importcsv.ts';

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
    + 'RK-SMP-12\tSampoerna Mild\trokok\tbungkus\t28000\t10\n'
    + 'AQUA-600\tAqua 600ml\tatk\tpcs\t3000\t24\n';
  const r = mapRows(parseTable(paste), { ...kosong, kategori: [...KAT, { slug: 'rokok', name: 'Rokok' }] });
  eq('2 baris valid', { n: r.length, g: r.filter((x) => x.aksi === 'gagal').length }, { n: 2, g: 0 });
  eq('harga rokok', r[0].data?.price, 28000);
  eq('stok aqua', r[1].data?.stock, 24);
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
