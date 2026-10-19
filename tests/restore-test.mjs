// Restore backup via UI/API (2026-10-16): POST /api/backup/restore —
// guard nama (404), integrity check (400), backup pengaman otomatis, audit,
// dan bukti data benar-benar kembali ke snapshot. Data uji = kategori marker
// A/B; API & koneksi DB harus sehat sesudah pulihkan (tanpa restart proses).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken } from './bantuan-uji.mjs';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const BACKUP_DIR = path0.join(REPO, 'apps/api/data/backups');
const sql = (q) => execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();
const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
const jget = async (path) => (await fetch(`${API}${path}`)).json();
const jpost = async (path, body) => {
  const r = await fetch(`${API}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const adaKategori = async (slug) => (await jget('/api/categories')).data.some((k) => k.slug === slug);

// Bersihkan sisa run lama.
sql(`DELETE FROM audit_log WHERE entity_id LIKE 'data-1999-01-01-000000.db' OR entity_id LIKE 'uji-restore%';`);
sql(`DELETE FROM categories WHERE slug LIKE 'uji-restore-%';`);
const sisaKotor = path0.join(BACKUP_DIR, 'data-1999-01-01-000000.db');
if (existsSync(sisaKotor)) unlinkSync(sisaKotor);

const TAG = Date.now().toString(36);
const slugA = `uji-restore-a-${TAG}`;
const slugB = `uji-restore-b-${TAG}`;
const slugC = `uji-restore-c-${TAG}`;

console.log('=== A. Marker A -> backup B1 -> marker B ===');
chk('marker A dibuat', (await jpost('/api/categories', { name: `UjiRestore A ${TAG}`, slug: slugA, track_stock: 0 })).status === 201);
const bk = await jpost('/api/backup', {});
chk('POST /api/backup -> 201 nama berpola', bk.status === 201 && /^data-\d{4}-\d{2}-\d{2}-\d{6}\.db$/.test(bk.json.data?.nama ?? ''), bk.json.data?.nama);
const B1 = bk.json.data.nama;
chk('marker B dibuat', (await jpost('/api/categories', { name: `UjiRestore B ${TAG}`, slug: slugB, track_stock: 0 })).status === 201);

console.log('=== B. Restore ke B1 ===');
const pulih = await jpost('/api/backup/restore', { nama: B1 });
chk('POST restore -> 200 + pengaman', pulih.status === 200 && pulih.json.data?.nama === B1 && !!pulih.json.data?.pengaman,
  `pengaman=${pulih.json.data?.pengaman}`);
chk('marker A kembali ada (dari snapshot)', await adaKategori(slugA));
chk('marker B hilang (dibuat sesudah snapshot)', !(await adaKategori(slugB)));
chk('file pengaman benar-benar ada di daftar backup',
  (await jget('/api/backup')).data.some((f) => f.nama === pulih.json.data.pengaman));
chk('koneksi DB hidup lagi (kategori & health)', Array.isArray((await jget('/api/categories')).data)
  && (await fetch(`${API}/health`)).ok);
const jejak = await jget(`/api/audit?entity=backup&q=${B1}`);
chk('restore tercatat di audit + detail pengaman',
  jejak.total >= 1 && jejak.data[0].action === 'restore'
  && String(jejak.data[0].detail).includes(pulih.json.data.pengaman), `total=${jejak.total}`);

console.log('=== B2. Tulis lewat transaction wrapper SESUDAH restore (anti-regresi) ===');
// Bug nyata 2026-10-16: `const tx = db.transaction(fn)` di scope modul mengikat
// koneksi LAMA — sesudah restore, POST produk/penjualan/retur/mutasi-hutang
// mati "The database connection is not open" sampai proses API di-restart.
// Helper `transaksi()` (db.ts) membuat transaction per pemanggilan; keempat
// jalur tulis ini yang mengawalnya.
const tulis = await jpost('/api/products', { name: `UjiRestore Tulis ${TAG}`, category_slug: 'atk', unit: 'pcs', price: 1000 });
chk('POST produk (upsertProduct) hidup sesudah restore', tulis.status === 201, `status=${tulis.status}`);
const pidT = tulis.json.data.id;
const cT = await jpost('/api/customers', { name: `UjiRestore Tulis ${TAG}` });
const cidT = cT.json.data.id;
chk('POST mutasi hutang (simpanMutasiHutang) hidup sesudah restore',
  (await jpost('/api/customer-debts', { customer_id: cidT, type: 'charge', amount: 1000 })).status === 201);
const sh = await jget('/api/shifts/open?cashier=kasir');
await jpost('/api/restock', { product_id: pidT, qty: 10, harga_beli: 500 });
const jual = await jpost('/api/sales', { id: crypto.randomUUID(), shift_id: sh.data.id, items: [{ product_id: pidT, qty: 1 }], pay_method: 'tunai', cash_in: 1000 });
chk('POST penjualan (insertSale) hidup sesudah restore',
  (jual.status === 201 || jual.status === 200) && !!jual.json.data?.sale?.id, `status=${jual.status}`);
const saleId = jual.json.data.sale.id;
const retur = await jpost('/api/returns', { items: [{ product_id: pidT, qty: 1, price: 1000 }] });
chk('POST retur (simpanRetur) hidup sesudah restore', retur.status === 201, `status=${retur.status}`);
// Bersihkan jejak tulis uji (sqlite3 CLI tidak menegakkan FK — return_items/
// sale_items/sale_payments dibuang eksplisit, bukan lewat cascade).
const returId = retur.json.data?.retur?.id ?? -1;
sql(`DELETE FROM return_items WHERE return_id = ${returId};`);
sql(`DELETE FROM returns WHERE id = ${returId};`);
sql(`DELETE FROM sale_items WHERE sale_id = '${saleId}';`);
sql(`DELETE FROM sale_payments WHERE sale_id = '${saleId}';`);
sql(`DELETE FROM sales WHERE id = '${saleId}';`);
sql(`DELETE FROM stock_moves WHERE product_id = ${pidT};`);
sql(`DELETE FROM products WHERE id = ${pidT};`);
sql(`DELETE FROM customer_debts WHERE customer_id = ${cidT};`);
sql(`DELETE FROM customers WHERE id = ${cidT};`);

console.log('=== C. Guard nama & file rusak ===');
chk('nama berjalur -> 404', (await jpost('/api/backup/restore', { nama: '../x.db' })).status === 404);
chk('nama di luar pola -> 404', (await jpost('/api/backup/restore', { nama: 'laporan.pdf' })).status === 404);
chk('file tidak ada -> 404', (await jpost('/api/backup/restore', { nama: 'data-1999-01-01-000000.db' })).status === 404);
const kotor = path0.join(BACKUP_DIR, 'data-1999-01-01-000000.db');
writeFileSync(kotor, 'ini bukan database sqlite');
await jpost('/api/categories', { name: `UjiRestore C ${TAG}`, slug: slugC, track_stock: 0 });
const rusak = await jpost('/api/backup/restore', { nama: 'data-1999-01-01-000000.db' });
chk('file rusak -> 400 tidak dipulihkan', rusak.status === 400 && String(rusak.json.error).includes('tidak'), rusak.json.error);
chk('DB hidup TIDAK berubah oleh percobaan gagal', await adaKategori(slugC));
unlinkSync(kotor);

console.log('=== D. UI: tombol Pulihkan di #/settings ===');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
await p.goto(`${WEB}/#/settings`, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
const nBackup = (await jget('/api/backup')).data.length;
chk('tombol Pulihkan = jumlah file backup', await p.locator('[data-restore]').count() === nBackup, `${nBackup} file`);
chk('tautan Unduh tetap ada', await p.locator('a[href^="/api/backup/"]').count() === nBackup);
chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan marker + jejak audit uji (file backup dibiarkan — retensi KEEP
// yang memangkasnya, sama seperti backup buatan pemilik).
sql(`DELETE FROM categories WHERE slug IN ('${slugA}', '${slugB}', '${slugC}');`);
sql(`DELETE FROM audit_log WHERE entity_id IN ('${B1}', 'data-1999-01-01-000000.db') OR entity_id LIKE 'uji-restore-%';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [restore-test.mjs]`);
if (fail) process.exit(1);
