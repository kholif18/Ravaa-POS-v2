// SKU urut `PRD#####` — server menomori ketika kolom SKU kosong.
//
// Yang dijaga di sini bukan sekadar "SKUnya berbentuk PRD", tapi dua keputusan
// yang gampang salah kalau diubah sembarangan:
//   1. Nomor dihitung dari MAX, bukan COUNT. COUNT salah ketika ada celah —
//      mis. PRD00001,00002,00003 lalu 00002 dihapus -> COUNT+1 = 00003 yang
//      SUDAH terpakai -> tabrakan, dan karena SKU adalah kunci upsert, tabrakan
//      berarti menimpa produk orang lain (bukan sekadar error).
//   2. Tombstone (produk di-soft-delete) tetap dihitung, jadi nomor tidak pernah
//      mundur dan label yang sudah tercetak tidak jadi ambigu.
//
// Suite ini murni HTTP + sqlite3 (tanpa browser). Artefaknya ditandai nama
// `Uji SKU Urut%` supaya pembersihan tidak menyentuh produk PRD asli.
import { execSync } from 'node:child_process';

const API = 'http://localhost:3001';
const DB = '/home/seira/Projects/ravaaposv2/apps/api/data/data.db';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};

const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`, { encoding: 'utf8' }).trim();
const hapusArtefak = () => {
  sql("DELETE FROM stock_moves WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'Uji SKU Urut%')");
  sql("DELETE FROM products WHERE name LIKE 'Uji SKU Urut%'");
};
const post = async (path, body) => {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json())?.data };
};
/** Nomor PRD tertinggi di DB, dihitung dengan aturan yang SAMA dengan server. */
const maxPrd = () => Number(sql(
  "SELECT COALESCE(MAX(CAST(SUBSTR(sku,4) AS INTEGER)),0) FROM products " +
  "WHERE sku LIKE 'PRD%' AND SUBSTR(sku,4) GLOB '[0-9]*'"));
const ada = (sku) => Number(sql(`SELECT COUNT(*) FROM products WHERE sku='${sku}'`));

hapusArtefak(); // sisa run yang gagal sebelumnya

console.log('=== A. POST tanpa SKU -> server menomori PRD##### ===');
const n0 = maxPrd();
const r1 = await post('/api/products', { name: 'Uji SKU Urut Satu', category_slug: 'atk', unit: 'pcs', price: 1000 });
chk('simpan sukses', !!r1.data?.sku, JSON.stringify(r1).slice(0, 200));
const sku1 = r1.data?.sku ?? '';
chk('SKU berformat PRD + 5 digit', /^PRD\d{5}$/.test(sku1), sku1);
chk('nomor = MAX sebelumnya + 1 (bukan COUNT)',
  sku1 === `PRD${String(n0 + 1).padStart(5, '0')}`, `${sku1} (MAX sebelumnya ${n0})`);

console.log('=== B. POST kosong berikutnya lanjut naik ===');
const r2 = await post('/api/products', { name: 'Uji SKU Urut Dua', category_slug: 'atk', unit: 'pcs', price: 1000 });
const sku2 = r2.data?.sku ?? '';
chk('SKU kedua juga PRD#####', /^PRD\d{5}$/.test(sku2), sku2);
chk('SKU kedua unik (beda dari pertama)', sku2 !== sku1, `${sku2} vs ${sku1}`);
chk('SKU kedua = SKU pertama + 1', Number(sku2.slice(3)) === Number(sku1.slice(3)) + 1, `${sku2}`);

console.log('=== C. SKU eksplisit dipakai apa adanya, tanpa diganti ===');
const r3 = await post('/api/products', {
  name: 'Uji SKU Urut Eksplisit', category_slug: 'atk', unit: 'pcs', price: 1000,
  sku: 'UJI-SKU-EKSPLISIT',
});
chk('SKU eksplisit dipertahankan', r3.data?.sku === 'UJI-SKU-EKSPLISIT', r3.data?.sku);
chk('rangkaian PRD tidak digeser oleh SKU eksplisit',
  maxPrd() === Number(sku2.slice(3)), `MAX=${maxPrd()} vs ${sku2}`);

console.log('=== D. Celah di tengah -> COUNT akan tabrakan, MAX tidak ===');
// Hapus yang PERTAMA (bukan terakhir) supaya jumlah baris (COUNT) menyusut tapi
// MAX tetap. Skema COUNT menghasilkan nomor yang sudah terpakai.
sql(`DELETE FROM products WHERE sku='${sku1}'`);
const nD = maxPrd();
const r4 = await post('/api/products', { name: 'Uji SKU Urut Empat', category_slug: 'atk', unit: 'pcs', price: 1000 });
const sku4 = r4.data?.sku ?? '';
chk('MAX tidak mundur setelah ada celah', Number(sku4.slice(3)) === nD + 1, `${sku4} (MAX=${nD})`);
chk('SKU baru benar-benar belum dipakai', ada(sku4) === 1, `${sku4} ada=${ada(sku4)}`);
chk('rangkaian yang tersisa tetap utuh', ada(sku2) === 1, sku2);

console.log('=== E. Tombstone (soft delete) tetap dihitung, nomor tidak mundur ===');
const r5 = await post('/api/products', {
  name: 'Uji SKU Urut Lima', category_slug: 'atk', unit: 'pcs', price: 1000,
});
const sku5 = r5.data?.sku ?? '';
const del = await fetch(`${API}/api/products/${r5.data?.id}`, { method: 'DELETE' });
chk('produk di-soft-delete (tombstone)', del.status === 200, `status ${del.status}`);
chk('tombstone memang tertulis', sql(
  `SELECT COUNT(*) FROM products WHERE sku='${sku5}' AND deleted_at IS NOT NULL`) === '1', sku5);
chk('tombstone tetap dihitung oleh MAX', maxPrd() === Number(sku5.slice(3)), `MAX=${maxPrd()} vs ${sku5}`);
const r6 = await post('/api/products', { name: 'Uji SKU Urut Enam', category_slug: 'atk', unit: 'pcs', price: 1000 });
chk('nomor berikutnya melewati tombstone (tidak dipakai ulang)',
  Number((r6.data?.sku ?? 'PRD00000').slice(3)) === Number(sku5.slice(3)) + 1, r6.data?.sku);

console.log('=== F. Import tanpa SKU juga dinomori server ===');
const r7 = await post('/api/products/import', {
  rows: [
    { name: 'Uji SKU Urut Impor A', category_slug: 'atk', unit: 'pcs', price: 500 },
    { name: 'Uji SKU Urut Impor B', category_slug: 'atk', unit: 'pcs', price: 500 },
  ],
});
const imporSku = sql("SELECT sku FROM products WHERE name='Uji SKU Urut Impor A'");
chk('import lulus', r7.data?.ok === 2 && r7.data?.gagal === 0, JSON.stringify(r7.data));
chk('baris import tanpa SKU mendapat PRD#####', /^PRD\d{5}$/.test(imporSku), imporSku);

hapusArtefak();
console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
