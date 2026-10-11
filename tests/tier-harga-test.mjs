// Tier harga grosir (2026-10-11): price_grosir produk + tier pelanggan.
// Ecer tak berubah; grosir = baris baru anti-gabung; pack ikut tier × factor.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
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

// Setup: nama UNIK per run (produk tanpa sku selalu INSERT baru).
const TS = Date.now();
const NP = `UjiTier Pensil ${TS}`;
const prod = await post('/api/products', {
  name: NP, category_slug: 'atk', price: 3000, price_grosir: 2500,
  units: [{ unit: 'pack', factor: 12 }],
});
const prodSku = prod.json.data.sku;
const cust = await post('/api/customers', { name: `UjiTier Warung ${TS}`, tier: 'grosir' });
const custId = cust.json.data.id;

console.log('=== A. API: grosir + tier + validasi ===');
const g = await api(`/api/products?q=${encodeURIComponent(NP)}`);
chk('price_grosir tersimpan + terbaca', g.data[0]?.price_grosir === 2500, JSON.stringify(g.data[0]));
chk('grosir negatif -> 400', (await post('/api/products', { name: 'UjiTier Neg', category_slug: 'atk', price_grosir: -5 })).status === 400);
chk('tier grosir tersimpan', cust.json.data.tier === 'grosir');
chk("tier ngawur -> 400", (await post('/api/customers', { name: 'UjiTier Z', tier: 'platinum' })).status === 400);
const t1 = await post('/api/products', { sku: prodSku, name: NP, category_slug: 'atk', price: 3000, price_grosir: 2500, unit: 'pcs', is_active: 0 });
const t2 = await post('/api/products', { sku: prodSku, name: NP, category_slug: 'atk', price: 3000, price_grosir: 2500, unit: 'pcs', is_active: 1 });
chk('toggle nonaktif/aktif pertahankan grosir', t1.status === 201 && t2.status === 201 && t2.json.data.price_grosir === 2500);

console.log('=== B. POS: ecer vs grosir ===');
await p.goto('http://localhost:5656/#/pos', { waitUntil: 'networkidle' });
await p.waitForSelector('#pos-q', { timeout: 15000 });
await p.waitForTimeout(1000);
await w('#pos-q', NP); await p.keyboard.press('Enter'); await p.waitForTimeout(800);
const baris1 = await p.locator('#pos-rows tr[data-key]').count();
const harga1 = await p.locator('#pos-rows tr[data-key] td').nth(3).textContent();
chk('ecer: 1 baris @3000', baris1 === 1 && (harga1 ?? '').includes('3.000'), `baris=${baris1} harga=${harga1}`);
chk('chip Grosir hidden saat ecer', await p.locator('#pos-tier.hidden').count() === 1);
await p.selectOption('#pos-customer', String(custId)); await p.waitForTimeout(500);
chk('chip Grosir tampil', await p.locator('#pos-tier:not(.hidden)').count() === 1);
await w('#pos-q', NP); await p.keyboard.press('Enter'); await p.waitForTimeout(800);
const baris2 = await p.locator('#pos-rows tr[data-key]').count();
chk('grosir = baris BARU (anti-gabung)', baris2 === 2, `baris=${baris2}`);
const harga2 = await p.locator('#pos-rows tr[data-key]').nth(1).locator('td').nth(3).textContent();
chk('baris grosir @2500', (harga2 ?? '').includes('2.500'), `harga=${harga2}`);
chk('total 3000+2500', (await p.textContent('#pos-grand')).includes('5.500'), await p.textContent('#pos-grand'));
await p.locator('#pos-rows tr[data-key]').nth(1).locator('select[data-act="unit"]').selectOption('pack');
await p.waitForTimeout(800);
const hargaPack = await p.locator('#pos-rows tr[data-key]').nth(1).locator('td').nth(3).textContent();
chk('pack grosir = 2500×12', (hargaPack ?? '').includes('30.000'), `harga=${hargaPack}`);

console.log('=== C. Persist: reload pertahankan tier ===');
await p.reload({ waitUntil: 'networkidle' });
await p.waitForSelector('#pos-q', { timeout: 15000 });
await p.waitForTimeout(1000);
const hargaPulih = await p.locator('#pos-rows tr[data-key]').nth(1).locator('td').nth(3).textContent();
chk('pack grosir pulih @30000 + chip nyala', (hargaPulih ?? '').includes('30.000') && await p.locator('#pos-tier:not(.hidden)').count() === 1, `harga=${hargaPulih}`);
await p.click('#pos-clear'); await p.waitForTimeout(800);

console.log('=== D. Modal customer: tier ===');
await p.goto('http://localhost:5656/#/customers', { waitUntil: 'networkidle' });
await p.waitForSelector('#cust-body', { timeout: 15000 });
await p.click('#cust-new'); await p.waitForSelector('.modal');
chk('select tier ada (ecer/grosir)', await p.locator('#c-tier option').count() === 2);
await p.click('.modal [data-x]'); await p.waitForTimeout(300);
await w('#cust-q', `UjiTier Warung ${TS}`); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
chk('badge Grosir di tabel', (await p.textContent('#cust-body')).includes('Grosir'));

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));

// Bersihkan DULU (masih butuh browser untuk post), baru tutup browser:
// customer uji hapus; produk uji nonaktif by sku (upsert by sku — field `id`
// diabaikan server, pola purchase-test).
execSync(`curl -s -m 10 -X DELETE localhost:3001/api/customers/${custId} >/dev/null`);
await post('/api/products', { sku: prodSku, name: NP, category_slug: 'atk', price: 3000, price_grosir: 2500, unit: 'pcs', is_active: 0 });
sql(`DELETE FROM products WHERE name LIKE 'UjiTier Neg%';`);
await b.close();

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
