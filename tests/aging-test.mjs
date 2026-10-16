// Aging hutang (2026-10-16): pengingat umur piutang pelanggan (FIFO) dan
// hutang supplier sejak barang diterima + chip & badge UI di #/debts dan
// #/purchases. Data uji dibuat lewat API nyata, umur di-backdate langsung di
// SQLite (pola sama product-delete/pager-test), dibersihkan di akhir.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
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
const sql = (q) => execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();
const WEB = 'http://localhost:5656';
const jget = async (path) => (await fetch(`http://localhost:3001${path}`)).json();
const jpost = async (path, body) => {
  const r = await fetch(`http://localhost:3001${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// Bersihkan sisa run lama.
sql(`DELETE FROM customer_debts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'UjiAging%');`);
sql(`DELETE FROM customers WHERE name LIKE 'UjiAging%';`);
// Purchase yatim dari run yang crash SEBELUM cleanup (pernah terjadi di run
// penuh 2026-10-16): stok yang sudah naik harus dikembalikan, kalau tidak
// baseline lewat30 bukan 0 dan asersi "chip hilang" jadi bohong. avg_cost
// dibiarkan (nilai lamanya tak bisa direkonstruksi) — yang penting stok+nota.
const yatim = sql(`SELECT id FROM purchases WHERE note LIKE 'UjiAging%'`).split('\n').filter(Boolean).map(Number);
for (const yid of yatim) {
  const statusY = sql(`SELECT status FROM purchases WHERE id = ${yid}`);
  if (statusY === 'received') {
    for (const it of sql(`SELECT product_id, qty FROM purchase_items WHERE purchase_id = ${yid}`).split('\n').filter(Boolean)) {
      const [prodId, qty] = it.split('|').map(Number);
      sql(`UPDATE products SET stock = stock - ${qty} WHERE id = ${prodId};`);
    }
  }
  sql(`DELETE FROM stock_moves WHERE ref_id = 'PO-${yid}';`);
  sql(`DELETE FROM purchase_items WHERE purchase_id = ${yid};`);
  sql(`DELETE FROM purchases WHERE id = ${yid};`);
}

const baseD = (await jget('/api/customer-debts')).lewat30;
const baseP = (await jget('/api/purchases?status=semua')).lewat30;
const TAG = Date.now().toString(36);

console.log('=== A. Umur hutang pelanggan (FIFO) ===');
const c1 = await jpost('/api/customers', { name: `UjiAging A ${TAG}` });
chk('buat pelanggan uji -> 201', c1.status === 201, `id=${c1.json.data?.id}`);
const cid = c1.json.data.id;
chk('catat charge 50rb -> 201', (await jpost('/api/customer-debts', { customer_id: cid, type: 'charge', amount: 50000 })).status === 201);
sql(`UPDATE customer_debts SET created_at = datetime('now','-41 days') WHERE customer_id = ${cid};`);

let d = await jget('/api/customer-debts');
let row = d.data.find((r) => r.customer_id === cid);
chk('umur_hari = 41 untuk charge 41 hari', row?.sisa === 50000 && row?.umur_hari === 41, `sisa=${row?.sisa} umur=${row?.umur_hari}`);
chk('lewat30 naik 1 (baseline ' + baseD + ')', d.lewat30 === baseD + 1, `lewat30=${d.lewat30}`);

chk('bayar sebagian 20rb -> 201', (await jpost('/api/customer-debts', { customer_id: cid, type: 'payment', amount: 20000 })).status === 201);
d = await jget('/api/customer-debts');
row = d.data.find((r) => r.customer_id === cid);
chk('sisa 30rb, umur TETAP 41 (bayar sebagian tak mereset)', row?.sisa === 30000 && row?.umur_hari === 41, `sisa=${row?.sisa} umur=${row?.umur_hari}`);

const c2 = await jpost('/api/customers', { name: `UjiAging B ${TAG}` });
const cid2 = c2.json.data.id;
await jpost('/api/customer-debts', { customer_id: cid2, type: 'charge', amount: 5000 });
await jpost('/api/customer-debts', { customer_id: cid2, type: 'payment', amount: 5000 });
const dsemua = await jget('/api/customer-debts?status=semua');
const row2 = dsemua.data.find((r) => r.customer_id === cid2);
chk('lunas: sisa 0 + umur null + tak masuk hitungan',
  row2?.sisa === 0 && row2?.umur_hari === null && dsemua.lewat30 === baseD + 1);
chk('status=open menyembunyikan yang lunas', (await jget('/api/customer-debts')).data.every((r) => r.customer_id !== cid2));

console.log('=== B. Umur hutang supplier (sejak diterima) ===');
const p1 = sql(`SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id
  WHERE c.track_stock = 1 AND p.is_active = 1 AND p.deleted_at IS NULL ORDER BY p.id LIMIT 1`);
const pid = Number(p1);
const stokAwal = Number(sql(`SELECT stock FROM products WHERE id = ${pid}`));
const avgAwal = Number(sql(`SELECT avg_cost FROM products WHERE id = ${pid}`));
const po = await jpost('/api/purchases', { items: [{ product_id: pid, qty: 2, harga_beli: 1500 }], note: `UjiAging ${TAG}` });
chk('buat PO -> 201', po.status === 201 && po.json.data?.purchase?.total === 3000, `total=${po.json.data?.purchase?.total}`);
const poId = po.json.data.purchase.id;
const terima = await jpost(`/api/purchases/${poId}/receive`, { dibayar: 1000 });
chk('terima dibayar sebagian -> 200', terima.status === 200);
// avg_cost TIDAK di-assert berubah: rata-rata tertimbang boleh membulat ke
// angka yang sama (49×1496 + 2×1500) / 51 = 1496,15 -> round 1496. Yang
// deterministik: stok naik & mutasi beli mencatat harga batch apa adanya.
chk('stok naik 2 + mutasi beli mencatat harga batch', Number(sql(`SELECT stock FROM products WHERE id = ${pid}`)) === stokAwal + 2
  && Number(sql(`SELECT unit_cost FROM stock_moves WHERE ref_id = 'PO-${poId}'`)) === 1500);

sql(`UPDATE purchases SET received_at = datetime('now','-40 days') WHERE id = ${poId};`);
let pl = await jget('/api/purchases?status=semua');
let poRow = pl.data.find((r) => r.id === poId);
chk('umur_hari = 40 (received 40 hari lalu)', poRow?.status === 'received' && poRow?.sisa === 2000 && poRow?.umur_hari === 40,
  `sisa=${poRow?.sisa} umur=${poRow?.umur_hari}`);
chk('lewat30 supplier naik 1 (baseline ' + baseP + ')', pl.lewat30 === baseP + 1, `lewat30=${pl.lewat30}`);

console.log('=== C. UI: chip + badge di #/debts dan #/purchases ===');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));

await p.goto(`${WEB}/#/debts`, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
chk('chip #hutang-lewat tampil + jumlah benar',
  await p.locator('#hutang-lewat').isVisible()
  && (await p.textContent('#hutang-lewat-n'))?.trim() === String((await jget('/api/customer-debts')).lewat30));
chk('badge "41 hari" di baris pelanggan',
  ((await p.textContent(`tr[data-row="${cid}"]`)) ?? '').includes('41 hari'));

await p.goto(`${WEB}/#/purchases`, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
chk('chip #po-lewat tampil di #/purchases', await p.locator('#po-lewat').isVisible());
chk('badge "40 hari" di baris PO', ((await p.textContent(`tr[data-row="${poId}"]`)) ?? '').includes('40 hari'));

console.log('=== D. Lunas -> penanda aging hilang ===');
chk('bayar sisa 2rb -> 200', (await jpost(`/api/purchases/${poId}/pay`, { amount: 2000 })).status === 200);
pl = await jget('/api/purchases?status=semua');
poRow = pl.data.find((r) => r.id === poId);
chk('sisa 0 + umur null + lewat30 kembali baseline', poRow?.sisa === 0 && poRow?.umur_hari === null && pl.lewat30 === baseP);
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(900);
// Chip = cermin angka server (bukan asumsi baseline 0): sisa PO yatim milik
// run lama tetap membuat chip tampil — asersi harus jujur soal itu.
chk('chip mengikuti server (tampil hanya bila masih ada yang lewat 30 hari)',
  (await p.locator('#po-lewat').isVisible()) === (pl.lewat30 > 0), `lewat30=${pl.lewat30}`);
chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan: stok & avg_cost dikembalikan apa adanya, nota + mutasi dihapus.
sql(`DELETE FROM stock_moves WHERE ref_id = 'PO-${poId}';`);
sql(`DELETE FROM purchase_items WHERE purchase_id = ${poId};`);
sql(`DELETE FROM purchases WHERE id = ${poId};`);
sql(`UPDATE products SET stock = ${stokAwal}, avg_cost = ${avgAwal} WHERE id = ${pid};`);
sql(`DELETE FROM customer_debts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'UjiAging%');`);
sql(`DELETE FROM customers WHERE name LIKE 'UjiAging%';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [aging-test.mjs]`);
if (fail) process.exit(1);
