// Retur penjualan Tahap 2: stok kembali + uang kembali + kurangi laci.
// Guard sisa qty, snapshot harga jual, manual tanpa nota, batal + laci + laporan.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
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
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();
const TODAY = new Date().toISOString().slice(0, 10);

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const post = (path, body) => p.evaluate(
  ([u, bd]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
  [path, body],
);
async function w(sel, v) { await p.fill(sel, v); await p.waitForTimeout(150); }

await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

// Setup: produk fisik + jasa uji, jual 3 pcs fisik.
// Nama UNIK per run (idempoten terhadap sisa run gagal: produk tanpa sku selalu
// INSERT baru, jadi nama tetap akan duplikat antar-run dan data[0] bisa milik
// run lain — stamp waktu membuat pencarian q tepat satu hasil).
const TS = Date.now();
const NAMA_FISIK = `UjiRet Fisik ${TS}`;
const NAMA_JASA = `UjiRet Jasa ${TS}`;
const QFISIK = encodeURIComponent(NAMA_FISIK);
const QJASA = encodeURIComponent(NAMA_JASA);
const prod = await post('/api/products', { name: NAMA_FISIK, category_slug: 'atk', price: 5000, stock: 10 });
const prodId = prod.json.data.id;
const jasa = await post('/api/products', { name: NAMA_JASA, category_slug: 'jasa', price: 20000 });
const jasaId = jasa.json.data.id;
const shift = await api('/api/shifts/open?cashier=kasir');
const saleId = `uji-retur-${Date.now()}`;
await post('/api/sales', { id: saleId, shift_id: shift.data.id, pay_method: 'tunai', discount: 0, cash_in: 15000, cashier: 'kasir', items: [{ product_id: prodId, qty: 3 }] });
const nota = await api(`/api/sales/${saleId}`);
const siId = nota.data.items[0].id;

console.log('=== A. Retur ber-nota: stok kembali + guard sisa ===');
const r1 = await post('/api/returns', { sale_id: saleId, items: [{ sale_item_id: siId, qty: 2 }], cashier: 'kasir' });
chk('POST retur 2/3 -> 201 total 10000', r1.status === 201 && r1.json.data.retur.total === 10000, JSON.stringify(r1.json.data?.retur));
const stok1 = (await api(`/api/products?q=${QFISIK}`)).data[0]?.stock;
chk('stok 10-3+2=9', stok1 === 9, `stok=${stok1}`);
chk('stock_moves reason=retur qty=2', sql(`SELECT COUNT(*) FROM stock_moves WHERE reason='retur' AND product_id=${prodId} AND qty=2;`) === '1');
// Qty per baris sudah diretura (2026-10-18): dasar penanda "sudah retur N ·
// sisa M" di dialog "Buat retur" halaman Riwayat (GET /api/sales/:id.items).
chk('items bawa qty_retur baris (2/3 baru diretur)', (await api(`/api/sales/${saleId}`)).data.items[0].qty_retur === 2);
chk('retur 2 lagi -> 400 melebihi sisa', (await post('/api/returns', { sale_id: saleId, items: [{ sale_item_id: siId, qty: 2 }] })).status === 400);
const r2 = await post('/api/returns', { sale_id: saleId, items: [{ sale_item_id: siId, qty: 1 }] });
chk('retur pas sisa 1 -> 201', r2.status === 201);
chk('retur setelah habis -> 400', (await post('/api/returns', { sale_id: saleId, items: [{ sale_item_id: siId, qty: 1 }] })).status === 400);

console.log('=== B. Validasi ===');
chk('items kosong -> 400', (await post('/api/returns', { sale_id: saleId, items: [] })).status === 400);
chk('qty 0 -> 400', (await post('/api/returns', { sale_id: saleId, items: [{ sale_item_id: siId, qty: 0 }] })).status === 400);
chk('sale_item ngawur -> 404', (await post('/api/returns', { sale_id: saleId, items: [{ sale_item_id: 999999, qty: 1 }] })).status === 404);
chk('sale_id ngawur -> 404', (await post('/api/returns', { sale_id: 'tidak-ada', items: [{ sale_item_id: siId, qty: 1 }] })).status === 404);
chk('note >200 -> 400', (await post('/api/returns', { items: [{ product_id: prodId, qty: 1, price: 5000 }], note: 'x'.repeat(201) })).status === 400);
chk('shift ngawur -> 400', (await post('/api/returns', { items: [{ product_id: prodId, qty: 1, price: 5000 }], shift_id: 999999 })).status === 400);
chk('manual tanpa price -> 400', (await post('/api/returns', { items: [{ product_id: prodId, qty: 1 }] })).status === 400);
chk('manual produk ngawur -> 404', (await post('/api/returns', { items: [{ product_id: 999999, qty: 1, price: 1 }] })).status === 404);

console.log('=== C. Manual + jasa tanpa stok ===');
const m1 = await post('/api/returns', { items: [{ product_id: prodId, qty: 1, price: 4000 }] });
chk('manual track -> 201 total 4000', m1.status === 201 && m1.json.data.retur.total === 4000);
const stok2 = (await api(`/api/products?q=${QFISIK}`)).data[0]?.stock;
chk('stok ikut +1 (manual juga kembalikan)', stok2 === 11, `stok=${stok2}`);
const m2 = await post('/api/returns', { items: [{ product_id: jasaId, qty: 1, price: 20000 }] });
chk('jasa: uang kembali, stok tetap 0', m2.status === 201 && m2.json.data.retur.total === 20000
  && (await api(`/api/products?q=${QJASA}`)).data[0]?.stock === 0);

console.log('=== D. Daftar + agregat + laci ===');
const gl = await api(`/api/returns?date=${TODAY}`);
chk('GET hari ini + jumlah ikut', gl.data.length >= 4 && gl.jumlah >= 39000, `n=${gl.total} jumlah=${gl.jumlah}`);
chk('detail memuat baris', (await api(`/api/returns/${r1.json.data.retur.id}`)).data.items.length === 1);
const dl = await api(`/api/reports/daily?date=${TODAY}`);
chk('daily retur.n/total ikut', dl.data.retur.n >= 4 && dl.data.retur.total >= 39000, JSON.stringify(dl.data.retur));
const e3 = await post('/api/returns', { items: [{ product_id: prodId, qty: 1, price: 1000 }], shift_id: shift.data.id });
chk('retur terikat shift -> 201', e3.status === 201);
const sh = await api('/api/shifts?cashier=kasir&status=open');
const bs = sh.data.find((s) => s.id === shift.data.id);
chk('agregat n_retur/retur_total ikut', bs?.n_retur >= 1 && bs?.retur_total >= 1000, JSON.stringify({ n: bs?.n_retur, tot: bs?.retur_total }));
// Penanda retur di NOTA (2026-10-18): field computed `n_retur`/`retur_total`
// di GET /api/sales & /:id — dasar chip "Retur" di halaman Riwayat. Saat ini
// r1 (2×5000) + r2 (1×5000) = 2 baris / 15000; e3 di atas MANUAL (sale_id
// NULL) jadi sengaja tidak mengattribusi nota.
const notaRet = await api(`/api/sales/${saleId}`);
chk('GET /api/sales/:id menandai retur (n=2, total 15000)',
  notaRet.data.sale.n_retur === 2 && notaRet.data.sale.retur_total === 15000,
  JSON.stringify({ n: notaRet.data.sale.n_retur, tot: notaRet.data.sale.retur_total }));
chk('items qty_retur per baris = 3 (penuh)', notaRet.data.items[0].qty_retur === 3);
const rowRet = (await api(`/api/sales?date=${TODAY}`)).data.find((r) => r.id === saleId);
chk('GET /api/sales daftar ikut membawa penanda retur',
  rowRet?.n_retur === 2 && rowRet?.retur_total === 15000, JSON.stringify(rowRet));

console.log('=== E. UI halaman returns ===');
await p.goto('http://localhost:5656/#/returns', { waitUntil: 'networkidle' });
await p.waitForSelector('#ret-body', { timeout: 15000 });
await p.waitForTimeout(600);
chk('nav "Retur" aktif', await p.locator('a[href="#/returns"].is-active').count() === 1);
await p.click('#ret-new'); await p.waitForSelector('.modal');
await w('#man-q', NAMA_FISIK); await p.waitForTimeout(800);
await p.click('[data-man-add]'); await p.waitForTimeout(300);
await p.click('.modal [data-ok]'); await p.waitForTimeout(1500);
const bodyRet = await p.textContent('#ret-body');
chk('manual via dialog -> baris muncul', bodyRet.includes('Tanpa nota') && /UjiRet|Rp/.test(bodyRet), bodyRet.replace(/\s+/g, ' ').slice(0, 120));
const idManual = await api(`/api/returns?date=${TODAY}`).then((g) => g.data.find((r) => r.sale_id === null)?.id);
await p.click(`[data-ret-buka="${idManual}"]`); await p.waitForSelector('.modal');
chk('rincian terbuka + tombol batal ada', (await p.textContent('.modal')).includes('Uang kembali') && (await p.locator('.modal-footer .btn-ghost').count()) >= 1);
await p.click('.modal-footer .btn-ghost'); await p.waitForSelector('.swal2-container', { timeout: 8000 });
await p.click('.swal2-container .sw-btn-danger'); await p.waitForTimeout(1500);
chk('batalkan -> hilang dari daftar', !(await api(`/api/returns?date=${TODAY}`)).data.some((r) => r.id === idManual));

console.log('=== F. UI riwayat: tombol retur per nota + penanda retur ===');
// Nota kedua khusus penanda PARTIAL (sisa > 0) di dialog "Buat retur":
// jual 2, retur 1 — sisa 1 yang bisa dikembalikan.
const sale2 = `uji-retur2-${Date.now()}`;
await post('/api/sales', { id: sale2, shift_id: shift.data.id, pay_method: 'tunai', cash_in: 10000, cashier: 'kasir', items: [{ product_id: prodId, qty: 2 }] });
const si2 = (await api(`/api/sales/${sale2}`)).data.items[0].id;
chk('nota kedua: retur 1/2 -> qty_retur 1', (await post('/api/returns', { sale_id: sale2, items: [{ sale_item_id: si2, qty: 1 }], cashier: 'kasir' })).status === 201
  && (await api(`/api/sales/${sale2}`)).data.items[0].qty_retur === 1);
await p.goto('http://localhost:5656/#/history', { waitUntil: 'networkidle' });
await p.waitForTimeout(1000);
chk('baris nota menandai retur (chip amber)',
  (await p.textContent(`[data-trx="sale:${saleId}"]`)).includes('Retur Rp15.000'));
await p.click(`[data-trx="sale:${saleId}"]`); await p.waitForTimeout(1200);
chk('detail nota memuat tombol Buat retur', await p.locator('[data-retur-nota]').count() === 1);
chk('detail nota memuat kotak Retur', (await p.textContent('.det-row')).includes('2× retur pada nota ini'));
await p.click('[data-retur-nota]'); await p.waitForSelector('.modal');
await p.waitForTimeout(200);
chk('dialog prefill item nota', (await p.textContent('.modal')).includes(NAMA_FISIK));
// Penanda per baris (permintaan pemilik 2026-10-18 — "tidak mendetail retur
// produk mana dan qty berapa pada modalnya"): baris penuh diretur -> badge
// "sudah retur 3 · sisa 0" + input mati; sisa sebagian -> badge + max input
// = sisa (input tetap aktif).
chk('dialog: baris penuh -> badge + input mati (max 0)',
  (await p.textContent('.modal')).includes('sudah retur 3 · sisa 0')
  && await p.locator(`#rt-${siId}[disabled]`).count() === 1
  && (await p.locator(`#rt-${siId}`).getAttribute('max')) === '0');
chk('dialog: catatan semua baris sudah penuh', (await p.textContent('.modal')).includes('sudah diretur penuh'));
await p.click('.modal [data-x]'); await p.waitForTimeout(300);
await p.click(`[data-trx="sale:${sale2}"]`); await p.waitForTimeout(1200);
await p.click('[data-retur-nota]'); await p.waitForSelector('.modal');
await p.waitForTimeout(200);
chk('dialog: sisa sebagian -> badge + max = sisa, input aktif',
  (await p.textContent('.modal')).includes('sudah retur 1 · sisa 1')
  && (await p.locator(`#rt-${si2}`).getAttribute('max')) === '1'
  && await p.locator(`#rt-${si2}[disabled]`).count() === 0);

console.log('=== F2. Regresi 2026-10-18: segar setelah retur tanpa reload ===');
// Laporan pemilik (nota 261018-000019): sesudah retur 1 btl, buka ulang
// "Buat retur" masih tampil max qty penuh tanpa badge — dialog dulu memakai
// cache item detail yang di-fetch SEBELUM retur. Sekarang dialog SELALU
// fetch item segar + sesudah submit linimasa/rincian disegarkan otomatis.
await p.fill(`#rt-${si2}`, '1');
await p.click('.modal [data-ok]');
await p.waitForFunction(
  (sel) => document.querySelector(sel)?.textContent?.includes('Retur Rp10.000'),
  `[data-trx="sale:${sale2}"]`,
  { timeout: 8000 },
);
chk('sesudah retur: chip baris sale2 segar (Retur Rp10.000)', true);
await p.waitForFunction(
  () => document.querySelector('.det-row')?.textContent?.includes('2× retur pada nota ini'),
  null,
  { timeout: 8000 },
);
chk('sesudah retur: kotak retur rincian segar (2× retur)', true);
await p.click('[data-retur-nota]'); await p.waitForSelector('.modal');
await p.waitForTimeout(200);
chk('buka ulang TANPA reload: badge & sisa segar (2/2, input mati)',
  (await p.textContent('.modal')).includes('sudah retur 2 · sisa 0')
  && await p.locator(`#rt-${si2}[disabled]`).count() === 1
  && (await p.locator(`#rt-${si2}`).getAttribute('max')) === '0');
await p.click('.modal [data-x]'); await p.waitForTimeout(300);

console.log('=== G. DELETE validasi ===');
chk('DELETE ngawur -> 404', await p.evaluate(() => fetch('/api/returns/999999', { method: 'DELETE' }).then((r) => r.status)) === 404);
const stokPre = (await api(`/api/products?q=${QFISIK}`)).data[0]?.stock;
await p.evaluate((id) => fetch(`/api/returns/${id}`, { method: 'DELETE' }), e3.json.data.retur.id);
chk('batalkan retur shift -> stok keluar lagi', (await api(`/api/products?q=${QFISIK}`)).data[0]?.stock === stokPre - 1, `stok ${stokPre} -> ${(await api(`/api/products?q=${QFISIK}`)).data[0]?.stock}`);

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));

