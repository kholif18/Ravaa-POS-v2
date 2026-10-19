// Rekap tutup shift ala Z-report Aronium (2026-10-11): agregat nota/diskon/
// hutang/piutang + struk thermal 32 kolom + PDF browser + dialog pasca-tutup.
// Jalankan: node recap-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
  import { pasangToken } from './bantuan-uji.mjs';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
const KASIR_UJI = `rekap-uji-${Date.now().toString(36)}`;
let lolos = 0, gagal = 0;
const ok = (name, cond, info = '') => {
  if (cond) { lolos++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { gagal++; console.log('  GAGAL', name, '|', info); }
};
const sql = (q) => execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();
const TS = Date.now();
const NAMA_PROD = `UjiRekap Barang ${TS}`;
const NAMA_CUST = `UjiRekap Hutang ${TS}`;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
try {
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(page);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 150)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 150)); });
  // Path RELATIF (vite proxy /api -> :3001, pola suite lain) — fetch absolut
  // ke :3001 diblokir CORS browser (curl lolos karena non-browser).
  const get = (path) => page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, body: await r.json() };
  }, path);
  const post = (path, body) => page.evaluate(async ([u, bd]) => {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [path, body]);
  // Jeda cetak MATI (pola e2e-struk): suite memverifikasi payload kirim —
  // route **/print di-mock, tanpa risiko kertas. window.print di-stub untuk PDF.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ravaa.printpause', '0');
      window.print = () => {};
    } catch { /* */ }
  });
  const tercetak = [];
  await page.route('**/print', async (route) => {
    try { tercetak.push(route.request().postDataJSON()?.data_base64 ?? ''); } catch { /* */ }
    await route.fulfill({ json: { ok: true, via: 'mock' } });
  });
  // fetch() butuh origin (CORS) — buka app dulu sebelum semua evaluate,
  // pola suite lain (customer-debt-test §1).
  await page.goto(`${WEB}/#/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  console.log('=== A. Setup + agregat Z-report ===');
  const sup = await post('/api/products', { name: NAMA_PROD, category_slug: 'atk', price: 10000, stock: 50 });
  const prodId = sup.body.data.id;
  const prodSku = sup.body.data.sku;
  const cust = await post('/api/customers', { name: NAMA_CUST });
  const custId = cust.body.data.id;
  const sh = await post('/api/shifts/open', { modal_awal: 50000, cashier: KASIR_UJI });
  const shiftId = sh.body.data.id;
  const baris0 = (await get(`/api/shifts?cashier=${encodeURIComponent(KASIR_UJI)}`)).body.data[0];
  ok('shift baru: rentang nota null', baris0.inv_awal === null && baris0.inv_akhir === null, JSON.stringify({ a: baris0.inv_awal, z: baris0.inv_akhir }));
  // Jual tunai 10000, terima 6000, diskon 1000 -> hutang 4000, kembalian 0.
  const saleId = `uji-rekap-${TS}`;
  await post('/api/sales', {
    id: saleId, shift_id: shiftId, pay_method: 'tunai', discount: 1000,
    cash_in: 6000, cashier: KASIR_UJI, customer_id: custId,
    items: [{ product_id: prodId, qty: 1 }],
  });
  const b1 = (await get(`/api/shifts?cashier=${encodeURIComponent(KASIR_UJI)}`)).body.data[0];
  const inv = b1.inv_awal;
  ok('rentang nota terisi (awal = akhir, 1 nota)', !!inv && b1.inv_awal === b1.inv_akhir, inv);
  ok('hutang_baru = 3000 (9000-6000, diskon 1000 ikut total)', b1.hutang_baru === 3000, `hutang=${b1.hutang_baru}`);
  ok('diskon_total = 1000 (transaksi)', b1.diskon_total === 1000, `diskon=${b1.diskon_total}`);
  // Charge 5000 lalu bayar 2000 -> piutang terbayar 2000 (periode shift uji).
  await post('/api/customer-debts', { customer_id: custId, type: 'charge', amount: 5000 });
  await post('/api/customer-debts', { customer_id: custId, type: 'payment', amount: 2000 });
  const b2 = (await get(`/api/shifts?cashier=${encodeURIComponent(KASIR_UJI)}`)).body.data[0];
  ok('piutang_bayar = 2000', b2.piutang_bayar === 2000, `bayar=${b2.piutang_bayar}`);
  ok('tunai/omzet ikut (9000 = 10000-1000 diskon)', b2.tunai === 9000 && b2.omzet === 9000, `tunai=${b2.tunai} omzet=${b2.omzet}`);

  console.log('=== B. Dialog: piutang + tombol cetak X ===');
  await page.goto(`${WEB}/#/shifts`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#sh-body', { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.locator(`#sh-body tbody tr[data-shift="${shiftId}"] [data-tutup]`).click();
  await page.waitForTimeout(500);
  const isiDialog = await page.textContent('.modal');
  ok('baris Hutang terbentuk + Piutang terbayar tampil',
    isiDialog.includes('Hutang terbentuk') && isiDialog.includes('3.000')
    && isiDialog.includes('Piutang terbayar') && isiDialog.includes('2.000'),
    isiDialog.replace(/\s+/g, ' ').slice(0, 160));
  ok('tombol rekap Thermal + PDF ada', await page.locator('[data-rekap="thermal"]').count() === 1
    && await page.locator('[data-rekap="pdf"]').count() === 1);
  const [popPdf] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('[data-rekap="pdf"]'),
  ]);
  await popPdf.waitForLoadState('domcontentloaded');
  const pdfTeks = await popPdf.evaluate(() => document.title + ' ' + document.body.innerText.replace(/\s+/g, ' '));
  ok('PDF: judul + Kas seharusnya + Selisih absen (X)', /Rekap Shift #\d+/.test(pdfTeks)
    && pdfTeks.includes('Kas seharusnya') && !pdfTeks.includes('Selisih'), pdfTeks.slice(0, 160));
  await popPdf.close().catch(() => {});
  await page.click('[data-rekap="thermal"]');
  await page.waitForTimeout(1200);
  const teksThermal = Buffer.from(tercetak[0] ?? '', 'base64').toString('binary')
    .split('').filter((ch) => { const c = ch.charCodeAt(0); return c === 10 || (c >= 32 && c < 127); }).join('');
  ok('Thermal X terkirim: REKAP SEMENTARA + Kas seharusnya',
    tercetak.length === 1 && teksThermal.includes('REKAP SEMENTARA') && teksThermal.includes('Kas seharusnya'),
    `req=${tercetak.length} ${teksThermal.slice(0, 80)}`);

  console.log('=== C. Tutup -> dialog rekap Z ===');
  // Expected = 50000 + (9000-3000) + 0 + 2000 = 58000 -> selisih pas.
  await page.fill('#sh-akhir', '58000');
  await page.click('.modal-overlay [data-ok]');
  await page.waitForSelector('.swal2-popup', { timeout: 10000 });
  const judulZ = await page.textContent('.swal2-popup');
  ok('dialog Z: selisih pas + tombol Selesai', judulZ.includes('selisih Rp0 (pas)') && judulZ.includes('Selesai'),
    judulZ.replace(/\s+/g, ' ').slice(0, 140));
  await page.click('.swal2-cancel');
  await page.waitForTimeout(1200);
  const tutup = (await get(`/api/shifts?cashier=${encodeURIComponent(KASIR_UJI)}`)).body.data[0];
  ok('shift closed + modal_akhir tersimpan', tutup?.status === 'closed' && tutup?.modal_akhir === 58000,
    JSON.stringify({ st: tutup?.status, akhir: tutup?.modal_akhir }));

  ok('tanpa error console', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  gagal++;
  console.log('  CRASH', String(e.message || e).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
}

// Cleanup keras: debts -> moves -> sales (items cascade) -> shift uji ->
// customer uji -> produk nonaktif. Arsip shift-uji% lain tak disentuh.
try {
  const ids = sql(`SELECT id FROM customers WHERE name LIKE 'UjiRekap Hutang %';`).split('\n').filter(Boolean);
  for (const id of ids) sql(`DELETE FROM customer_debts WHERE customer_id = ${Number(id)};`);
  const sales = sql(`SELECT id FROM sales WHERE id LIKE 'uji-rekap-%';`).split('\n').filter(Boolean);
  for (const sid of sales) {
    sql(`DELETE FROM stock_moves WHERE ref_id = '${sid}';`);
    // sale_payments harus eksplisit: sqlite3 CLI TIDAK menegakkan FK
    // (ON DELETE CASCADE tak jalan) — sisa baris yatim walau tak terlihat
    // oleh query (selalu JOIN sales), biar DB uji tetap bersih.
    sql(`DELETE FROM sale_payments WHERE sale_id = '${sid}';`);
    sql(`DELETE FROM sales WHERE id = '${sid}';`);
  }
  sql(`DELETE FROM shifts WHERE cashier LIKE 'rekap-uji-%';`);
  sql(`DELETE FROM customers WHERE name LIKE 'UjiRekap Hutang %';`);
  sql(`UPDATE products SET is_active = 0, version = (SELECT COALESCE(MAX(version),0)+1 FROM products) WHERE name LIKE 'UjiRekap Barang %';`);
} catch (e) { console.log('  cleanup gagal:', String(e).slice(0, 120)); }

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [recap-test.mjs]`);
if (gagal) process.exit(1);