// Bersihkan DULU (masih butuh browser untuk fetch), baru tutup browser:
// batalkan sisa retur uji (stok ikut terkoreksi), opname ke stok awal,
// nonaktifkan produk uji supaya tak muncul di POS.
for (const r of (await api(`/api/returns?date=${TODAY}`)).data) {
  const det = await api(`/api/returns/${r.id}`);
  if (det.data.items.some((it) => /UjiRet/.test(it.name))) {
    await p.evaluate((id) => fetch(`/api/returns/${id}`, { method: 'DELETE' }), r.id).catch(() => ({}));
  }
}
// Nonaktifkan DULU (payload tanpa stock me-reset stock→0), opname TERAKHIR
// mengembalikan fisik 10 (opname tak menyentuh is_active). Semua masih butuh
// browser (fetch via evaluate) — close PALING akhir.
await post('/api/products', { sku: (await api(`/api/products?q=${QFISIK}`)).data[0]?.sku, name: NAMA_FISIK, category_slug: 'atk', price: 5000, is_active: 0 });
await post('/api/products', { sku: (await api(`/api/products?q=${QJASA}`)).data[0]?.sku, name: NAMA_JASA, category_slug: 'jasa', price: 20000, is_active: 0 });
await post('/api/stock-opname', { product_id: prodId, qty_fisik: 10 });
await b.close();

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
